import { readFileSync } from 'node:fs';

/**
 * The preview is one self-contained HTML file: the template has no external
 * scripts, styles or fonts, and the schedule data is inlined as JSON. A
 * `version` (e.g. "V2") is added to the page title.
 */
export function renderNewShiftsPreview(data: Record<string, unknown>): string {
  const json = JSON.stringify({ ...data, people: sharedPeople(data.people) }).replace(/</g, '\\u003c');
  const version = typeof data.version === 'string' && data.version ? ` (${data.version.replace(/[&<>"']/g, '')})` : '';
  // One pass, so neither inserted value is ever scanned for the other placeholder.
  return readFileSync(new URL('./new-shifts-preview.html', import.meta.url), 'utf8')
    .replace(/__DATA__|__VERSION__/g, (m) => (m === '__DATA__' ? json : version));
}

type Person = Record<string, unknown> & { prefs?: Record<string, unknown> | null };

/**
 * The page is sent to volunteers, so each person carries only what it shows:
 * name, grades and how often on the panel, plus what "Can work" needs. Notes,
 * blocked days and sign-up details never leave the generator.
 */
function sharedPeople(people: unknown): Record<string, Person> {
  return Object.fromEntries(
    Object.entries((people ?? {}) as Record<string, Person>).map(([id, p]) => [
      id,
      {
        name: p.name,
        grades: p.grades,
        thirdGrader: p.thirdGrader,
        fourthOrFifthGrader: p.fourthOrFifthGrader,
        spacing: p.spacing,
        avail: p.avail,
        prefs: p.prefs
          ? {
              only: p.prefs.only,
              perMonth: p.prefs.perMonth,
              together: p.prefs.together,
              periods: (p.prefs.periods as { from: string; to: string; only?: string[] }[] | undefined)?.map(({ from, to, only }) => ({ from, to, only })),
            }
          : null,
      },
    ]),
  );
}

/** The data inlined in a previously written preview page. */
export function readNewShiftsPreviewData(html: string): Record<string, unknown> {
  const match = html.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/);
  if (!match) throw new Error('no embedded schedule data found');
  return JSON.parse(match[1]!) as Record<string, unknown>;
}
