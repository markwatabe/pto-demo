/**
 * Google API auth for local scripts — the PTO service account key with
 * domain-wide delegation. Never expires and never prompts, unlike gcloud
 * user credentials (which the Workspace session policy kills within a day).
 *
 * Key file: GOOGLE_SA_KEY_FILE or ~/.config/pto-calendar-sync-key.json.
 */
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';

export const KEY_FILE =
  process.env.GOOGLE_SA_KEY_FILE ?? `${process.env.HOME}/.config/pto-calendar-sync-key.json`;

/** The Workspace user scripts act as for Sheets (owns/edits the roster sheet). */
export const SHEETS_USER = process.env.GOOGLE_IMPERSONATE_EMAIL ?? 'mwatabe@fiskeschoolpto.org';
/** The shared Green Team mailbox + calendar — all volunteer-facing mail/invites come from it. */
export const GREEN_TEAM_USER = process.env.MAIL_FROM_EMAIL ?? 'greenteam@fiskeschoolpto.org';
export const GREEN_TEAM_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID ?? GREEN_TEAM_USER;

export const SCOPES = {
  sheets: 'https://www.googleapis.com/auth/spreadsheets',
  drive: 'https://www.googleapis.com/auth/drive',
  calendar: 'https://www.googleapis.com/auth/calendar',
  gmailSend: 'https://www.googleapis.com/auth/gmail.send',
} as const;

type ServiceAccountKey = { client_email: string; private_key: string };

let cachedKey: ServiceAccountKey | undefined;
function serviceAccount(): ServiceAccountKey {
  cachedKey ??= JSON.parse(readFileSync(KEY_FILE, 'utf8')) as ServiceAccountKey;
  return cachedKey;
}

/** Mint an access token for `scope`, acting as Workspace user `sub`. */
export async function googleAccessToken(sub: string, scope: string): Promise<string> {
  const key = serviceAccount();
  const b64u = (s: string) => Buffer.from(s).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64u(
    JSON.stringify({
      iss: key.client_email,
      sub,
      scope,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const sig = signer.sign(key.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${sig}`,
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Google token exchange failed for ${sub} (${scope}): ${JSON.stringify(data)}`);
  }
  return data.access_token as string;
}

/** fetch() against a Google API with a bearer token; throws on non-2xx with the body. */
export async function googleFetch<T = unknown>(
  token: string,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url} -> ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}
