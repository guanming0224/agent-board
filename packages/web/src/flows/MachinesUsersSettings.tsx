// 設定「機器與使用者」：配對、移除機器；新增、移除使用者，幫別人重設密碼。
// 成員只看得到機器清單（hub 的 machinesList 是 user 權限），配對、移除與使用者區只有 owner。
import { useCallback, useState } from 'react';
import type { Machine, User } from '@agent-board/protocol';
import { useLocale, useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { Empty, ErrorBox, errorText, Msg, useLoad, useTwoStep, type Note } from './common';
import { PairingPanel } from './PairingPanel';
import { ResetPassword } from './ResetPassword';
import { Section, useSettingsUser, type AdminBackend } from './settingsParts';

function MachineRow({ machine, canManage }: { machine: Machine; canManage: boolean }) {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const { backend, sessions, connected } = useBoard();
  const twoStep = useTwoStep();
  const [note, setNote] = useState<Note | null>(null);
  const active = sessions.filter((s) => s.machineId === machine.id && !s.archived).length;
  const { hasGpu, gpuName, cpuCores, memoryBytes } = machine.capabilities;
  const remove = () =>
    twoStep.press(() => {
      backend
        .removeMachine(machine.id)
        .catch((e: unknown) =>
          setNote({ text: t('flows.machine.removeFailed', { error: errorText(e) }), tone: 'err' }),
        );
    });
  return (
    <li className={`rig-row${machine.online ? '' : ' off'}`} data-testid={`machine-${machine.id}`}>
      <div className="rig-name">
        {machine.online ? (
          <span className="dot" aria-hidden="true" />
        ) : (
          <span aria-hidden="true">⊘</span>
        )}
        <strong>{machine.name}</strong>
        <span className="sub">{t(machine.online ? 'flows.machine.online' : 'status.offline')}</span>
      </div>
      <div className="sub">
        {machine.os} · {cpuCores} CPU · {Math.round(memoryBytes / 1024 ** 3)} GB
        {hasGpu ? ` · ${gpuName ?? 'GPU'}` : ''}
      </div>
      {!machine.online && machine.lastSeenAt && (
        <div className="sub">
          {t('flows.machine.lastSeen', {
            time: new Date(machine.lastSeenAt).toLocaleString(locale),
          })}
        </div>
      )}
      {canManage && (
        <div className="acts">
          <button type="button" className="danger" disabled={!connected} onClick={remove}>
            {twoStep.armed ? t('flows.machine.removeAgain') : t('flows.machine.remove')}
          </button>
          {twoStep.armed ? (
            <span className="msg" role="status">
              {t('flows.machine.removeHint', { n: active })}
            </span>
          ) : (
            <Msg note={note} />
          )}
        </div>
      )}
    </li>
  );
}

/** canManage：目前登入的是 owner，才有配對與移除（hub 只准 owner）。 */
export function MachinesSection({ canManage }: { canManage: boolean }) {
  const t = useT();
  const { machines } = useBoard();
  return (
    <Section id="machines" title={t('flows.settings.machines')}>
      {machines.length === 0 ? (
        <Empty
          title={t('flows.machine.none')}
          next={canManage ? t('flows.machine.noneNext') : t('flows.new.noMachinesMember')}
        />
      ) : (
        <ul className="rows">
          {machines.map((machine) => (
            <MachineRow key={machine.id} machine={machine} canManage={canManage} />
          ))}
        </ul>
      )}
      {canManage && <PairingPanel />}
    </Section>
  );
}

function UserRow({
  user,
  onDeleted,
  self,
  canReset = false,
}: {
  user: User;
  onDeleted: () => void;
  self: boolean;
  /** 目前登入的是 owner：可以重設別人的密碼（自己的走「改密碼」）。 */
  canReset?: boolean;
}) {
  const t = useT();
  const { backend } = useBoard();
  const admin = backend as AdminBackend;
  const twoStep = useTwoStep();
  const [note, setNote] = useState<Note | null>(null);
  return (
    <li className="rig-row">
      <div className="rig-name">
        <strong>{user.name}</strong>
        <span className="chip">{t(`flows.user.role.${user.role}`)}</span>
      </div>
      {!self && admin.deleteUser && (
        <div className="acts">
          <button
            type="button"
            className="danger"
            onClick={() =>
              twoStep.press(() => {
                admin.deleteUser?.(user.id).then(onDeleted, (e: unknown) =>
                  setNote({
                    text: t('flows.user.deleteFailed', { error: errorText(e) }),
                    tone: 'err',
                  }),
                );
              })
            }
          >
            {twoStep.armed ? t('flows.user.deleteAgain') : t('flows.user.delete')}
          </button>
          <Msg note={note} />
        </div>
      )}
      {!self && canReset && <ResetPassword user={user} />}
    </li>
  );
}

function AddUser({ onAdded }: { onAdded: () => void }) {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const { backend } = useBoard();
  const admin = backend as AdminBackend;
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<User['role']>('member');
  const [note, setNote] = useState<Note | null>(null);
  const add = async () => {
    if (!name.trim()) return setNote({ text: t('flows.user.needName'), tone: 'err' });
    if (password.length < 8) return setNote({ text: t('flows.user.shortPassword'), tone: 'err' });
    try {
      await admin.createUser?.({ name: name.trim(), password, role, locale });
      setName('');
      setPassword('');
      setNote({ text: t('flows.user.added') });
      onAdded();
    } catch (e) {
      setNote({ text: t('flows.user.addFailed', { error: errorText(e) }), tone: 'err' });
    }
  };
  return (
    <div className="add-user">
      <label>
        {t('flows.user.name')}
        <input value={name} autoComplete="off" onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        {t('flows.user.password')}
        <input
          type="password"
          value={password}
          autoComplete="new-password"
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <label>
        {t('flows.user.role')}
        <select value={role} onChange={(e) => setRole(e.target.value as User['role'])}>
          <option value="member">{t('flows.user.role.member')}</option>
          <option value="owner">{t('flows.user.role.owner')}</option>
        </select>
      </label>
      <div className="acts">
        <button type="button" onClick={() => void add()}>
          {t('flows.user.add')}
        </button>
        <Msg note={note} />
      </div>
    </div>
  );
}

export function UsersSection() {
  const t = useT();
  const { backend } = useBoard();
  const admin = backend as AdminBackend;
  const me = useSettingsUser();
  const users = useLoad(
    useCallback(async () => (admin.listUsers ? admin.listUsers() : null), [admin]),
  );
  return (
    <Section id="users" title={t('flows.settings.users')}>
      {!admin.listUsers ? (
        <p className="hint" data-testid="users-unavailable">
          {t('flows.user.unavailable')}
        </p>
      ) : users.error ? (
        <ErrorBox
          what={t('flows.user.listFailed', { error: users.error })}
          how={t('flows.retryHow')}
          onRetry={users.reload}
        />
      ) : (
        <>
          <ul className="rows">
            {users.data?.map((user) => (
              <UserRow
                key={user.id}
                user={user}
                self={user.id === me.data?.id}
                canReset={me.data?.role === 'owner'}
                onDeleted={users.reload}
              />
            ))}
          </ul>
          {admin.createUser && <AddUser onAdded={users.reload} />}
        </>
      )}
    </Section>
  );
}
