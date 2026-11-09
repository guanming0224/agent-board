// 深層搜尋的 worker（worker_threads）：在這裡讀對話紀錄 JSONL、切行、JSON 解析、比對、遮蔽，
// daemon 主執行緒只等結果（PTY 轉送、hub 連線不會被大檔解析卡住）。程式和主執行緒共用 deepScan.ts。
// 取消、讓位、時間與讀檔量上限都在 SharedBudget（SharedArrayBuffer）裡，主執行緒改了下一塊就看得到。
// 只讀檔、只回片段給主執行緒；不對外連線、不開行程。
import { parentPort } from 'node:worker_threads';
import { scanTranscriptFile, SharedBudget } from './deepScan';
import type { ScanJob, ScanReply } from './deepScanPool';

const port = parentPort;
if (!port) throw new Error('deepSearchWorker 只能當 worker 跑');

port.on('message', (job: ScanJob) => {
  void (async () => {
    let reply: ScanReply;
    try {
      const scan = await scanTranscriptFile(job.file, job.sessionId, {
        terms: job.terms,
        mask: job.mask,
        sinceMs: job.sinceMs,
        maxHits: job.maxHits,
        budget: new SharedBudget(job.control),
        now: Date.now,
      });
      reply = { type: 'scan', id: job.id, ok: true, scan };
    } catch (error) {
      reply = {
        type: 'scan',
        id: job.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    port.postMessage(reply);
  })();
});

// 載入完成（import 都成功）才回 ready：主執行緒靠這個分辨「worker 根本起不來」和「跑到一半壞掉」。
port.postMessage({ type: 'ready' } satisfies ScanReply);
