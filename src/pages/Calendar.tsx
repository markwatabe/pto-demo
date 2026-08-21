import { Alert, Card, Body, PageHeader, PageShell, SectionTitle, Stack } from '@apygee/atoms';

export function CalendarPage() {
  return (
    <PageShell width="xl">
      <Stack gap="xl">
        <PageHeader
          eyebrow="Planning"
          title="My calendar"
          description="Your PTO events, volunteer shifts, and school dates will show up here."
        />
        <Alert
          tone="info"
          title="Coming soon"
          description="The calendar view is not wired up yet."
        />
        <Card padding="lg" surface="muted">
          <Stack gap="md">
            <SectionTitle>Calendar placeholder</SectionTitle>
            <Body>
              A future pass will connect this to event data and render a month / agenda view.
            </Body>
          </Stack>
        </Card>
      </Stack>
    </PageShell>
  );
}
