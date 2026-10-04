/**
 * Re-render an existing new-shifts preview with the current page template,
 * keeping its schedule exactly as it was generated. Only the shift
 * descriptions are refreshed from NEW_SHIFT_INFO, and people are trimmed to
 * what the page shows (see renderNewShiftsPreview). Reads nothing else.
 *
 *   pnpm rerender:new-shifts new-shifts-preview.html                 # in place
 *   pnpm rerender:new-shifts old.html --out green-team-schedule.html
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { NEW_SHIFT_INFO } from '../src/newShifts';
import { readNewShiftsPreviewData, renderNewShiftsPreview } from './lib/render-new-shifts-preview';

const [input] = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--out');
const outIndex = process.argv.indexOf('--out');
if (!input) {
  console.error('usage: pnpm rerender:new-shifts <preview.html> [--out <file.html>]');
  process.exit(1);
}
const output = outIndex === -1 ? input : process.argv[outIndex + 1]!;
const data = readNewShiftsPreviewData(readFileSync(input, 'utf8'));
delete data.minLeadDays; // No longer used; the 5-day notice rule was dropped from previews.
writeFileSync(output, renderNewShiftsPreview({ ...data, shifts: NEW_SHIFT_INFO }));
console.log(`Re-rendered ${input} (generated ${String(data.generatedAt)}) -> ${output}`);
