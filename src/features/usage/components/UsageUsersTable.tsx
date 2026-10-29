import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronDown } from '@/components/ui/icons';
import { formatCompactNumber, formatPercent, maskApiKey } from '@/utils/format';
import { formatUsd, type ClientRow, type SeriesSlot, type UsageRollup } from '../usageModel';
import { slotClassName } from './slotClass';
import styles from './UsageUsersTable.module.scss';

interface UsageUsersTableProps {
  rollup: UsageRollup;
  slots: Map<string, SeriesSlot>;
  userLabel: (user: string) => string;
  /** Known keys by fingerprint: configured device keys and app keys. */
  clients: Map<string, ClientRow>;
}

const toggle = (set: Set<string>, key: string) => {
  const next = new Set(set);
  if (!next.delete(key)) next.add(key);
  return next;
};

export function UsageUsersTable({ rollup, slots, userLabel, clients }: UsageUsersTableProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const [openUsers, setOpenUsers] = useState<Set<string>>(() => new Set());
  const [openDevices, setOpenDevices] = useState<Set<string>>(() => new Set());

  if (rollup.users.length === 0) {
    return <p className={styles.empty}>{t('usage.selection_empty')}</p>;
  }

  const share = (cost: number) => (rollup.costUsd > 0 ? (cost / rollup.costUsd) * 100 : 0);

  return (
    <div className={styles.scroller}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{t('usage.col_user')}</th>
            <th scope="col" className={styles.num}>
              {t('usage.col_spend')}
            </th>
            <th scope="col" className={styles.shareCol}>
              {t('usage.col_share')}
            </th>
            <th scope="col" className={styles.num}>
              {t('usage.col_requests')}
            </th>
            <th scope="col" className={styles.num}>
              {t('usage.col_tokens')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rollup.users.map((user) => {
            const userOpen = openUsers.has(user.user);
            const slot = slots.get(user.user) ?? 'other';
            const userShare = share(user.costUsd);
            const appCount = user.devices.filter(
              (device) => clients.get(device.fingerprint)?.appKey
            ).length;
            const deviceCount = user.devices.length - appCount;
            return (
              <Fragment key={user.user || '\u0000'}>
                <tr className={styles.userRow}>
                  <th scope="row">
                    <button
                      type="button"
                      className={styles.expander}
                      aria-expanded={userOpen}
                      onClick={() => setOpenUsers((set) => toggle(set, user.user))}
                    >
                      <IconChevronDown size={14} className={styles.chevron} aria-hidden="true" />
                      <span
                        className={`${styles.swatch} ${slotClassName(slot)}`}
                        aria-hidden="true"
                      />
                      <span className={user.user ? styles.userName : styles.unassigned}>
                        {userLabel(user.user)}
                      </span>
                      <span className={styles.meta}>
                        {[
                          deviceCount > 0 && t('usage.device_count', { count: deviceCount }),
                          appCount > 0 && t('usage.app_key_count', { count: appCount }),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </button>
                  </th>
                  <td className={styles.spend}>{formatUsd(user.costUsd, locale)}</td>
                  <td className={styles.shareCol}>
                    <span className={styles.share}>
                      <span className={styles.shareTrack} aria-hidden="true">
                        <span
                          className={`${styles.shareFill} ${slotClassName(slot)}`}
                          style={{ width: `${userShare}%` }}
                        />
                      </span>
                      {formatPercent(userShare, 0)}
                    </span>
                  </td>
                  <td className={styles.num}>{user.requests.toLocaleString(locale)}</td>
                  <td className={styles.num}>{formatCompactNumber(user.tokens)}</td>
                </tr>

                {userOpen &&
                  user.devices.map((device) => {
                    const deviceKey = `${user.user}\u0000${device.fingerprint}`;
                    const deviceOpen = openDevices.has(deviceKey);
                    const client = clients.get(device.fingerprint);
                    const appKey = client?.appKey;
                    const name = device.device || appKey?.name;
                    return (
                      <Fragment key={deviceKey}>
                        <tr className={styles.deviceRow}>
                          <th scope="row">
                            <button
                              type="button"
                              className={styles.expander}
                              aria-expanded={deviceOpen}
                              onClick={() => setOpenDevices((set) => toggle(set, deviceKey))}
                            >
                              <IconChevronDown
                                size={13}
                                className={styles.chevron}
                                aria-hidden="true"
                              />
                              <span className={name ? undefined : styles.unassigned}>
                                {device.fingerprint
                                  ? name || t('usage.unnamed_device')
                                  : t('usage.anonymous')}
                              </span>
                              {appKey && (
                                <span className={styles.appTag}>{t('usage.app_key_tag')}</span>
                              )}
                              {device.fingerprint && (
                                <code className={styles.fingerprint}>{device.fingerprint}</code>
                              )}
                              {client?.apiKey && (
                                <span className={styles.meta}>{maskApiKey(client.apiKey)}</span>
                              )}
                              {appKey?.project && (
                                <span className={styles.meta}>{appKey.project}</span>
                              )}
                            </button>
                          </th>
                          <td className={styles.num}>{formatUsd(device.costUsd, locale)}</td>
                          <td className={`${styles.shareCol} ${styles.muted}`}>
                            {formatPercent(share(device.costUsd), 0)}
                          </td>
                          <td className={styles.num}>{device.requests.toLocaleString(locale)}</td>
                          <td className={styles.num}>{formatCompactNumber(device.tokens)}</td>
                        </tr>
                        {deviceOpen &&
                          device.models.map((model) => (
                            <tr
                              key={`${model.provider}\u0000${model.model}`}
                              className={styles.modelRow}
                            >
                              <th scope="row">
                                <span className={styles.modelCell}>
                                  <span className={styles.modelName}>{model.model || '—'}</span>
                                  {model.provider && (
                                    <span className={styles.meta}>{model.provider}</span>
                                  )}
                                </span>
                              </th>
                              <td className={styles.num}>{formatUsd(model.costUsd, locale)}</td>
                              <td className={`${styles.shareCol} ${styles.muted}`}>
                                {formatPercent(share(model.costUsd), 0)}
                              </td>
                              <td className={styles.num}>
                                {model.requests.toLocaleString(locale)}
                              </td>
                              <td className={styles.num}>{formatCompactNumber(model.tokens)}</td>
                            </tr>
                          ))}
                      </Fragment>
                    );
                  })}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
