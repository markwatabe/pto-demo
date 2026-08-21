import { init } from '@instantdb/react';
import schema from './instant.schema';

// InstantDB application ID, supplied via .env (VITE_INSTANT_APP_ID).
export const APP_ID = import.meta.env.VITE_INSTANT_APP_ID;

if (!APP_ID) {
  throw new Error('Missing VITE_INSTANT_APP_ID. Define it in .env');
}

export const db = init({ appId: APP_ID, schema });
