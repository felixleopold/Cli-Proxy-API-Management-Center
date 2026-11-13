import { apiClient } from '@/services/api/client';
import {
  anthropicResetGrantBlocker,
  claimClaudeResetGrant,
  readClaudeOrganization,
  readClaudeResetGrants,
  type AnthropicResetSettledCode,
} from '@/services/api/claudeResetGrants';

export const RETRY_WINDOW_MS = 10 * 60 * 1000;
type Operation = {
  grantId: string;
  organization: string;
  requestId: string;
  createdAt: number;
  code?: AnthropicResetSettledCode;
};
const defaultDependencies = {
  revision: () => apiClient.getConnectionRevision(),
  readStatus: readClaudeResetGrants,
  readOrganization: readClaudeOrganization,
  claim: claimClaudeResetGrant,
  now: () => Date.now(),
  requestId: createRequestId,
};

/** A v4 UUID. `crypto.randomUUID` exists only in secure contexts, and the panel is often
 * served over plain HTTP (e.g. http://cliproxy.lan); `getRandomValues` works in both. */
export function createRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Tab-memory journal: survives dialog/card unmounts, never crosses connections.
 * No automatic retry. Expired ambiguous operations stay blocked until session end.
 * This is not a cross-tab or durable backend spending ledger.
 */
export function createResetGrantOperations(deps = defaultDependencies) {
  let revision = deps.revision();
  const operations = new Map<string, Operation>();
  const busy = new Set<string>();
  const syncSession = () => {
    if (revision !== deps.revision()) {
      revision = deps.revision();
      operations.clear();
      busy.clear();
    }
    return revision;
  };
  return {
    inspect(key: string) {
      syncSession();
      return operations.get(key);
    },
    async run(key: string, authIndex: string, grantId: string) {
      const session = syncSession();
      const assertSession = () => {
        if (deps.revision() !== session) throw new Error('session');
      };
      if (busy.has(key)) throw new Error('busy');
      busy.add(key);
      try {
        let operation = operations.get(key);
        if (operation?.code) operation = undefined;
        if (
          operation &&
          (operation.grantId !== grantId || deps.now() - operation.createdAt >= RETRY_WINDOW_MS)
        )
          throw new Error('expired');
        const wasRetry = Boolean(operation);
        const organization = await deps.readOrganization(authIndex);
        assertSession();
        if (operation && operation.organization !== organization) throw new Error('identity');
        if (!operation) {
          const status = await deps.readStatus(authIndex);
          assertSession();
          const grant = status.grants.find((item) => item.id === grantId);
          const now = deps.now();
          if (
            anthropicResetGrantBlocker(status, grantId) ||
            !grant ||
            (grant.startsAt && Date.parse(grant.startsAt) > now) ||
            (grant.endsAt && Date.parse(grant.endsAt) <= now) ||
            (status.cooldownUntil && Date.parse(status.cooldownUntil) > now)
          ) {
            throw new Error('blocked');
          }
          operation = { grantId, organization, requestId: deps.requestId(), createdAt: now };
          operations.set(key, operation);
        }
        // Re-check immediately before dispatch; never send against a replacement connection.
        assertSession();
        if (wasRetry && deps.now() - operation.createdAt >= RETRY_WINDOW_MS) {
          throw new Error('expired');
        }
        const answer = await deps.claim(authIndex, organization, grantId, operation.requestId);
        assertSession();
        const { code } = answer;
        // A refusal on a retry cannot prove that the earlier ambiguous POST did not spend.
        if (!wasRetry || code === 'reset' || code === 'already_used') operation.code = code;
        return { ...answer, unresolved: !operation.code };
      } finally {
        if (deps.revision() === session) busy.delete(key);
      }
    },
  };
}

export const resetGrantOperations = createResetGrantOperations();
