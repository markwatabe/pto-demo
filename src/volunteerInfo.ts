/**
 * Shared volunteer display helpers: the roster columns admin pages show on
 * hover, and the tooltip lines built from them.
 */
import type { AvailabilityRow, Frequency, RosterVolunteer } from './schedule';

// Roster rows with the extra columns the hover tooltip shows.
export type RosterDetail = RosterVolunteer & {
  grades: string | null;
  frequency_note: string | null;
  notes: string | null;
};

/** The volunteers select list matching RosterDetail. */
export const ROSTER_DETAIL_SELECT = 'id, name, frequency, backfill, grades, frequency_note, notes';

export const FREQ_LABEL: Record<Frequency, string> = {
  monthly: '1×/month',
  biweekly: '2×/month',
  custom: 'custom',
};

const WEEKDAY_SHORT = ['', 'Mon', 'Tue', 'Wed', 'Thu'];

/** One line each: availability ("Mon E/L · Thu E"), frequency, grades, notes. */
export function volunteerTooltipLines(
  v: RosterDetail,
  availability: readonly AvailabilityRow[],
): string[] {
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
    v.grades ? `Grades: ${v.grades}` : '',
    v.notes ? `Notes: ${v.notes}` : '',
  ].filter(Boolean);
}
