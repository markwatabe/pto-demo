import { Outlet } from 'react-router';
import {
  AppShell,
  Body,
  Button,
  Caption,
  Divider,
  NavLink,
  Stack,
  Strong,
} from '@apygee/atoms';
import { useAuth } from '../auth';
import { supabase } from '../supabase';

const NAV_ITEMS = [
  { to: '/calendar', label: 'Shift calendar' },
  { to: '/availability', label: 'My availability' },
  { to: '/directory', label: 'Directory' },
  { to: '/forms', label: 'Forms' },
  { to: '/our-pto', label: 'Our PTO' },
] as const;

export function AppLayout({ isAdmin }: { isAdmin: boolean }) {
  const { user } = useAuth();

  return (
    <AppShell
      sidebar={
        <Stack gap="lg" as="div">
          <div className="p-lg">
            <Stack gap="xs">
              <Caption>School PTO</Caption>
              <Strong>Family Hub</Strong>
            </Stack>
          </div>

          <Divider />

          <div className="p-md">
            <Stack gap="sm">
              {NAV_ITEMS.map((item) => (
                <NavLink key={item.to} to={item.to} end>
                  {item.label}
                </NavLink>
              ))}
              {isAdmin ? (
                <NavLink to="/admin" end>
                  Admin
                </NavLink>
              ) : null}
            </Stack>
          </div>

          <Divider />

          <div className="p-md">
            <Stack gap="sm">
              {user?.email ? <Caption>{`Signed in as ${user.email}`}</Caption> : null}
              <Button variant="secondary" fullWidth onClick={() => supabase.auth.signOut()}>
                Sign out
              </Button>
            </Stack>
          </div>
        </Stack>
      }
    >
      <Outlet />
    </AppShell>
  );
}
