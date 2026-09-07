import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Alert,
  Body,
  Button,
  Caption,
  Dialog,
  Inline,
  PageHeader,
  PageShell,
  Spinner,
  Stack,
  Strong,
  TextField,
} from '@apygee/atoms';
import { DataTable, type DataTableColumnDef } from '@apygee/data-table';
import { supabase } from '../supabase';
import { formatBlackout, parseUserDate, type Blackout } from '../volunteerInfo';

type AvailabilityRow = { volunteer_id: string; weekday: number; slot: string };

type Volunteer = {
  id: string;
  email: string;
  name: string;
  veteran: boolean;
  grades: string | null;
  frequency: 'weekly' | 'biweekly' | 'monthly' | 'custom';
  frequency_note: string | null;
  cori: 'yes' | 'no' | 'unsure';
  backfill: boolean;
  notes: string | null;
};

type Row = Volunteer & { availability: string; blackouts: Blackout[] };

const WEEKDAY_SHORT = ['', 'Mon', 'Tue', 'Wed', 'Thu'];
const FREQ_LABEL: Record<Volunteer['frequency'], string> = {
  weekly: '1×/week',
  monthly: '1×/month',
  biweekly: '2×/month',
  custom: 'custom',
};

// "Mon E/L · Thu E" — E = early (11:05–12:15), L = late (12:20–1:30).
function availabilityLabel(rows: AvailabilityRow[]): string {
  const byDay = new Map<number, Set<string>>();
  for (const r of rows) {
    let slots = byDay.get(r.weekday);
    if (!slots) {
      slots = new Set();
      byDay.set(r.weekday, slots);
    }
    slots.add(r.slot);
  }
  const parts = [1, 2, 3, 4]
    .filter((d) => byDay.has(d))
    .map((d) => {
      const slots = byDay.get(d)!;
      const label =
        slots.has('early') && slots.has('late') ? 'E/L' : slots.has('early') ? 'E' : 'L';
      return `${WEEKDAY_SHORT[d]} ${label}`;
    });
  return parts.join(' · ') || '—';
}

function buildColumns(onManageBlackouts: (v: Row) => void): DataTableColumnDef<Row>[] {
  return [
  {
    id: 'name',
    header: 'Volunteer',
    accessorFn: (v) => v.name,
    size: 220,
    cell: ({ row }) => (
      <Stack gap="xs">
        <Strong>{row.original.name}</Strong>
        <Caption>{row.original.email}</Caption>
      </Stack>
    ),
  },
  {
    id: 'availability',
    header: 'Availability',
    enableSorting: false,
    accessorFn: (v) => v.availability,
    size: 180,
    cell: ({ row }) => <Body>{row.original.availability}</Body>,
  },
  {
    id: 'frequency',
    header: 'Frequency',
    accessorFn: (v) => v.frequency,
    size: 140,
    cell: ({ row }) => (
      <Stack gap="xs">
        <Body>{FREQ_LABEL[row.original.frequency]}</Body>
        {row.original.frequency === 'custom' && row.original.frequency_note ? (
          <Caption>{row.original.frequency_note}</Caption>
        ) : null}
      </Stack>
    ),
  },
  {
    id: 'flags',
    header: 'Flags',
    enableSorting: false,
    accessorFn: (v) =>
      [v.backfill ? 'backfill' : '', v.veteran ? 'veteran' : '', `cori-${v.cori}`].join(' '),
    size: 160,
    cell: ({ row }) => {
      const flags = [
        row.original.backfill ? 'Backfill' : null,
        row.original.veteran ? 'Veteran' : null,
        row.original.cori === 'yes' ? 'CORI ✓' : row.original.cori === 'no' ? 'CORI ✗' : 'CORI ?',
      ].filter(Boolean);
      return <Caption>{flags.join(' · ')}</Caption>;
    },
  },
  {
    id: 'blackouts',
    header: 'Away',
    enableSorting: false,
    accessorFn: (v) => v.blackouts.map(formatBlackout).join(' '),
    size: 220,
    cell: ({ row }) => (
      <Stack gap="xs">
        {row.original.blackouts.length === 0 ? (
          <Caption>—</Caption>
        ) : (
          row.original.blackouts.map((b) => <Caption key={b.id}>{formatBlackout(b)}</Caption>)
        )}
        <span>
          <Button variant="ghost" size="sm" onClick={() => onManageBlackouts(row.original)}>
            {row.original.blackouts.length ? 'Edit' : 'Add dates'}
          </Button>
        </span>
      </Stack>
    ),
  },
  {
    id: 'grades',
    header: 'Grades',
    enableSorting: false,
    accessorFn: (v) => v.grades ?? '',
    size: 160,
    cell: ({ row }) => <Caption>{row.original.grades ?? '—'}</Caption>,
  },
  {
    id: 'notes',
    header: 'Notes',
    enableSorting: false,
    accessorFn: (v) => v.notes ?? '',
    size: 280,
    cell: ({ row }) => <Caption>{row.original.notes ?? ''}</Caption>,
  },
  ];
}

/**
 * Per-volunteer blackout windows: any number of inclusive date ranges they
 * can't do at all. Dates accept 9/1/2025 or 2025-09-01; leave "To" blank for
 * a single day.
 */
function BlackoutDialog({
  volunteer,
  onClose,
  onChanged,
}: {
  volunteer: Row | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setFrom('');
    setTo('');
    setNote('');
    setFormError(null);
  }, [volunteer?.id]);

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!volunteer) return;
    const starts = parseUserDate(from);
    const ends = to.trim() ? parseUserDate(to) : starts;
    if (!starts) return setFormError('Enter a start date like 9/1/2025.');
    if (!ends) return setFormError('Enter an end date like 9/14/2025, or leave it blank for one day.');
    if (ends < starts) return setFormError('The end date is before the start date.');
    setBusy(true);
    setFormError(null);
    const { error } = await supabase
      .from('volunteer_blackouts')
      .insert({ volunteer_id: volunteer.id, starts_on: starts, ends_on: ends, note: note.trim() || null });
    setBusy(false);
    if (error) return setFormError(error.message);
    setFrom('');
    setTo('');
    setNote('');
    await onChanged();
  }

  async function remove(id: string) {
    setBusy(true);
    const { error } = await supabase.from('volunteer_blackouts').delete().eq('id', id);
    setBusy(false);
    if (error) return setFormError(error.message);
    await onChanged();
  }

  const sorted = [...(volunteer?.blackouts ?? [])].sort((a, b) => a.starts_on.localeCompare(b.starts_on));

  return (
    <Dialog
      open={volunteer !== null}
      onClose={onClose}
      title={volunteer ? `${volunteer.name} — away dates` : ''}
      description="Dates they can't volunteer at all. The scheduler and cover requests skip these windows."
      footer={
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      }
    >
      <Stack gap="lg">
        {sorted.length === 0 ? (
          <Caption>No away dates yet.</Caption>
        ) : (
          <Stack gap="sm">
            {sorted.map((b) => (
              <Inline key={b.id} gap="sm" align="center" justify="between" wrap>
                <Stack gap="xs">
                  <Body>{formatBlackout(b)}</Body>
                  {b.note ? <Caption>{b.note}</Caption> : null}
                </Stack>
                <Button variant="ghost" size="sm" onClick={() => remove(b.id)} disabled={busy}>
                  Remove
                </Button>
              </Inline>
            ))}
          </Stack>
        )}
        <form onSubmit={add}>
          <Stack gap="sm">
            <Strong>Add a window</Strong>
            <Inline gap="sm" wrap>
              <TextField
                label="From"
                placeholder="9/1/2025"
                value={from}
                onChange={(e) => setFrom(e.currentTarget.value)}
                required
              />
              <TextField
                label="To (optional)"
                placeholder="9/14/2025"
                value={to}
                onChange={(e) => setTo(e.currentTarget.value)}
              />
            </Inline>
            <TextField
              label="Note (optional)"
              placeholder="Vacation"
              value={note}
              onChange={(e) => setNote(e.currentTarget.value)}
            />
            {formError ? <Alert tone="danger" title="Check the dates" description={formError} /> : null}
            <span>
              <Button type="submit" disabled={busy || !from.trim()}>
                {busy ? 'Saving…' : 'Add'}
              </Button>
            </span>
          </Stack>
        </form>
      </Stack>
    </Dialog>
  );
}

export function VolunteersPage() {
  const [filter, setFilter] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<{ message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [volunteers, setVolunteers] = useState<Volunteer[]>([]);
  const [availability, setAvailability] = useState<AvailabilityRow[]>([]);
  const [blackouts, setBlackouts] = useState<Blackout[]>([]);
  const [managing, setManaging] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [volsRes, availRes, blackoutRes] = await Promise.all([
      supabase
        .from('volunteers')
        .select('id, email, name, veteran, grades, frequency, frequency_note, cori, backfill, notes')
        .order('name'),
      supabase.from('availability').select('volunteer_id, weekday, slot'),
      supabase.from('volunteer_blackouts').select('id, volunteer_id, starts_on, ends_on, note'),
    ]);
    setError(volsRes.error ?? availRes.error ?? blackoutRes.error);
    setVolunteers((volsRes.data ?? []) as Volunteer[]);
    setAvailability((availRes.data ?? []) as AvailabilityRow[]);
    setBlackouts((blackoutRes.data ?? []) as Blackout[]);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function resync() {
    setSyncing(true);
    setError(null);
    setNotice(null);
    const { data, error: fnError } = await supabase.functions.invoke('sync-volunteers');
    if (fnError) {
      // FunctionsHttpError carries the response; surface the function's message.
      let message = fnError.message;
      try {
        const ctx = (fnError as { context?: Response }).context;
        if (ctx) message = (await ctx.json()).error ?? message;
      } catch {
        // keep the generic message
      }
      setSyncing(false);
      setError({ message });
      return;
    }
    await load();
    setSyncing(false);
    setNotice(
      `Spreadsheet synced: ${data.imported} of ${data.responses} responses imported${data.skipped ? `, ${data.skipped} skipped (missing email or name)` : ''}.`,
    );
  }

  const rows = useMemo<Row[]>(() => {
    const byVolunteer = new Map<string, AvailabilityRow[]>();
    for (const a of availability) {
      let list = byVolunteer.get(a.volunteer_id);
      if (!list) {
        list = [];
        byVolunteer.set(a.volunteer_id, list);
      }
      list.push(a);
    }
    const q = filter.trim().toLowerCase();
    return volunteers
      .map((v) => ({
        ...v,
        availability: availabilityLabel(byVolunteer.get(v.id) ?? []),
        blackouts: blackouts.filter((b) => b.volunteer_id === v.id),
      }))
      .filter(
        (v) =>
          !q ||
          [v.name, v.email, v.grades ?? '', v.notes ?? '']
            .join(' ')
            .toLowerCase()
            .includes(q),
      );
  }, [volunteers, availability, blackouts, filter]);

  const columns = useMemo(() => buildColumns((v) => setManaging(v.id)), []);
  const managingRow = managing ? (rows.find((r) => r.id === managing) ?? null) : null;

  return (
    <PageShell width="xl">
      <Stack gap="xl">
        <PageHeader
          eyebrow="Green Team · Admin"
          title="Volunteers"
          description="The roster from the sign-up form. Resync pulls the latest responses from the spreadsheet."
        />

        <Inline gap="sm" align="center" wrap>
          <Button onClick={resync} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Resync from spreadsheet'}
          </Button>
          <Caption>Updates volunteers and their availability; in-app sign-ups not on the form are untouched.</Caption>
        </Inline>

        {notice ? <Alert tone="info" title="Synced" description={notice} /> : null}

        {isLoading ? (
          <Stack gap="md" align="center">
            <Spinner />
          </Stack>
        ) : error ? (
          <Alert tone="danger" title="Could not load volunteers" description={error.message} />
        ) : (
          <DataTable<Row>
            data={rows}
            columns={columns}
            ariaLabel="Volunteer roster"
            getRowId={(v) => v.id}
            density="comfortable"
            filterValue={filter}
            onFilterValueChange={setFilter}
            filterPlaceholder="Search name, email, grades, notes…"
            rowCountLabel={(visible) => `${visible} ${visible === 1 ? 'volunteer' : 'volunteers'}`}
            emptyState="No volunteers match your search."
          />
        )}

        <BlackoutDialog volunteer={managingRow} onClose={() => setManaging(null)} onChanged={load} />
      </Stack>
    </PageShell>
  );
}
