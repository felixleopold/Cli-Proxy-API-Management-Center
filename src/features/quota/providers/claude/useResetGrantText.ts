import { useTranslation } from 'react-i18next';
import type { AnthropicResetGrant, AnthropicResetWindow } from '@/services/api/claudeResetGrants';
import { buildResetDisplay, parseIsoToMs } from '@/utils/quota';
import { resetGrantGivesBack, resetGrantKind, type ResetGrantBlock } from './resetGrantInfo';

/** Plain-language text for grant kinds, give-backs and blockers. */
export function useResetGrantText(now: number) {
  const { t, i18n } = useTranslation();
  const time = (iso: string) => {
    const display = buildResetDisplay(null, parseIsoToMs(iso), now, i18n.resolvedLanguage);
    if (!display) return iso;
    return display.relative ? `${display.absolute} · ${display.relative}` : display.absolute;
  };
  const windows = (list: readonly AnthropicResetWindow[]) =>
    list.map((window) => t(`claude_reset.window.${window}`)).join(', ');
  return {
    windows,
    kind: (grant: AnthropicResetGrant) => t(`claude_reset.kind.${resetGrantKind(grant)}`),
    givesBack(grant: AnthropicResetGrant) {
      const items = resetGrantGivesBack(grant);
      if (grant.givesBackWeekly) {
        const percent = items[0]?.percent;
        return percent == null
          ? t('claude_reset.gives_fable_unknown')
          : t('claude_reset.gives_fable', { percent });
      }
      if (items.length === 0) return t('claude_reset.gives_unknown');
      return t('claude_reset.gives_frees', {
        items: items
          .map(({ window, percent }) =>
            percent == null
              ? t('claude_reset.gives_item_unknown', { window: t(`claude_reset.window.${window}`) })
              : t('claude_reset.gives_item', {
                  percent,
                  window: t(`claude_reset.window.${window}`),
                })
          )
          .join(', '),
      });
    },
    block(block: ResetGrantBlock) {
      switch (block.code) {
        case 'ineligible':
          return block.reason
            ? t('claude_reset.block.ineligible_reason', { reason: block.reason })
            : t('claude_reset.block.ineligible');
        case 'not_started':
          return t('claude_reset.block.not_started', { time: time(block.at) });
        case 'cooldown':
          return block.until
            ? t('claude_reset.block.cooldown_until', { time: time(block.until) })
            : t('claude_reset.block.cooldown');
        case 'blocked':
          return block.windows.length > 0
            ? t('claude_reset.block.blocked', { windows: windows(block.windows) })
            : t('claude_reset.block.blocked_other');
        default:
          return t(`claude_reset.block.${block.code}`);
      }
    },
  };
}
