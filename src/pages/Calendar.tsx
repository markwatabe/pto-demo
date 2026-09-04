import { useEffect, useMemo, useState } from 'react';
import { Alert, PageHeader, PageShell, Spinner, Stack } from '@apygee/atoms';
import { Calendar } from '@apygee/calendar';
import type { CalendarEvent } from '@apygee/types';
import { supabase } from '../supabase';
import { useAuth } from '../auth';
import { SLOT_TIMES, type Slot } from '../schedule';

type Volunteer = { id: string; name: string; email: string };
type Shift = {
  id: string;
  date: string; // ISO date, e.g. "2026-08-24"
  slot: Slot;
  volunteers: Volunteer[];
};

// Shifts with their assigned volunteers from the roster.
const SHIFTS_SELECT = `
  id, date, slot,
  volunteers:volunteers!shift_volunteers ( id, name, email )
`;

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
  const { start, end } = SLOT_TIMES[shift.slot];
  return {
    id: shift.id,
    title: `Green Team: ${names || 'unfilled'}`,
    description: `Lunch shift ${start}–${end} · ${names || 'no volunteers yet'}`,
    startsAt: `${shift.date}T${start}:00`,
    endsAt: `${shift.date}T${end}:00`,
  };
}

type Closure = { date: string; reason: string | null };

// Closures render as labeled all-school-hours events; no shifts exist on
// these days so they never compete for lanes.
function closureToEvent(closure: Closure): CalendarEvent {
  return {
    id: `closure-${closure.date}`,
    title: closure.reason ? `No school · ${closure.reason}` : 'No school',
    startsAt: `${closure.date}T08:00:00`,
    endsAt: `${closure.date}T15:00:00`,
  };
}

type ShiftsResult = {
  isLoading: boolean;
  error: { message: string } | null;
  shifts: Shift[];
  closures: Closure[];
};

function useShifts(): ShiftsResult {
  const [result, setResult] = useState<ShiftsResult>({
    isLoading: true,
    error: null,
    shifts: [],
    closures: [],
  });

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      supabase.from('green_team_shifts').select(SHIFTS_SELECT),
      supabase.from('school_closures').select('date, reason'),
    ]).then(([shiftsRes, closuresRes]) => {
      if (cancelled) return;
      setResult({
        isLoading: false,
        error: shiftsRes.error ?? closuresRes.error,
        shifts: (shiftsRes.data ?? []) as unknown as Shift[],
        closures: (closuresRes.data ?? []) as Closure[],
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
  const { isLoading, error, shifts, closures } = useShifts();

  const events = useMemo(
    () => [...shifts.map(shiftToEvent), ...closures.map(closureToEvent)],
    [shifts, closures],
  );
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
            getEventTone={(event) => {
              const id = String(event.id);
              if (id.startsWith('closure-')) return 'neutral';
              return myShiftIds.has(id) ? 'primary' : 'success';
            }}
          />
        )}
      </Stack>
    </PageShell>
  );
}
