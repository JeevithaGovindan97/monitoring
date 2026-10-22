import { useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useApi, useAuth } from '../lib/hooks';
import { TzContext } from '../lib/format';

const NAV: Array<{ label?: string; to?: string; text?: string; admin?: boolean; badge?: 'incidents' }> = [
  { label: 'Monitor' },
  { to: '/', text: 'Overview' },
  { to: '/inventory', text: 'Inventory' },
  { to: '/uptime', text: 'Uptime history' },
  { to: '/incidents', text: 'Incidents', badge: 'incidents' },
  { to: '/ssl', text: 'SSL certificates' },
  { to: '/forms', text: 'Forms & checkout' },
  { label: 'Analytics' },
  { to: '/traffic', text: 'Traffic (GA4)' },
  { to: '/seo', text: 'SEO (Search Console)' },
  { to: '/performance', text: 'Performance' },
  { label: 'Work' },
  { to: '/tasks', text: 'Tasks & escalations' },
  { to: '/reports', text: 'Reports' },
  { to: '/notifications', text: 'Notifications' },
  { label: 'Administration' },
  { to: '/integrations', text: 'Integrations', admin: true },
  { to: '/users', text: 'Users', admin: true },
  { to: '/audit', text: 'Audit logs', admin: true },
  { to: '/system', text: 'System health' },
];

const ICONS: Record<string, string> = {
  '/': 'M3 12l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  '/inventory': 'M4 6h16M4 12h16M4 18h16',
  '/uptime': 'M3 12h4l3-8 4 16 3-8h4',
  '/incidents': 'M12 3l10 18H2L12 3zM12 10v5M12 18v.5',
  '/ssl': 'M6 11V8a6 6 0 0112 0v3M5 11h14v10H5V11zM12 15v3',
  '/forms': 'M5 3h14v18H5V3zM9 8h6M9 12h6M9 16h4',
  '/traffic': 'M4 20V10M10 20V4M16 20v-8M22 20H2',
  '/seo': 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5',
  '/performance': 'M12 14l4-5M4 18a9 9 0 1116 0',
  '/tasks': 'M4 6l2 2 3-3M12 7h8M4 14l2 2 3-3M12 15h8',
  '/reports': 'M7 3h8l4 4v14H7V3zM14 3v5h5M10 13h6M10 17h6',
  '/notifications': 'M6 16V11a6 6 0 1112 0v5l2 2H4l2-2zM10 21h4',
  '/integrations': 'M9 3v5M15 3v5M7 8h10v4a5 5 0 01-10 0V8zM12 17v4',
  '/users': 'M16 20v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M10 4a4 4 0 100 8 4 4 0 000-8zM20 20v-2a4 4 0 00-3-3.9',
  '/audit': 'M9 12l2 2 4-4M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z',
  '/system': 'M4 5h16v6H4V5zM4 13h16v6H4v-6zM8 8h.01M8 16h.01',
};
function NavIcon({ to }: { to: string }) {
  return (
    <svg className="nav-ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICONS[to] ?? ICONS['/']} /></svg>
  );
}

export function Layout({ children, onLogout }: { children: ReactNode; onLogout: () => void }) {
  const { me, isAdmin } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const [theme, setTheme] = useState<string>(() => { try { return localStorage.getItem('theme') ?? 'auto'; } catch { return 'auto'; } });
  const applyTheme = (t: string) => {
    setTheme(t);
    try { localStorage.setItem('theme', t); } catch { /* ignore */ }
    if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
  };
  useState(() => { if (theme !== 'auto') document.documentElement.setAttribute('data-theme', theme); });

  const settings = useApi<any>(['settings'], '/settings');
  const tz = settings.data?.settings?.timezone ?? 'UTC';
  const health = useQuery({ queryKey: ['health-banner'], queryFn: () => api('/system/health'), refetchInterval: 60_000 });
  const unread = useQuery({ queryKey: ['unread'], queryFn: () => api<{ unread: number }>('/notifications/unread-count'), refetchInterval: 45_000 });
  const openInc = useQuery({ queryKey: ['open-inc-count'], queryFn: () => api('/incidents?open=true&pageSize=1'), refetchInterval: 60_000 });
  const workerDown = health.data && !health.data.monitoring_worker?.alive;

  return (
    <TzContext.Provider value={tz}>
      <a href="#main" className="sr-only">Skip to content</a>
      <div className="app">
        <aside className={`sidebar ${open ? 'open' : ''}`} aria-label="Primary">
          <div className="brand">
            <span className="brand-logo" aria-hidden><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h4l3-8 4 16 3-8h4" /></svg></span>
            <span className="brand-text"><strong>Website Monitoring</strong><small>IGO Groups</small></span>
          </div>
          <nav className="nav" onClick={() => setOpen(false)}>
            {NAV.map((n, i) => n.label ? <div key={i} className="nav-label">{n.label}</div> : (n.admin && !isAdmin) ? null : (
              <NavLink key={n.to} to={n.to!} end={n.to === '/'}>
                <NavIcon to={n.to!} />
                <span>{n.text}</span>
                {n.badge === 'incidents' && openInc.data?.total > 0 && <span className="badge-count" aria-label={`${openInc.data.total} open`}>{openInc.data.total}</span>}
              </NavLink>
            ))}
          </nav>
          <div className="side-user" aria-label="Signed in user">
            <span className="avatar" aria-hidden>{(me.name || me.email || '?').trim().charAt(0).toUpperCase()}</span>
            <span className="side-user-t"><strong>{me.name}</strong><small>{me.role === 'admin' ? 'Administrator' : me.role}</small></span>
          </div>
        </aside>
        <div className="main">
          <header className="topbar">
            <button className="btn ghost menu-btn" onClick={() => setOpen((o) => !o)} aria-label="Toggle navigation" aria-expanded={open}>☰</button>
            <div className="grow muted topbar-note"><span className="live-dot" aria-hidden />Live monitoring · times shown in {tz}</div>
            <select aria-label="Theme" value={theme} onChange={(e) => applyTheme(e.target.value)} style={{ width: 'auto' }}>
              <option value="auto">Theme: system</option><option value="light">Light</option><option value="dark">Dark</option>
            </select>
            <NavLink to="/notifications" className="btn icon-btn" aria-label={`Notifications, ${unread.data?.unread ?? 0} unread`} title="Notifications">
              <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICONS['/notifications']} /></svg>{(unread.data?.unread ?? 0) > 0 && <span className="badge-count" style={{ position: 'absolute', top: -4, right: -4, background: '#e5484d', color: '#fff', borderRadius: 10, fontSize: 11, padding: '0 5px' }}>{unread.data!.unread}</span>}
            </NavLink>
            <NavLink to="/change-password" className="user-chip" title="Change your password"><span className="avatar sm" aria-hidden>{(me.name || me.email || '?').trim().charAt(0).toUpperCase()}</span><span className="user-chip-t"><strong>{me.name}</strong><small>{me.role}</small></span></NavLink>
            <button className="btn sm" onClick={onLogout}>Log out</button>
          </header>
          {workerDown && (
            <div className="banner warn" role="alert">
              <strong>Monitoring worker is not reporting.</strong>
              <span>Website statuses may be stale. This is a monitoring-system problem, not necessarily a website outage. <NavLink to="/system">View system health</NavLink></span>
            </div>
          )}
          <main id="main" className="content" key={loc.pathname}>{children}</main>
        </div>
      </div>
    </TzContext.Provider>
  );
}
