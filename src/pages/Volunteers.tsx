import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Body,
  Button,
  Caption,
  Inline,
  PageHeader,
  PageShell,
  Spinner,
  Stack,
  Strong,
} from '@apygee/atoms';
import { DataTable, type DataTableColumnDef } from '@apygee/data-table';
import { supabase } from '../supabase';

type AvailabilityRow = { volunteer_id: string; weekday: number; slot: string };

type Volunteer = {
  id: string;
  email: string;
  name: string;
  veteran: boolean;
  grades: string | null;
  frequency: 'monthly' | 'biweekly' | 'custom';
  frequency_note: string | null;
  cori: 'yes' | 'no' | 'unsure';
  backfill: boolean;
  notes: string | null;
};

type Row = Volunteer & { availability: string };

const WEEKDAY_SHORT = ['', 'Mon', 'Tue', 'Wed', 'Thu'];
const FREQ_LABEL: Record<Volunteer['frequency'], string> = {
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

const COLUMNS: DataTableColumnDef<Row>[] = [
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

export function VolunteersPage() {
  const [filter, setFilter] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<{ message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [volunteers, setVolunteers] = useState<Volunteer[]>([]);
  const [availability, setAvailability] = useState<AvailabilityRow[]>([]);

  const load = useCallback(async () => {
    const [volsRes, availRes] = await Promise.all([
      supabase
        .from('volunteers')
        .select('id, email, name, veteran, grades, frequency, frequency_note, cori, backfill, notes')
        .order('name'),
      supabase.from('availability').select('volunteer_id, weekday, slot'),
    ]);
    setError(volsRes.error ?? availRes.error);
    setVolunteers((volsRes.data ?? []) as Volunteer[]);
    setAvailability((availRes.data ?? []) as AvailabilityRow[]);
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
      .map((v) => ({ ...v, availability: availabilityLabel(byVolunteer.get(v.id) ?? []) }))
      .filter(
        (v) =>
          !q ||
          [v.name, v.email, v.grades ?? '', v.notes ?? '']
            .join(' ')
            .toLowerCase()
            .includes(q),
      );
  }, [volunteers, availability, filter]);

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
            columns={COLUMNS}
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
      </Stack>
    </PageShell>
  );
}
