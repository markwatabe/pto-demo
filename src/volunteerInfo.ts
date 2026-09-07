/**
 * Shared volunteer display helpers: the roster columns admin pages show on
 * hover, and the tooltip lines built from them.
 */
import { isoDate, toLocalDate, type AvailabilityRow, type BlackoutRow, type Frequency, type RosterVolunteer } from './schedule';

// Roster rows with the extra columns the hover tooltip shows.
export type RosterDetail = RosterVolunteer & {
  grades: string | null;
  frequency_note: string | null;
  notes: string | null;
};

/** The volunteers select list matching RosterDetail. */
export const ROSTER_DETAIL_SELECT =
  'id, name, frequency, backfill, veteran, grades, frequency_note, notes';

export const FREQ_LABEL: Record<Frequency, string> = {
  weekly: '1×/week',
  monthly: '1×/month',
  biweekly: '2×/month',
  custom: 'custom',
};

const WEEKDAY_SHORT = ['', 'Mon', 'Tue', 'Wed', 'Thu'];

export type Blackout = BlackoutRow & { id: string; note: string | null };
export const WEEKDAY_LONG = ['', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays'];

/**
 * "9/1/2025", "9/1/25", "2025-09-01" or "Sep 1 2025" -> "2025-09-01"; null if
 * unparseable. Month/day/year is the coordinator's habit; ISO is the app's.
 */
export function parseUserDate(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  const iso = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const us = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  let y: number, m: number, d: number;
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (us) {
    [m, d] = [Number(us[1]), Number(us[2])];
    y = Number(us[3]);
    if (y < 100) y += 2000;
  } else {
    const parsed = new Date(t);
    if (Number.isNaN(parsed.getTime())) return null;
    [y, m, d] = [parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate()];
  }
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return isoDate(date);
}

/**
 * "2025-09-01".."2025-09-14" -> "Sep 1 – Sep 14, 2025"; a one-day window ->
 * "Sep 1, 2025"; with a weekday -> "Tuesdays, Sep 8 – Apr 6, 2027".
 */
export function formatBlackout(b: BlackoutRow): string {
  const a = toLocalDate(b.starts_on);
  const z = toLocalDate(b.ends_on);
  const md = (x: Date) => x.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const prefix = b.weekday ? `${WEEKDAY_LONG[b.weekday]}, ` : '';
  if (b.starts_on === b.ends_on) return `${prefix}${md(a)}, ${a.getFullYear()}`;
  if (a.getFullYear() === z.getFullYear()) return `${prefix}${md(a)} – ${md(z)}, ${z.getFullYear()}`;
  return `${prefix}${md(a)}, ${a.getFullYear()} – ${md(z)}, ${z.getFullYear()}`;
}

/** One line each: availability ("Mon E/L · Thu E"), frequency, grades, notes. */
export function volunteerTooltipLines(
  v: RosterDetail,
  availability: readonly AvailabilityRow[],
  blackouts: readonly BlackoutRow[] = [],
): string[] {
  const away = blackouts
    .filter((b) => b.volunteer_id === v.id)
    .sort((a, b) => a.starts_on.localeCompare(b.starts_on))
    .map(formatBlackout);
  const byDay = new Map<number, Set<string>>();
  for (const a of availability) {
    if (a.volunteer_id !== v.id) continue;
    let slots = byDay.get(a.weekday);
    if (!slots) {
      slots = new Set();
      byDay.set(a.weekday, slots);
    }
    slots.add(a.slot);
  }
  const avail = [1, 2, 3, 4]
    .filter((d) => byDay.has(d))
    .map((d) => {
      const slots = byDay.get(d)!;
      const label = slots.has('early') && slots.has('late') ? 'E/L' : slots.has('early') ? 'E' : 'L';
      return `${WEEKDAY_SHORT[d]} ${label}`;
    })
    .join(' · ');
  const freq =
    FREQ_LABEL[v.frequency] +
    (v.frequency === 'custom' && v.frequency_note ? ` (${v.frequency_note})` : '');
  return [
    `Avail: ${avail || 'none listed'}`,
    `Freq: ${freq}${v.backfill ? ' · backfill' : ''}`,
    v.veteran ? 'Veteran — can take a shift alone' : 'New — pair with a veteran',
    away.length ? `Away: ${away.join(' · ')}` : '',
    v.grades ? `Grades: ${v.grades}` : '',
    v.notes ? `Notes: ${v.notes}` : '',
  ].filter(Boolean);
}
