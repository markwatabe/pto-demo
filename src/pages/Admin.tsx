import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Alert,
  Body,
  Button,
  Caption,
  Card,
  Divider,
  Inline,
  PageHeader,
  PageShell,
  SectionTitle,
  Spinner,
  Stack,
  Strong,
  TextField,
} from '@apygee/atoms';
import { supabase } from '../supabase';
import { useAuth } from '../auth';

type ProfileRow = {
  id: string;
  email: string;
  status: string;
  requested_at: string;
};

type AdminRow = {
  user_id: string;
  email: string;
  granted_at: string;
};

export function AdminPage() {
  const { user } = useAuth();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [admins, setAdmins] = useState<AdminRow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [grantEmail, setGrantEmail] = useState('');
  const [granting, setGranting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const [profilesRes, adminsRes] = await Promise.all([
      supabase
        .from('profiles')
        .select('id, email, status, requested_at')
        .order('requested_at', { ascending: true }),
      supabase
        .from('admins')
        .select('user_id, email, granted_at')
        .order('granted_at', { ascending: true }),
    ]);
    if (profilesRes.error || adminsRes.error) {
      setError((profilesRes.error ?? adminsRes.error)!.message);
    } else {
      setProfiles((profilesRes.data ?? []) as ProfileRow[]);
      setAdmins((adminsRes.data ?? []) as AdminRow[]);
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function approve(profile: ProfileRow) {
    setBusyId(profile.id);
    setError(null);
    const { data: updated, error: updateError } = await supabase
      .from('profiles')
      .update({
        status: 'approved',
        approved_at: new Date().toISOString(),
        approved_by: user?.id ?? null,
      })
      .eq('id', profile.id)
      .select('id');
    setBusyId(null);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    if ((updated ?? []).length === 0) {
      setError('You no longer have permission to approve sign-ups.');
      return;
    }
    await load();
  }

  async function grant(event: FormEvent) {
    event.preventDefault();
    const email = grantEmail.trim().toLowerCase();
    if (!email) return;
    setGranting(true);
    setError(null);
    const { data: profile, error: lookupError } = await supabase
      .from('profiles')
      .select('id, email')
      .eq('email', email)
      .maybeSingle();
    if (lookupError) {
      setGranting(false);
      setError(lookupError.message);
      return;
    }
    if (!profile) {
      setGranting(false);
      setError('No account with that email has signed in yet.');
      return;
    }
    const { error: insertError } = await supabase
      .from('admins')
      .insert({ user_id: profile.id, email: profile.email, granted_by: user?.id ?? null });
    setGranting(false);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    setGrantEmail('');
    await load();
  }

  async function revoke(admin: AdminRow) {
    setBusyId(admin.user_id);
    setError(null);
    const { data: removed, error: deleteError } = await supabase
      .from('admins')
      .delete()
      .eq('user_id', admin.user_id)
      .select('user_id');
    setBusyId(null);
    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    if ((removed ?? []).length === 0) {
      setError('You no longer have permission to revoke admins.');
      return;
    }
    await load();
  }

  const pending = profiles.filter((p) => p.status === 'pending');
  const members = profiles.filter((p) => p.status === 'approved');

  return (
    <PageShell width="lg">
      <Stack gap="xl">
        <PageHeader
          eyebrow="PTO"
          title="Admin"
          description="Approve new sign-ups and manage admins."
        />

        {error ? <Alert tone="danger" title="Something went wrong" description={error} /> : null}

        {isLoading ? (
          <Stack gap="md" align="center">
            <Spinner />
          </Stack>
        ) : (
          <>
            <Card padding="lg" surface="raised">
              <Stack gap="md">
                <SectionTitle>Pending sign-ups</SectionTitle>
                {pending.length === 0 ? (
                  <Body>No one is waiting for approval.</Body>
                ) : (
                  <Stack gap="md">
                    {pending.map((profile) => (
                      <Inline key={profile.id} gap="md" align="center" wrap>
                        <Stack gap="xs">
                          <Strong>{profile.email}</Strong>
                          <Caption>
                            {`Requested ${new Date(profile.requested_at).toLocaleDateString()}`}
                          </Caption>
                        </Stack>
                        <Button onClick={() => approve(profile)} disabled={busyId === profile.id}>
                          {busyId === profile.id ? 'Approving…' : 'Approve'}
                        </Button>
                      </Inline>
                    ))}
                  </Stack>
                )}
              </Stack>
            </Card>

            <Card padding="lg" surface="raised">
              <Stack gap="md">
                <SectionTitle>Members</SectionTitle>
                {members.length === 0 ? (
                  <Body>No approved members yet.</Body>
                ) : (
                  <Stack gap="sm">
                    {members.map((profile) => (
                      <Body key={profile.id}>{profile.email}</Body>
                    ))}
                  </Stack>
                )}
              </Stack>
            </Card>

            <Card padding="lg" surface="raised">
              <Stack gap="md">
                <SectionTitle>Admins</SectionTitle>
                <Stack gap="sm">
                  {admins.map((admin) => (
                    <Inline key={admin.user_id} gap="md" align="center" wrap>
                      <Body>{admin.email}</Body>
                      {admin.user_id === user?.id ? (
                        <Caption>you</Caption>
                      ) : (
                        <Button
                          variant="secondary"
                          onClick={() => revoke(admin)}
                          disabled={busyId === admin.user_id}
                        >
                          {busyId === admin.user_id ? 'Revoking…' : 'Revoke'}
                        </Button>
                      )}
                    </Inline>
                  ))}
                </Stack>

                <Divider />

                <form onSubmit={grant}>
                  <Stack gap="md">
                    <TextField
                      label="Grant admin by email"
                      name="grantEmail"
                      placeholder="parent@example.com"
                      inputMode="email"
                      value={grantEmail}
                      onChange={(e) => setGrantEmail(e.currentTarget.value)}
                    />
                    <Button type="submit" disabled={granting || !grantEmail.trim()}>
                      {granting ? 'Granting…' : 'Grant admin'}
                    </Button>
                  </Stack>
                </form>
              </Stack>
            </Card>
          </>
        )}
      </Stack>
    </PageShell>
  );
}
