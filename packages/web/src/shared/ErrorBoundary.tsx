// 畫面出錯時的錯誤畫面（GM 2026-11-08：以前一出錯整頁空白，看不出原因）。
// 刻意不用 useT 與 store 的資料：出錯的可能就是它們。語言只讀目前的語言設定，讀不到就看瀏覽器。
// 換頁（hashchange）就重試一次，所以一頁壞掉時還能切去別頁。
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { markBooted } from './boot';
import { useLocale } from './i18n';

const TEXT = {
  zh: {
    title: '這個畫面出錯了',
    body: '其他 session 不受影響。可以重新載入，或先切到待處理。把下面的細節複製給 Claude 就能查原因。',
    reload: '重新載入',
    inbox: '回待處理',
    copy: '複製錯誤細節',
    copied: '已複製',
  },
  en: {
    title: 'This screen hit an error',
    body: 'Your sessions are not affected. Reload, or go to the inbox for now. Copy the details below to find the cause.',
    reload: 'Reload',
    inbox: 'Go to inbox',
    copy: 'Copy error details',
    copied: 'Copied',
  },
};

function text() {
  let lang: string;
  try {
    lang = useLocale.getState().locale;
  } catch {
    lang = navigator.language || '';
  }
  return /^zh/i.test(lang) ? TEXT.zh : TEXT.en;
}

interface State {
  error: Error | null;
  componentStack: string;
  copied: boolean;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null, componentStack: '', copied: false };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(_error: unknown, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? '' });
    // 錯誤畫面本身就是給人看的畫面，開機檢查不用再蓋上來。
    markBooted();
  }

  override componentDidMount(): void {
    addEventListener('hashchange', this.reset);
  }

  override componentWillUnmount(): void {
    removeEventListener('hashchange', this.reset);
  }

  private reset = () => {
    if (this.state.error) this.setState({ error: null, componentStack: '', copied: false });
  };

  private details(): string {
    const { error, componentStack } = this.state;
    return [
      location.href,
      navigator.userAgent,
      new Date().toISOString(),
      `${error?.name}: ${error?.message}`,
      error?.stack ?? '',
      componentStack.trim(),
    ]
      .filter(Boolean)
      .join('\n');
  }

  private copy = () => {
    void navigator.clipboard?.writeText(this.details()).then(() => this.setState({ copied: true }));
  };

  override render(): ReactNode {
    const { error, copied } = this.state;
    if (!error) return this.props.children;
    const t = text();
    return (
      <main className="error-screen" role="alert" data-testid="error-screen">
        <h1>{t.title}</h1>
        <p>{t.body}</p>
        <div className="error-actions">
          <button type="button" onClick={() => location.reload()}>
            {t.reload}
          </button>
          <button type="button" onClick={() => (location.hash = '#/inbox')}>
            {t.inbox}
          </button>
          <button type="button" onClick={this.copy}>
            {copied ? t.copied : t.copy}
          </button>
        </div>
        <pre data-testid="error-details">{`${error.name}: ${error.message}\n\n${this.details()}`}</pre>
      </main>
    );
  }
}
