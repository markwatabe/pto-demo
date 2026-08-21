import { Body, Button, Caption, Card, PageShell, SectionTitle, Stack } from '@apygee/atoms';
import { supabase } from '../supabase';

export function WaitingPage({ onCheckAgain }: { onCheckAgain: () => void }) {
  return (
    <PageShell width="sm">
      <Stack gap="xl">
        <Stack gap="xs">
          <Caption>PTO Demo</Caption>
          <SectionTitle>Waiting for approval</SectionTitle>
          <Body>
            Your account is waiting for PTO admin approval. You will get access to the
            directory once an admin approves your sign-up.
          </Body>
        </Stack>

        <Card padding="lg" surface="raised">
          <Stack gap="md">
            <Button fullWidth onClick={onCheckAgain}>
              Check again
            </Button>
            <Button variant="ghost" fullWidth onClick={() => supabase.auth.signOut()}>
              Sign out
            </Button>
          </Stack>
        </Card>
      </Stack>
    </PageShell>
  );
}
