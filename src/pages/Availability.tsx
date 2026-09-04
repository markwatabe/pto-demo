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
import { useAuth } from '../auth';

type Frequency = 'monthly' | 'biweekly' | 'custom';

type Volunteer = {
  id: string;
  email: string;
  name: string;
  frequency: Frequency;
  frequency_note: string | null;
  backfill: boolean;
  notes: string | null;
};

const WEEKDAYS = [
  { weekday: 1, label: 'Monday' },
  { weekday: 2, label: 'Tuesday' },
  { weekday: 3, label: 'Wednesday' },
  { weekday: 4, label: 'Thursday' },
] as const;

const SLOTS = [
  { slot: 'early', label: 'Early (11:05–12:15)' },
  { slot: 'late', label: 'Late (12:20–1:30)' },
] as const;

const FREQUENCIES: Array<{ value: Frequency; label: string }> = [
  { value: 'monthly', label: 'Once a month' },
  { value: 'biweekly', label: 'Every other week' },
  { value: 'custom', label: 'Custom' },
];

const cellKey = (weekday: number, slot: string) => `${weekday}:${slot}`;

export function AvailabilityPage() {
  const { user } = useAuth();
  const email = (user?.email ?? '').toLowerCase();

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [volunteer, setVolunteer] = useState<Volunteer | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [frequency, setFrequency] = useState<Frequency>('monthly');
  const [frequencyNote, setFrequencyNote] = useState('');
  const [backfill, setBackfill] = useState(false);
  const [notes, setNotes] = useState('');
  const [joinName, setJoinName] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    if (!email) return;
    setError(null);
    const { data: vol, error: volError } = await supabase
      .from('volunteers')
      .select('id, email, name, frequency, frequency_note, backfill, notes')
      .eq('email', email)
      .maybeSingle();
    if (volError) {
      setError(volError.message);
      setIsLoading(false);
      return;
    }
    if (vol) {
      const v = vol as Volunteer;
      setVolunteer(v);
      setFrequency(v.frequency);
      setFrequencyNote(v.frequency_note ?? '');
      setBackfill(v.backfill);
      setNotes(v.notes ?? '');
      const { data: slots, error: availError } = await supabase
        .from('availability')
        .select('weekday, slot')
        .eq('volunteer_id', v.id);
      if (availError) {
        setError(availError.message);
      } else {
        setSelected(new Set((slots ?? []).map((s) => cellKey(s.weekday as number, s.slot as string))));
      }
    }
    setIsLoading(false);
  }, [email]);

  useEffect(() => {
    load();
  }, [load]);

  async function join(event: FormEvent) {
    event.preventDefault();
    const name = joinName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    const { error: insertError } = await supabase
      .from('volunteers')
      .insert({ email, name });
    setBusy(false);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    setIsLoading(true);
    await load();
  }

  function toggle(weekday: number, slot: string) {
    setSaved(false);
    setSelected((prev) => {
      const next = new Set(prev);
      const key = cellKey(weekday, slot);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function save() {
    if (!volunteer) return;
    setBusy(true);
    setError(null);
    setSaved(false);

    const { data: updated, error: updateError } = await supabase
      .from('volunteers')
      .update({
        frequency,
        frequency_note: frequency === 'custom' ? frequencyNote.trim() || null : null,
        backfill,
        notes: notes.trim() || null,
      })
      .eq('id', volunteer.id)
      .select('id');
    if (updateError || (updated ?? []).length === 0) {
      setBusy(false);
      setError(updateError?.message ?? 'Could not save your details.');
      return;
    }

    const { error: clearError } = await supabase
      .from('availability')
      .delete()
      .eq('volunteer_id', volunteer.id);
    if (clearError) {
      setBusy(false);
      setError(clearError.message);
      return;
    }
    // cellKey(1, 'early') is "1:early".
    const rows = [...selected].map((key) => {
      const sep = key.indexOf(':');
      return {
        volunteer_id: volunteer.id,
        weekday: Number(key.slice(0, sep)),
        slot: key.slice(sep + 1),
      };
    });
    if (rows.length > 0) {
      const { error: insertError } = await supabase.from('availability').insert(rows);
      if (insertError) {
        setBusy(false);
        setError(insertError.message);
        return;
      }
    }
    setBusy(false);
    setSaved(true);
  }

  return (
    <PageShell width="lg">
      <Stack gap="xl">
        <PageHeader
          eyebrow="Green Team"
          title="My availability"
          description="Tell us when you can cover a lunch shift. Admins build the schedule from this."
        />

        {error ? <Alert tone="danger" title="Something went wrong" description={error} /> : null}
        {saved ? <Alert tone="info" title="Saved" description="Your availability is up to date." /> : null}

        {isLoading ? (
          <Stack gap="md" align="center">
            <Spinner />
          </Stack>
        ) : !volunteer ? (
          <Card padding="lg" surface="raised">
            <form onSubmit={join}>
              <Stack gap="md">
                <SectionTitle>Join the Green Team</SectionTitle>
                <Body>{`You're signed in as ${email}, but you're not on the volunteer roster yet.`}</Body>
                <TextField
                  label="Your name"
                  name="joinName"
                  placeholder="First Last"
                  value={joinName}
                  onChange={(e) => setJoinName(e.currentTarget.value)}
                  required
                />
                <Button type="submit" disabled={busy || !joinName.trim()}>
                  {busy ? 'Joining…' : 'Join'}
                </Button>
              </Stack>
            </form>
          </Card>
        ) : (
          <>
            <Card padding="lg" surface="raised">
              <Stack gap="md">
                <SectionTitle>Weekly availability</SectionTitle>
                <Caption>Tap the shifts you can usually cover. Lunch shifts run Monday–Thursday.</Caption>
                <Stack gap="md">
                  {WEEKDAYS.map(({ weekday, label }) => (
                    <Stack key={weekday} gap="xs">
                      <Strong>{label}</Strong>
                      <Inline gap="sm" wrap>
                        {SLOTS.map(({ slot, label: slotLabel }) => {
                          const on = selected.has(cellKey(weekday, slot));
                          return (
                            <Button
                              key={slot}
                              variant={on ? 'primary' : 'secondary'}
                              onClick={() => toggle(weekday, slot)}
                            >
                              {on ? `✓ ${slotLabel}` : slotLabel}
                            </Button>
                          );
                        })}
                      </Inline>
                    </Stack>
                  ))}
                </Stack>
              </Stack>
            </Card>

            <Card padding="lg" surface="raised">
              <Stack gap="md">
                <SectionTitle>How often</SectionTitle>
                <Inline gap="sm" wrap>
                  {FREQUENCIES.map(({ value, label }) => (
                    <Button
                      key={value}
                      variant={frequency === value ? 'primary' : 'secondary'}
                      onClick={() => {
                        setSaved(false);
                        setFrequency(value);
                      }}
                    >
                      {frequency === value ? `✓ ${label}` : label}
                    </Button>
                  ))}
                </Inline>
                {frequency === 'custom' ? (
                  <TextField
                    label="Describe your custom cadence"
                    name="frequencyNote"
                    value={frequencyNote}
                    onChange={(e) => setFrequencyNote(e.currentTarget.value)}
                  />
                ) : null}

                <Divider />

                <Inline gap="sm" align="center" wrap>
                  <Button
                    variant={backfill ? 'primary' : 'secondary'}
                    onClick={() => {
                      setSaved(false);
                      setBackfill(!backfill);
                    }}
                  >
                    {backfill ? '✓ On the emergency backfill list' : 'Join the emergency backfill list'}
                  </Button>
                  <Caption>Flexible schedule? We may ping you for last-minute gaps.</Caption>
                </Inline>

                <TextField
                  label="Notes for the coordinators"
                  name="notes"
                  placeholder="Blackout dates, alternating weeks, anything else…"
                  value={notes}
                  onChange={(e) => setNotes(e.currentTarget.value)}
                />

                <Button onClick={save} disabled={busy}>
                  {busy ? 'Saving…' : 'Save availability'}
                </Button>
              </Stack>
            </Card>
          </>
        )}
      </Stack>
    </PageShell>
  );
}
