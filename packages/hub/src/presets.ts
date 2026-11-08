// 團隊 Presets（P3 項目二，docs/p3-spec.md §2.5、CONTRACTS §15）：存設定、排序、記最後使用時間、寫 audit。
// hub 不建立任何東西：套用是前端沿用「團隊快速建立」（runPlan）逐列建立，完成後回報 `used`。
// 這裡不送任何字進 session（隊長第一個指令是建立 session 時的 firstPrompt，或暫停中由 GM 手動送）。
import { randomUUID } from 'node:crypto';
import {
  TeamPresetConfig,
  type TeamPreset,
  type TeamPresetUsed,
  type User,
} from '@agent-board/protocol';
import type { Db } from './db';
import { conflict, notFound } from './errors';

interface PresetRow {
  id: string;
  name: string;
  config: string;
  position: number;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

export interface PresetDeps {
  db: Db;
  now(): Date;
  audit(userId: string | null, sessionId: string | null, action: string, detail: string): void;
  /** 清單變了：整份推給每個 client（WS preset.list）。 */
  changed(presets: TeamPreset[]): void;
}

const nameTaken = (name: string) =>
  conflict('preset_name_taken', `A preset named "${name}" already exists`);

const isUniqueError = (error: unknown) =>
  error instanceof Error && /UNIQUE constraint failed: team_presets\.name/.test(error.message);

/** audit 只記摘要（列數、規則數、有沒有第一個指令），不記 TEAM.md 與指令全文。 */
function summary(config: TeamPresetConfig) {
  return {
    rows: config.rows.length,
    rules: config.handoffRules.length,
    rulesEnabled: config.handoffRules.filter((r) => r.enabled).length,
    taskAuto: config.taskAuto,
    firstPrompt: config.leadFirstPrompt !== null,
    bypass: config.rows.some((r) => r.permissionMode === 'bypassPermissions'),
  };
}

export class TeamPresets {
  constructor(private readonly deps: PresetDeps) {}

  private nowIso(): string {
    return this.deps.now().toISOString();
  }

  /**
   * 讀出來時再用 zod 解析一次（補上新版加的預設值）。資料庫裡的內容壞掉（理論上不會發生）就略過那一筆，
   * 不讓整份清單讀不出來。
   */
  private toPreset(row: PresetRow): TeamPreset | null {
    let raw: unknown;
    try {
      raw = JSON.parse(row.config);
    } catch {
      return null;
    }
    const config = TeamPresetConfig.safeParse(raw);
    if (!config.success) return null;
    return {
      id: row.id,
      name: row.name,
      config: config.data,
      position: row.position,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at,
    };
  }

  list(): TeamPreset[] {
    const rows = this.deps.db
      .prepare('SELECT * FROM team_presets ORDER BY position, created_at, rowid')
      .all() as PresetRow[];
    return rows.flatMap((row) => this.toPreset(row) ?? []);
  }

  get(id: string): TeamPreset | null {
    const row = this.deps.db.prepare('SELECT * FROM team_presets WHERE id = ?').get(id) as
      PresetRow | undefined;
    return row ? this.toPreset(row) : null;
  }

  private require(id: string): TeamPreset {
    const preset = this.get(id);
    if (!preset) throw notFound('Preset');
    return preset;
  }

  /** 把 id 移到第 index 個（超過就放最後），其他的依原本順序重新編號成 0..n-1。在交易內呼叫。 */
  private placeAt(id: string, index: number): void {
    const ids = (
      this.deps.db
        .prepare('SELECT id FROM team_presets ORDER BY position, created_at, rowid')
        .all() as { id: string }[]
    )
      .map((r) => r.id)
      .filter((x) => x !== id);
    ids.splice(Math.min(index, ids.length), 0, id);
    const update = this.deps.db.prepare('UPDATE team_presets SET position = ? WHERE id = ?');
    ids.forEach((x, i) => update.run(i, x));
  }

  private publish(): void {
    this.deps.changed(this.list());
  }

  create(
    input: { name: string; config: TeamPresetConfig; position?: number },
    user: User,
  ): TeamPreset {
    const id = randomUUID();
    const now = this.nowIso();
    try {
      this.deps.db.transaction(() => {
        this.deps.db
          .prepare(
            `INSERT INTO team_presets (id, name, config, position, created_at, updated_at, last_used_at)
             VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM team_presets), ?, ?, NULL)`,
          )
          .run(id, input.name, JSON.stringify(input.config), now, now);
        if (input.position !== undefined) this.placeAt(id, input.position);
      })();
    } catch (error) {
      if (isUniqueError(error)) throw nameTaken(input.name);
      throw error;
    }
    const preset = this.require(id);
    this.deps.audit(
      user.id,
      null,
      'preset.create',
      JSON.stringify({ id, name: preset.name, ...summary(preset.config) }),
    );
    this.publish();
    return preset;
  }

  update(
    id: string,
    patch: { name?: string; config?: TeamPresetConfig; position?: number },
    user: User,
  ): TeamPreset {
    const current = this.require(id);
    const now = this.nowIso();
    try {
      this.deps.db.transaction(() => {
        if (patch.name !== undefined || patch.config !== undefined) {
          this.deps.db
            .prepare('UPDATE team_presets SET name = ?, config = ?, updated_at = ? WHERE id = ?')
            .run(
              patch.name ?? current.name,
              JSON.stringify(patch.config ?? current.config),
              now,
              id,
            );
        }
        if (patch.position !== undefined) this.placeAt(id, patch.position);
      })();
    } catch (error) {
      if (isUniqueError(error)) throw nameTaken(patch.name ?? current.name);
      throw error;
    }
    const next = this.require(id);
    this.deps.audit(
      user.id,
      null,
      'preset.update',
      JSON.stringify({
        id,
        ...(patch.name !== undefined && patch.name !== current.name
          ? { from: current.name, to: next.name }
          : { name: next.name }),
        ...(patch.position !== undefined
          ? { position: { from: current.position, to: next.position } }
          : {}),
        ...(patch.config !== undefined ? summary(next.config) : {}),
      }),
    );
    this.publish();
    return next;
  }

  delete(id: string, user: User): void {
    const preset = this.require(id);
    this.deps.db.transaction(() => {
      this.deps.db.prepare('DELETE FROM team_presets WHERE id = ?').run(id);
      // 刪掉後補位，position 維持連續。
      const ids = this.deps.db
        .prepare('SELECT id FROM team_presets ORDER BY position, created_at, rowid')
        .all() as { id: string }[];
      const update = this.deps.db.prepare('UPDATE team_presets SET position = ? WHERE id = ?');
      ids.forEach((row, i) => update.run(i, row.id));
    })();
    this.deps.audit(
      user.id,
      null,
      'preset.delete',
      JSON.stringify({ id, name: preset.name, position: preset.position }),
    );
    this.publish();
  }

  /** 套用完成：記最後使用時間（有建成至少一列才算用過），audit `preset.apply`。 */
  used(id: string, result: TeamPresetUsed, user: User): TeamPreset {
    const preset = this.require(id);
    if (result.created > 0) {
      this.deps.db
        .prepare('UPDATE team_presets SET last_used_at = ? WHERE id = ?')
        .run(this.nowIso(), id);
    }
    this.deps.audit(
      user.id,
      null,
      'preset.apply',
      JSON.stringify({ presetId: id, name: preset.name, ...result }),
    );
    if (result.created > 0) this.publish();
    return this.require(id);
  }
}
