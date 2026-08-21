import { Navigate, Route, Routes } from 'react-router';
import { PageShell, Spinner, Stack } from '@apygee/atoms';
import { useAuth } from './auth';
import { AppLayout } from './components/AppLayout';
import { LoginPage } from './pages/Login';
import { DirectoryPage } from './pages/Directory';
import { CalendarPage } from './pages/Calendar';
import { FormsPage } from './pages/Forms';
import { OurPtoPage } from './pages/OurPto';

export function App() {
  const { isLoading, user } = useAuth();

  if (isLoading) {
    return (
      <PageShell width="sm">
        <Stack gap="md" align="center">
          <Spinner />
        </Stack>
      </PageShell>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/directory" replace />} />
      <Route element={<AppLayout />}>
        <Route path="/directory" element={<DirectoryPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/forms" element={<FormsPage />} />
        <Route path="/our-pto" element={<OurPtoPage />} />
        <Route path="/" element={<Navigate to="/directory" replace />} />
        <Route path="*" element={<Navigate to="/directory" replace />} />
      </Route>
    </Routes>
  );
}
