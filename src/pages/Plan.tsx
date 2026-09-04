import { useEffect, useMemo, useState } from 'react';
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
} from '@apygee/atoms';
import { supabase } from '../supabase';
import {
  buildDraft,
  isoDate,
  SLOT_LABEL,
  toLocalDate,
  TRAILING_WINDOW_DAYS,
  type AssignmentRow,
  type AvailabilityRow,
  type DraftPlan,
  type Frequency,
  type RosterVolunteer,
  type ShiftRow,
} from '../schedule';

type SchoolYear = { starts_on: string; ends_on: string };

const FREQ_LABEL: Record<Frequency, string> = {
  monthly: '1×/month',
  biweekly: '2×/month',
  custom: 'custom',
};

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
};

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
      supabase.from('volunteers').select('id, name, frequency, backfill').order('name'),
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

    setBusy(null);
    setPreview({ month, plan, loads });
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
  }

  const summary = preview?.plan.summary ?? null;

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

            {preview && summary ? (
              <Card padding="lg" surface="raised">
                <Stack gap="md">
                  <SectionTitle>{`Draft for ${monthLabel(preview.month)}`}</SectionTitle>
                  <Body>
                    {`${summary.schoolDays} school days · ${summary.shiftsCreated} new shifts · ${summary.slotsFilled} slots filled`}
                  </Body>
                  {summary.overBudgetPicks > 0 ? (
                    <Alert
                      tone="warning"
                      title={`${summary.overBudgetPicks} over-budget picks`}
                      description="Some volunteers are drafted more often than their requested frequency — the roster is thinner than the month needs."
                    />
                  ) : null}
                  {summary.unfilled.length > 0 ? (
                    <Alert
                      tone="warning"
                      title={`${summary.unfilled.length} understaffed slots`}
                      description={summary.unfilled
                        .map((u) => `${u.date} ${SLOT_LABEL[u.slot]} (${u.assigned}/2)`)
                        .join(' · ')}
                    />
                  ) : null}

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
