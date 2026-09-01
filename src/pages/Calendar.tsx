import { useEffect, useMemo, useState } from 'react';
import { Alert, PageHeader, PageShell, Spinner, Stack } from '@apygee/atoms';
import { Calendar } from '@apygee/calendar';
import type { CalendarEvent } from '@apygee/types';
import { supabase } from '../supabase';
import { useAuth } from '../auth';

type Volunteer = { id: string; name: string; email: string };
type Shift = {
  id: string;
  date: string; // ISO date, e.g. "2026-08-24"
  slot: '11:30' | '12:30';
  volunteers: Volunteer[];
};

// Shifts with their assigned volunteers from the roster.
const SHIFTS_SELECT = `
  id, date, slot,
  volunteers:volunteers!shift_volunteers ( id, name, email )
`;

const SLOT_END: Record<Shift['slot'], string> = { '11:30': '12:30', '12:30': '13:30' };

// Sunday of the week containing d, at local midnight.
function startOfWeek(d: Date): Date {
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  day.setDate(day.getDate() - day.getDay());
  return day;
}

function shiftToEvent(shift: Shift): CalendarEvent {
  const names = shift.volunteers
    .map((v) => v.name)
    .sort((a, b) => a.localeCompare(b))
    .join(', ');
  return {
    id: shift.id,
    title: `Green Team: ${names || 'unfilled'}`,
    description: `Lunch shift ${shift.slot}–${SLOT_END[shift.slot]} · ${names || 'no volunteers yet'}`,
    startsAt: `${shift.date}T${shift.slot}:00`,
    endsAt: `${shift.date}T${SLOT_END[shift.slot]}:00`,
  };
}

type ShiftsResult = {
  isLoading: boolean;
  error: { message: string } | null;
  shifts: Shift[];
};

function useShifts(): ShiftsResult {
  const [result, setResult] = useState<ShiftsResult>({
    isLoading: true,
    error: null,
    shifts: [],
  });

  useEffect(() => {
    let cancelled = false;
    supabase
      .from('green_team_shifts')
      .select(SHIFTS_SELECT)
      .then(({ data, error }) => {
        if (cancelled) return;
        setResult({
          isLoading: false,
          error,
          shifts: (data ?? []) as unknown as Shift[],
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return result;
}

export function CalendarPage() {
  const { user } = useAuth();
  const myEmail = (user?.email ?? '').toLowerCase();
  const [viewStart, setViewStart] = useState<Date>(() => startOfWeek(new Date()));
  const { isLoading, error, shifts } = useShifts();

  const events = useMemo(() => shifts.map(shiftToEvent), [shifts]);
  const myShiftIds = useMemo(
    () =>
      new Set(
        shifts
          .filter((s) => s.volunteers.some((v) => v.email.toLowerCase() === myEmail))
          .map((s) => s.id),
      ),
    [shifts, myEmail],
  );

  return (
    <PageShell width="xl">
      <Stack gap="xl">
        <PageHeader
          eyebrow="Green Team"
          title="Shift calendar"
          description="Lunch shifts Monday–Thursday. Shifts you're on are highlighted."
        />

        {isLoading ? (
          <Stack gap="md" align="center">
            <Spinner />
          </Stack>
        ) : error ? (
          <Alert tone="danger" title="Could not load shifts" description={error.message} />
        ) : (
          <Calendar
            events={events}
            viewStart={viewStart}
            onViewStartChange={setViewStart}
            defaultZoom="3"
            getEventTone={(event) => (myShiftIds.has(String(event.id)) ? 'primary' : 'success')}
          />
        )}
      </Stack>
    </PageShell>
  );
}
