// REST 路由：依 protocol 的 routes 表註冊與驗證。Handlers 的型別要求每條路由都有實作。
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { routes, type RouteName, type Routes, type User } from '@agent-board/protocol';
import { z } from 'zod';
import {
  hashPassword,
  isAllowedOrigin,
  randomPairingCode,
  randomToken,
  RateLimiter,
  sha256,
  verifyPassword,
  type PasswordParams,
} from './auth';
import { auditToCsv } from './audit';
import { assertBindableHost } from './config';
import { conflict, HttpError, notFound } from './errors';
import type { Hub } from './hub';
import { isAllowedPushEndpoint, isValidClockTime, type VapidKeys } from './push';
import type { Store } from './store';

export const AUTH_COOKIE = 'ab_session';
const LOGIN_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const PAIRING_TTL_MS = 10 * 60 * 1000;
const LIMIT_WINDOW_MS = 5 * 60 * 1000;

type BodyOf<N extends RouteName> = Routes[N] extends { body: infer B extends z.ZodType }
  ? z.output<B>
  : undefined;
type QueryOf<N extends RouteName> = Routes[N] extends { query: infer Q extends z.ZodType }
  ? z.output<Q>
  : undefined;
type UserOf<N extends RouteName> = Routes[N]['auth'] extends 'public' ? User | null : User;

interface Ctx<N extends RouteName> {
  user: UserOf<N>;
  tokenHash: string | null;
  body: BodyOf<N>;
  query: QueryOf<N>;
  params: Record<string, string>;
  req: FastifyRequest;
  reply: FastifyReply;
}

type Handlers = {
  [N in RouteName]: (
    ctx: Ctx<N>,
  ) => z.input<Routes[N]['response']> | Promise<z.input<Routes[N]['response']>>;
};

export interface RestDeps {
  store: Store;
  hub: Hub;
  passwordParams: PasswordParams;
  now(): Date;
  vapid: VapidKeys;
  loginLimit: { perAccount: number; perIp: number };
  pairingLimit: { perIp: number; global: number };
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser: User | null;
    authTokenHash: string | null;
  }
}

const param = (ctx: { params: Record<string, string> }, key = 'id'): string => {
  const value = ctx.params[key];
  if (value === undefined) throw new HttpError(400, 'invalid_request', `Missing ${key}`);
  return value;
};

/** PATCH：只蓋有帶的欄位。 */
function merge<T extends object>(current: T, patch: Partial<T>): T {
  const defined = Object.entries(patch).filter(([, value]) => value !== undefined);
  return { ...current, ...(Object.fromEntries(defined) as Partial<T>) };
}

const ok = { ok: true } as const;

function zodMessage(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

function parseOr400<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new HttpError(400, 'invalid_request', zodMessage(result.error));
}

export function registerRest(app: FastifyInstance, deps: RestDeps): void {
  const { store, hub, passwordParams, now } = deps;
  const nowMs = () => now().getTime();
  const nowIso = () => now().toISOString();

  const loginAccount = new RateLimiter(deps.loginLimit.perAccount, LIMIT_WINDOW_MS, nowMs);
  const loginIp = new RateLimiter(deps.loginLimit.perIp, LIMIT_WINDOW_MS, nowMs);
  const pairIp = new RateLimiter(deps.pairingLimit.perIp, LIMIT_WINDOW_MS, nowMs);
  const pairGlobal = new RateLimiter(deps.pairingLimit.global, LIMIT_WINDOW_MS, nowMs);

  // 帳號不存在時也做一次驗證，回應時間才不會洩漏帳號是否存在。
  let dummyHash: Promise<string> | null = null;
  const getDummyHash = () => (dummyHash ??= hashPassword(randomUUID(), passwordParams));

  const throwIfLimited = (...checks: [RateLimiter, string][]) => {
    const wait = Math.max(...checks.map(([limiter, key]) => limiter.retryAfterSeconds(key)));
    if (wait > 0) throw new HttpError(429, 'rate_limited', 'Too many attempts', wait);
  };

  const startLogin = (reply: FastifyReply, user: User) => {
    const token = randomToken('abs_');
    const created = now();
    const expires = new Date(created.getTime() + LOGIN_SESSION_MS);
    store.createAuthSession(sha256(token), user.id, created.toISOString(), expires.toISOString());
    const publicOrigin = store.getSettings().publicOrigin;
    reply.setCookie(AUTH_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: publicOrigin?.startsWith('https:') ?? false,
      path: '/',
      maxAge: Math.floor(LOGIN_SESSION_MS / 1000),
    });
  };

  const requireTeam = (id: string) => {
    const team = store.getTeam(id);
    if (!team) throw notFound('Team');
    return team;
  };

  const handlers: Handlers = {
    authStatus: (ctx) => ({ needsSetup: store.countUsers() === 0, user: ctx.user }),
    authSetup: async (ctx) => {
      if (store.countUsers() > 0) throw conflict('already_set_up', 'Setup already completed');
      const hash = await hashPassword(ctx.body.password, passwordParams);
      const user: User = {
        id: randomUUID(),
        name: ctx.body.name,
        role: 'owner',
        locale: ctx.body.locale,
      };
      // 上面的檢查擋不住競爭，真正的防線是這個單一 SQL。
      if (!store.createFirstOwner(user, hash)) {
        throw conflict('already_set_up', 'Setup already completed');
      }
      hub.audit(user.id, null, 'auth.setup', user.name);
      startLogin(ctx.reply, user);
      return user;
    },
    authLogin: async (ctx) => {
      const account = `${ctx.req.ip}|${ctx.body.name.toLowerCase()}`;
      throwIfLimited([loginAccount, account], [loginIp, ctx.req.ip]);
      // 先計數再驗證：同時大量請求也算得到。
      loginAccount.hit(account);
      loginIp.hit(ctx.req.ip);
      const found = store.userCredentials(ctx.body.name);
      const valid = await verifyPassword(
        found?.passwordHash ?? (await getDummyHash()),
        ctx.body.password,
      );
      if (!found || !valid) {
        hub.audit(found?.user.id ?? null, null, 'auth.login_failed', ctx.body.name.slice(0, 200));
        throw new HttpError(401, 'invalid_credentials', 'Invalid name or password');
      }
      loginAccount.reset(account);
      hub.audit(found.user.id, null, 'auth.login', found.user.name);
      startLogin(ctx.reply, found.user);
      return found.user;
    },
    authLogout: (ctx) => {
      if (ctx.tokenHash) {
        const tokenHash = ctx.tokenHash;
        store.deleteAuthSession(tokenHash);
        hub.dropClients((c) => c.tokenHash === tokenHash);
      }
      ctx.reply.clearCookie(AUTH_COOKIE, { path: '/' });
      return ok;
    },

    usersList: () => store.listUsers(),
    usersCreate: async (ctx) => {
      const hash = await hashPassword(ctx.body.password, passwordParams);
      const { name, role, locale } = ctx.body;
      const user: User = { id: randomUUID(), name, role, locale };
      store.createUser(user, hash);
      hub.audit(ctx.user.id, null, 'user.create', JSON.stringify({ id: user.id, name, role }));
      return user;
    },
    usersUpdate: async (ctx) => {
      const id = param(ctx);
      if (ctx.user.role !== 'owner' && ctx.user.id !== id) {
        throw new HttpError(403, 'forbidden', 'Cannot modify another user');
      }
      const target = store.getUser(id);
      if (!target) throw notFound('User');
      if (ctx.body.password) {
        if (ctx.user.id !== id) {
          throw new HttpError(403, 'forbidden', 'Cannot change the password of another user');
        }
        // 舊密碼的猜測跟登入一樣要限速；key 綁帳號，換 IP 也繞不掉，也不會擋到正常登入。
        const account = `password-change|${id}`;
        throwIfLimited([loginAccount, account]);
        loginAccount.hit(account);
        const credentials = store.userCredentials(target.name);
        const valid =
          credentials !== null &&
          (await verifyPassword(credentials.passwordHash, ctx.body.currentPassword ?? ''));
        if (!valid) {
          hub.audit(ctx.user.id, null, 'user.password_change_failed', id);
          throw new HttpError(403, 'invalid_current_password', 'Current password is incorrect');
        }
        loginAccount.reset(account);
      }
      const passwordHash = ctx.body.password
        ? await hashPassword(ctx.body.password, passwordParams)
        : undefined;
      store.updateUser(id, { locale: ctx.body.locale, passwordHash });
      if (passwordHash) {
        // 改密碼：其他裝置全部登出，只留下正在操作的這一個。
        const keep = ctx.tokenHash;
        store.deleteUserAuthSessions(id, keep);
        hub.dropClients((c) => c.userId === id && c.tokenHash !== keep);
        hub.audit(ctx.user.id, null, 'user.password_change', id);
      }
      return store.getUser(id) as User;
    },
    usersDelete: (ctx) => {
      const id = param(ctx);
      const result = store.deleteUser(id);
      if (result === 'not_found') throw notFound('User');
      if (result === 'last_owner') throw conflict('last_owner', 'Cannot delete the last owner');
      hub.dropClients((c) => c.userId === id);
      hub.audit(ctx.user.id, null, 'user.delete', id);
      return ok;
    },

    machinesList: () => store.listMachines(),
    machinesRename: (ctx) => {
      const id = param(ctx);
      if (!store.getMachine(id)) throw notFound('Machine');
      store.renameMachine(id, ctx.body.name);
      hub.broadcastMachine(id);
      return store.getMachine(id)!;
    },
    machinesDelete: (ctx) => {
      hub.deleteMachine(param(ctx), ctx.user);
      return ok;
    },
    pairingCreate: (ctx) => {
      const code = randomPairingCode();
      const created = now();
      const expiresAt = new Date(created.getTime() + PAIRING_TTL_MS).toISOString();
      store.insertPairingCode(sha256(code), ctx.user.id, created.toISOString(), expiresAt);
      hub.audit(ctx.user.id, null, 'machine.pairing_code', `expires ${expiresAt}`);
      const hubUrl = hubOrigin(ctx.req, store.getSettings().publicOrigin);
      return {
        code,
        expiresAt,
        installCommand: `agent-board-daemon pair --hub ${shellQuote(hubUrl)} --code ${code}`,
      };
    },
    pairingExchange: (ctx) => {
      const ip = ctx.req.ip;
      throwIfLimited([pairIp, ip], [pairGlobal, 'all']);
      const machineId = randomUUID();
      const token = randomToken('abm_');
      const accepted = store.exchangePairingCode(
        sha256(ctx.body.code.trim().toUpperCase()),
        nowIso(),
        {
          id: machineId,
          name: ctx.body.name,
          os: ctx.body.os,
          capabilities: ctx.body.capabilities,
        },
        sha256(token),
      );
      if (!accepted) {
        pairIp.hit(ip);
        pairGlobal.hit('all');
        hub.audit(null, null, 'machine.pair_failed', ip);
        throw new HttpError(401, 'invalid_pairing_code', 'Invalid or expired pairing code');
      }
      hub.audit(null, null, 'machine.pair', JSON.stringify({ machineId, name: ctx.body.name }));
      hub.broadcastMachine(machineId);
      return { machineId, token };
    },
    machineBrowse: (ctx) => hub.browse(param(ctx), ctx.query.path),
    machineUsage: (ctx) => {
      const id = param(ctx);
      if (!store.getMachine(id)) throw notFound('Machine');
      return hub.latestUsage(id);
    },

    sessionsList: (ctx) => store.listSessions(ctx.query.archived),
    sessionsCreate: (ctx) => hub.createSession(ctx.body, ctx.user),
    sessionsUpdate: (ctx) => hub.updateSession(param(ctx), ctx.body, ctx.user),
    sessionsStop: (ctx) => hub.stopSession(param(ctx), ctx.user),
    sessionsResume: (ctx) => hub.resumeSession(param(ctx), ctx.user),
    sessionEvents: (ctx) => {
      const id = param(ctx);
      if (!store.getSession(id)) throw notFound('Session');
      return store.listEvents(id);
    },

    projectsList: () => store.listProjects(),
    projectsCreate: (ctx) => {
      const project = { id: randomUUID(), ...ctx.body };
      store.upsertProject(project);
      return project;
    },
    projectsUpdate: (ctx) => {
      const current = store.getProject(param(ctx));
      if (!current) throw notFound('Project');
      const next = merge(current, ctx.body);
      store.upsertProject(next);
      return next;
    },
    projectsDelete: (ctx) => {
      const id = param(ctx);
      const affected = store.sessionIdsInProject(id);
      if (!store.deleteProject(id)) throw notFound('Project');
      for (const sessionId of affected) hub.broadcastSession(sessionId);
      return ok;
    },
    layoutsGet: (ctx) => store.listLayouts(ctx.user.id, ctx.query.workspace),
    layoutsPut: (ctx) => {
      store.replaceLayouts(ctx.user.id, ctx.body);
      return ok;
    },
    notesList: (ctx) => store.listNotes(ctx.query.workspace),
    notesCreate: (ctx) => {
      const note = { id: randomUUID(), ...ctx.body };
      store.upsertNote(note);
      return note;
    },
    notesUpdate: (ctx) => {
      const current = store.getNote(param(ctx));
      if (!current) throw notFound('Note');
      const next = merge(current, ctx.body);
      store.upsertNote(next);
      return next;
    },
    notesDelete: (ctx) => {
      if (!store.deleteNote(param(ctx))) throw notFound('Note');
      return ok;
    },

    templatesList: () => store.listTemplates(),
    templatesCreate: (ctx) => {
      const template = { id: randomUUID(), ...ctx.body };
      store.upsertTemplate(template);
      return template;
    },
    templatesUpdate: (ctx) => {
      const current = store.getTemplate(param(ctx));
      if (!current) throw notFound('Template');
      const next = merge(current, ctx.body);
      store.upsertTemplate(next);
      return next;
    },
    templatesDelete: (ctx) => {
      if (!store.deleteTemplate(param(ctx))) throw notFound('Template');
      return ok;
    },

    teamsList: () => store.listTeams(),
    teamsCreate: (ctx) => {
      const team = { id: randomUUID(), ...ctx.body };
      store.upsertTeam(team);
      return team;
    },
    teamsUpdate: (ctx) => {
      const next = merge(requireTeam(param(ctx)), ctx.body);
      store.upsertTeam(next);
      return next;
    },
    teamsDelete: (ctx) => {
      if (!store.deleteTeam(param(ctx))) throw notFound('Team');
      return ok;
    },
    teamMembersList: (ctx) => store.listTeamMembers(requireTeam(param(ctx)).id),
    teamMembersPut: (ctx) => {
      const member = {
        teamId: requireTeam(param(ctx)).id,
        sessionId: param(ctx, 'sessionId'),
        role: ctx.body.role,
      };
      store.upsertTeamMember(member);
      return member;
    },
    teamMembersDelete: (ctx) => {
      if (!store.deleteTeamMember(param(ctx), param(ctx, 'sessionId'))) {
        throw notFound('Team member');
      }
      return ok;
    },
    tasksList: (ctx) => store.listTasks(requireTeam(param(ctx)).id),
    tasksCreate: (ctx) => {
      const task = {
        id: randomUUID(),
        teamId: requireTeam(param(ctx)).id,
        title: ctx.body.title,
        ownerSessionId: ctx.body.ownerSessionId,
        column: 'todo' as const,
      };
      store.upsertTask(task);
      return task;
    },
    tasksUpdate: (ctx) => {
      const current = store.getTask(param(ctx));
      if (!current) throw notFound('Task');
      const next = merge(current, ctx.body);
      if (next.column !== 'todo' && next.ownerSessionId === null) {
        throw conflict('task_unassigned', 'Assign the task before moving it');
      }
      store.upsertTask(next);
      return next;
    },
    tasksDelete: (ctx) => {
      if (!store.deleteTask(param(ctx))) throw notFound('Task');
      return ok;
    },
    handoffRulesList: (ctx) => store.listRules(requireTeam(param(ctx)).id),
    handoffRulesCreate: (ctx) => {
      const rule = { id: randomUUID(), teamId: requireTeam(param(ctx)).id, ...ctx.body };
      store.upsertRule(rule);
      return rule;
    },
    handoffRulesUpdate: (ctx) => {
      const current = store.getRule(param(ctx));
      if (!current) throw notFound('Handoff rule');
      const next = merge(current, ctx.body);
      store.upsertRule(next);
      return next;
    },
    handoffRulesDelete: (ctx) => {
      if (!store.deleteRule(param(ctx))) throw notFound('Handoff rule');
      return ok;
    },

    auditList: (ctx) => store.listAudit(ctx.query),
    auditExport: (ctx) => {
      const csv = auditToCsv(store.iterateAudit());
      hub.audit(ctx.user.id, null, 'audit.export', '');
      ctx.reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="agent-board-audit.csv"');
      return csv;
    },
    settingsGet: () => store.getSettings(),
    settingsUpdate: (ctx) => {
      const patch = normalizeSettings(ctx.body);
      const prev = store.getSettings();
      const next = store.updateSettings(patch);
      hub.audit(ctx.user.id, null, 'settings.update', Object.keys(patch).join(','));
      hub.onSettingsChanged(prev, next);
      return next;
    },

    pushVapidKey: () => ({ publicKey: deps.vapid.publicKey }),
    pushSubscribe: (ctx) => {
      if (!isAllowedPushEndpoint(ctx.body.endpoint)) {
        throw new HttpError(400, 'invalid_endpoint', 'Push endpoint must be a public https URL');
      }
      store.upsertPushSubscription(ctx.user.id, ctx.body);
      return ok;
    },
    pushUnsubscribe: (ctx) => {
      store.deletePushSubscription(ctx.user.id, ctx.body.endpoint);
      return ok;
    },
  };

  // 所有請求先認證（放在 onRequest，比 body 解析早），路由再依 auth 等級判斷。
  app.decorateRequest('authUser', null);
  app.decorateRequest('authTokenHash', null);
  app.addHook('onRequest', async (req) => {
    const token = req.cookies[AUTH_COOKIE];
    if (!token) return;
    const tokenHash = sha256(token);
    req.authUser = store.authSessionUser(tokenHash, nowIso());
    if (req.authUser) req.authTokenHash = tokenHash;
  });

  for (const name of Object.keys(routes) as RouteName[]) {
    registerRoute(name);
  }

  function registerRoute<N extends RouteName>(name: N): void {
    const def: Routes[N] & { body?: z.ZodType; query?: z.ZodType } = routes[name];
    app.route({
      method: def.method,
      url: def.path,
      onRequest: async (req) => {
        if (def.auth !== 'public' && !req.authUser) {
          throw new HttpError(401, 'unauthenticated', 'Login required');
        }
        if (def.auth === 'owner' && req.authUser?.role !== 'owner') {
          throw new HttpError(403, 'forbidden', 'Owner role required');
        }
        // 深度防禦：SameSite=Strict 之外，改變狀態的請求若帶 Origin 也要同源。
        const origin = req.headers.origin;
        if (
          req.method !== 'GET' &&
          origin !== undefined &&
          !isAllowedOrigin(origin, req.headers.host, store.getSettings().publicOrigin)
        ) {
          throw new HttpError(403, 'bad_origin', 'Origin not allowed');
        }
      },
      handler: async (req, reply) => {
        const ctx = {
          user: req.authUser,
          tokenHash: req.authTokenHash,
          body: def.body ? parseOr400(def.body, req.body) : undefined,
          query: def.query ? parseOr400(def.query, req.query) : undefined,
          params: req.params as Record<string, string>,
          req,
          reply,
        } as unknown as Ctx<N>;
        const result = await handlers[name](ctx);
        // 回應也過 schema：多餘欄位（例如 password_hash）在這裡被濾掉。
        return def.response.parse(result);
      },
    });
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Host 是請求帶來的，安裝指令會被貼進 shell：只取解析得過的 origin。 */
function hubOrigin(req: FastifyRequest, publicOrigin: string | null): string {
  if (publicOrigin) return new URL(publicOrigin).origin;
  try {
    return new URL(`${req.protocol}://${req.headers.host ?? ''}`).origin;
  } catch {
    throw new HttpError(400, 'invalid_request', 'Invalid Host header');
  }
}

function normalizeSettings<T extends Parameters<Store['updateSettings']>[0]>(patch: T): T {
  const next = { ...patch };
  if (next.listenAddress !== undefined) {
    try {
      assertBindableHost(next.listenAddress);
    } catch (error) {
      throw new HttpError(400, 'unsafe_listen_address', (error as Error).message);
    }
  }
  if (next.publicOrigin) {
    const url = new URL(next.publicOrigin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new HttpError(400, 'invalid_public_origin', 'publicOrigin must be http or https');
    }
    next.publicOrigin = url.origin;
  }
  const quiet = next.notifications?.quietHours;
  if (quiet && !(isValidClockTime(quiet.start) && isValidClockTime(quiet.end))) {
    throw new HttpError(400, 'invalid_quiet_hours', 'Quiet hours must use HH:MM');
  }
  return next;
}
