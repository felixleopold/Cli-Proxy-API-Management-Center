import type { AnthropicResetGrantStatus } from '@/services/api/claudeResetGrants';
import { resetGrantBlock } from './resetGrantInfo';

/** Prefer the upstream recommendation; otherwise use stable ID ordering. */
export function selectResetGrant(status: AnthropicResetGrantStatus, now: number) {
  const usable = status.grants.filter((grant) => !resetGrantBlock(status, grant, now));
  return (
    usable.find((grant) => grant.id === status.nextGrantId) ??
    usable.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]
  );
}
