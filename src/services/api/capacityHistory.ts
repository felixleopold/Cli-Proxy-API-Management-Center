/**
 * Capacity timeline: the gateway's append-only snapshots of what each
 * subscription credential contributed to its pool (plan weight and our share
 * per window, active or retired), one entry whenever that changes.
 */

import { apiClient } from './client';
import { isRecord } from '@/utils/helpers';

export interface CapacityEntry {
  atMs: number;
  authId: string;
  provider: string;
  /** Email or account label. */
  label: string;
  nickname: string;
  /** Enabled and not retired. */
  active: boolean;
  retired: boolean;
  plan: string;
  weightFiveHour: number;
  weightWeekly: number;
  /** Share counted as ours, 0..100. */
  shareFiveHourPercent: number;
  shareWeeklyPercent: number;
  lender: string;
  lenderGroup: boolean;
  /** What changed versus the credential's previous entry, e.g. "retired" or "plan pro → max". */
  reason: string;
  source: 'observed' | 'backfill';
}

export type CapacityHistoryResult =
  | { status: 'ok'; entries: CapacityEntry[] }
  /** The gateway has no timeline (404) or quota history is off (409). */
  | { status: 'unavailable' };

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const percent = (value: unknown): number | null => {
  const parsed = number(value);
  return parsed === null ? null : Math.min(100, Math.max(0, parsed));
};

/** Drops malformed entries instead of failing the whole response; result is sorted by time. */
export const normalizeCapacityEntries = (payload: unknown): CapacityEntry[] => {
  const raw = isRecord(payload) && Array.isArray(payload.entries) ? payload.entries : [];
  return raw
    .flatMap((entry: unknown): CapacityEntry[] => {
      if (!isRecord(entry)) return [];
      const atMs = number(entry.at_ms);
      const authId = text(entry.auth_id);
      const weightFiveHour = number(entry.weight_five_hour);
      const weightWeekly = number(entry.weight_weekly);
      const shareFiveHourPercent = percent(entry.share_five_hour_percent);
      const shareWeeklyPercent = percent(entry.share_weekly_percent);
      if (
        atMs === null ||
        !authId ||
        weightFiveHour === null ||
        weightWeekly === null ||
        shareFiveHourPercent === null ||
        shareWeeklyPercent === null
      ) {
        return [];
      }
      return [
        {
          atMs,
          authId,
          provider: text(entry.provider).toLowerCase(),
          label: text(entry.label),
          nickname: text(entry.nickname),
          active: entry.active === true,
          retired: entry.retired === true,
          plan: text(entry.plan),
          weightFiveHour: Math.max(0, weightFiveHour),
          weightWeekly: Math.max(0, weightWeekly),
          shareFiveHourPercent,
          shareWeeklyPercent,
          lender: text(entry.lender),
          lenderGroup: entry.lender_group === true,
          reason: text(entry.reason),
          source: entry.source === 'backfill' ? 'backfill' : 'observed',
        },
      ];
    })
    .sort((left, right) => left.atMs - right.atMs);
};

export const capacityHistoryApi = {
  list: async (fromMs: number, toMs: number): Promise<CapacityHistoryResult> => {
    try {
      const payload = await apiClient.get<unknown>('/observability/capacity/history', {
        params: { from: Math.floor(fromMs), to: Math.ceil(toMs) },
      });
      return { status: 'ok', entries: normalizeCapacityEntries(payload) };
    } catch (error: unknown) {
      if (isRecord(error) && (error.status === 404 || error.status === 409)) {
        return { status: 'unavailable' };
      }
      throw error;
    }
  },
};
