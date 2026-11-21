import { useTranslation } from 'react-i18next';

export function VerifyAccountLink({ url, className }: { url: string; className?: string }) {
  const { t } = useTranslation();

  return (
    <a className={className} href={url} target="_blank" rel="noopener noreferrer">
      {t('usage_accounts.verify_account')}
    </a>
  );
}
