/**
 * Plain-text version of a new-shifts preview for pasting into an email, for
 * people who won't open the HTML page: every scheduled person, alphabetical,
 * with their dates. Built from the data inlined in the preview, so the two
 * always agree.
 *
 *   pnpm text:new-shifts                                   # new-shifts-preview.html -> new-shifts-by-person.txt
 *   pnpm text:new-shifts new-shifts-preview-v2.html        # -> new-shifts-by-person-v2.txt
 *   pnpm text:new-shifts other.html --out other.txt
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { readNewShiftsPreviewData } from './lib/render-new-shifts-preview';

type ShiftKey = 'first' | 'second' | 'third';
type ShiftInfo = { label: string; time: string; lunches: { grades: string; time: string }[] };
type Day = { date: string; seats: Record<ShiftKey, { id: string }[]> };

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const input = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out') ?? 'new-shifts-preview.html';
// By default the text file follows the page's name (new-shifts-preview-v2.html -> new-shifts-by-person-v2.txt),
// so making one version's text never overwrites another's.
const output = outIndex === -1 ? input.replace(/new-shifts-preview([^/]*)\.html$/, 'new-shifts-by-person$1.txt').replace(/\.html$/, '.txt') : args[outIndex + 1]!;
if (output === input) throw new Error(`refusing to overwrite ${input}; pass --out`);

const data = readNewShiftsPreviewData(readFileSync(input, 'utf8'));
const shifts = data.shifts as Record<ShiftKey, ShiftInfo>;
const people = data.people as Record<string, { name: string }>;
const order: ShiftKey[] = ['first', 'second', 'third'];

const byPerson = new Map<string, { date: string; shift: ShiftKey }[]>();
for (const day of data.days as Day[])
  for (const shift of order)
    for (const seat of day.seats[shift] ?? []) byPerson.set(seat.id, [...(byPerson.get(seat.id) ?? []), { date: day.date, shift }]);

const when = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
};
const year = (iso: unknown) => String(iso).slice(0, 4);

const lines: string[] = [
  `Fiske Green Team lunch shifts, ${year(data.from)}–${year(data.to)}${data.version ? ` (${String(data.version)})` : ''}`,
  '',
  'Shift times',
  ...order.map((s) => {
    const lunches = shifts[s].lunches.map((l) => `${l.grades} ${l.time}`).join(', ');
    return `  ${shifts[s].label} shift ${shifts[s].time} (${lunches})`;
  }),
  '',
  'Find your name below (alphabetical by first name).',
];

const scheduled = [...byPerson.entries()]
  .map(([id, list]) => ({ name: people[id]?.name.trim() ?? id, list: list.sort((a, b) => a.date.localeCompare(b.date)) }))
  .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
for (const { name, list } of scheduled) {
  lines.push('', `${name} (${list.length} shift${list.length === 1 ? '' : 's'})`);
  // No column padding: pasted into email, text is usually in a proportional font.
  for (const x of list) lines.push(`  ${when(x.date)}: ${shifts[x.shift].label} shift (${shifts[x.shift].time})`);
}

writeFileSync(output, lines.join('\n') + '\n');
console.log(`${scheduled.length} people, ${scheduled.reduce((n, p) => n + p.list.length, 0)} shifts -> ${output}`);
