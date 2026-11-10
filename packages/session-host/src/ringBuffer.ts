// 每個 session 的輸出環狀緩衝：保留最近 capacity 位元組的原始輸出，序號以位元組計（第一個位元組是 0）。
// 只在記憶體，不落地（對話內容不寫到磁碟，docs/session-host-spec.md §3.5）。
// 以「塊」為單位丟最舊的：PTY 給的每一塊都是完整的 UTF-8，整塊丟才不會把字切一半；
// 只有單一塊本身就超過上限時才切，切點可能落在多位元組字中間（重播時頭一個字壞掉，可接受）。

export interface BufferedChunk {
  /** 這塊第一個位元組的序號。 */
  seq: number;
  data: Buffer;
}

export interface ReadResult {
  /** 要的位置已經被丟掉的位元組數（0＝沒有缺）。 */
  lostBytes: number;
  chunks: BufferedChunk[];
}

export class RingBuffer {
  private chunks: BufferedChunk[] = [];
  private bytes = 0;
  private end = 0;

  constructor(readonly capacity: number) {
    if (!(capacity > 0)) throw new Error('緩衝上限必須大於 0');
  }

  /** 緩衝裡最舊的位元組序號。 */
  get seqStart(): number {
    return this.chunks[0]?.seq ?? this.end;
  }

  /** 到目前為止的總位元組數（下一個位元組的序號）。 */
  get seqEnd(): number {
    return this.end;
  }

  get size(): number {
    return this.bytes;
  }

  /** 加一塊，回傳它的起始序號。 */
  append(data: Buffer): number {
    const seq = this.end;
    if (data.length === 0) return seq;
    this.end += data.length;
    if (data.length >= this.capacity) {
      const keep = data.subarray(data.length - this.capacity);
      this.chunks = [{ seq: this.end - keep.length, data: Buffer.from(keep) }];
      this.bytes = keep.length;
      return seq;
    }
    this.chunks.push({ seq, data });
    this.bytes += data.length;
    while (this.bytes > this.capacity) {
      const oldest = this.chunks.shift()!;
      this.bytes -= oldest.data.length;
    }
    return seq;
  }

  /** 從 fromSeq 讀到最新。fromSeq 落在某塊中間時只給那塊的後半。 */
  readFrom(fromSeq: number): ReadResult {
    const start = this.seqStart;
    const lostBytes = fromSeq < start ? start - fromSeq : 0;
    const from = Math.max(fromSeq, start);
    const chunks: BufferedChunk[] = [];
    for (const chunk of this.chunks) {
      const chunkEnd = chunk.seq + chunk.data.length;
      if (chunkEnd <= from) continue;
      if (chunk.seq >= from) chunks.push(chunk);
      else chunks.push({ seq: from, data: chunk.data.subarray(from - chunk.seq) });
    }
    return { lostBytes, chunks };
  }
}
