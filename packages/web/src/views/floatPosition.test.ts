// 浮動對話框的位置規則（GM 2026-11-14，STYLE §5.2）。
import { describe, expect, it } from 'vitest';
import {
  centerPos,
  clampPos,
  FLOAT_MARGIN,
  floatBounds,
  keyMove,
  KEY_STEP,
  KEY_STEP_BIG,
  readPos,
  shouldFloat,
  storageKey,
  writePos,
} from './floatPosition';
import { FLOATING_MODALS, isFloatingModal } from './overlay';

const viewport = { width: 1280, height: 800 };
const bounds = floatBounds(viewport, 56);
const size = { width: 480, height: 300 };

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

const broken = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
  removeItem: () => {
    throw new Error('SecurityError');
  },
};

describe('floatBounds', () => {
  it('頁首下緣以下、視窗以內，各留邊距', () => {
    expect(bounds).toEqual({
      left: FLOAT_MARGIN,
      top: 56 + FLOAT_MARGIN,
      right: 1280 - FLOAT_MARGIN,
      bottom: 800 - FLOAT_MARGIN,
    });
  });
});

describe('clampPos：位置夾在範圍內', () => {
  it('範圍內的位置不動', () => {
    expect(clampPos({ x: 100, y: 200 }, size, bounds)).toEqual({ x: 100, y: 200 });
  });
  it('拖出右下：整個框留在視窗裡', () => {
    expect(clampPos({ x: 5000, y: 5000 }, size, bounds)).toEqual({
      x: 1280 - FLOAT_MARGIN - 480,
      y: 800 - FLOAT_MARGIN - 300,
    });
  });
  it('拖到左上或頁首上面：停在頁首下緣', () => {
    expect(clampPos({ x: -300, y: 0 }, size, bounds)).toEqual({ x: FLOAT_MARGIN, y: 64 });
  });
  it('視窗縮小（或換到小螢幕）：記住的位置被拉回看得到的地方', () => {
    const small = floatBounds({ width: 800, height: 600 }, 56);
    const pos = clampPos({ x: 760, y: 480 }, size, small);
    expect(pos.x + size.width).toBeLessThanOrEqual(800 - FLOAT_MARGIN);
    expect(pos.y + size.height).toBeLessThanOrEqual(600 - FLOAT_MARGIN);
  });
  it('框比視窗大：對齊左上，標題列一定看得到', () => {
    const tiny = floatBounds({ width: 400, height: 300 }, 56);
    expect(clampPos({ x: 200, y: 200 }, { width: 900, height: 700 }, tiny)).toEqual({
      x: FLOAT_MARGIN,
      y: 64,
    });
  });
  it('四捨五入成整數像素', () => {
    expect(clampPos({ x: 100.6, y: 200.4 }, size, bounds)).toEqual({ x: 101, y: 200 });
  });
});

describe('centerPos', () => {
  it('置中在頁首以下的區域', () => {
    expect(centerPos(size, bounds)).toEqual({
      x: Math.round(8 + (1272 - 8 - 480) / 2),
      y: Math.round(64 + (792 - 64 - 300) / 2),
    });
  });
  it('右側面板開著且放得下：置中在面板左邊', () => {
    const pos = centerPos(size, bounds, 420);
    expect(pos.x + size.width).toBeLessThanOrEqual(1272 - 420);
  });
  it('面板左邊放不下：照整個視窗置中', () => {
    const narrow = floatBounds({ width: 800, height: 800 }, 56);
    expect(centerPos(size, narrow, 420)).toEqual(centerPos(size, narrow));
  });
});

describe('readPos／writePos：localStorage', () => {
  it('寫進去再讀出來是同一個位置；每個對話框各記各的', () => {
    const storage = memoryStorage();
    writePos('new-team', { x: 120, y: 90 }, storage);
    expect(readPos('new-team', storage)).toEqual({ x: 120, y: 90 });
    expect(readPos('add-members', storage)).toBeNull();
    expect(storage.data.has(storageKey('new-team'))).toBe(true);
  });
  it('回到中間（null）會清掉記錄', () => {
    const storage = memoryStorage();
    writePos('preset', { x: 1, y: 2 }, storage);
    writePos('preset', null, storage);
    expect(readPos('preset', storage)).toBeNull();
  });
  it('localStorage 讀寫丟例外：不炸、讀到 null（＝置中）', () => {
    expect(readPos('new-team', broken)).toBeNull();
    expect(() => writePos('new-team', { x: 1, y: 2 }, broken)).not.toThrow();
    expect(() => writePos('new-team', null, broken)).not.toThrow();
  });
  it('沒有 localStorage（null）：讀到 null', () => {
    expect(readPos('new-team', null)).toBeNull();
    expect(() => writePos('new-team', { x: 1, y: 2 }, null)).not.toThrow();
  });
  it('壞掉的記錄（不是 JSON、缺欄位、不是數字）：當沒有，置中', () => {
    for (const raw of ['{', 'null', '[]', '{"x":1}', '{"x":"1","y":2}', '{"x":null,"y":2}']) {
      expect(readPos('m', memoryStorage({ [storageKey('m')]: raw })), raw).toBeNull();
    }
  });
  it('讀不到時的實際位置就是置中', () => {
    const pos = readPos('new-team', broken) ?? centerPos(size, bounds);
    expect(pos).toEqual(centerPos(size, bounds));
  });
});

describe('shouldFloat：手機不浮動', () => {
  it('≤ 640px（手機）維持全螢幕頁', () => {
    expect(shouldFloat(390)).toBe(false);
    expect(shouldFloat(640)).toBe(false);
  });
  it('比手機寬才浮動', () => {
    expect(shouldFloat(641)).toBe(true);
    expect(shouldFloat(1440)).toBe(true);
  });
});

describe('keyMove：Alt＋方向鍵', () => {
  it('四個方向，Shift 走大步；其他鍵不動', () => {
    expect(keyMove('ArrowLeft', false)).toEqual({ x: -KEY_STEP, y: 0 });
    expect(keyMove('ArrowDown', true)).toEqual({ x: 0, y: KEY_STEP_BIG });
    expect(keyMove('a', false)).toBeNull();
  });
});

describe('哪些次畫面浮動', () => {
  it('只有新增 session；設定、搜尋等維持置中模態', () => {
    expect([...FLOATING_MODALS]).toEqual(['new']);
    expect(isFloatingModal('new')).toBe(true);
    expect(isFloatingModal('settings')).toBe(false);
    expect(isFloatingModal('search')).toBe(false);
    expect(isFloatingModal(null)).toBe(false);
  });
});
