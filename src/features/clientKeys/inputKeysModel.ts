/**
 * Upstream input keys: scope, spend-limit state, labels and the settings form's parsing. Pure, so
 * it is tested without a browser (tests/inputKeysModel.test.ts).
 */

import type { InputKey } from '@/services/api/inputKeys';
import { NEAR_BUDGET_RATIO, type BudgetLevel } from './clientKeysModel';

/** Who may use the key: client keys only, both client keys and devices, or devices only. */
export type InputKeyScope = 'client_only' | 'shared' | 'device_only';

export const inputKeyScope = (key: Pick<InputKey, 'clientKeysOnly' | 'serveClientKeys'>) =>
  key.clientKeysOnly ? 'client_only' : key.serveClientKeys ? 'shared' : 'device_only';

export interface InputKeyLimitState {
  level: BudgetLevel;
  /** Spent over limit, clamped to 0..1 for the bar; null without a limit or spend. */
  ratio: number | null;
}

/** The gateway's `limit_reached` wins, so a key it already stopped reads as over. */
export function inputKeyLimit(key: InputKey): InputKeyLimitState {
  const { monthlyLimitUsd: limit, spentUsdCycle: spent } = key;
  if (limit <= 0) return { level: 'unlimited', ratio: null };
  if (spent === null) return { level: key.limitReached ? 'over' : 'untracked', ratio: null };
  const raw = spent / limit;
  const level = key.limitReached || raw >= 1 ? 'over' : raw >= NEAR_BUDGET_RATIO ? 'near' : 'ok';
  return { level, ratio: Math.min(1, Math.max(0, raw)) };
}

/** Configured name, else the auth id without its provider prefix (shown beside it anyway). */
export const inputKeyLabel = (key: Pick<InputKey, 'name' | 'id' | 'provider'>): string => {
  if (key.name) return key.name;
  const id =
    key.provider && key.id.startsWith(`${key.provider}:`)
      ? key.id.slice(key.provider.length + 1)
      : key.id;
  return id.length > 24 ? `…${id.slice(-20)}` : id;
};

/** Provider, then label; disabled keys last within a provider. */
export const sortInputKeys = (keys: InputKey[]): InputKey[] =>
  [...keys].sort(
    (a, b) =>
      a.provider.localeCompare(b.provider) ||
      Number(a.disabled) - Number(b.disabled) ||
      inputKeyLabel(a).localeCompare(inputKeyLabel(b))
  );

/** A whole day of the month, 1–31; null otherwise. */
export const parseCycleDay = (text: string): number | null => {
  const trimmed = text.trim();
  if (!/^\d{1,2}$/.test(trimmed)) return null;
  const day = Number(trimmed);
  return day >= 1 && day <= 31 ? day : null;
};

/** USD limit; empty is 0 (unlimited); null when not a non-negative number. */
export const parseLimitUsd = (text: string): number | null => {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

/** Groups the UI never offers (the private `special*` groups); agents still set them via the API. */
const isHiddenGroup = (group: string) => group.startsWith('special');

/**
 * Configured groups first (config order), then any the key holds that config no longer lists.
 * Hidden groups appear only when the key already holds them, so an edit keeps them.
 */
export const groupChoices = (configured: string[], held: string[]): string[] => [
  ...configured.filter((group) => !isHiddenGroup(group) || held.includes(group)),
  ...held.filter((group) => !configured.includes(group)),
];
