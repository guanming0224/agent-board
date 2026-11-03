import { describe, expect, it } from 'vitest';
import type { TerminalServerMessage, TerminalStream } from '../shared/terminal-contract';
import { HIDDEN_BUFFER_LIMIT, TerminalFeed, judgeSeq, type TerminalSink } from './feed';

const SESSION = 's-1';

class ScriptedStream implements TerminalStream {
  subscribes = 0;
  unsubscribes = 0;
  listener: ((m: TerminalServerMessage) => void) | null = null;
  /** 設定後，subscribe 會同步回一份快照（假 PTY 的行為）。 */
  syncSnapshotSeq: number | null = null;

  subscribe(_sessionId: string, onMessage: (m: TerminalServerMessage) => void) {
    this.subscribes += 1;
    this.listener = onMessage;
    if (this.syncSnapshotSeq !== null) this.snapshot(this.syncSnapshotSeq);
    return () => {
      this.unsubscribes += 1;
    };
  }

  send(): void {}

  snapshot(seq: number, data = `snap@${seq}`, sessionId = SESSION) {
    this.listener?.({ type: 'terminal.snapshot', sessionId, seq, cols: 80, rows: 24, data });
  }

  output(seq: number, data = `out@${seq}`, sessionId = SESSION) {
    this.listener?.({ type: 'terminal.output', sessionId, seq, data });
  }
}

function setup(visible = true) {
  const stream = new ScriptedStream();
  const log: string[] = [];
  const sink: TerminalSink = {
    snapshot: (m) => log.push(m.data),
    output: (data) => log.push(data),
    size: (m) => log.push(`size ${m.cols}x${m.rows} ${m.owner}`),
  };
  const feed = new TerminalFeed(stream, SESSION, sink, visible);
  return { stream, log, feed };
}

describe('judgeSeq', () => {
  it('還沒收到快照的 output 一律丟棄', () => {
    expect(judgeSeq(null, 1)).toBe('drop');
  });

  it('區分舊資料、連續與跳號', () => {
    expect(judgeSeq(5, 4)).toBe('drop');
    expect(judgeSeq(5, 5)).toBe('drop');
    expect(judgeSeq(5, 6)).toBe('write');
    expect(judgeSeq(5, 7)).toBe('gap');
  });
});

describe('TerminalFeed', () => {
  it('寫入快照，丟棄 seq 小於等於快照的 output', () => {
    const { stream, log, feed } = setup();
    feed.start();
    stream.output(4);
    stream.snapshot(5);
    stream.output(4);
    stream.output(5);
    stream.output(6);
    expect(log).toEqual(['snap@5', 'out@6']);
    expect(stream.subscribes).toBe(1);
  });

  it('發現跳號就退訂再重新訂閱，舊資料不寫入', () => {
    const { stream, log, feed } = setup();
    feed.start();
    stream.snapshot(1);
    stream.output(3);
    expect(stream.unsubscribes).toBe(1);
    expect(stream.subscribes).toBe(2);
    expect(log).toEqual(['snap@1']);

    // 新快照到之前，在途的 output 都不算跳號
    stream.output(4);
    expect(stream.subscribes).toBe(2);
    stream.snapshot(4);
    stream.output(5);
    expect(log).toEqual(['snap@1', 'snap@4', 'out@5']);
  });

  it('舊訂閱晚到的訊息被忽略', () => {
    const { stream, log, feed } = setup();
    feed.start();
    const stale = stream.listener!;
    stream.snapshot(1);
    stream.output(5);
    stream.snapshot(5);
    stale({ type: 'terminal.output', sessionId: SESSION, seq: 6, data: 'stale' });
    expect(log).toEqual(['snap@1', 'snap@5']);
  });

  it('subscribe 同步回快照時也能正常退訂', () => {
    const { stream, feed, log } = setup();
    stream.syncSnapshotSeq = 2;
    feed.start();
    expect(log).toEqual(['snap@2']);
    feed.stop();
    expect(stream.unsubscribes).toBe(1);
  });

  it('其他 session 的訊息不寫入', () => {
    const { stream, log, feed } = setup();
    feed.start();
    stream.snapshot(1);
    stream.output(2, 'other', 's-2');
    expect(log).toEqual(['snap@1']);
  });

  it('stop 之後不再寫入', () => {
    const { stream, log, feed } = setup();
    feed.start();
    stream.snapshot(1);
    feed.stop();
    stream.output(2);
    expect(log).toEqual(['snap@1']);
    expect(stream.unsubscribes).toBe(1);
  });

  it('看不見時累積，重新可見時依序補上，且不退訂', () => {
    const { stream, log, feed } = setup();
    feed.start();
    stream.snapshot(1);
    feed.setVisible(false);
    stream.output(2, 'a');
    stream.output(3, 'b');
    expect(log).toEqual(['snap@1']);
    expect(stream.unsubscribes).toBe(0);

    feed.setVisible(true);
    expect(log).toEqual(['snap@1', 'ab']);
    feed.setVisible(true);
    expect(log).toEqual(['snap@1', 'ab']);
  });

  it('一開始就看不見：快照也先累積', () => {
    const { stream, log, feed } = setup(false);
    feed.start();
    stream.snapshot(1);
    stream.output(2, 'a');
    expect(log).toEqual([]);
    feed.setVisible(true);
    expect(log).toEqual(['snap@1', 'a']);
  });

  it('看不見時收到新快照，先前累積的作廢', () => {
    const { stream, log, feed } = setup(false);
    feed.start();
    stream.snapshot(1);
    stream.output(2, 'old');
    stream.snapshot(9);
    stream.output(10, 'new');
    feed.setVisible(true);
    expect(log).toEqual(['snap@9', 'new']);
  });

  it('累積超過上限就丟掉，重新可見時改拿新快照', () => {
    const { stream, log, feed } = setup();
    feed.start();
    stream.snapshot(1);
    feed.setVisible(false);
    stream.output(2, 'x'.repeat(HIDDEN_BUFFER_LIMIT));
    stream.output(3, 'y');
    stream.output(4, 'z');
    expect(stream.subscribes).toBe(1);

    feed.setVisible(true);
    expect(stream.subscribes).toBe(2);
    expect(log).toEqual(['snap@1']);
    stream.snapshot(4);
    expect(log).toEqual(['snap@1', 'snap@4']);
  });

  it('尺寸訊息不受 seq 與可見性影響，看不見時也立刻交給終端機', () => {
    const { stream, log, feed } = setup(false);
    feed.start();
    stream.snapshot(1);
    stream.listener?.({
      type: 'terminal.size',
      sessionId: SESSION,
      cols: 90,
      rows: 30,
      owner: 'other',
    });
    stream.listener?.({
      type: 'terminal.size',
      sessionId: 'someone-else',
      cols: 1,
      rows: 1,
      owner: 'you',
    });
    expect(log).toEqual(['size 90x30 other']);
    feed.setVisible(true);
    expect(log).toEqual(['size 90x30 other', 'snap@1']);
  });
});
