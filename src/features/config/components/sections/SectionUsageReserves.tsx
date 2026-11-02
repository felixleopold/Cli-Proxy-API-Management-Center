import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useLedgerUsers } from '@/features/usage/hooks/useLedgerUsers';
import { makeClientId, type UsageReservePersonDraft } from '@/types/visualConfig';
import type { ConfigSectionProps } from '../../types';
import {
  USAGE_RESERVE_DEFAULTS,
  validPersonReserve,
  type UsageReserveField,
} from '../../visualConfigUsageReserves';
import {
  FieldAnchor,
  FieldGrid,
  FieldGroup,
  FieldShell,
  FieldStack,
} from '../fields/FieldPrimitives';
import { getValidationMessage } from '../blocks/shared';
import blockStyles from '../blocks/Blocks.module.scss';

const L = (key: string) => `config_management.visual.usageReserves.${key}`;

/**
 * usage-reserves: who keeps a share of each provider's pool, and when reserves
 * are released before a window resets. Lender reserves live on the credentials.
 */
export function SectionUsageReserves({
  values,
  validationErrors,
  disabled,
  onChange,
}: Omit<ConfigSectionProps, 'animateIn'>) {
  const { t } = useTranslation();
  const id = useId();
  const ledgerUsers = useLedgerUsers();
  const people = values.usageReservesPeople;
  const setPeople = (usageReservesPeople: UsageReservePersonDraft[]) =>
    onChange({ usageReservesPeople });
  const updatePerson = (index: number, patch: Partial<UsageReservePersonDraft>) =>
    setPeople(people.map((person, i) => (i === index ? { ...person, ...patch } : person)));
  const taken = new Set(people.map((person) => person.name.trim().toLowerCase()));
  const suggestions = ledgerUsers.filter((user) => !taken.has(user.toLowerCase()));

  const textField = (key: UsageReserveField, i18nKey: string) => (
    <Input
      type="text"
      label={t(L(`${i18nKey}.label`))}
      hint={t(L(`${i18nKey}.hint`))}
      placeholder={USAGE_RESERVE_DEFAULTS[key]}
      error={getValidationMessage(t, validationErrors?.[key])}
      value={values[key]}
      disabled={disabled}
      onChange={(event) => onChange({ [key]: event.target.value })}
    />
  );

  return (
    <FieldGroup title={t(L('title'))} description={t(L('description'))}>
      <FieldStack>
        <FieldAnchor fieldId="usageReservesPeople">
          <FieldShell
            label={t(L('people.label'))}
            labelId={`${id}-people-label`}
            hint={t(L('people.hint'))}
            hintId={`${id}-people-hint`}
            error={getValidationMessage(t, validationErrors?.usageReservesPeople)}
          >
            <div
              role="group"
              aria-labelledby={`${id}-people-label`}
              aria-describedby={`${id}-people-hint`}
              className={blockStyles.stringList}
            >
              <datalist id={`${id}-users`}>
                {suggestions.map((user) => (
                  <option key={user} value={user} />
                ))}
              </datalist>
              {people.map((person, index) => {
                const reserveInvalid =
                  person.reservePercent.trim() !== '' && !validPersonReserve(person.reservePercent);
                return (
                  <div key={person.id} className={blockStyles.stringListRow}>
                    <Input
                      type="text"
                      list={`${id}-users`}
                      aria-label={t(L('people.name'))}
                      placeholder={t(L('people.name'))}
                      value={person.name}
                      disabled={disabled}
                      onChange={(event) => updatePerson(index, { name: event.target.value })}
                    />
                    <Input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      max={100}
                      step="any"
                      aria-label={t(L('people.reserve'), { name: person.name || '…' })}
                      placeholder="10"
                      aria-invalid={reserveInvalid}
                      value={person.reservePercent}
                      disabled={disabled}
                      rightElement={<span aria-hidden="true">%</span>}
                      onChange={(event) =>
                        updatePerson(index, { reservePercent: event.target.value })
                      }
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      aria-label={t(L('people.remove'), { name: person.name || '…' })}
                      onClick={() => setPeople(people.filter((_, i) => i !== index))}
                    >
                      {t('config_management.visual.common.delete')}
                    </Button>
                  </div>
                );
              })}
              <div className={blockStyles.actionRow}>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={disabled}
                  onClick={() =>
                    setPeople([
                      ...people,
                      { id: makeClientId(), name: suggestions[0] ?? '', reservePercent: '' },
                    ])
                  }
                >
                  {t(L('people.add'))}
                </Button>
              </div>
            </div>
          </FieldShell>
        </FieldAnchor>
        <FieldGrid>
          <FieldAnchor fieldId="usageReservesQuietStart">
            {textField('usageReservesQuietStart', 'quietStart')}
          </FieldAnchor>
          <FieldAnchor fieldId="usageReservesQuietEnd">
            {textField('usageReservesQuietEnd', 'quietEnd')}
          </FieldAnchor>
          <FieldAnchor fieldId="usageReservesLeadFiveHour">
            {textField('usageReservesLeadFiveHour', 'leadFiveHour')}
          </FieldAnchor>
          <FieldAnchor fieldId="usageReservesLeadWeekly">
            {textField('usageReservesLeadWeekly', 'leadWeekly')}
          </FieldAnchor>
          <FieldAnchor fieldId="usageReservesFloorFiveHour">
            {textField('usageReservesFloorFiveHour', 'floorFiveHour')}
          </FieldAnchor>
          <FieldAnchor fieldId="usageReservesFloorWeekly">
            {textField('usageReservesFloorWeekly', 'floorWeekly')}
          </FieldAnchor>
          <FieldAnchor fieldId="usageReservesTimezone">
            {textField('usageReservesTimezone', 'timezone')}
          </FieldAnchor>
        </FieldGrid>
      </FieldStack>
    </FieldGroup>
  );
}
