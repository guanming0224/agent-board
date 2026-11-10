// 路由（P2 §1）：畫布是唯一主畫面且常駐，收件匣、團隊、Memory（P3）是右側面板（互斥），設定、封存細節、完整新增表單是
// 置中次畫面，可疊在右側面板之上。全尺寸終端機、登入、首次引導仍是整頁。手機（≤ 640px）的收件匣、團隊、
// 設定是全螢幕頁。網址規則在 views/overlay.ts。
import { useEffect, useState, type ReactNode } from 'react';
import { CanvasPage, InboxDrawer, TerminalPage } from './canvas';
import {
  ArchivePage,
  InboxPage,
  LoginPage,
  NewSessionPage,
  OnboardingPage,
  SettingsPage,
  TranscriptPage,
} from './flows';
import { applyAccountLocale } from './flows/locale';
import { MemoryContent, MemoryDrawer } from './progress';
import { markBooted } from './shared/boot';
import { useT } from './shared/i18n';
import { isDemo, useBoard } from './shared/store';
import { isSearchShortcut, SearchPanel } from './search';
import { TeamContent, TeamDrawer } from './team';
import { MachinesPage } from './machines';
import { UsagePage } from './usage';
import {
  cameFrom,
  closeModal,
  closeRight,
  isSearchHash,
  markHistory,
  openSearch,
  replaceHash,
  resolve,
  toggleInbox,
  useOverlay,
  useViewsUi,
  type ModalKind,
  type RightPanel,
} from './views';
import { ModalLayer, PhonePage } from './views/Overlays';
import { PHONE_QUERY, PHONE_WIDTH } from './shared/breakpoints';

const PUBLIC_PAGES = new Set(['login', 'onboarding']);

function hashOf(url: string): string {
  try {
    return new URL(url).hash;
  } catch {
    return '';
  }
}

function isPhone(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia(PHONE_QUERY).matches;
}

function usePhone(): boolean {
  const [phone, setPhone] = useState(isPhone);
  useEffect(() => {
    const query = matchMedia(PHONE_QUERY);
    const onChange = () => setPhone(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return phone;
}

/** 打字中（含終端機 xterm 的 textarea）：Esc 與 I 交給它，不關面板（Esc 在終端機是中斷 Claude）。 */
function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.closest('input, textarea, select, .xterm, [role="textbox"]') !== null)
  );
}

interface Nav {
  hash: string;
  right: RightPanel | null;
  /** 每次網址變一次：同一個 #/inbox/<id> 再送一次（推播點兩次）也要重新捲到那一項。 */
  nonce: number;
}

/**
 * 舊網址換成新網址（replace，不留歷史）。畫面不靠換網址送出的 hashchange 更新：呼叫端換完自己讀
 * location.hash；畫面那邊遇到 redirect 也直接畫目標畫面（見 App 的 effective）。
 */
function redirect(hash: string): void {
  const { view } = resolve(hash, null);
  if (view.kind !== 'redirect') return;
  // 從 #/queue 來的這一次切到依組別；不改使用者記住的排序（Q1 的偏好只由排序鈕改）。
  if (view.inboxSort) useViewsUi.getState().showInboxSort(view.inboxSort);
  replaceHash(view.to);
}

/** 舊網址直接當目標網址看：轉址事件沒送到也不會停在空白畫面。 */
function effectiveHash(hash: string): string {
  const { view } = resolve(hash, null);
  return view.kind === 'redirect' ? view.to : hash;
}

function ModalContent({ kind }: { kind: ModalKind }) {
  if (kind === 'settings') return <SettingsPage />;
  if (kind === 'archive') return <ArchivePage />;
  if (kind === 'search') return <SearchPanel />;
  if (kind === 'transcript') return <TranscriptPage />;
  if (kind === 'usage') return <UsagePage />;
  if (kind === 'machines') return <MachinesPage />;
  return <NewSessionPage />;
}

/**
 * 次畫面的內容。搜尋結果按 ⌘Enter／⌘點擊開的對話紀錄：搜尋視窗不卸載、只藏起來（hidden），
 * 關掉對話紀錄（Esc、✕、上一頁，closeStep 會 history.back() 回 #/search?q=…）時，查詢字、快速與深層結果、
 * 展開的群組、選到的那一列都還在；深層搜尋也不會因為卸載被取消。兩者固定在同樣的位置，React 才不會重掛搜尋。
 * 刻意的取捨：藏起來的期間搜尋照常訂閱 board／遮蔽／區域，遮蔽或區域一改就在背景重算（深層會被取消重來）。
 * 不加「藏起來就暫停」，是為了回到搜尋時結果一定照目前的遮蔽與區域，不會顯示切換前的舊結果；多出的只是少量 render 與請求。
 */
function ModalStack({ modal }: { modal: ModalKind }) {
  const keepSearch = modal === 'search' || (modal === 'transcript' && isSearchHash(cameFrom()));
  return (
    <>
      {keepSearch && (
        <div className="modal-keep" hidden={modal !== 'search'} data-testid="search-keep">
          <SearchPanel />
        </div>
      )}
      {modal !== 'search' && <ModalContent kind={modal} />}
    </>
  );
}

const MODAL_LABEL: Record<ModalKind, string> = {
  settings: 'flows.settings.title',
  archive: 'flows.archived.title',
  new: 'flows.new.title',
  search: 'search.title',
  transcript: 'flows.archive.transcript',
  usage: 'usage.title',
  machines: 'machines.title',
};

/** 手機：上一筆歷史就是 app 裡的畫面就上一頁，否則回收件匣（手機的首頁）。 */
function phoneBack() {
  if (cameFrom() !== null) history.back();
  else replaceHash('#/inbox');
}

function Board({ nav, phone }: { nav: Nav; phone: boolean }) {
  const t = useT();
  const { view } = resolve(nav.hash, nav.right);
  const modal = view.kind === 'board' ? view.modal : null;
  const right = nav.right;

  // 手機（≤ 640px）：收件匣、團隊、設定、新增都是全螢幕頁；畫布只有開 #/canvas 時才有。
  if (phone) {
    if (modal) {
      return (
        <PhonePage onBack={phoneBack} testId={`phone-${modal}`}>
          <ModalStack modal={modal} />
        </PhonePage>
      );
    }
    if (right?.kind === 'inbox') return <InboxPage />;
    if (right?.kind === 'team') {
      return (
        <PhonePage onBack={phoneBack} testId="phone-team">
          <div className="phone-team">
            <TeamContent teamId={right.teamId} frameOnCanvas={false} />
          </div>
        </PhonePage>
      );
    }
    if (right?.kind === 'memory') {
      return (
        <PhonePage onBack={phoneBack} testId="phone-memory">
          <MemoryContent phone />
        </PhonePage>
      );
    }
    return <CanvasPage />;
  }

  return (
    <>
      {/* 畫布永遠掛著（開面板不卸載，終端機不重連）；次畫面開著時整層 inert，焦點不會跑到背後。 */}
      <div className="board-layer" inert={modal !== null}>
        <CanvasPage />
        {right?.kind === 'inbox' && <InboxDrawer target={right.target} nonce={nav.nonce} />}
        {right?.kind === 'team' && <TeamDrawer teamId={right.teamId} />}
        {right?.kind === 'memory' && <MemoryDrawer />}
      </div>
      {modal && (
        <ModalLayer
          label={t(MODAL_LABEL[modal])}
          onClose={closeModal}
          testId="modal"
          className={modal === 'search' ? 'search-modal' : undefined}
        >
          <ModalStack modal={modal} />
        </ModalLayer>
      )}
    </>
  );
}

export function App() {
  // nav.hash 一律是轉址後的網址，所以畫面永遠不會是「轉址中」的空白。
  const [nav, setNav] = useState<Nav>(() => ({
    hash: effectiveHash(location.hash),
    right: resolve(effectiveHash(location.hash), null).right,
    nonce: 0,
  }));
  const [checked, setChecked] = useState(isDemo);
  const backend = useBoard((s) => s.backend);
  const phone = usePhone();

  useEffect(() => {
    if (!location.hash && innerWidth <= PHONE_WIDTH) replaceHash('#/inbox');
    // 開頁的這一筆沒有「上一筆」：關面板時用 replace，不會上一頁跳出 app。
    markHistory(null);
    // 先接 hashchange 再解析開頁的網址：開頁就是舊網址時，轉址送出的事件才有人接。
    // 轉址那條路自己也更新畫面，不靠那個事件（正式版沒有 StrictMode 的重跑可以救）。
    const onChange = (e?: HashChangeEvent) => {
      if (e) markHistory(hashOf(e.oldURL));
      redirect(location.hash);
      const hash = effectiveHash(location.hash);
      setNav((prev) => ({
        hash,
        right: resolve(hash, prev.right).right,
        nonce: prev.nonce + 1,
      }));
    };
    addEventListener('hashchange', onChange);
    onChange();
    return () => removeEventListener('hashchange', onChange);
  }, []);

  // 頁首、收件匣的開關從這裡讀現在開著什麼。
  const { view } = resolve(nav.hash, nav.right);
  const modal = view.kind === 'board' ? view.modal : null;
  const onBoard = view.kind === 'board';
  useEffect(() => {
    useOverlay.setState({ right: onBoard ? nav.right : null, modal });
  }, [nav.right, modal, onBoard]);

  // Esc 只關最上層；I 開關收件匣；⌘K、/ 開搜尋。打字中（終端機、輸入框）一律不攔。
  useEffect(() => {
    if (!onBoard || phone) return;
    const onKey = (e: KeyboardEvent) => {
      // 全域搜尋（P3 §3.3）：⌘K／Ctrl+K，或焦點不在輸入框與終端機時按 /。焦點在終端機時一律交給終端機。
      if (isSearchShortcut(e)) {
        // 開著別的次畫面（新 session、設定、封存）時不換頁：表單填到一半的內容會不見。
        const open = useOverlay.getState().modal;
        if (open && open !== 'search') return;
        e.preventDefault();
        openSearch();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing || isTyping(e.target)) return;
      if (e.key === 'Escape') {
        // 等別的元件先處理（卡片選單、快速建立、對話框會 preventDefault），沒人處理才關面板。
        setTimeout(() => {
          if (e.defaultPrevented) return;
          const { modal: open, right } = useOverlay.getState();
          if (open) closeModal();
          else if (right) closeRight();
        }, 0);
      } else if ((e.key === 'i' || e.key === 'I') && !e.shiftKey) {
        if (useOverlay.getState().modal) return;
        e.preventDefault();
        toggleInbox();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onBoard, phone]);

  useEffect(() => {
    if (isDemo) return;
    let cancelled = false;
    void (async () => {
      try {
        const user = (await backend.needsSetup()) ? undefined : await backend.currentUser();
        if (user === undefined) location.hash = '#/onboarding';
        else if (!user) location.hash = '#/login';
        else {
          // 已登入：畫面用帳號的語言（只在開頁時套一次，之後切換由頁首／設定頁負責）。
          if (!cancelled) applyAccountLocale(user);
          const now = resolve(location.hash, null).view;
          if (now.kind === 'page' && PUBLIC_PAGES.has(now.page)) location.hash = '#/canvas';
        }
      } catch {
        // hub 連不上時停在登入頁，那裡會說明怎麼辦。
        location.hash = '#/login';
      }
      if (!cancelled) setChecked(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [backend]);

  // 確認完登入、要畫第一個畫面了：告訴開機檢查不用跳說明（flows/pwa/boot-check.js）。
  useEffect(() => {
    if (checked) markBooted();
  }, [checked]);

  if (!checked) return null;

  let content: ReactNode;
  if (view.kind === 'page') {
    content =
      view.page === 'terminal' ? (
        <TerminalPage />
      ) : view.page === 'login' ? (
        <LoginPage />
      ) : (
        <OnboardingPage />
      );
  } else {
    content = <Board nav={nav} phone={phone} />;
  }
  return content;
}
