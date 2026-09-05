import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Body,
  Button,
  Caption,
  Card,
  Divider,
  Inline,
  PageHeader,
  PageShell,
  SectionTitle,
  Spinner,
  Stack,
  Strong,
  Tooltip,
} from '@apygee/atoms';
import { supabase } from '../supabase';
import {
  buildDraft,
  isoDate,
  SLOT_LABEL,
  SLOTS,
  toLocalDate,
  TRAILING_WINDOW_DAYS,
  type AssignmentRow,
  type AvailabilityRow,
  type DraftPlan,
  type RosterVolunteer,
  type ShiftRow,
  type Slot,
} from '../schedule';
import {
  FREQ_LABEL,
  ROSTER_DETAIL_SELECT,
  volunteerTooltipLines,
  type RosterDetail,
} from '../volunteerInfo';

type SchoolYear = { starts_on: string; ends_on: string };
type MonthShift = ShiftRow & {
  assignments: { volunteer: { id: string; name: string } }[];
};
type Person = { id: string; name: string };

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

// "2026-09" -> the month's [first, last] ISO dates.
function monthRange(ym: string): { from: string; to: string } {
  const [y, m] = ym.split('-').map(Number);
  return {
    from: isoDate(new Date(y!, m! - 1, 1)),
    to: isoDate(new Date(y!, m!, 0)),
  };
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTH_NAMES[m! - 1]} ${y}`;
}

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y!, m! - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

type Preview = {
  month: string;
  plan: DraftPlan;
  // volunteer id -> new assignments this preview would add
  loads: Array<{ volunteer: RosterVolunteer; added: number }>;
  // every drafted (not yet saved) pick, resolved to date/slot/person
  added: Array<{ date: string; slot: Slot; person: Person }>;
};

// "2026-09-14" -> "Mon, Sep 14"
function dayLabel(iso: string): string {
  return toLocalDate(iso).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

async function chunkedInsert(
  table: string,
  rows: Record<string, unknown>[],
): Promise<string | null> {
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabase.from(table).insert(rows.slice(i, i + 200));
    if (error) return error.message;
  }
  return null;
}

export function PlanPage() {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [year, setYear] = useState<SchoolYear | null>(null);
  const [month, setMonth] = useState('');
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [monthShifts, setMonthShifts] = useState<MonthShift[]>([]);
  const [roster, setRoster] = useState<RosterDetail[]>([]);
  const [availability, setAvailability] = useState<AvailabilityRow[]>([]);

  // Roster details + full availability back the hover tooltips on pills.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      supabase.from('volunteers').select(ROSTER_DETAIL_SELECT).order('name'),
      supabase.from('availability').select('volunteer_id, weekday, slot'),
    ]).then(([rosterRes, availRes]) => {
      if (cancelled) return;
      if (rosterRes.error || availRes.error) {
        setError((rosterRes.error ?? availRes.error)!.message);
        return;
      }
      setRoster((rosterRes.data ?? []) as RosterDetail[]);
      setAvailability((availRes.data ?? []) as AvailabilityRow[]);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The month's saved schedule (shifts with assigned volunteer names).
  const loadMonth = useCallback(async (ym: string) => {
    const range = monthRange(ym);
    const { data, error: shiftsError } = await supabase
      .from('green_team_shifts')
      .select('id, date, slot, assignments:shift_volunteers ( volunteer:volunteers ( id, name ) )')
      .gte('date', range.from)
      .lte('date', range.to);
    if (shiftsError) setError(shiftsError.message);
    else setMonthShifts((data ?? []) as unknown as MonthShift[]);
  }, []);

  useEffect(() => {
    if (month) loadMonth(month);
  }, [month, loadMonth]);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from('school_year')
      .select('starts_on, ends_on')
      .maybeSingle()
      .then(({ data, error: yearError }) => {
        if (cancelled) return;
        if (yearError) setError(yearError.message);
        else if (!data) setError('Set the school year on the Schedule page first.');
        else {
          const y = data as SchoolYear;
          setYear(y);
          // Default to the current month, clamped inside the school year.
          const now = isoDate(new Date()).slice(0, 7);
          const first = y.starts_on.slice(0, 7);
          const last = y.ends_on.slice(0, 7);
          setMonth(now < first ? first : now > last ? last : now);
        }
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const canPrev = useMemo(
    () => Boolean(year && month && shiftMonth(month, -1) >= year.starts_on.slice(0, 7)),
    [year, month],
  );
  const canNext = useMemo(
    () => Boolean(year && month && shiftMonth(month, 1) <= year.ends_on.slice(0, 7)),
    [year, month],
  );

  function move(delta: number) {
    setPreview(null);
    setNotice(null);
    setMonth((m) => shiftMonth(m, delta));
  }

  async function runPreview() {
    if (!year || !month) return;
    const range = monthRange(month);
    const from = range.from < year.starts_on ? year.starts_on : range.from;
    const to = range.to > year.ends_on ? year.ends_on : range.to;
    setBusy('preview');
    setError(null);
    setNotice(null);
    setPreview(null);

    // Budget scoring looks back up to 27 days before the month starts.
    const fromDate = toLocalDate(from);
    const windowStartIso = isoDate(
      new Date(
        fromDate.getFullYear(),
        fromDate.getMonth(),
        fromDate.getDate() - (TRAILING_WINDOW_DAYS - 1),
      ),
    );

    const [shiftsRes, availabilityRes, volunteersRes, closuresRes] = await Promise.all([
      supabase
        .from('green_team_shifts')
        .select('id, date, slot')
        .gte('date', windowStartIso)
        .lte('date', to),
      supabase.from('availability').select('volunteer_id, weekday, slot'),
      supabase.from('volunteers').select('id, name, frequency, backfill, veteran').order('name'),
      supabase.from('school_closures').select('date'),
    ]);
    const fetchError =
      shiftsRes.error ?? availabilityRes.error ?? volunteersRes.error ?? closuresRes.error;
    if (fetchError) {
      setBusy(null);
      setError(fetchError.message);
      return;
    }
    const existingShifts = (shiftsRes.data ?? []) as ShiftRow[];
    let existingAssignments: AssignmentRow[] = [];
    const shiftIds = existingShifts.map((s) => s.id);
    for (let i = 0; i < shiftIds.length; i += 150) {
      const { data, error: aErr } = await supabase
        .from('shift_volunteers')
        .select('shift_id, volunteer_id')
        .in('shift_id', shiftIds.slice(i, i + 150));
      if (aErr) {
        setBusy(null);
        setError(aErr.message);
        return;
      }
      existingAssignments = existingAssignments.concat((data ?? []) as AssignmentRow[]);
    }

    const volunteers = (volunteersRes.data ?? []) as RosterVolunteer[];
    const plan = buildDraft({
      from,
      to,
      closures: new Set(((closuresRes.data ?? []) as { date: string }[]).map((c) => c.date)),
      existingShifts,
      existingAssignments,
      availability: (availabilityRes.data ?? []) as AvailabilityRow[],
      volunteers,
      newId: () => crypto.randomUUID(),
    });

    const addedById = new Map<string, number>();
    for (const a of plan.assignmentInserts) {
      addedById.set(a.volunteer_id, (addedById.get(a.volunteer_id) ?? 0) + 1);
    }
    const loads = volunteers
      .map((volunteer) => ({ volunteer, added: addedById.get(volunteer.id) ?? 0 }))
      .filter((l) => l.added > 0)
      .sort((a, b) => b.added - a.added || a.volunteer.name.localeCompare(b.volunteer.name));

    const shiftById = new Map(
      [...existingShifts, ...plan.shiftInserts].map((s) => [s.id, s]),
    );
    const nameById = new Map(volunteers.map((v) => [v.id, v.name]));
    const added = plan.assignmentInserts.flatMap((a) => {
      const shift = shiftById.get(a.shift_id);
      return shift
        ? [
            {
              date: shift.date,
              slot: shift.slot,
              person: { id: a.volunteer_id, name: nameById.get(a.volunteer_id) ?? '?' },
            },
          ]
        : [];
    });

    setBusy(null);
    setPreview({ month, plan, loads, added });
  }

  async function apply() {
    if (!preview) return;
    setBusy('apply');
    setError(null);
    setNotice(null);
    const shiftError = await chunkedInsert('green_team_shifts', preview.plan.shiftInserts);
    if (shiftError) {
      setBusy(null);
      setError(shiftError);
      return;
    }
    const assignError = await chunkedInsert('shift_volunteers', preview.plan.assignmentInserts);
    setBusy(null);
    if (assignError) {
      setError(assignError);
      return;
    }
    setNotice(
      `Applied ${monthLabel(preview.month)}: ${preview.plan.shiftInserts.length} shifts, ${preview.plan.assignmentInserts.length} assignments saved.`,
    );
    setPreview(null);
    await loadMonth(preview.month);
  }

  const summary = preview?.plan.summary ?? null;

  // date -> per-slot saved and drafted people, merged for the schedule list.
  const scheduleDays = useMemo(() => {
    const byDate = new Map<string, Record<Slot, { saved: Person[]; drafted: Person[] }>>();
    const cell = (date: string, slot: Slot) => {
      let day = byDate.get(date);
      if (!day) {
        day = { early: { saved: [], drafted: [] }, late: { saved: [], drafted: [] } };
        byDate.set(date, day);
      }
      return day[slot];
    };
    for (const s of monthShifts) {
      const c = cell(s.date, s.slot);
      for (const a of s.assignments) c.saved.push(a.volunteer);
    }
    if (preview?.month === month) {
      for (const a of preview.added) cell(a.date, a.slot).drafted.push(a.person);
    }
    for (const day of byDate.values()) {
      for (const slot of SLOTS) day[slot].saved.sort((x, y) => x.name.localeCompare(y.name));
    }
    return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [monthShifts, preview, month]);

  const hasDraft = Boolean(preview && preview.month === month && preview.added.length > 0);

  return (
    <PageShell width="lg">
      <Stack gap="xl">
        <PageHeader
          eyebrow="Green Team · Admin"
          title="Month planner"
          description="Preview a month's draft schedule before writing anything, then apply it. Re-runs only fill gaps — existing assignments are never touched."
        />

        {error ? <Alert tone="danger" title="Something went wrong" description={error} /> : null}
        {notice ? <Alert tone="info" title="Done" description={notice} /> : null}

        {isLoading ? (
          <Stack gap="md" align="center">
            <Spinner />
          </Stack>
        ) : year && month ? (
          <>
            <Card padding="lg" surface="raised">
              <Stack gap="md">
                <SectionTitle>Pick a month</SectionTitle>
                <Inline gap="sm" align="center" wrap>
                  <Button variant="secondary" onClick={() => move(-1)} disabled={!canPrev}>
                    ← Previous
                  </Button>
                  <Strong>{monthLabel(month)}</Strong>
                  <Button variant="secondary" onClick={() => move(1)} disabled={!canNext}>
                    Next →
                  </Button>
                </Inline>
                <Caption>{`School year ${year.starts_on} to ${year.ends_on}. Preview computes the draft without saving.`}</Caption>
                <Inline gap="sm" wrap>
                  <Button onClick={runPreview} disabled={busy !== null}>
                    {busy === 'preview' ? 'Previewing…' : `Preview ${monthLabel(month)}`}
                  </Button>
                  {preview ? (
                    <Button onClick={apply} disabled={busy !== null}>
                      {busy === 'apply' ? 'Applying…' : 'Apply this draft'}
                    </Button>
                  ) : null}
                </Inline>
              </Stack>
            </Card>

            <Card padding="lg" surface="raised">
              <Stack gap="md">
                <SectionTitle>{`Schedule for ${monthLabel(month)}`}</SectionTitle>
                {hasDraft ? (
                  <Caption>Highlighted pills are drafted — nothing is saved until you press Apply.</Caption>
                ) : null}
                {scheduleDays.length === 0 ? (
                  <Body>No shifts scheduled this month yet. Run Preview to draft one.</Body>
                ) : (
                  <Stack gap="md">
                    {scheduleDays.map(([date, day]) => (
                      <Stack key={date} gap="xs">
                        <Strong>{dayLabel(date)}</Strong>
                        {SLOTS.map((slot) => {
                          const { saved, drafted } = day[slot];
                          const people = [
                            ...saved.map((p) => ({ ...p, drafted: false })),
                            ...drafted.map((p) => ({ ...p, drafted: true })),
                          ];
                          return (
                            <Inline key={slot} gap="sm" align="center" wrap>
                              <Caption>{SLOT_LABEL[slot]}</Caption>
                              {people.length === 0 ? (
                                <Body>—</Body>
                              ) : (
                                people.map((p) => {
                                  const badge = (
                                    <Badge tone={p.drafted ? 'warning' : 'neutral'}>{p.name}</Badge>
                                  );
                                  const v = roster.find((r) => r.id === p.id);
                                  return v ? (
                                    <Tooltip
                                      key={p.id}
                                      label={
                                        <>
                                          {volunteerTooltipLines(v, availability).map((line) => (
                                            <div key={line}>{line}</div>
                                          ))}
                                        </>
                                      }
                                    >
                                      {badge}
                                    </Tooltip>
                                  ) : (
                                    <span key={p.id}>{badge}</span>
                                  );
                                })
                              )}
                            </Inline>
                          );
                        })}
                      </Stack>
                    ))}
                  </Stack>
                )}
              </Stack>
            </Card>

            {preview && summary ? (
              <Card padding="lg" surface="raised">
                <Stack gap="md">
                  <SectionTitle>{`Draft for ${monthLabel(preview.month)}`}</SectionTitle>
                  <Body>
                    {`${summary.schoolDays} school days · ${summary.shiftsCreated} new shifts · ${summary.assignments} assignments · ${summary.openSlots} slots left open for claiming`}
                  </Body>

                  <Divider />

                  <SectionTitle>Who gets drafted</SectionTitle>
                  {preview.loads.length === 0 ? (
                    <Body>No new assignments — the month is already fully scheduled.</Body>
                  ) : (
                    <Stack gap="xs">
                      {preview.loads.map(({ volunteer, added }) => (
                        <Inline key={volunteer.id} gap="sm" align="center" wrap>
                          <Strong>{volunteer.name}</Strong>
                          <Body>{`${added} ${added === 1 ? 'shift' : 'shifts'}`}</Body>
                          <Caption>{`asked for ${FREQ_LABEL[volunteer.frequency]}${volunteer.backfill ? ' · backfill' : ''}`}</Caption>
                        </Inline>
                      ))}
                    </Stack>
                  )}
                  <Caption>Nothing is saved until you press Apply.</Caption>
                </Stack>
              </Card>
            ) : null}
          </>
        ) : null}
      </Stack>
    </PageShell>
  );
}
