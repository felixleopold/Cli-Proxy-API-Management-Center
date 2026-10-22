import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Select } from '@/components/ui/Select';
import {
  IconBan,
  IconCheckCircle2,
  IconPencil,
  IconRefreshCw,
  IconSearch,
  IconTrash2,
  IconX,
} from '@/components/ui/icons';
import type { ClientKey } from '@/services/api/clientKeys';
import { formatUsd } from '@/features/usage/usageModel';
import {
  filterKeys,
  groupKeys,
  keyStatus,
  projectsOf,
  type ProjectFilter,
} from '../clientKeysModel';
import { OPTIONAL_COLUMNS, type ClientKeysViewPrefs, type OptionalColumn } from '../viewPrefs';
import { ColumnsMenu } from './ColumnsMenu';
import { BudgetBar, CredentialsBadge, ModelChips, StatusBadge, UnpricedBadge } from './KeyBits';
import styles from './KeysList.module.scss';

export interface KeyActions {
  onOpen: (key: ClientKey) => void;
  onEdit: (key: ClientKey) => void;
  onRotate: (key: ClientKey) => void;
  onToggleDisabled: (key: ClientKey) => void;
  onRevoke: (key: ClientKey) => void;
}

interface KeysListProps extends KeyActions {
  keys: ClientKey[];
  nowMs: number;
  prefs: ClientKeysViewPrefs;
  onPrefsChange: (prefs: ClientKeysViewPrefs) => void;
  /** Key with a change in flight; its actions wait. */
  pendingId: string | null;
  onCreate: () => void;
}

const ALL = '\u0000all';
const NO_PROJECT = '\u0000none';

const toFilter = (value: string): ProjectFilter =>
  value === ALL ? { kind: 'all' } : { kind: 'project', project: value === NO_PROJECT ? '' : value };

/** Search, project filter, grouping and column choice over one table of keys. */
export function KeysList({
  keys,
  nowMs,
  prefs,
  onPrefsChange,
  pendingId,
  onCreate,
  ...actions
}: KeysListProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const [query, setQuery] = useState('');
  const [projectValue, setProjectValue] = useState(ALL);

  const projects = useMemo(() => projectsOf(keys), [keys]);
  const hasUnassigned = keys.some((key) => !key.project);
  // A filter on a project that no longer exists falls back to every project.
  const activeValue =
    projectValue === ALL ||
    (projectValue === NO_PROJECT ? hasUnassigned : projects.includes(projectValue))
      ? projectValue
      : ALL;
  const groups = useMemo(
    () => groupKeys(filterKeys(keys, query, toFilter(activeValue)), prefs.grouping),
    [keys, query, activeValue, prefs.grouping]
  );

  const projectOptions = [
    { value: ALL, label: t('client_keys.filter_all_projects') },
    ...projects.map((project) => ({ value: project, label: project })),
    ...(hasUnassigned ? [{ value: NO_PROJECT, label: t('client_keys.no_project') }] : []),
  ];

  const flat = prefs.grouping === 'flat';
  const optional = OPTIONAL_COLUMNS.filter((column) => prefs.columns[column]);
  const columnCount = 3 + optional.length + (flat ? 1 : 0);
  const formatDate = (ms: number | null) =>
    ms === null
      ? t('client_keys.never')
      : new Date(ms).toLocaleDateString(locale, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        });

  const cell: Record<OptionalColumn, (key: ClientKey) => ReactNode> = {
    models: (key) => <ModelChips models={key.models} />,
    credentials: (key) => <CredentialsBadge credentials={key.credentials} />,
    budget: (key) => <BudgetBar keyEntry={key} />,
    expires: (key) => <span className={styles.date}>{formatDate(key.expiresAtMs)}</span>,
    created: (key) => <span className={styles.date}>{formatDate(key.createdAtMs)}</span>,
  };

  if (keys.length === 0) {
    return (
      <EmptyState
        title={t('client_keys.empty_title')}
        description={t('client_keys.empty_desc')}
        action={
          <Button size="sm" onClick={onCreate}>
            {t('client_keys.new_key')}
          </Button>
        }
      />
    );
  }

  return (
    <div className={styles.list}>
      <div className={styles.toolbar}>
        <div className={styles.filters}>
          <label className={styles.search}>
            <IconSearch size={16} className={styles.searchIcon} aria-hidden="true" />
            <input
              className={styles.searchInput}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('client_keys.search_placeholder')}
              aria-label={t('client_keys.search_placeholder')}
            />
            {query && (
              <button
                type="button"
                className={styles.clearSearch}
                onClick={() => setQuery('')}
                aria-label={t('client_keys.search_clear')}
              >
                <IconX size={14} aria-hidden="true" />
              </button>
            )}
          </label>
          <Select
            className={styles.projectSelect}
            value={activeValue}
            options={projectOptions}
            onChange={setProjectValue}
            ariaLabel={t('client_keys.filter_project_label')}
            fullWidth={false}
            size="sm"
          />
        </div>
        <div className={styles.viewControls}>
          <div
            className={styles.segmented}
            role="group"
            aria-label={t('client_keys.grouping_label')}
          >
            {(['project', 'flat'] as const).map((grouping) => (
              <button
                key={grouping}
                type="button"
                aria-pressed={prefs.grouping === grouping}
                onClick={() => onPrefsChange({ ...prefs, grouping })}
              >
                {t(`client_keys.grouping_${grouping}`)}
              </button>
            ))}
          </div>
          <ColumnsMenu
            columns={prefs.columns}
            onChange={(columns) => onPrefsChange({ ...prefs, columns })}
          />
        </div>
      </div>

      {groups.length === 0 ? (
        <p className={styles.noMatch}>{t('client_keys.search_empty')}</p>
      ) : (
        <div className={styles.scroller}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('client_keys.col_name')}</th>
                {flat && <th scope="col">{t('client_keys.col_project')}</th>}
                {optional.map((column) => (
                  <th key={column} scope="col">
                    {t(`client_keys.col_${column}`)}
                  </th>
                ))}
                <th scope="col">{t('client_keys.col_status')}</th>
                <th scope="col" className={styles.actionsHead}>
                  <span className={styles.srOnly}>{t('client_keys.col_actions')}</span>
                </th>
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group.id}>
                {group.project !== null && (
                  <tr className={styles.groupRow}>
                    <th scope="rowgroup" colSpan={columnCount}>
                      <span className={group.project ? styles.groupName : styles.groupNameMuted}>
                        {group.project || t('client_keys.no_project')}
                      </span>
                      <span className={styles.groupMeta}>
                        {t('client_keys.group_count', { count: group.keys.length })}
                        {group.spentUsd !== null && (
                          <>
                            <span aria-hidden="true"> · </span>
                            {t('client_keys.group_spend', {
                              amount: formatUsd(group.spentUsd, locale),
                            })}
                          </>
                        )}
                      </span>
                    </th>
                  </tr>
                )}
                {group.keys.map((key) => {
                  const status = keyStatus(key, nowMs);
                  const pending = pendingId === key.id;
                  return (
                    <tr
                      key={key.id}
                      className={
                        status === 'active' ? styles.row : `${styles.row} ${styles.rowInactive}`
                      }
                    >
                      <th scope="row" className={styles.nameCell}>
                        <button
                          type="button"
                          className={styles.nameButton}
                          onClick={() => actions.onOpen(key)}
                          aria-label={t('client_keys.open_details', { name: key.name })}
                        >
                          <span className={styles.name}>{key.name}</span>
                          <span className={styles.prefix}>{key.prefix}</span>
                        </button>
                        <UnpricedBadge keyEntry={key} />
                      </th>
                      {flat && (
                        <td className={key.project ? undefined : styles.muted}>
                          {key.project || t('client_keys.no_project')}
                        </td>
                      )}
                      {optional.map((column) => (
                        <td key={column}>{cell[column](key)}</td>
                      ))}
                      <td>
                        <StatusBadge status={status} />
                      </td>
                      <td className={styles.actionsCell}>
                        <div className={styles.actions}>
                          <IconAction
                            label={t('client_keys.action_edit', { name: key.name })}
                            title={t('client_keys.action_edit_short')}
                            disabled={pending}
                            onClick={() => actions.onEdit(key)}
                          >
                            <IconPencil size={15} />
                          </IconAction>
                          <IconAction
                            label={t('client_keys.action_rotate', { name: key.name })}
                            title={t('client_keys.action_rotate_short')}
                            disabled={pending}
                            onClick={() => actions.onRotate(key)}
                          >
                            <IconRefreshCw size={15} />
                          </IconAction>
                          <IconAction
                            label={t(
                              key.disabled
                                ? 'client_keys.action_enable'
                                : 'client_keys.action_disable',
                              { name: key.name }
                            )}
                            title={t(
                              key.disabled
                                ? 'client_keys.action_enable_short'
                                : 'client_keys.action_disable_short'
                            )}
                            disabled={pending}
                            onClick={() => actions.onToggleDisabled(key)}
                          >
                            {key.disabled ? <IconCheckCircle2 size={15} /> : <IconBan size={15} />}
                          </IconAction>
                          <IconAction
                            label={t('client_keys.action_revoke', { name: key.name })}
                            title={t('client_keys.action_revoke_short')}
                            disabled={pending}
                            danger
                            onClick={() => actions.onRevoke(key)}
                          >
                            <IconTrash2 size={15} />
                          </IconAction>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            ))}
          </table>
        </div>
      )}
    </div>
  );
}

interface IconActionProps {
  label: string;
  title: string;
  disabled: boolean;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}

function IconAction({
  label,
  title,
  disabled,
  danger = false,
  onClick,
  children,
}: IconActionProps) {
  return (
    <button
      type="button"
      className={danger ? `${styles.iconAction} ${styles.iconDanger}` : styles.iconAction}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
