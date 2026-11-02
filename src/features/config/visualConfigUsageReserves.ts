import { isMap, isScalar, type parseDocument } from 'yaml';
import type {
  UsageReservePersonDraft,
  VisualConfigValidationErrors,
  VisualConfigValues,
} from '@/types/visualConfig';
import { goDurationSeconds } from './visualConfigAdditions';

// Backend: internal/config/config_types.go UsageReservesConfig and
// sdk/cliproxy/auth/usage_reserves.go newReserveRelease. Empty or invalid values
// fall back to the gateway defaults below.
const ROOT = 'usage-reserves';
export const USAGE_RESERVE_FIELDS = [
  { key: 'usageReservesTimezone', path: [ROOT, 'timezone'] },
  { key: 'usageReservesQuietStart', path: [ROOT, 'quiet-hours', 'start'] },
  { key: 'usageReservesQuietEnd', path: [ROOT, 'quiet-hours', 'end'] },
  { key: 'usageReservesLeadFiveHour', path: [ROOT, 'release-lead', 'five-hour'] },
  { key: 'usageReservesLeadWeekly', path: [ROOT, 'release-lead', 'weekly'] },
] as const;
export const PEOPLE_KEY = 'usageReservesPeople';
const PEOPLE_PATH = [ROOT, 'people'];

export const USAGE_RESERVE_DEFAULTS = {
  usageReservesTimezone: 'Europe/Vienna',
  usageReservesQuietStart: '23:00',
  usageReservesQuietEnd: '07:00',
  usageReservesLeadFiveHour: '15m',
  usageReservesLeadWeekly: '1h',
} as const;

type Doc = ReturnType<typeof parseDocument>;
type UsageReserveKey = (typeof USAGE_RESERVE_FIELDS)[number]['key'] | typeof PEOPLE_KEY;

const scalarText = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

export function readVisualUsageReserves(doc: Doc): Pick<VisualConfigValues, UsageReserveKey> {
  const values = {} as Pick<VisualConfigValues, UsageReserveKey>;
  for (const { key, path } of USAGE_RESERVE_FIELDS) values[key] = scalarText(doc.getIn(path));
  const people = doc.getIn(PEOPLE_PATH, true);
  values[PEOPLE_KEY] = isMap(people)
    ? people.items.map((pair, index) => {
        const name = isScalar(pair.key) ? scalarText(pair.key.value) : '';
        const person = isMap(pair.value) ? pair.value.toJSON() : {};
        return {
          id: `person-${index}`,
          name,
          reservePercent: scalarText((person as Record<string, unknown>)['reserve-percent']),
        };
      })
    : [];
  return values;
}

/** Same people, ignoring editor ids and surrounding whitespace. */
export const samePeople = (left: UsageReservePersonDraft[], right: UsageReservePersonDraft[]) =>
  left.length === right.length &&
  left.every(
    (person, index) =>
      person.name.trim() === right[index].name.trim() &&
      person.reservePercent.trim() === right[index].reservePercent.trim()
  );

function ensureParents(doc: Doc, path: readonly string[]) {
  for (let i = 1; i < path.length; i++) {
    const parent = path.slice(0, i);
    if (!isMap(doc.getIn(parent, true))) doc.setIn(parent, doc.createNode({}));
  }
}

/** Removes path and then any parent map it leaves empty, up to the section root. */
function deleteAndPrune(doc: Doc, path: readonly string[]) {
  if (doc.hasIn(path)) doc.deleteIn(path);
  for (let i = path.length - 1; i >= 1; i--) {
    const parent = path.slice(0, i);
    const node = doc.getIn(parent, true);
    if (isMap(node) && node.items.length === 0) doc.deleteIn(parent);
  }
}

/** Writes only dirty fields; empty text removes the key so the gateway default applies. */
export function writeVisualUsageReserves(
  doc: Doc,
  values: VisualConfigValues,
  dirty: ReadonlySet<string>
) {
  for (const { key, path } of USAGE_RESERVE_FIELDS) {
    if (!dirty.has(key)) continue;
    const text = values[key].trim();
    if (!text) {
      deleteAndPrune(doc, path);
      continue;
    }
    ensureParents(doc, path);
    const old = doc.getIn(path, true);
    if (isScalar(old)) old.value = text;
    else doc.setIn(path, text);
  }
  if (!dirty.has(PEOPLE_KEY)) return;
  const people = values[PEOPLE_KEY].filter((person) => person.name.trim());
  if (people.length === 0) {
    deleteAndPrune(doc, PEOPLE_PATH);
    return;
  }
  ensureParents(doc, PEOPLE_PATH);
  doc.setIn(
    PEOPLE_PATH,
    doc.createNode(
      Object.fromEntries(
        people.map((person) => [
          person.name.trim(),
          { 'reserve-percent': Number(person.reservePercent.trim()) },
        ])
      )
    )
  );
}

const validClock = (text: string) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  return match !== null && Number(match[1]) < 24 && Number(match[2]) < 60;
};

/** A person's reserve as the gateway reads it: 0 (no active reserve) to 100. */
export const validPersonReserve = (text: string) => {
  const trimmed = text.trim();
  return /^(\d+(\.\d*)?|\.\d+)$/.test(trimmed) && Number(trimmed) <= 100;
};

export function validateVisualUsageReserves(
  values: VisualConfigValues
): VisualConfigValidationErrors {
  const errors: VisualConfigValidationErrors = {
    usageReservesTimezone: undefined,
    usageReservesQuietStart: undefined,
    usageReservesQuietEnd: undefined,
    usageReservesLeadFiveHour: undefined,
    usageReservesLeadWeekly: undefined,
    usageReservesPeople: undefined,
  };
  const timezone = values.usageReservesTimezone.trim();
  if (timezone && timezone !== 'Local') {
    try {
      if (/^[+-]/.test(timezone)) throw new Error('Not an IANA timezone');
      new Intl.DateTimeFormat('en', { timeZone: timezone });
    } catch {
      errors.usageReservesTimezone = 'invalid_timezone';
    }
  }
  // The gateway takes quiet hours only as a pair; one bad half resets both to the default.
  const start = values.usageReservesQuietStart.trim();
  const end = values.usageReservesQuietEnd.trim();
  if ((start || end) && !(validClock(start) && validClock(end))) {
    if (!validClock(start)) errors.usageReservesQuietStart = 'invalid_clock_pair';
    if (!validClock(end)) errors.usageReservesQuietEnd = 'invalid_clock_pair';
  }
  for (const key of ['usageReservesLeadFiveHour', 'usageReservesLeadWeekly'] as const) {
    const text = values[key].trim();
    const seconds = text ? goDurationSeconds(text) : 0;
    if (seconds === undefined || seconds < 0) errors[key] = 'invalid_duration';
  }
  const names = new Set<string>();
  for (const person of values[PEOPLE_KEY]) {
    const name = person.name.trim().toLowerCase();
    // Names match case-insensitively in the gateway, so duplicates would shadow each other.
    if (!name || names.has(name) || !validPersonReserve(person.reservePercent)) {
      errors[PEOPLE_KEY] = 'invalid_people';
      break;
    }
    names.add(name);
  }
  return errors;
}
