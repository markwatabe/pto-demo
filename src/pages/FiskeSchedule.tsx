import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Alert,
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
// Public half of the server's VAPID keypair (safe to embed).
const VAPID_PUBLIC_KEY =
  'BNhSsFQqkNsMaSRbAEdFSZukzrXkdV1onR3wC609jlPMoXbo0kvIdtXDwJftHOX0BdiN4oURM5SFjQZcirUm6s8';

type PushState = 'unsupported' | 'need-install' | 'idle' | 'busy' | 'enabled' | 'denied';

function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function isIosNotInstalled(): boolean {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  return ios && !standalone;
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

type Day = {
  date: string;
  shifts: {
    slot: Slot;
    people: { name: string; me: boolean; accepted: boolean }[];
    declined: string[];
  }[];
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

// "Mary Jane Watson" -> "Mary Watson" — first and last word only.
function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length > 2 ? `${parts[0]} ${parts[parts.length - 1]}` : name;
}

// Badge-styled pill (same design-system classes) that can shrink and
// ellipsize its name — the atoms Badge can't be width-constrained.
// RSVP status drives the color: accepted = green ✓, declined = red 👎,
// no response = neutral (or primary when it's you).
function Pill({
  me = false,
  name,
  status = 'none',
}: {
  me?: boolean;
  name: string;
  status?: 'none' | 'accepted' | 'declined';
}) {
  const tone =
    status === 'accepted'
      ? 'bg-success-soft text-success border-success-soft'
      : status === 'declined'
        ? 'bg-danger-soft text-danger border-danger-soft'
        : me
          ? 'bg-primary-soft text-primary border-primary-soft'
          : 'bg-muted text-default border-default';
  const prefix = status === 'accepted' ? '✓ ' : status === 'declined' ? '👎 ' : '';
  return (
    <span
      className={`inline-flex items-center px-sm rounded-full border font-sans text-xs font-medium ${tone}`}
      style={{ height: '1.5rem', minWidth: 0, flex: '0 1 auto' }}
    >
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {`${prefix}${shortName(name)}${me ? ' (you)' : ''}`}
      </span>
    </span>
  );
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

// The coordinator's email — /fiske-admin only works for this identity.
const COORDINATOR_EMAIL = 'm.watabe@gmail.com';

export function FiskeSchedulePage({ admin = false }: { admin?: boolean }) {
  const [email, setEmail] = useState(readSavedEmail);
  const [emailInput, setEmailInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState<Day[] | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);
  // "date|slot" of the shift whose "Can't make it" is awaiting confirmation / sending.
  const [declineKey, setDeclineKey] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  // "date|slot|name" of the nudge in flight (admin view).
  const [nudging, setNudging] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [push, setPush] = useState<PushState>('unsupported');

  // Figure out where this device stands on notifications.
  useEffect(() => {
    if (!pushSupported()) {
      setPush(isIosNotInstalled() ? 'need-install' : 'unsupported');
      return;
    }
    if (Notification.permission === 'denied') {
      setPush('denied');
      return;
    }
    let cancelled = false;
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => {
        if (!cancelled) setPush(sub ? 'enabled' : 'idle');
      })
      .catch(() => {
        if (!cancelled) setPush('idle');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function enableReminders() {
    setPush('busy');
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setPush(permission === 'denied' ? 'denied' : 'idle');
        return;
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
      const { error: fnError } = await supabase.functions.invoke('push-subscribe', {
        body: { action: 'subscribe', email, subscription: sub.toJSON() },
      });
      if (fnError) {
        setError('Could not save the reminder subscription. Please try again.');
        setPush('idle');
        return;
      }
      setPush('enabled');
    } catch {
      setError('Could not enable reminders on this device.');
      setPush('idle');
    }
  }

  async function disableReminders() {
    setPush('busy');
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await supabase.functions.invoke('push-subscribe', {
          body: { action: 'unsubscribe', subscription: sub.toJSON() },
        });
        await sub.unsubscribe();
      }
      setPush('idle');
    } catch {
      setPush('enabled');
    }
  }

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

  async function nudge(date: string, slot: Slot, name: string) {
    setNudging(`${date}|${slot}|${name}`);
    setError(null);
    setNotice(null);
    const { error: fnError } = await supabase.functions.invoke('nudge-volunteer', {
      body: { date, slot, name },
    });
    setNudging(null);
    if (fnError) {
      let message = 'Could not send the nudge. Please try again.';
      try {
        const ctx = (fnError as { context?: Response }).context;
        if (ctx) message = (await ctx.json()).error ?? message;
      } catch {
        // keep the generic message
      }
      setError(message);
      return;
    }
    setNotice(`Nudged ${shortName(name)} about ${dayLabel(date)} (${SLOT_NAME[slot]}).`);
  }

  async function claim(date: string, slot: Slot) {
    setClaiming(`${date}|${slot}`);
    setError(null);
    const { error: fnError } = await supabase.functions.invoke('claim-shift', {
      body: { email, date, slot },
    });
    if (fnError) {
      // FunctionsHttpError carries the response; surface the server's message.
      let message = 'Could not claim the shift. Please try again.';
      try {
        const ctx = (fnError as { context?: Response }).context;
        if (ctx) message = (await ctx.json()).error ?? message;
      } catch {
        // keep the generic message
      }
      setError(message);
      setClaiming(null);
      return;
    }
    await load(email);
    setClaiming(null);
  }

  async function decline(date: string, slot: Slot) {
    setDeclining(true);
    setError(null);
    setNotice(null);
    const { error: fnError } = await supabase.functions.invoke('decline-shift', {
      body: { email, date, slot },
    });
    setDeclining(false);
    if (fnError) {
      let message = "Could not send that — please email the coordinator directly.";
      try {
        const ctx = (fnError as { context?: Response }).context;
        if (ctx) message = (await ctx.json()).error ?? message;
      } catch {
        // keep the generic message
      }
      setError(message);
      return;
    }
    setDeclineKey(null);
    setNotice(`Thanks — you're off ${dayLabel(date)} (${SLOT_NAME[slot]}) and the coordinator has been told.`);
    await load(email);
  }

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

  if (admin && email !== COORDINATOR_EMAIL) {
    return (
      <PageShell width="sm">
        <Stack gap="lg">
          <PageHeader
            eyebrow="Fiske Green Team"
            title="Coordinator view"
            description="This page is just for the coordinator."
          />
          <Button variant="ghost" onClick={changeEmail}>
            Switch email
          </Button>
        </Stack>
      </PageShell>
    );
  }

  return (
    <PageShell width="sm">
      <Stack gap="lg">
        <PageHeader
          eyebrow="Fiske Green Team"
          title={admin ? 'Upcoming shifts · coordinator' : 'Upcoming shifts'}
          description={admin ? `${TIMES_LINE} · Nudge emails a reminder to accept or decline.` : TIMES_LINE}
        />

        {error ? <Alert tone="danger" title="Something went wrong" description={error} /> : null}
        {notice ? <Alert tone="success" title="Done" description={notice} /> : null}

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
                  {day.shifts.map((shift) => (
                      <div
                        key={shift.slot}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}
                      >
                        <span style={{ flexShrink: 0, width: '2.6rem' }}>
                          <Caption>{SLOT_NAME[shift.slot]}</Caption>
                        </span>
                        {shift.people.map((p) => (
                          <span
                            key={p.name}
                            style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}
                          >
                            <Pill me={p.me} name={p.name} status={p.accepted ? 'accepted' : 'none'} />
                            {admin && !p.accepted ? (
                              <Button
                                variant="ghost"
                                onClick={() => nudge(day.date, shift.slot, p.name)}
                                disabled={nudging !== null}
                              >
                                {nudging === `${day.date}|${shift.slot}|${p.name}` ? '…' : 'Nudge'}
                              </Button>
                            ) : null}
                          </span>
                        ))}
                        {shift.declined.map((name) => (
                          <Pill key={`declined-${name}`} name={name} status="declined" />
                        ))}
                        {shift.people.some((p) => p.me) ? (
                          <span
                            style={{
                              marginLeft: 'auto',
                              flexShrink: 0,
                              display: 'flex',
                              alignItems: 'center',
                              gap: 4,
                            }}
                          >
                            {declineKey === `${day.date}|${shift.slot}` ? (
                              <>
                                <Caption>Tell the coordinator?</Caption>
                                <Button
                                  variant="ghost"
                                  onClick={() => decline(day.date, shift.slot)}
                                  disabled={declining}
                                >
                                  {declining ? 'Sending…' : 'Yes'}
                                </Button>
                                <Button
                                  variant="ghost"
                                  onClick={() => setDeclineKey(null)}
                                  disabled={declining}
                                >
                                  No
                                </Button>
                              </>
                            ) : (
                              <Button
                                variant="ghost"
                                onClick={() => {
                                  setNotice(null);
                                  setDeclineKey(`${day.date}|${shift.slot}`);
                                }}
                                disabled={declining}
                              >
                                Can’t make it
                              </Button>
                            )}
                          </span>
                        ) : shift.people.length < 2 ? (
                          <span style={{ marginLeft: 'auto', flexShrink: 0 }}>
                            <Button
                              variant="ghost"
                              onClick={() => claim(day.date, shift.slot)}
                              disabled={claiming !== null}
                            >
                              {claiming === `${day.date}|${shift.slot}` ? 'Claiming…' : 'Claim'}
                            </Button>
                          </span>
                        ) : null}
                      </div>
                  ))}
                </Stack>
              </Card>
            ))}
          </Stack>
        )}

        {push === 'unsupported' ? null : (
          <Card padding="md" surface="raised">
            <Stack gap="sm">
              {push === 'need-install' ? (
                <>
                  <Strong>Get shift reminders</Strong>
                  <Caption>
                    On iPhone: tap the Share button, choose “Add to Home Screen”, then open the
                    Green Team app from your home screen and enable reminders there.
                  </Caption>
                </>
              ) : push === 'denied' ? (
                <Caption>
                  Notifications are blocked for this site. Allow them in your browser settings to
                  get shift reminders.
                </Caption>
              ) : push === 'enabled' ? (
                <Stack gap="xs">
                  <Caption>🔔 Shift reminders are on for this device — you’ll get a notification the evening before your shift.</Caption>
                  <Button variant="ghost" onClick={disableReminders}>
                    Turn off reminders
                  </Button>
                </Stack>
              ) : (
                <Stack gap="sm">
                  <Strong>Get shift reminders</Strong>
                  <Caption>A notification the evening before each of your shifts.</Caption>
                  <Button onClick={enableReminders} disabled={push === 'busy'}>
                    {push === 'busy' ? 'Enabling…' : 'Enable reminders'}
                  </Button>
                </Stack>
              )}
            </Stack>
          </Card>
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
