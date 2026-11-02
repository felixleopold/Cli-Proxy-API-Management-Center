import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import type {
  PrefixProxyEditorField,
  PrefixProxyEditorState,
} from '@/features/authFiles/hooks/useAuthFilesPrefixProxyEditor';
import { CLAUDE_PLAN_WEIGHTS, type ClaudePlan } from '@/features/authFiles/constants';
import styles from './AuthFileDetailsSheet.module.scss';

const CLAUDE_PLANS = Object.keys(CLAUDE_PLAN_WEIGHTS) as ClaudePlan[];

/**
 * Pool fields of a credential whose windows the gateway observes: Claude plan,
 * lender, per-window lender reserves, and the older plan multiplier and usage
 * cap. Explicit reserves win over the cap per window (gateway
 * LenderReservePercent); a Claude plan's weights win over the multiplier
 * (gateway PlanWeight).
 */
export function AuthFileReserveFields({
  editor,
  disabled,
  onChange,
}: {
  editor: PrefixProxyEditorState;
  disabled: boolean;
  onChange: (field: PrefixProxyEditorField, value: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const claude = editor.providerKey === 'claude';
  const planOptions = [
    { value: '', label: t('auth_files.plan_unset') },
    ...CLAUDE_PLANS.map((plan) => ({
      value: plan,
      label: t(`auth_files.plan_${plan}`, CLAUDE_PLAN_WEIGHTS[plan]),
    })),
    // Keep an unknown value visible instead of silently showing "not set".
    ...(editor.plan && !(editor.plan in CLAUDE_PLAN_WEIGHTS)
      ? [{ value: editor.plan, label: editor.plan }]
      : []),
  ];
  const percentInput = (field: 'reserveFiveHour' | 'reserveWeekly') => (
    <Input
      label={t(
        `auth_files.${field === 'reserveFiveHour' ? 'reserve_five_hour' : 'reserve_weekly'}_label`
      )}
      type="number"
      inputMode="decimal"
      min={0}
      max={100}
      step="any"
      value={editor[field]}
      error={editor[`${field}Error`] ?? undefined}
      className={styles.suffixedInput}
      rightElement={<span className={styles.inputSuffix}>%</span>}
      disabled={disabled}
      onChange={(e) => onChange(field, e.target.value)}
    />
  );

  return (
    <fieldset className={styles.reserveFields}>
      <legend className={styles.reserveLegend}>{t('auth_files.reserve_group_label')}</legend>
      <p className={styles.reserveIntro}>{t('auth_files.reserve_group_hint')}</p>
      {claude && (
        <div className="form-group">
          <label id={`${id}-plan`}>{t('auth_files.plan_label')}</label>
          <Select
            ariaLabelledBy={`${id}-plan`}
            ariaDescribedBy={`${id}-plan-hint`}
            value={editor.plan}
            options={planOptions}
            disabled={disabled}
            onChange={(value) => onChange('plan', value)}
          />
          <div className="hint" id={`${id}-plan-hint`}>
            {t('auth_files.plan_hint')}
          </div>
        </div>
      )}
      <Input
        label={t('auth_files.lender_label')}
        value={editor.lender}
        placeholder={t('auth_files.lender_placeholder')}
        hint={t('auth_files.lender_hint')}
        disabled={disabled}
        onChange={(e) => onChange('lender', e.target.value)}
      />
      <div className={styles.reservePair}>
        {percentInput('reserveFiveHour')}
        {percentInput('reserveWeekly')}
      </div>
      <p className={styles.reserveIntro}>{t('auth_files.reserve_hint')}</p>
      <Input
        label={t('auth_files.usage_cap_label')}
        type="number"
        inputMode="numeric"
        min={1}
        max={99}
        step="1"
        value={editor.usageCapPercent}
        hint={t('auth_files.usage_cap_hint')}
        error={editor.usageCapPercentError ?? undefined}
        className={styles.suffixedInput}
        rightElement={<span className={styles.inputSuffix}>%</span>}
        disabled={disabled}
        onChange={(e) => onChange('usageCapPercent', e.target.value)}
      />
      <Input
        label={t('auth_files.plan_multiplier_label')}
        type="number"
        inputMode="decimal"
        min={0}
        max={100}
        step="any"
        value={editor.planMultiplier}
        hint={t(
          claude ? 'auth_files.plan_multiplier_hint_claude' : 'auth_files.plan_multiplier_hint'
        )}
        error={editor.planMultiplierError ?? undefined}
        className={styles.suffixedInput}
        rightElement={<span className={styles.inputSuffix}>×</span>}
        disabled={disabled}
        onChange={(e) => onChange('planMultiplier', e.target.value)}
      />
    </fieldset>
  );
}
