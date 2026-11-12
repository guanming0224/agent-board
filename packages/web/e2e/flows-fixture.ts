// flows e2e 共用的 test：每個測試自動收集瀏覽器的 console error 與未捕捉的例外，測試結束時一個都不能有。
// 起因：11/9 起 flows 跑的時候 SessionNode 被 ErrorBoundary 接住（codeClass 讀到 undefined），一直沒人發現。
// 測試裡故意觸發的錯誤用 `consoleErrors.allow(/…/)` 放行。
import { expect, test as base } from '@playwright/test';

interface ConsoleGuard {
  allow(pattern: RegExp): void;
}

export const test = base.extend<{ consoleErrors: ConsoleGuard }>({
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      const allowed: RegExp[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
      });
      page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
      await use({ allow: (pattern) => allowed.push(pattern) });
      const unexpected = errors.filter((e) => !allowed.some((pattern) => pattern.test(e)));
      expect(unexpected, '瀏覽器 console 不應該有 error').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
export type { Page, TestInfo } from '@playwright/test';
