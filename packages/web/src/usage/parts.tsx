// 用量詳情共用的小元件（期間切換、四項拆開、分布）：每日（7／30／90 天）與「全部」期間共用。
import { useLocale, useT } from '../shared/i18n';
import { formatTokens, formatTokensFull } from '../views/usage';
import { allTokens, TOKEN_KINDS, type Counts, type Share } from './model';

export function Seg<V extends string | number>({
  label,
  value,
  options,
  onChange,
  testId,
}: {
  label: string;
  value: V;
  options: readonly { value: V; label: string }[];
  onChange: (v: V) => void;
  testId: string;
}) {
  return (
    <div className="usage-control">
      <span className="usage-control-label">{label}</span>
      <div className="seg sm" role="group" aria-label={label} data-testid={testId}>
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={o.value === value}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Breakdown({ counts }: { counts: Counts }) {
  const t = useT();
  const { locale } = useLocale();
  return (
    <dl className="usage-breakdown">
      {TOKEN_KINDS.map((k) => (
        <div key={k}>
          <dt>{t(`usage.kind.${k}`)}</dt>
          <dd className="num" title={formatTokensFull(counts[k], locale)}>
            {formatTokens(counts[k], locale)}
          </dd>
        </div>
      ))}
      <div className="usage-breakdown-all">
        <dt>{t('usage.all')}</dt>
        <dd className="num" title={formatTokensFull(allTokens(counts), locale)}>
          {formatTokens(allTokens(counts), locale)}
        </dd>
      </div>
    </dl>
  );
}

export function Shares({
  title,
  shares,
  testId,
  labelOf,
  caption,
}: {
  title: string;
  shares: readonly Share[];
  testId: string;
  labelOf: (s: Share) => string;
  caption: string;
}) {
  const t = useT();
  const { locale } = useLocale();
  const total = shares.reduce((a, s) => a + s.value, 0);
  const max = Math.max(1, ...shares.map((s) => s.value));
  return (
    <section className="usage-card" data-testid={testId}>
      <h3>
        {title}
        <span className="usage-caption">{caption}</span>
      </h3>
      {shares.length === 0 ? (
        <p className="empty">{t('usage.rank.empty')}</p>
      ) : (
        <ul className="usage-shares">
          {shares.map((s) => {
            const pct = total > 0 ? Math.round((s.value / total) * 100) : 0;
            return (
              <li key={s.key} title={formatTokensFull(s.value, locale)}>
                <span className="usage-share-label">{labelOf(s)}</span>
                <span className="usage-share-value num">
                  {formatTokens(s.value, locale)}
                  <span className="hint-inline"> {t('usage.share.pct', { pct })}</span>
                </span>
                <span className="usage-meter" aria-hidden="true">
                  <span style={{ width: `${(s.value / max) * 100}%` }} />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
