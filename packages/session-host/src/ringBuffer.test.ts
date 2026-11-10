import { describe, expect, it } from 'vitest';
import { RingBuffer } from './ringBuffer';

const text = (chunks: { data: Buffer }[]) => Buffer.concat(chunks.map((c) => c.data)).toString();

describe('RingBuffer', () => {
  it('序號以位元組計，從 0 開始', () => {
    const buffer = new RingBuffer(100);
    expect(buffer.append(Buffer.from('abc'))).toBe(0);
    expect(buffer.append(Buffer.from('中'))).toBe(3); // 3 個位元組
    expect(buffer.seqStart).toBe(0);
    expect(buffer.seqEnd).toBe(6);
    expect(text(buffer.readFrom(0).chunks)).toBe('abc中');
  });

  it('超過上限丟最舊的整塊，seqStart 往前推；要的位置被丟掉時回報缺多少', () => {
    const buffer = new RingBuffer(10);
    buffer.append(Buffer.from('aaaa')); // 0–3
    buffer.append(Buffer.from('bbbb')); // 4–7
    buffer.append(Buffer.from('cccc')); // 8–11 → 丟掉 aaaa
    expect(buffer.seqStart).toBe(4);
    expect(buffer.seqEnd).toBe(12);
    expect(buffer.size).toBe(8);
    const result = buffer.readFrom(0);
    expect(result.lostBytes).toBe(4);
    expect(text(result.chunks)).toBe('bbbbcccc');
  });

  it('從塊的中間讀：只給後半；讀到最新之後是空的', () => {
    const buffer = new RingBuffer(100);
    buffer.append(Buffer.from('hello'));
    buffer.append(Buffer.from('world'));
    const result = buffer.readFrom(7);
    expect(result.lostBytes).toBe(0);
    expect(result.chunks[0]!.seq).toBe(7);
    expect(text(result.chunks)).toBe('rld');
    expect(buffer.readFrom(10).chunks).toEqual([]);
  });

  it('單一塊比上限還大：只留最後 capacity 個位元組', () => {
    const buffer = new RingBuffer(4);
    buffer.append(Buffer.from('xy'));
    buffer.append(Buffer.from('0123456789'));
    expect(buffer.seqStart).toBe(8);
    expect(buffer.seqEnd).toBe(12);
    expect(text(buffer.readFrom(8).chunks)).toBe('6789');
    expect(buffer.readFrom(0).lostBytes).toBe(8);
  });

  it('2 MB 上限下大量輸出：記憶體不超過上限、最新的內容都在', () => {
    const capacity = 2 * 1024 * 1024;
    const buffer = new RingBuffer(capacity);
    const line = Buffer.from(`${'x'.repeat(1023)}\n`);
    for (let i = 0; i < 5_000; i += 1) buffer.append(line);
    expect(buffer.size).toBeLessThanOrEqual(capacity);
    expect(buffer.seqEnd).toBe(5_000 * 1024);
    expect(buffer.seqEnd - buffer.seqStart).toBe(buffer.size);
  });

  it('空資料不動序號', () => {
    const buffer = new RingBuffer(4);
    expect(buffer.append(Buffer.alloc(0))).toBe(0);
    expect(buffer.seqEnd).toBe(0);
  });
});
