import { useState, type FormEvent } from 'react';
import {
  Body,
  Button,
  Caption,
  Card,
  PageShell,
  SectionTitle,
  Stack,
  TextField,
} from '@apygee/atoms';
import { supabase } from '../supabase';

type Step = 'email' | 'code';

export function LoginPage() {
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSendCode(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const { error: sendError } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    });
    setSubmitting(false);
    if (sendError) {
      setError(sendError.message || 'Could not send the code. Check the email and try again.');
      return;
    }
    setStep('code');
  }

  async function handleVerifyCode(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const { error: verifyError } = await supabase.auth.verifyOtp({
      email,
      token: code,
      type: 'email',
    });
    setSubmitting(false);
    if (verifyError) {
      setError(verifyError.message || 'That code did not work. Request a new one and try again.');
    }
    // On success, useAuth() in <App> flips to a signed-in user and routes away.
  }

  return (
    <PageShell width="sm">
      <Stack gap="xl">
        <Stack gap="xs">
          <Caption>PTO Demo</Caption>
          <SectionTitle>Sign in</SectionTitle>
          <Body>Email-code authentication powered by Supabase.</Body>
        </Stack>

        <Card padding="lg" surface="raised">
          {step === 'email' ? (
            <form onSubmit={handleSendCode}>
              <Stack gap="md">
                <TextField
                  label="Email"
                  name="email"
                  placeholder="you@example.com"
                  inputMode="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.currentTarget.value)}
                  error={error ?? undefined}
                  required
                />
                <Button type="submit" fullWidth disabled={submitting || !email}>
                  {submitting ? 'Sending…' : 'Send code'}
                </Button>
              </Stack>
            </form>
          ) : (
            <form onSubmit={handleVerifyCode}>
              <Stack gap="md">
                <Body>{`We sent a 6-digit code to ${email}.`}</Body>
                <TextField
                  label="Code"
                  name="code"
                  placeholder="123456"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.currentTarget.value)}
                  error={error ?? undefined}
                  required
                />
                <Button type="submit" fullWidth disabled={submitting || !code}>
                  {submitting ? 'Verifying…' : 'Verify and sign in'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  fullWidth
                  disabled={submitting}
                  onClick={() => {
                    setStep('email');
                    setCode('');
                    setError(null);
                  }}
                >
                  Use a different email
                </Button>
              </Stack>
            </form>
          )}
        </Card>
      </Stack>
    </PageShell>
  );
}
