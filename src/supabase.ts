import { createClient } from '@supabase/supabase-js';

// Supabase project URL + publishable key, supplied via .env (see .env.example).
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Define them in .env');
}

export const supabase = createClient(url, anonKey);
