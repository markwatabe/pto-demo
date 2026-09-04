import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Alert,
  Badge,
  Body,
  Button,
  Caption,
  Card,
  PageHeader,
  PageShell,
  Spinner,
  Stack,
  Strong,
  TextField,
} from '@apygee/atoms';
import { supabase } from '../supabase';
import { SLOT_TIMES, toLocalDate, type Slot } from '../schedule';

const EMAIL_KEY = 'fiske-schedule-email';

type Day = {
  date: string;
  closure: string | null;
  shifts: { slot: Slot; people: { name: string; me: boolean }[] }[];
};

const SLOT_NAME: Record<Slot, string> = { early: 'Early', late: 'Late' };

function readSavedEmail(): string {
  try {
    return localStorage.getItem(EMAIL_KEY) ?? '';
  } catch {
    return '';
  }
}

// "13:30" -> "1:30"
function clock(t: string): string {
  const [h, m] = t.split(':').map(Number);
  return `${h! > 12 ? h! - 12 : h}:${String(m).padStart(2, '0')}`;
}

// "2026-09-14" -> "Mon, Sep 14"
function dayLabel(iso: string): string {
  return toLocalDate(iso).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

const TIMES_LINE = `Early ${clock(SLOT_TIMES.early.start)}–${clock(SLOT_TIMES.early.end)} · Late ${clock(SLOT_TIMES.late.start)}–${clock(SLOT_TIMES.late.end)}`;

export function FiskeSchedulePage() {
  const [email, setEmail] = useState(readSavedEmail);
  const [emailInput, setEmailInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState<Day[] | null>(null);

  const load = useCallback(async (forEmail: string) => {
    setIsLoading(true);
    setError(null);
    const { data, error: fnError } = await supabase.functions.invoke('public-schedule', {
      body: { email: forEmail },
    });
    setIsLoading(false);
    if (fnError) {
      setError('Could not load the schedule. Please try again.');
      return;
    }
    setDays((data.days ?? []) as Day[]);
  }, []);

  useEffect(() => {
    if (email) load(email);
  }, [email, load]);

  function saveEmail(event: FormEvent) {
    event.preventDefault();
    const value = emailInput.trim().toLowerCase();
    if (!value.includes('@')) return;
    try {
      localStorage.setItem(EMAIL_KEY, value);
    } catch {
      // still usable for this visit
    }
    setEmail(value);
  }

  function changeEmail() {
    try {
      localStorage.removeItem(EMAIL_KEY);
    } catch {
      // ignore
    }
    setEmailInput('');
    setDays(null);
    setEmail('');
  }

  if (!email) {
    return (
      <PageShell width="sm">
        <Stack gap="xl">
          <PageHeader
            eyebrow="Fiske Green Team"
            title="Lunch shift schedule"
            description="Enter your email so we can highlight your shifts. We only store it on this device."
          />
          <Card padding="lg" surface="raised">
            <form onSubmit={saveEmail}>
              <Stack gap="md">
                <TextField
                  label="Your email"
                  name="email"
                  placeholder="you@example.com"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.currentTarget.value)}
                  required
                />
                <Button type="submit" disabled={!emailInput.trim().includes('@')}>
                  Show my schedule
                </Button>
              </Stack>
            </form>
          </Card>
        </Stack>
      </PageShell>
    );
  }

  return (
    <PageShell width="sm">
      <Stack gap="lg">
        <PageHeader
          eyebrow="Fiske Green Team"
          title="Upcoming shifts"
          description={TIMES_LINE}
        />

        {error ? <Alert tone="danger" title="Something went wrong" description={error} /> : null}

        {isLoading || days === null ? (
          <Stack gap="md" align="center">
            <Spinner />
          </Stack>
        ) : days.length === 0 ? (
          <Body>No upcoming shifts are scheduled yet.</Body>
        ) : (
          <Stack gap="md">
            {days.map((day) => (
              <Card key={day.date} padding="md" surface="raised">
                <Stack gap="sm">
                  <Strong>{dayLabel(day.date)}</Strong>
                  {day.closure ? (
                    <Caption>
                      {day.closure === 'No school' ? 'No school' : `No school · ${day.closure}`}
                    </Caption>
                  ) : (
                    day.shifts.map((shift) => (
                      <Stack key={shift.slot} gap="xs">
                        <Caption>{SLOT_NAME[shift.slot]}</Caption>
                        {shift.people.length === 0 ? (
                          <Body>Nobody yet</Body>
                        ) : (
                          <Stack gap="xs">
                            {shift.people.map((p) => (
                              <Badge key={p.name} tone={p.me ? 'primary' : 'neutral'}>
                                {p.me ? `${p.name} (you)` : p.name}
                              </Badge>
                            ))}
                          </Stack>
                        )}
                      </Stack>
                    ))
                  )}
                </Stack>
              </Card>
            ))}
          </Stack>
        )}

        <Stack gap="xs" align="center">
          <Caption>{`Showing shifts for ${email}`}</Caption>
          <Button variant="ghost" onClick={changeEmail}>
            Not you? Change email
          </Button>
        </Stack>
      </Stack>
    </PageShell>
  );
}
