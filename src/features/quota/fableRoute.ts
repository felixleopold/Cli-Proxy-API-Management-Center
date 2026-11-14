/**
 * The "Fable goes to" control's model: which Claude credential serves the Fable
 * model first, read from each credential's `preferred_models`, and the patches
 * that move it to another account.
 */

import type { AuthFileFieldsPatch } from '@/services/api';
import type { AuthFileItem } from '@/types';
import { isClaudeFile } from '@/utils/quota/validators';

export const FABLE_MODEL_ID = 'claude-fable-5-2';

/** Select values besides credential names: "Any account" and the non-selectable several state. */
export const FABLE_ROUTE_ANY = '';
export const FABLE_ROUTE_SEVERAL = '\u0000several';

type PreferredModelsFile = Pick<AuthFileItem, 'name' | 'preferredModels'>;

export interface FableRoutePatch {
  name: string;
  fields: Pick<AuthFileFieldsPatch, 'preferred_models'>;
}

export const claudeRouteFiles = (files: AuthFileItem[]): AuthFileItem[] =>
  files.filter(isClaudeFile);

const holdsFable = (file: PreferredModelsFile) =>
  file.preferredModels?.includes(FABLE_MODEL_ID) === true;

/** The credential name holding Fable, "" for none, or the several sentinel. */
export const fableRouteValue = (files: PreferredModelsFile[]): string => {
  const holders = files.filter(holdsFable);
  if (holders.length === 0) return FABLE_ROUTE_ANY;
  return holders.length === 1 ? holders[0].name : FABLE_ROUTE_SEVERAL;
};

/**
 * Patches for routing Fable to `target` (a credential name, or "" for any account):
 * the target gains it (keeping its other entries), every other holder loses it,
 * and an emptied list is sent as null. Credentials already right get no patch.
 */
export const fableRoutePatches = (
  files: PreferredModelsFile[],
  target: string
): FableRoutePatch[] =>
  files.flatMap((file): FableRoutePatch[] => {
    const current = file.preferredModels ?? [];
    const has = current.includes(FABLE_MODEL_ID);
    if (file.name === target) {
      return has
        ? []
        : [{ name: file.name, fields: { preferred_models: [...current, FABLE_MODEL_ID] } }];
    }
    if (!has) return [];
    const rest = current.filter((model) => model !== FABLE_MODEL_ID);
    return [{ name: file.name, fields: { preferred_models: rest.length > 0 ? rest : null } }];
  });
