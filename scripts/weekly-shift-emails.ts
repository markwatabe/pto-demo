/**
 * Weekly shift emails, one per shift, from the Green Team mailbox: the week's
 * assignments as a table and a reminder to reply all to swap or cancel. Each
 * goes to every parent scheduled on that shift (anywhere in the preview page)
 * plus the coordinators. The schedule comes from a new-shifts preview page
 * (the same data volunteers see); email addresses come from the roster.
 *
 * Each shift keeps one thread: the subject never changes, and once the first
 * email is sent its thread is saved in shift-email-threads.json (git-ignored),
 * so later weeks go out as replies in that thread.
 *
 *   pnpm emails:weekly --dry-run --in new-shifts-preview-v4.html               # print, send nothing
 *   pnpm emails:weekly --preview-to you@example.com --in ...                   # only to you, marked PREVIEW
 *   pnpm emails:weekly --send --in ... [--week 2026-10-05] [--invites-updated] # to every parent on the shift
 *
 * --invites-updated adds the note that the calendar invites were just updated
 * (the first email of the three-shift schedule).
 */
import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { googleAccessToken, googleFetch, GREEN_TEAM_USER, SCOPES } from './lib/google';
import { readNewShiftsPreviewData } from './lib/render-new-shifts-preview';

type ShiftKey = 'first' | 'second' | 'third';
type ShiftInfo = { label: string; time: string; lunches: { grades: string; time: string }[] };
type Person = { name: string };
type Day = { date: string; seats: Record<ShiftKey, { id: string }[]> };
/** The first email of each shift's thread: Gmail's thread id and the RFC 822 Message-ID replies point at. */
type Thread = { threadId: string; messageId: string; subject: string };

const arg = (n: string) => { const i = process.argv.indexOf(n); return i === -1 ? undefined : process.argv[i + 1]; };
const PREVIEW_TO = arg('--preview-to');
const DRY_RUN = process.argv.includes('--dry-run');
const SEND = process.argv.includes('--send');
const INVITES_UPDATED = process.argv.includes('--invites-updated');
if ([Boolean(PREVIEW_TO), DRY_RUN, SEND].filter(Boolean).length !== 1) throw new Error('Pass exactly one of --dry-run, --preview-to <address> or --send.');

/** On every shift's email, whether or not they're scheduled on it: WEEKLY_EMAIL_COORDINATORS in .env, comma-separated. */
const COORDINATORS = (process.env.WEEKLY_EMAIL_COORDINATORS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
if (SEND && !COORDINATORS.length) throw new Error('Set WEEKLY_EMAIL_COORDINATORS in .env (the coordinators get every shift email).');
const THREADS_FILE = 'shift-email-threads.json';
const INVITES_NOTE = 'All the Google Calendar invites have been updated. Please accept or reject the invite once you know for certain if you can or cannot make it.';

const ORDER: ShiftKey[] = ['first', 'second', 'third'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu'];

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const local = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y!, m! - 1, d!); };
const nice = (s: string) => local(s).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Monday of the coming week (today if it is Monday). */
function upcomingMonday(): string {
  const today = local(new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }));
  const offset = (8 - today.getDay()) % 7;
  return iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset));
}

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const mimeWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

async function main() {
  const input = arg('--in') ?? 'new-shifts-preview.html';
  const monday = arg('--week') ?? upcomingMonday();
  if (local(monday).getDay() !== 1) throw new Error(`--week must be a Monday, got ${monday}`);
  const week = [0, 1, 2, 3].map((i) => iso(new Date(local(monday).getFullYear(), local(monday).getMonth(), local(monday).getDate() + i)));

  const data = readNewShiftsPreviewData(readFileSync(input, 'utf8'));
  const shifts = data.shifts as Record<ShiftKey, ShiftInfo>;
  const people = data.people as Record<string, Person>;
  const days = new Map((data.days as Day[]).map((d) => [d.date, d]));
  const closed = new Set(data.closedDays as string[]);
  const threads: Partial<Record<ShiftKey, Thread>> = existsSync(THREADS_FILE) ? JSON.parse(readFileSync(THREADS_FILE, 'utf8')) : {};

  const db = createClient(process.env.VITE_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data: roster, error } = await db.from('volunteers').select('id, email');
  if (error) throw error;
  const emailOf = new Map(roster!.map((v) => [v.id as string, (v.email as string).trim().toLowerCase()]));
  const nameOf = new Map(roster!.map((v) => [(v.email as string).trim().toLowerCase(), people[v.id as string]?.name.trim()]));

  const token = DRY_RUN ? '' : await googleAccessToken(GREEN_TEAM_USER, SCOPES.gmailSend);
  for (const shift of ORDER) {
    const info = shifts[shift];
    const assigned = (date: string) => (days.get(date)?.seats[shift] ?? []).map((s) => s.id);
    // Every parent scheduled on this shift (this week's included), then the coordinators.
    const ids = new Set([...days.keys(), ...week].flatMap(assigned));
    const parents = [...ids].map((id) => ({ name: people[id]?.name.trim() ?? id, email: emailOf.get(id) }));
    const missing = parents.filter((r) => !r.email).map((r) => r.name);
    if (missing.length) throw new Error(`No roster email for: ${missing.join(', ')}`);
    const emails = new Set(parents.map((p) => p.email!));
    const recipients = [...parents, ...COORDINATORS.filter((e) => !emails.has(e)).map((email) => ({ name: nameOf.get(email) ?? email, email }))]
      .sort((a, b) => a.name.localeCompare(b.name));

    const lunches = info.lunches.map((l) => `${l.grades} ${l.time}`).join(', ');
    const thread = SEND ? threads[shift] : undefined;
    const subject = thread?.subject ?? `Green Team ${info.label} shift (${info.time})`;
    const rows = week.map((date, i) => {
      if (closed.has(date) || !days.has(date)) return { day: `${WEEKDAYS[i]} ${nice(date).replace(/^\w+, /, '')}`, who: 'No lunch shift', off: true };
      const names = assigned(date).map((id) => people[id]?.name.trim() ?? id);
      return { day: `${WEEKDAYS[i]} ${nice(date).replace(/^\w+, /, '')}`, who: names.length ? names.join(', ') : 'Open: no one yet', off: false };
    });
    const swap = `Need to swap or cancel your shift? Reply all to this email so every ${info.label} shift parent sees it and someone can cover for you.`;
    const to = recipients.map((r) => `${r.name} <${r.email}>`);

    const text = [
      ...(PREVIEW_TO || DRY_RUN ? [`PREVIEW ONLY: sent to ${PREVIEW_TO ?? '(dry run)'}. The real email would go to ${recipients.length} people:`, to.join(', '), ''] : []),
      `Hi ${info.label} shift volunteers,`,
      '',
      ...(INVITES_UPDATED ? [INVITES_NOTE, ''] : []),
      `Here is the ${info.label} shift schedule for the week of ${nice(monday)}.`,
      `${info.label} shift: ${info.time} (${lunches})`,
      '',
      ...rows.map((r) => `  ${r.day}: ${r.who}`),
      '',
      swap,
      '',
      'Thank you!',
      'Fiske Green Team',
    ].join('\n');

    const cell = 'padding:6px 12px;border:1px solid #ccc;text-align:left;vertical-align:top';
    const html = `<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45;color:#111">
${PREVIEW_TO || DRY_RUN ? `<div style="background:#fff4e5;border:1px solid #f0b264;border-radius:6px;padding:10px 12px;margin-bottom:18px;font-size:13px">
<b>PREVIEW ONLY</b>: this example was sent only to ${esc(PREVIEW_TO ?? '(dry run)')}. The real email would go to these ${recipients.length} people:<br>
${recipients.map((r) => `${esc(r.name)} &lt;${esc(r.email!)}&gt;`).join(', ')}
</div>
` : ''}<p>Hi ${esc(info.label)} shift volunteers,</p>
${INVITES_UPDATED ? `<p><b>${esc(INVITES_NOTE)}</b></p>\n` : ''}<p>Here is the ${esc(info.label)} shift schedule for the week of ${esc(nice(monday))}.<br>
<b>${esc(info.label)} shift: ${esc(info.time)}</b> <span style="color:#666">(${esc(lunches)})</span></p>
<table style="border-collapse:collapse;margin:8px 0 16px">
<thead><tr><th style="${cell};background:#f2f2f2">Day</th><th style="${cell};background:#f2f2f2">Volunteers</th></tr></thead>
<tbody>${rows.map((r) => `<tr><td style="${cell};white-space:nowrap"><b>${esc(r.day)}</b></td><td style="${cell}${r.off ? ';color:#888;font-style:italic' : ''}">${esc(r.who)}</td></tr>`).join('')}</tbody>
</table>
<p><b>${esc(swap)}</b></p>
<p>Thank you!<br>Fiske Green Team</p>
</div>`;

    const headerSubject = PREVIEW_TO ? `[PREVIEW] ${subject}` : thread ? `Re: ${subject}` : subject;
    console.log(`\n=== ${headerSubject}${SEND ? `\nTo (${recipients.length}): ${to.join(', ')}` : ''}\n${text}`);
    if (DRY_RUN) continue;
    const boundary = `b${Date.now().toString(36)}${shift}`;
    const raw = [
      `From: Fiske Green Team <${GREEN_TEAM_USER}>`,
      `To: ${PREVIEW_TO ?? recipients.map((r) => `${/^[\x20-\x7e]*$/.test(r.name) ? `"${r.name.replace(/["\\]/g, '')}"` : mimeWord(r.name)} <${r.email}>`).join(', ')}`,
      `Subject: ${mimeWord(headerSubject)}`,
      ...(thread ? [`In-Reply-To: ${thread.messageId}`, `References: ${thread.messageId}`] : []),
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(text, 'utf8').toString('base64'),
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(html, 'utf8').toString('base64'),
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const sent = await googleFetch<{ id: string; threadId: string }>(token, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      body: JSON.stringify({ raw: b64url(raw), ...(thread ? { threadId: thread.threadId } : {}) }),
    });
    if (PREVIEW_TO) { console.log(`(sent preview to ${PREVIEW_TO} only)`); continue; }
    console.log(`(sent to ${recipients.length} people${thread ? ', as a reply in the shift thread' : ''})`);
    if (!thread) {
      // Start of this shift's thread: keep what later replies need.
      const readToken = await googleAccessToken(GREEN_TEAM_USER, SCOPES.gmailRead);
      const msg = await googleFetch<{ payload?: { headers?: { name: string; value: string }[] } }>(
        readToken,
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${sent.id}?format=metadata&metadataHeaders=Message-ID`,
      );
      const messageId = msg.payload?.headers?.find((h) => h.name.toLowerCase() === 'message-id')?.value;
      if (!messageId) throw new Error(`Sent ${shift}, but could not read its Message-ID (Gmail id ${sent.id})`);
      threads[shift] = { threadId: sent.threadId, messageId, subject };
      writeFileSync(THREADS_FILE, JSON.stringify(threads, null, 2) + '\n');
    }
  }
}

main().catch((e) => { console.error('weekly-shift-emails failed:', e); process.exit(1); });
