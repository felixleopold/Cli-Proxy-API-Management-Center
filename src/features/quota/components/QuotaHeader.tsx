import { useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronDown, IconRefreshCw, IconSlidersHorizontal } from '@/components/ui/icons';
import { useCountUp } from '@/hooks/motion';
import styles from './QuotaHeader.module.scss';

export type QuotaHeaderProps = {
  totalCount: number;
  loadedCount: number;
  attentionCount: number;
  refreshing: boolean;
  disableControls: boolean;
  onRefreshAll: () => void;
  /** Inline controls before the refresh button (the Claude credit switch). */
  extra?: ReactNode;
  /**
   * Phones: one compact line (title, Controls, refresh) with the meta line, `extra` and
   * `panel` (the reserves) in a panel the Controls button opens.
   */
  compact?: boolean;
  panel?: ReactNode;
  /** Phones: overrides in force, shown while the panel is closed. */
  overrides?: { key: string; text: string }[];
};

/**
 * 额度页头部：标题领衔 + ▍mono 遥测 meta 行 + 墨色药丸「刷新全部」。
 * 与凭证库头部同语汇（无 eyebrow —— ▍游标挂在 meta 行开头）。
 *
 * 入场：三处 `data-reveal` 交给页面壳的 useRevealGroup 统一编排
 * （标题 0ms → meta 70ms → 动作 140ms → tabs 210ms）。
 */
export function QuotaHeader(props: QuotaHeaderProps) {
  const {
    totalCount,
    loadedCount,
    attentionCount,
    refreshing,
    disableControls,
    onRefreshAll,
    extra,
    compact,
    panel,
    overrides = [],
  } = props;
  const { t } = useTranslation();
  const panelId = useId();
  const controlsButtonRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  // 批量结果陆续落地时，「已加载」是页面上唯一滚动的数字
  const displayLoadedCount = useCountUp(loadedCount);

  const meta = (
    <p className={styles.meta} data-reveal={compact ? undefined : true}>
      <span className={styles.metaTotal}>
        {t('quota_management.meta_credentials', { count: totalCount })}
      </span>
      <span className={styles.metaDot} aria-hidden="true">
        ·
      </span>
      <span className={loadedCount > 0 ? styles.metaLoaded : styles.metaMuted}>
        {t('quota_management.meta_loaded', { count: displayLoadedCount })}
      </span>
      {attentionCount > 0 && (
        <>
          <span className={styles.metaDot} aria-hidden="true">
            ·
          </span>
          <span className={styles.metaAttention}>
            {t('quota_management.meta_attention', { count: attentionCount })}
          </span>
        </>
      )}
    </p>
  );

  if (compact) {
    return (
      <header className={styles.compact}>
        <div className={styles.compactBar}>
          <h1 className={styles.compactTitle} data-reveal>
            {t('usage.page_title')}
          </h1>
          <div className={styles.compactActions} data-reveal>
            <button
              ref={controlsButtonRef}
              type="button"
              className={styles.compactButton}
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setOpen((current) => !current)}
            >
              <IconSlidersHorizontal size={15} aria-hidden="true" />
              {t('usage_mobile.controls')}
              {attentionCount > 0 && <span className={styles.attentionDot} aria-hidden="true" />}
              <IconChevronDown size={14} aria-hidden="true" className={styles.compactChevron} />
            </button>
            <button
              type="button"
              className={`${styles.compactButton} ${styles.compactRefresh}`}
              onClick={onRefreshAll}
              disabled={disableControls || refreshing}
              aria-busy={refreshing}
              aria-label={t('quota_management.refresh_all_credentials')}
              title={t('quota_management.refresh_all_credentials')}
            >
              <IconRefreshCw size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
        {!open && overrides.length > 0 && (
          <button
            type="button"
            className={styles.overrides}
            aria-controls={panelId}
            aria-expanded={false}
            onClick={() => {
              setOpen(true);
              controlsButtonRef.current?.focus();
            }}
          >
            {overrides.map((override) => (
              <span key={override.key} className={styles.override}>
                {override.text}
              </span>
            ))}
          </button>
        )}
        {/* Kept mounted while closed, so its switches keep their state and polling. */}
        <div id={panelId} className={styles.panel} hidden={!open}>
          {meta}
          {extra}
          {panel}
        </div>
      </header>
    );
  }

  return (
    <header className={styles.header}>
      <div className={styles.copy}>
        <h1 className={styles.title} data-reveal>
          {t('usage.page_title')}
        </h1>
        {meta}
      </div>
      <div className={styles.actions} data-reveal>
        {extra}
        <button
          type="button"
          className={styles.primaryAction}
          onClick={onRefreshAll}
          disabled={disableControls || refreshing}
          aria-busy={refreshing}
        >
          <IconRefreshCw size={14} aria-hidden="true" />
          {t('quota_management.refresh_all_credentials')}
        </button>
      </div>
    </header>
  );
}
