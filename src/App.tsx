import { Navigate, Route, Routes } from 'react-router';
import { PageShell, Spinner, Stack } from '@apygee/atoms';
import { useAccess } from './access';
import { AppLayout } from './components/AppLayout';
import { LoginPage } from './pages/Login';
import { DirectoryPage } from './pages/Directory';
import { CalendarPage } from './pages/Calendar';
import { AvailabilityPage } from './pages/Availability';
import { FormsPage } from './pages/Forms';
import { OurPtoPage } from './pages/OurPto';
import { AdminPage } from './pages/Admin';
import { SchedulePage } from './pages/Schedule';
import { VolunteersPage } from './pages/Volunteers';
import { WaitingPage } from './pages/Waiting';

export function App() {
  const { isLoading, user, status, isAdmin, refresh } = useAccess();

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

  if (status !== 'approved') {
    return <WaitingPage onCheckAgain={refresh} />;
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/calendar" replace />} />
      <Route element={<AppLayout isAdmin={isAdmin} />}>
        <Route path="/directory" element={<DirectoryPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/availability" element={<AvailabilityPage />} />
        <Route path="/forms" element={<FormsPage />} />
        <Route path="/our-pto" element={<OurPtoPage />} />
        <Route
          path="/admin"
          element={isAdmin ? <AdminPage /> : <Navigate to="/calendar" replace />}
        />
        <Route
          path="/admin/schedule"
          element={isAdmin ? <SchedulePage /> : <Navigate to="/calendar" replace />}
        />
        <Route
          path="/admin/volunteers"
          element={isAdmin ? <VolunteersPage /> : <Navigate to="/calendar" replace />}
        />
        <Route path="/" element={<Navigate to="/calendar" replace />} />
        <Route path="*" element={<Navigate to="/calendar" replace />} />
      </Route>
    </Routes>
  );
}
