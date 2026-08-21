import { Body, Card, PageHeader, PageShell, SectionTitle, Stack } from '@apygee/atoms';

export function OurPtoPage() {
  return (
    <PageShell width="lg">
      <Stack gap="xl">
        <PageHeader
          eyebrow="Welcome"
          title="Our PTO"
          description="Who we are and how families can get involved."
        />
        <Card padding="lg" surface="raised">
          <Stack gap="md">
            <SectionTitle>About the PTO</SectionTitle>
            <Body>
              Our Parent–Teacher Organization brings families and staff together to support
              students through events, volunteering, and fundraising. Use the directory to connect
              with other families, check your calendar for upcoming events, and complete any forms
              you need.
            </Body>
          </Stack>
        </Card>
      </Stack>
    </PageShell>
  );
}
