import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Alert,
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
  TextField,
} from '@apygee/atoms';
import { supabase } from '../supabase';
import {
  buildDraft,
  isSchoolDay,
  weekdayOf,
  type AssignmentRow,
  type AvailabilityRow,
  type DraftPlan,
  type RosterVolunteer,
  type ShiftRow,
  type Slot,
} from '../schedule';

type Closure = { date: string; reason: string | null };
type SchoolYear = { starts_on: string; ends_on: string };
type DayShift = ShiftRow & { volunteers: { id: string; name: string }[] };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLOT_LABEL: Record<Slot, string> = {
  '11:30': 'Early (11:30–12:30)',
  '12:30': 'Late (12:30–1:30)',
};

async function chunkedInsert(table: string, rows: Record<string, unknown>[]): Promise<string | null> {
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabase.from(table).insert(rows.slice(i, i + 200));
    if (error) return error.message;
  }
  return null;
}

export function SchedulePage() {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // School year
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [savingYear, setSavingYear] = useState(false);

  // Closures
  const [closures, setClosures] = useState<Closure[]>([]);
  const [closureDate, setClosureDate] = useState('');
  const [closureReason, setClosureReason] = useState('');
  const [closureBusy, setClosureBusy] = useState<string | null>(null);

  // Generation
  const [genFrom, setGenFrom] = useState('');
  const [genTo, setGenTo] = useState('');
  const [generating, setGenerating] = useState(false);
  const [summary, setSummary] = useState<DraftPlan['summary'] | null>(null);

  // Day editor
  const [dayDate, setDayDate] = useState('');
  const [dayShifts, setDayShifts] = useState<DayShift[] | null>(null);
  const [roster, setRoster] = useState<RosterVolunteer[]>([]);
  const [dayAvailability, setDayAvailability] = useState<AvailabilityRow[]>([]);
  const [dayBusy, setDayBusy] = useState<string | null>(null);

  const loadBase = useCallback(async () => {
    setError(null);
    const [yearRes, closuresRes] = await Promise.all([
      supabase.from('school_year').select('starts_on, ends_on').maybeSingle(),
      supabase.from('school_closures').select('date, reason').order('date', { ascending: true }),
    ]);
    if (yearRes.error || closuresRes.error) {
      setError((yearRes.error ?? closuresRes.error)!.message);
    } else {
      if (yearRes.data) {
        const year = yearRes.data as SchoolYear;
        setStartsOn(year.starts_on);
        setEndsOn(year.ends_on);
        setGenFrom((prev) => prev || year.starts_on);
        setGenTo((prev) => prev || year.ends_on);
      }
      setClosures((closuresRes.data ?? []) as Closure[]);
    }
    setIsLoading(false);
  }, []);

  const loadClosures = useCallback(async () => {
    const { data, error: closuresError } = await supabase
      .from('school_closures')
      .select('date, reason')
      .order('date', { ascending: true });
    if (closuresError) {
      setError(closuresError.message);
      return;
    }
    setClosures((data ?? []) as Closure[]);
  }, []);

  useEffect(() => {
    loadBase();
  }, [loadBase]);

  async function saveYear(event: FormEvent) {
    event.preventDefault();
    if (!DATE_RE.test(startsOn) || !DATE_RE.test(endsOn) || endsOn < startsOn) {
      setError('School year needs valid YYYY-MM-DD dates with the end after the start.');
      return;
    }
    setSavingYear(true);
    setError(null);
    setNotice(null);
    const { data, error: upsertError } = await supabase
      .from('school_year')
      .upsert({ id: true, starts_on: startsOn, ends_on: endsOn })
      .select('id');
    setSavingYear(false);
    if (upsertError || (data ?? []).length === 0) {
      setError(upsertError?.message ?? 'Could not save the school year.');
      return;
    }
    setNotice('School year saved.');
  }

  async function addClosure(event: FormEvent) {
    event.preventDefault();
    if (!DATE_RE.test(closureDate)) {
      setError('Closure date must be YYYY-MM-DD.');
      return;
    }
    setClosureBusy('add');
    setError(null);
    setNotice(null);
    const { data, error: insertError } = await supabase
      .from('school_closures')
      .insert({ date: closureDate, reason: closureReason.trim() || null })
      .select('date');
    if (insertError || (data ?? []).length === 0) {
      setClosureBusy(null);
      setError(insertError?.message ?? 'Could not add the closure.');
      return;
    }
    // Marking a non-school day removes its shifts (cascade removes assignments).
    const { data: removedShifts, error: deleteError } = await supabase
      .from('green_team_shifts')
      .delete()
      .eq('date', closureDate)
      .select('id');
    setClosureBusy(null);
    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    setNotice(
      `Closure added${(removedShifts ?? []).length ? ` — removed ${removedShifts!.length} shifts on that day` : ''}.`,
    );
    setClosureDate('');
    setClosureReason('');
    await loadClosures();
  }

  async function removeClosure(date: string) {
    setClosureBusy(date);
    setError(null);
    setNotice(null);
    const { data, error: deleteError } = await supabase
      .from('school_closures')
      .delete()
      .eq('date', date)
      .select('date');
    setClosureBusy(null);
    if (deleteError || (data ?? []).length === 0) {
      setError(deleteError?.message ?? 'Could not remove the closure.');
      return;
    }
    await loadClosures();
  }

  async function generate() {
    if (!DATE_RE.test(genFrom) || !DATE_RE.test(genTo) || genTo < genFrom) {
      setError('Generation range needs valid YYYY-MM-DD dates with the end after the start.');
      return;
    }
    if (!startsOn || !endsOn) {
      setError('Set the school year first.');
      return;
    }
    const from = genFrom < startsOn ? startsOn : genFrom;
    const to = genTo > endsOn ? endsOn : genTo;
    setGenerating(true);
    setError(null);
    setNotice(null);
    setSummary(null);

    // Trailing window: budget scoring needs assignments up to 27 days back.
    const [wy, wm, wd] = from.split('-').map(Number);
    const windowStart = new Date(wy!, (wm ?? 1) - 1, (wd ?? 1) - 27);
    const pad = (n: number) => String(n).padStart(2, '0');
    const windowStartIso = `${windowStart.getFullYear()}-${pad(windowStart.getMonth() + 1)}-${pad(windowStart.getDate())}`;

    const [shiftsRes, availabilityRes, volunteersRes, closuresRes] = await Promise.all([
      supabase
        .from('green_team_shifts')
        .select('id, date, slot')
        .gte('date', windowStartIso)
        .lte('date', to),
      supabase.from('availability').select('volunteer_id, weekday, slot'),
      supabase.from('volunteers').select('id, name, frequency, backfill'),
      supabase.from('school_closures').select('date, reason'),
    ]);
    const fetchError =
      shiftsRes.error ?? availabilityRes.error ?? volunteersRes.error ?? closuresRes.error;
    if (fetchError) {
      setGenerating(false);
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
        setGenerating(false);
        setError(aErr.message);
        return;
      }
      existingAssignments = existingAssignments.concat((data ?? []) as AssignmentRow[]);
    }

    const plan = buildDraft({
      from,
      to,
      closures: new Set(((closuresRes.data ?? []) as Closure[]).map((c) => c.date)),
      existingShifts,
      existingAssignments,
      availability: (availabilityRes.data ?? []) as AvailabilityRow[],
      volunteers: (volunteersRes.data ?? []) as RosterVolunteer[],
      newId: () => crypto.randomUUID(),
    });

    const shiftError = await chunkedInsert('green_team_shifts', plan.shiftInserts);
    if (shiftError) {
      setGenerating(false);
      setError(shiftError);
      return;
    }
    const assignError = await chunkedInsert('shift_volunteers', plan.assignmentInserts);
    setGenerating(false);
    if (assignError) {
      setError(assignError);
      return;
    }
    setSummary(plan.summary);
    if (dayShifts) await loadDay();
  }

  const loadDay = useCallback(async () => {
    if (!DATE_RE.test(dayDate)) {
      setError('Day to adjust must be YYYY-MM-DD.');
      return;
    }
    setError(null);
    const weekday = weekdayOf(dayDate);
    const [shiftsRes, rosterRes, availRes] = await Promise.all([
      supabase
        .from('green_team_shifts')
        .select('id, date, slot, volunteers:volunteers!shift_volunteers ( id, name )')
        .eq('date', dayDate),
      supabase.from('volunteers').select('id, name, frequency, backfill').order('name'),
      supabase
        .from('availability')
        .select('volunteer_id, weekday, slot')
        .eq('weekday', weekday),
    ]);
    const loadError = shiftsRes.error ?? rosterRes.error ?? availRes.error;
    if (loadError) {
      setError(loadError.message);
      return;
    }
    const shifts = ((shiftsRes.data ?? []) as unknown as DayShift[]).sort((a, b) =>
      a.slot.localeCompare(b.slot),
    );
    setDayShifts(shifts);
    setRoster((rosterRes.data ?? []) as RosterVolunteer[]);
    setDayAvailability((availRes.data ?? []) as AvailabilityRow[]);
  }, [dayDate]);

  async function addToShift(shift: DayShift, volunteerId: string) {
    setDayBusy(`${shift.id}:${volunteerId}`);
    setError(null);
    const { data, error: insertError } = await supabase
      .from('shift_volunteers')
      .insert({ shift_id: shift.id, volunteer_id: volunteerId })
      .select('shift_id');
    setDayBusy(null);
    if (insertError || (data ?? []).length === 0) {
      setError(insertError?.message ?? 'Could not add the volunteer.');
      return;
    }
    await loadDay();
  }

  async function removeFromShift(shift: DayShift, volunteerId: string) {
    setDayBusy(`${shift.id}:${volunteerId}`);
    setError(null);
    const { data, error: deleteError } = await supabase
      .from('shift_volunteers')
      .delete()
      .eq('shift_id', shift.id)
      .eq('volunteer_id', volunteerId)
      .select('shift_id');
    setDayBusy(null);
    if (deleteError || (data ?? []).length === 0) {
      setError(deleteError?.message ?? 'Could not remove the volunteer.');
      return;
    }
    await loadDay();
  }

  function candidatesFor(shift: DayShift): { available: RosterVolunteer[]; backfill: RosterVolunteer[]; others: RosterVolunteer[] } {
    const assigned = new Set(shift.volunteers.map((v) => v.id));
    const availableIds = new Set(
      dayAvailability.filter((a) => a.slot === shift.slot).map((a) => a.volunteer_id),
    );
    const available: RosterVolunteer[] = [];
    const backfill: RosterVolunteer[] = [];
    const others: RosterVolunteer[] = [];
    for (const v of roster) {
      if (assigned.has(v.id)) continue;
      if (availableIds.has(v.id)) available.push(v);
      else if (v.backfill) backfill.push(v);
      else others.push(v);
    }
    return { available, backfill, others };
  }

  return (
    <PageShell width="lg">
      <Stack gap="xl">
        <PageHeader
          eyebrow="Green Team · Admin"
          title="Schedule"
          description="Set the school year, mark no-school days, and generate the shift schedule."
        />

        {error ? <Alert tone="danger" title="Something went wrong" description={error} /> : null}
        {notice ? <Alert tone="info" title="Done" description={notice} /> : null}

        {isLoading ? (
          <Stack gap="md" align="center">
            <Spinner />
          </Stack>
        ) : (
          <>
            <Card padding="lg" surface="raised">
              <form onSubmit={saveYear}>
                <Stack gap="md">
                  <SectionTitle>School year</SectionTitle>
                  <Inline gap="md" wrap>
                    <TextField
                      label="First day"
                      name="startsOn"
                      placeholder="2026-09-08"
                      value={startsOn}
                      onChange={(e) => setStartsOn(e.currentTarget.value)}
                    />
                    <TextField
                      label="Last day"
                      name="endsOn"
                      placeholder="2027-06-18"
                      value={endsOn}
                      onChange={(e) => setEndsOn(e.currentTarget.value)}
                    />
                  </Inline>
                  <Button type="submit" disabled={savingYear}>
                    {savingYear ? 'Saving…' : 'Save school year'}
                  </Button>
                </Stack>
              </form>
            </Card>

            <Card padding="lg" surface="raised">
              <Stack gap="md">
                <SectionTitle>No-school days</SectionTitle>
                {closures.length === 0 ? (
                  <Body>No closures yet — holidays and vacation days go here.</Body>
                ) : (
                  <Stack gap="sm">
                    {closures.map((c) => (
                      <Inline key={c.date} gap="md" align="center" wrap>
                        <Strong>{c.date}</Strong>
                        {c.reason ? <Body>{c.reason}</Body> : null}
                        <Button
                          variant="secondary"
                          onClick={() => removeClosure(c.date)}
                          disabled={closureBusy === c.date}
                        >
                          {closureBusy === c.date ? 'Removing…' : 'Remove'}
                        </Button>
                      </Inline>
                    ))}
                  </Stack>
                )}
                <Divider />
                <form onSubmit={addClosure}>
                  <Stack gap="md">
                    <Inline gap="md" wrap>
                      <TextField
                        label="Date"
                        name="closureDate"
                        placeholder="2026-11-26"
                        value={closureDate}
                        onChange={(e) => setClosureDate(e.currentTarget.value)}
                      />
                      <TextField
                        label="Reason (optional)"
                        name="closureReason"
                        placeholder="Thanksgiving"
                        value={closureReason}
                        onChange={(e) => setClosureReason(e.currentTarget.value)}
                      />
                    </Inline>
                    <Caption>
                      Adding a closure also removes any shifts already scheduled that day.
                    </Caption>
                    <Button type="submit" disabled={closureBusy === 'add'}>
                      {closureBusy === 'add' ? 'Adding…' : 'Add no-school day'}
                    </Button>
                  </Stack>
                </form>
              </Stack>
            </Card>

            <Card padding="lg" surface="raised">
              <Stack gap="md">
                <SectionTitle>Generate schedule</SectionTitle>
                <Caption>
                  Fills every school-day shift up to 2 volunteers from availability, respecting how
                  often each person wants to serve. Existing assignments are kept.
                </Caption>
                <Inline gap="md" wrap>
                  <TextField
                    label="From"
                    name="genFrom"
                    placeholder="2026-09-08"
                    value={genFrom}
                    onChange={(e) => setGenFrom(e.currentTarget.value)}
                  />
                  <TextField
                    label="To"
                    name="genTo"
                    placeholder="2026-12-18"
                    value={genTo}
                    onChange={(e) => setGenTo(e.currentTarget.value)}
                  />
                </Inline>
                <Button onClick={generate} disabled={generating}>
                  {generating ? 'Generating…' : 'Generate draft'}
                </Button>
                {summary ? (
                  <Stack gap="xs">
                    <Body>
                      {`${summary.schoolDays} school days · ${summary.shiftsCreated} new shifts · ${summary.slotsFilled} slots filled`}
                    </Body>
                    {summary.unfilled.length > 0 ? (
                      <Caption>
                        {`Understaffed: ${summary.unfilled
                          .map((u) => `${u.date} ${SLOT_LABEL[u.slot]} (${u.assigned}/2)`)
                          .join(', ')}`}
                      </Caption>
                    ) : (
                      <Caption>Every shift has 2 volunteers.</Caption>
                    )}
                  </Stack>
                ) : null}
              </Stack>
            </Card>

            <Card padding="lg" surface="raised">
              <Stack gap="md">
                <SectionTitle>Adjust a day</SectionTitle>
                <Inline gap="md" align="center" wrap>
                  <TextField
                    label="Date"
                    name="dayDate"
                    placeholder="2026-09-15"
                    value={dayDate}
                    onChange={(e) => setDayDate(e.currentTarget.value)}
                  />
                  <Button onClick={loadDay}>Load day</Button>
                </Inline>

                {dayShifts === null ? null : dayShifts.length === 0 ? (
                  <Body>
                    {isSchoolDay(dayDate, new Set(closures.map((c) => c.date)))
                      ? 'No shifts exist for this date yet — generate the schedule first.'
                      : 'Not a school day (weekend or closure).'}
                  </Body>
                ) : (
                  <Stack gap="lg">
                    {dayShifts.map((shift) => {
                      const groups = candidatesFor(shift);
                      return (
                        <Stack key={shift.id} gap="sm">
                          <Strong>{SLOT_LABEL[shift.slot]}</Strong>
                          {shift.volunteers.length === 0 ? (
                            <Body>Nobody assigned.</Body>
                          ) : (
                            <Stack gap="xs">
                              {shift.volunteers.map((v) => (
                                <Inline key={v.id} gap="sm" align="center" wrap>
                                  <Body>{v.name}</Body>
                                  <Button
                                    variant="secondary"
                                    onClick={() => removeFromShift(shift, v.id)}
                                    disabled={dayBusy === `${shift.id}:${v.id}`}
                                  >
                                    {dayBusy === `${shift.id}:${v.id}` ? 'Removing…' : 'Remove'}
                                  </Button>
                                </Inline>
                              ))}
                            </Stack>
                          )}
                          {(
                            [
                              ['Available', groups.available],
                              ['Backfill list', groups.backfill],
                              ['Everyone else', groups.others],
                            ] as const
                          ).map(([label, group]) =>
                            group.length === 0 ? null : (
                              <Stack key={label} gap="xs">
                                <Caption>{label}</Caption>
                                <Inline gap="sm" wrap>
                                  {group.map((v) => (
                                    <Button
                                      key={v.id}
                                      variant="ghost"
                                      onClick={() => addToShift(shift, v.id)}
                                      disabled={dayBusy === `${shift.id}:${v.id}`}
                                    >
                                      {dayBusy === `${shift.id}:${v.id}` ? 'Adding…' : `+ ${v.name}`}
                                    </Button>
                                  ))}
                                </Inline>
                              </Stack>
                            ),
                          )}
                          <Divider />
                        </Stack>
                      );
                    })}
                  </Stack>
                )}
              </Stack>
            </Card>
          </>
        )}
      </Stack>
    </PageShell>
  );
}
