/**
 * Deploy Supabase Edge Functions without the CLI, via the Management API.
 *
 *   pnpm deploy:functions                 # every function under supabase/functions
 *   pnpm deploy:functions claim-link ...  # just these
 *
 * verify_jwt is false for the public, self-authenticating functions listed
 * in PUBLIC_FUNCTIONS and true otherwise. Needs SUPABASE_ACCESS_TOKEN in .env.
 */
import 'dotenv/config';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? 'vecvuuujwgbkvmhkncan';
const PUBLIC_FUNCTIONS = new Set([
  'public-schedule',
  'push-subscribe',
  'push-reminders',
  'claim-shift',
  'claim-link',
  'decline-shift',
  'calendar-webhook',
  'cover-requests',
]);

const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token) throw new Error('Missing SUPABASE_ACCESS_TOKEN in .env');
const root = fileURLToPath(new URL('../supabase/functions', import.meta.url));

async function deploy(slug: string) {
  const dir = join(root, slug);
  const form = new FormData();
  form.append(
    'metadata',
    JSON.stringify({ entrypoint_path: 'index.ts', name: slug, verify_jwt: !PUBLIC_FUNCTIONS.has(slug) }),
  );
  for (const f of readdirSync(dir)) {
    if (!statSync(join(dir, f)).isFile()) continue;
    form.append('file', new Blob([readFileSync(join(dir, f))]), f);
  }
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/functions/deploy?slug=${slug}`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form },
  );
  const body = await res.text();
  if (!res.ok) throw new Error(`${slug}: ${res.status} ${body.slice(0, 300)}`);
  const info = JSON.parse(body) as { version?: number; verify_jwt?: boolean };
  console.log(`  ${slug}: v${info.version} (verify_jwt=${info.verify_jwt})`);
}

const wanted = process.argv.slice(2);
const slugs = wanted.length
  ? wanted
  : readdirSync(root).filter((d) => !d.startsWith('_') && statSync(join(root, d)).isDirectory());
for (const slug of slugs) await deploy(slug);
console.log(`Deployed ${slugs.length} function${slugs.length === 1 ? '' : 's'}.`);
