import { useCallback, useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { useAuth } from './auth';

export type AccessStatus = 'pending' | 'approved' | null;

type AccessState = {
  isLoading: boolean;
  status: AccessStatus;
  isAdmin: boolean;
};

export type Access = AccessState & {
  user: User | null;
  refresh: () => void;
};

/**
 * Auth session plus approval status. Signed-out users have status null.
 * A signed-in user with no readable profile row is treated as pending —
 * access fails closed. refresh() re-checks (used by the waiting room).
 */
export function useAccess(): Access {
  const { isLoading: authLoading, user } = useAuth();
  const userId = user?.id ?? null;
  const [state, setState] = useState<AccessState>({
    isLoading: true,
    status: null,
    isAdmin: false,
  });
  const [generation, setGeneration] = useState(0);

  const refresh = useCallback(() => setGeneration((g) => g + 1), []);

  useEffect(() => {
    if (authLoading) return;
    if (!userId) {
      setState({ isLoading: false, status: null, isAdmin: false });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, isLoading: true }));
    Promise.all([
      supabase.from('profiles').select('status').eq('id', userId).maybeSingle(),
      supabase.from('admins').select('user_id').eq('user_id', userId).maybeSingle(),
    ]).then(([profile, admin]) => {
      if (cancelled) return;
      const isAdmin = !admin.error && Boolean(admin.data);
      const approved = !profile.error && profile.data?.status === 'approved';
      setState({
        isLoading: false,
        status: approved || isAdmin ? 'approved' : 'pending',
        isAdmin,
      });
    }).catch(() => {
      if (cancelled) return;
      setState({ isLoading: false, status: 'pending', isAdmin: false });
    });
    return () => {
      cancelled = true;
    };
  }, [authLoading, userId, generation]);

  return {
    ...state,
    user,
    isLoading: authLoading || state.isLoading,
    refresh,
  };
}
