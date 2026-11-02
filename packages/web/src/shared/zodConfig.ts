// zod 預設會試 new Function 來加速，被 hub 的 CSP 擋下會在 console 留錯誤，而我們不開 unsafe-eval。
// 判斷在定義 schema 時就做了，所以這個模組要比 @agent-board/protocol 先載入（main.tsx 第一行）。
import { z } from 'zod';

z.config({ jitless: true });
