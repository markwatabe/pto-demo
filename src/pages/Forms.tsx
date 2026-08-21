import { Alert, Card, Body, PageHeader, PageShell, SectionTitle, Stack } from '@apygee/atoms';

export function FormsPage() {
  return (
    <PageShell width="xl">
      <Stack gap="xl">
        <PageHeader
          eyebrow="Paperwork"
          title="Forms"
          description="Directory opt-in, volunteer sign-ups, and permission slips will live here."
        />
        <Alert
          tone="info"
          title="Coming soon"
          description="Forms are not wired up yet."
        />
        <Card padding="lg" surface="muted">
          <Stack gap="md">
            <SectionTitle>Forms placeholder</SectionTitle>
            <Body>
              A future pass will list available forms and let families submit them.
            </Body>
          </Stack>
        </Card>
      </Stack>
    </PageShell>
  );
}
