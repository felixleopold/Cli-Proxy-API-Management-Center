import type { AuthFileItem } from '@/types';

export const requiresVerification = (file: AuthFileItem): boolean =>
  file.status === 'verification_required' ||
  file.statusMessage === 'verification_required' ||
  file.routingStatus?.reason === 'verification_required' ||
  (file.cooldownSnapshot?.records?.some(({ reason }) => reason === 'verification_required') ??
    false);
