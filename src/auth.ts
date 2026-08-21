import { useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from './supabase';

type AuthState = { isLoading: boolean; user: User | null };

/**
 * Current auth session. Resolves the persisted session on mount, then stays
 * in sync via onAuthStateChange (sign-in, sign-out, token refresh).
 */
export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({ isLoading: true, user: null });

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setState({ isLoading: false, user: data.session?.user ?? null });
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      setState({ isLoading: false, user: session?.user ?? null });
    });

    return () => subscription.subscription.unsubscribe();
  }, []);

  return state;
}
