import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Select, type SelectOption } from '@/components/ui/Select';
import { authFilesApi } from '@/services/api';
import { useNotificationStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import {
  FABLE_ROUTE_ANY,
  FABLE_ROUTE_SEVERAL,
  claudeRouteFiles,
  fableRoutePatches,
  fableRouteValue,
  isFableDestination,
} from '../fableRoute';
import styles from './FableRouteControl.module.scss';

/**
 * Which Claude account serves Fable first: a label · select group in the page
 * header, next to the API credit switch. Choosing an account puts the Fable
 * model in its preferred_models and takes it off every other account; "Any
 * account" only takes it off. Renders nothing without a Claude credential.
 */
export function FableRouteControl({
  files,
  disabled,
  onReload,
}: {
  files: AuthFileItem[];
  disabled: boolean;
  /** Refetches the listing, the source of truth for each credential's preferred models. */
  onReload: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [saving, setSaving] = useState(false);
  const claudeFiles = useMemo(() => claudeRouteFiles(files), [files]);
  const value = fableRouteValue(claudeFiles);
  const options = useMemo<SelectOption[]>(
    () => [
      { value: FABLE_ROUTE_ANY, label: t('fable_route.any') },
      ...claudeFiles.filter(isFableDestination).map((file) => ({
        value: file.name,
        label: file.nickname || file.email || file.name,
      })),
    ],
    [claudeFiles, t]
  );

  if (claudeFiles.length === 0) return null;

  const choose = async (target: string) => {
    if (target === value) return;
    setSaving(true);
    try {
      for (const { name, fields } of fableRoutePatches(claudeFiles, target)) {
        await authFilesApi.patchFields(name, fields);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('common.unknown_error');
      showNotification(t('fable_route.save_failed', { message }), 'error');
    } finally {
      setSaving(false);
      onReload();
    }
  };

  return (
    <div
      className={styles.group}
      role="group"
      aria-labelledby={titleId}
      title={t('fable_route.hint')}
    >
      <span id={titleId} className={styles.title}>
        {t('fable_route.title')}
      </span>
      <Select
        value={value}
        options={options}
        onChange={(next) => void choose(next)}
        placeholder={value === FABLE_ROUTE_SEVERAL ? t('fable_route.several') : undefined}
        ariaLabelledBy={titleId}
        disabled={disabled || saving}
        fullWidth={false}
        size="sm"
        className={styles.select}
      />
    </div>
  );
}
