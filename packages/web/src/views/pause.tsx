// 全部暫停（P2 項目三，docs/p2-spec.md §3）：畫布底部的浮動指令列、暫停中的提示列、手機收件匣的暫停鈕。
// 狀態在 hub（board.state.pause／board.pause），每個 client 即時同步；這裡只畫與送 REST。
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { create } from 'zustand';
import {
  NOT_PAUSED,
  type BoardInterruptResult,
  type BoardPauseMode,
  type BoardPauseState,
} from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { closeRight, useOverlay } from './overlayStore';
import { teamHash } from './overlay';
import {
  heldParts,
  interruptText,
  notSentNames,
  releasedText,
  releaseText,
  runningCount,
} from './pauseText';
import { useClock } from './session';
import { errorText } from './useBoardLoad';
import { useViewsUi } from './uiStore';
import './messages';

/** 「立刻中斷」按兩次的時限（規格 §3.3：3 秒內再按才執行）。 */
const ARM_MS = 3000;
/** 兩下太快（連點、手抖）不算第二下。 */
const ARM_MIN_GAP_MS = 350;

interface PauseUi {
  busy: boolean;
  /** 操作結果，緊貼按鈕顯示（STYLE 邏輯 7）。 */
  msg: { text: string; tone: 'ok' | 'err' } | null;
  /**
   * 這個瀏覽器最近一次「立刻中斷」的結果（只有按的人拿得到）。暫停中一直留在提示列，
   * 失聯、daemon 太舊沒送到的 session 要自己處理；繼續後清掉。
   */
  lastInterrupt: BoardInterruptResult[] | null;
}

export const usePauseUi = create<PauseUi>(() => ({ busy: false, msg: null, lastInterrupt: null }));

export function usePauseState(): BoardPauseState {
  return useBoard((s) => s.pause) ?? NOT_PAUSED;
}

function usePauseActions() {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const pause = async (mode: BoardPauseMode) => {
    if (usePauseUi.getState().busy) return;
    usePauseUi.setState({ busy: true, msg: null });
    try {
      const { interrupted } = await backend.pauseBoard(mode);
      usePauseUi.setState({
        msg: {
          text:
            mode === 'interrupt'
              ? t('views.pause.done.interrupt', { result: interruptText(interrupted, t) })
              : t('views.pause.done.finishTurn'),
          tone: 'ok',
        },
        lastInterrupt: mode === 'interrupt' ? interrupted : usePauseUi.getState().lastInterrupt,
      });
    } catch (e) {
      usePauseUi.setState({
        msg: { text: t('views.pause.error.pause', { detail: errorText(e) }), tone: 'err' },
      });
    } finally {
      usePauseUi.setState({ busy: false });
    }
  };
  const resume = async () => {
    if (usePauseUi.getState().busy) return;
    usePauseUi.setState({ busy: true, msg: null });
    try {
      const { released } = await backend.resumeBoard();
      usePauseUi.setState({
        msg: { text: releasedText(released, t), tone: 'ok' },
        lastInterrupt: null,
      });
    } catch (e) {
      usePauseUi.setState({
        msg: { text: t('views.pause.error.resume', { detail: errorText(e) }), tone: 'err' },
      });
    } finally {
      usePauseUi.setState({ busy: false });
    }
  };
  return { pause, resume };
}

/** 按兩次：第一次只「上膛」，ARM_MS 內再按一次才執行。 */
function useArm() {
  const [armedAt, setArmedAt] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const disarm = useCallback(() => {
    clearTimeout(timer.current);
    setArmedAt(null);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  const press = (action: () => void) => {
    const now = Date.now();
    if (armedAt === null) {
      setArmedAt(now);
      timer.current = setTimeout(() => setArmedAt(null), ARM_MS);
      return;
    }
    if (now - armedAt < ARM_MIN_GAP_MS) return;
    disarm();
    action();
  };
  return { armed: armedAt !== null, press, disarm };
}

/**
 * 「全部暫停 ▾」與它的兩個選項。(a) 做完這輪就停按一次；(b) 立刻中斷全部（Esc）按兩次（Q7）。
 * 暫停中按鈕呈按下狀態並寫出模式，仍可打開選單改模式（例如從 (a) 升級成 (b)）。
 */
export function PauseMenu({ phone = false }: { phone?: boolean }) {
  const t = useT();
  const { paused } = usePauseState();
  const busy = usePauseUi((s) => s.busy);
  const running = useBoard((s) => runningCount(s.sessions));
  const { pause } = usePauseActions();
  const [open, setOpen] = useState(false);
  const arm = useArm();
  const box = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  // 只依賴穩定的 disarm：不然每次 render 都會把 window 上的監聽拆掉重裝。
  const { disarm } = arm;
  const close = useCallback(() => {
    setOpen(false);
    disarm();
  }, [disarm]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 只關這個選單，不讓 App 順手關掉右側面板。
      e.preventDefault();
      close();
      toggle.current?.focus();
    };
    addEventListener('pointerdown', onDown);
    addEventListener('keydown', onKey);
    return () => {
      removeEventListener('pointerdown', onDown);
      removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  const choose = (mode: BoardPauseMode) => {
    if (mode === 'finish_turn') {
      close();
      void pause(mode);
      return;
    }
    arm.press(() => {
      close();
      void pause(mode);
    });
  };

  const label = paused
    ? t('views.pause.pausedButton', { mode: t(`views.pause.mode.${paused.mode}`) })
    : t('views.pause.button');

  return (
    <div className={`pause-menu${phone ? ' phone' : ''}`} ref={box}>
      <button
        ref={toggle}
        type="button"
        className="pause-toggle"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-pressed={paused !== null}
        disabled={busy}
        onClick={() => (open ? close() : setOpen(true))}
        data-testid="pause-button"
      >
        <span aria-hidden="true">⏸</span> {label} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="pause-options" id={menuId} data-testid="pause-menu">
          <button
            type="button"
            aria-pressed={paused?.mode === 'finish_turn'}
            disabled={busy}
            onClick={() => choose('finish_turn')}
            data-testid="pause-finish-turn"
          >
            <b>{t('views.pause.mode.finish_turn')}</b>
            <span className="sub">{t('views.pause.finishTurnHint')}</span>
          </button>
          <button
            type="button"
            aria-pressed={paused?.mode === 'interrupt'}
            className={arm.armed ? 'danger' : undefined}
            disabled={busy}
            onClick={() => choose('interrupt')}
            data-testid="pause-interrupt"
          >
            <b>
              {arm.armed
                ? t('views.pause.interruptConfirm', { n: running })
                : t('views.pause.interruptOption')}
            </b>
            <span className="sub">{t('views.pause.interruptHint')}</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** 「▶ 全部繼續」：沒暫停時停用；暫停中旁邊一直顯示「會放出：…」（按之前就知道會放出什麼，Q8 不自動送「繼續」）。 */
export function ResumeButton({ showRelease = true }: { showRelease?: boolean }) {
  const t = useT();
  const { paused, held } = usePauseState();
  const busy = usePauseUi((s) => s.busy);
  const { resume } = usePauseActions();
  const release = releaseText(held, t);
  return (
    <>
      <button
        type="button"
        className="resume-btn"
        disabled={paused === null || busy}
        title={paused ? `${release}${t('views.pause.resumeHint')}` : t('views.pause.notPaused')}
        onClick={() => void resume()}
        data-testid="resume-button"
      >
        <span aria-hidden="true">▶</span> {t('views.pause.resume')}
      </button>
      {showRelease && paused && (
        <span className="release" data-testid="resume-release">
          {release}
        </span>
      )}
    </>
  );
}

function PauseMsg() {
  const msg = usePauseUi((s) => s.msg);
  useEffect(() => {
    if (!msg || msg.tone === 'err') return;
    const timer = setTimeout(() => usePauseUi.setState({ msg: null }), 8000);
    return () => clearTimeout(timer);
  }, [msg]);
  if (!msg) return null;
  return (
    <span
      className={`msg ${msg.tone}`}
      role={msg.tone === 'err' ? 'alert' : 'status'}
      data-testid="pause-msg"
    >
      {msg.text}
    </span>
  );
}

/**
 * 暫停中一直看得到的提示列（規格 §3.3）：中性色，不用狀態色。
 * 「⏸ 已暫停（做完這輪就停）・排隊送字 2 則・14:02 起　［全部繼續］」，下面補 hub 重啟清掉的排隊數與沒送到的中斷。
 */
export function PauseStrip({ withResume = true }: { withResume?: boolean }) {
  const t = useT();
  const clock = useClock();
  const { paused, held } = usePauseState();
  const lastInterrupt = usePauseUi((s) => s.lastInterrupt);
  // 暫停解除（不論是誰按的）就清掉這台記著的中斷結果。
  useEffect(() => {
    if (!paused && usePauseUi.getState().lastInterrupt) {
      usePauseUi.setState({ lastInterrupt: null });
    }
  }, [paused]);
  if (!paused) return null;
  const queued = heldParts(held, t);
  const missed = lastInterrupt ? notSentNames(lastInterrupt) : [];
  return (
    <div className="pause-strip" role="status" data-testid="pause-strip">
      <div className="pause-line">
        <span className="pause-what">
          <span aria-hidden="true">⏸ </span>
          {t('views.pause.strip', { mode: t(`views.pause.mode.${paused.mode}`) })}
        </span>
        <span className="pause-held" data-testid="pause-held">
          {queued ? t('views.pause.queued', { parts: queued }) : t('views.pause.queuedNone')}
        </span>
        <span className="pause-since" title={new Date(paused.since).toLocaleString()}>
          {paused.byName
            ? t('views.pause.sinceBy', { time: clock(paused.since), name: paused.byName })
            : t('views.pause.since', { time: clock(paused.since) })}
        </span>
        {held.sessionsWaiting > 0 && (
          <span className="pause-sub" title={t('views.pause.sessionsWaitingHint')}>
            {t('views.pause.sessionsWaiting', { n: held.sessionsWaiting })}
          </span>
        )}
        {withResume && (
          <span className="pause-act">
            <ResumeButton showRelease={false} />
          </span>
        )}
      </div>
      {paused.clearedOnRestart > 0 && (
        <p className="pause-note" data-testid="pause-cleared">
          {t('views.pause.cleared', { n: paused.clearedOnRestart })}
        </p>
      )}
      {lastInterrupt && (
        <p className="pause-note" data-testid="pause-interrupt-result">
          {interruptText(lastInterrupt, t)}
          {missed.length > 0 &&
            t('views.pause.notSent', { names: missed.join(t('views.pause.held.sep')) })}
        </p>
      )}
    </div>
  );
}

/**
 * 「群組」：開右側團隊面板的清單模式（#/team：目前工作區的團隊、等你數，可切全部工作區；點一列進名單＋群發）。
 * 清單開著再按＝收起；正在看某個團隊的名單時按＝回到清單。
 */
function toggleTeams() {
  const right = useOverlay.getState().right;
  if (right?.kind === 'team' && right.teamId === null) closeRight();
  else location.hash = teamHash();
}

/**
 * 畫布底部置中的浮動指令列（桌面；手機沒有）：
 * `[＋ 新增 session] [群組] │ [⏸ 全部暫停 ▾] [▶ 全部繼續]`。Presets、Memory 本輪不顯示（Q9）。
 */
export function CommandBar() {
  const t = useT();
  const teamOpen = useOverlay((s) => s.right?.kind === 'team' && s.right.teamId === null);
  const inset = useViewsUi((s) => s.rightInset);
  const openNew = (full: boolean) => {
    const open = useViewsUi.getState().openQuickCreate;
    if (open && !full) open();
    else location.hash = '#/new';
  };
  return (
    <div
      className="command-dock"
      // 右側面板開著時置中在看得到的那一塊。
      style={inset > 0 ? { right: inset } : undefined}
    >
      <div
        className="command-bar"
        role="toolbar"
        aria-label={t('views.command.aria')}
        data-testid="command-bar"
      >
        <button
          type="button"
          title={t('views.command.newHint')}
          onClick={(e) => openNew(e.shiftKey)}
          data-testid="command-new"
        >
          <span aria-hidden="true">＋</span> {t('views.newSession')}
        </button>
        <button
          type="button"
          aria-pressed={teamOpen}
          title={t('views.command.teamsHint')}
          onClick={toggleTeams}
          data-testid="command-teams"
        >
          {t('views.command.teams')}
        </button>
        <span className="command-sep" aria-hidden="true" />
        <PauseMenu />
        <ResumeButton />
      </div>
      <PauseMsg />
    </div>
  );
}

/** 手機收件匣頂部：暫停狀態列＋兩顆大按鈕（≥ 56px）。這是手機上唯一會影響全部 session 的按鈕，(b) 同樣按兩次。 */
export function PhonePauseControls() {
  const t = useT();
  return (
    <section
      className="phone-pause"
      aria-label={t('views.pause.phoneAria')}
      data-testid="phone-pause"
    >
      <PauseStrip withResume={false} />
      <div className="phone-pause-row">
        <PauseMenu phone />
        <ResumeButton />
      </div>
      <PauseMsg />
    </section>
  );
}
