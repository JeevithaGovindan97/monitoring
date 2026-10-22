import { lazy, Suspense, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, setCsrf, setUnauthorizedHandler } from './lib/api';
import { Provide, type Me } from './lib/hooks';
import { LoadingBlock } from './components/ui';
import { Layout } from './components/Layout';
import { LoginPage, ChangePasswordPage } from './pages/Auth';
import { OverviewPage } from './pages/Overview';
import { InventoryPage } from './pages/Inventory';
const WebsiteDetailPage = lazy(() => import('./pages/WebsiteDetail').then((m) => ({ default: m.WebsiteDetailPage })));
const UptimePage = lazy(() => import('./pages/Uptime').then((m) => ({ default: m.UptimePage })));
const TrafficPage = lazy(() => import('./pages/Sections').then((m) => ({ default: m.TrafficPage })));
const SeoPage = lazy(() => import('./pages/Sections').then((m) => ({ default: m.SeoPage })));
const PerformancePage = lazy(() => import('./pages/Sections').then((m) => ({ default: m.PerformancePage })));
const SslPage = lazy(() => import('./pages/Sections').then((m) => ({ default: m.SslPage })));
const FormsPage = lazy(() => import('./pages/Sections').then((m) => ({ default: m.FormsPage })));
import { IncidentsPage, IncidentDetailPage } from './pages/Incidents';
import { TasksPage } from './pages/Tasks';
import { ReportsPage } from './pages/Reports';
import { IntegrationsPage } from './pages/Integrations';
import { UsersPage } from './pages/Users';
import { NotificationsPage } from './pages/Notifications';
import { AuditPage } from './pages/Audit';
import { SystemPage } from './pages/System';

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const nav = useNavigate();
  const qc = useQueryClient();

  useEffect(() => {
    setUnauthorizedHandler(() => { setMe(null); qc.clear(); });
    api('/auth/me').then((r) => { setCsrf(r.csrfToken); setMe(r.user); }).catch(() => setMe(null));
  }, [qc]);

  if (me === undefined) return <div style={{ padding: 40 }}><LoadingBlock rows={3} /></div>;

  const onLogin = (user: Me, csrf: string) => { setCsrf(csrf); setMe(user); qc.clear(); nav(user.mustChangePassword ? '/change-password' : '/', { replace: true }); };
  const onLogout = async () => { try { await api('/auth/logout', { method: 'POST' }); } catch { /* session may already be gone */ } setMe(null); setCsrf(''); qc.clear(); nav('/login'); };

  if (!me) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage onLogin={onLogin} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }
  if (me.mustChangePassword) {
    return (
      <Routes>
        <Route path="/change-password" element={<ChangePasswordPage forced onDone={() => setMe({ ...me, mustChangePassword: false })} onLogout={onLogout} />} />
        <Route path="*" element={<Navigate to="/change-password" replace />} />
      </Routes>
    );
  }
  const isAdmin = me.role === 'admin';
  return (
    <Provide value={{ me, isAdmin }}>
      <Layout onLogout={onLogout}>
        <Suspense fallback={<LoadingBlock />}>
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/inventory" element={<InventoryPage />} />
          <Route path="/websites/:id" element={<WebsiteDetailPage />} />
          <Route path="/uptime" element={<UptimePage />} />
          <Route path="/traffic" element={<TrafficPage />} />
          <Route path="/seo" element={<SeoPage />} />
          <Route path="/performance" element={<PerformancePage />} />
          <Route path="/ssl" element={<SslPage />} />
          <Route path="/incidents" element={<IncidentsPage />} />
          <Route path="/incidents/:id" element={<IncidentDetailPage />} />
          <Route path="/forms" element={<FormsPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/change-password" element={<ChangePasswordPage onDone={() => nav('/')} onLogout={onLogout} />} />
          {isAdmin && <Route path="/integrations" element={<IntegrationsPage />} />}
          {isAdmin && <Route path="/users" element={<UsersPage />} />}
          {isAdmin && <Route path="/audit" element={<AuditPage />} />}
          <Route path="/system" element={<SystemPage />} />
          <Route path="*" element={<div className="empty"><h3>Page not found</h3><p>That page does not exist or you do not have access to it.</p></div>} />
        </Routes>
        </Suspense>
      </Layout>
    </Provide>
  );
}
