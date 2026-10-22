import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../lib/api';
import { Async, Badge, Card, Confirm, Empty, Field, PageHeader, Pager, Tabs } from '../components/ui';
import { MaintenanceModal } from './WebsiteDetail';
import { useApi, useAuth } from '../lib/hooks';
import { ago, fmtDateTime, useTz } from '../lib/format';
import { useToast } from '../lib/toast';

export function NotificationsPage() {
  const { isAdmin } = useAuth();
  const [tab, setTab] = useState('inbox');
  const tabs = [{ key: 'inbox', label: 'Inbox' }, { key: 'prefs', label: 'My preferences' }, ...(isAdmin ? [{ key: 'alerts', label: 'Alert settings' }, { key: 'email', label: 'E-mail delivery log' }] : []), { key: 'maint', label: 'Maintenance windows' }];
  return (
    <>
      <PageHeader title="Notifications" sub="In-app notifications and e-mail alerts. E-mails are marked “sent” only after the mail server accepted them." />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'inbox' && <Inbox />}{tab === 'prefs' && <Prefs />}{tab === 'alerts' && <AlertSettings />}{tab === 'email' && <EmailLog />}{tab === 'maint' && <Maintenance />}
    </>
  );
}

const sevKind = (s: string) => (s === 'warning' ? 'degraded' : s === 'critical' ? 'down' : 'info');

function Inbox() {
  const tz = useTz(); const nav = useNavigate(); const qc = useQueryClient();
  const [page, setPage] = useState(1); const [unread, setUnread] = useState(false);
  const q = useApi<any>(['notifs', page, unread], `/notifications${qs({ page, pageSize: 25, unread: unread ? 'true' : undefined })}`, { refetchMs: 30_000 });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['notifs'] }); qc.invalidateQueries({ queryKey: ['unread'] }); };
  const all = useMutation({ mutationFn: () => api('/notifications/read-all', { method: 'POST' }), onSuccess: refresh });
  const one = useMutation({ mutationFn: (id: string) => api(`/notifications/${id}/read`, { method: 'PATCH' }), onSuccess: refresh });
  return (
    <Card pad={false} actions={<><label className="check"><input type="checkbox" checked={unread} onChange={(e) => { setUnread(e.target.checked); setPage(1); }} /> Unread only</label><button className="btn sm" onClick={() => all.mutate()} disabled={all.isPending}>Mark all read</button></>}>
      <Async q={q}>{(d) => !d.data.length ? <Empty title="No notifications">{unread ? 'You are all caught up.' : 'Alerts for incidents, SSL, tasks and escalations appear here.'}</Empty> : (
        <>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{d.data.map((n: any) => (
            <li key={n.id} style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', background: n.read_at ? undefined : 'var(--accent-soft)' }}>
              <div className="row"><Badge kind={sevKind(n.severity)}>{n.severity}</Badge><strong>{n.title}</strong><span className="faint" title={fmtDateTime(n.created_at, tz)}>{ago(n.created_at)}</span><span className="grow" />
                {n.link && <button className="btn sm" onClick={() => { if (!n.read_at) one.mutate(n.id); nav(n.link); }}>Open</button>}
                {!n.read_at && <button className="btn sm" onClick={() => one.mutate(n.id)}>Mark read</button>}</div>
              {n.body && <div className="muted" style={{ marginTop: 4 }}>{n.body}</div>}
            </li>))}</ul>
          <Pager page={d.page} totalPages={d.totalPages} total={d.total} pageSize={25} onPage={setPage} />
        </>)}</Async>
    </Card>
  );
}

function Prefs() {
  const q = useApi<any>(['my-prefs'], '/settings/me'); const toast = useToast(); const qc = useQueryClient();
  const m = useMutation({ mutationFn: (b: object) => api('/settings/me', { method: 'PATCH', body: b }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['my-prefs'] }); toast('ok', 'Saved'); }, onError: (e) => toast('err', (e as Error).message) });
  return <Card title="My notification preferences"><Async q={q}>{(p) => (
    <div className="col">
      <label className="check"><input type="checkbox" checked={p.notify_in_app} onChange={(e) => m.mutate({ notify_in_app: e.target.checked })} /> Show in-app notifications</label>
      <label className="check"><input type="checkbox" checked={p.notify_email} onChange={(e) => m.mutate({ notify_email: e.target.checked })} /> Send me e-mail alerts</label>
      <p className="faint">Critical system-wide alerts also go to the shared alert recipients configured by an administrator.</p>
    </div>)}</Async></Card>;
}

function AlertSettings() {
  const q = useApi<any>(['settings'], '/settings'); const toast = useToast(); const qc = useQueryClient();
  const [f, setF] = useState<any>(null);
  useEffect(() => { if (q.data && !f) { const s = q.data.settings; setF({ ...s, ssl_alert_days: (s.ssl_alert_days ?? []).join(', '), alert_recipients: (s.alert_recipients ?? []).join(', ') }); } }, [q.data, f]);
  const save = useMutation({
    mutationFn: () => api('/settings', { method: 'PUT', body: { ...f, ssl_alert_days: String(f.ssl_alert_days).split(',').map((x) => Number(x.trim())).filter(Boolean), alert_recipients: String(f.alert_recipients).split(',').map((x) => x.trim()).filter(Boolean) } }),
    onSuccess: () => { toast('ok', 'Settings saved'); qc.invalidateQueries({ queryKey: ['settings'] }); }, onError: (e) => toast('err', (e as Error).message),
  });
  const [to, setTo] = useState('');
  const test = useMutation({ mutationFn: () => api('/notifications/test-email', { body: to ? { to } : {} }), onSuccess: (r: any) => toast('ok', `Test e-mail accepted by the mail server for ${r.to}`), onError: (e) => toast('err', `Test failed: ${(e as Error).message}`) });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <Async q={q}>{(d) => f && (
      <div className="stack">
        {!d.smtp.configured && <div className="alert warn">SMTP is not configured on the server (SMTP_HOST, SMTP_FROM…). E-mails cannot be sent; they will stay queued/failed and are never marked as delivered.</div>}
        <Card title="Alerting">
          <div className="form-grid">
            <Field label="Alert recipients (comma separated)" hint={`Also from environment: ${d.env_recipients.join(', ') || 'none'}`} full><input value={f.alert_recipients} onChange={set('alert_recipients')} /></Field>
            <Field label="Cooldown between repeat alerts (minutes)"><input type="number" value={f.alert_cooldown_minutes} onChange={set('alert_cooldown_minutes')} /></Field>
            <Field label="Default “degraded” threshold (ms)"><input type="number" value={f.degraded_threshold_ms} onChange={set('degraded_threshold_ms')} /></Field>
            <Field label="SSL alert days before expiry" hint="e.g. 30, 14, 7"><input value={f.ssl_alert_days} onChange={set('ssl_alert_days')} /></Field>
            <Field label="Display time zone" hint="IANA name, e.g. Asia/Kolkata"><input value={f.timezone} onChange={set('timezone')} /></Field>
          </div>
        </Card>
        <Card title="Data retention (days)"><div className="form-grid">
          {[['retention_checks_days', 'Raw checks'], ['retention_hourly_days', 'Hourly summaries'], ['retention_reports_days', 'Generated reports'], ['retention_audit_days', 'Audit logs'], ['retention_notifications_days', 'Notifications']].map(([k, l]) => <Field key={k} label={l!}><input type="number" value={f[k!]} onChange={set(k!)} /></Field>)}
        </div></Card>
        <div className="row"><button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save settings'}</button></div>
        <Card title="Send a test e-mail" tip="Uses the real SMTP configuration. Success means the mail server accepted the message, not that it reached the inbox.">
          <div className="row"><input type="email" aria-label="Recipient" placeholder="Recipient (blank = your own address)" value={to} onChange={(e) => setTo(e.target.value)} style={{ maxWidth: 340 }} /><button className="btn" disabled={test.isPending || !d.smtp.configured} onClick={() => test.mutate()}>{test.isPending ? 'Sending…' : 'Send test'}</button></div>
          <p className="faint">SMTP server: {d.smtp.host ?? 'not set'}:{d.smtp.port} · From: {d.smtp.from ?? 'not set'} · Credentials: {d.smtp.user_set ? 'set (hidden)' : 'none'}</p>
        </Card>
      </div>)}</Async>
  );
}

function EmailLog() {
  const tz = useTz(); const [page, setPage] = useState(1);
  const q = useApi<any>(['deliveries', page], `/notifications/deliveries?page=${page}&pageSize=25`, { refetchMs: 20_000 });
  return <Card pad={false}><Async q={q}>{(d) => !d.data.length ? <Empty title="No e-mails yet" /> : (
    <>
      <div className="table-wrap"><table><thead><tr><th>Created</th><th>To</th><th>Subject</th><th>Status</th><th className="num">Attempts</th><th>Sent</th></tr></thead>
        <tbody>{d.data.map((r: any) => <tr key={r.id}><td className="nowrap">{fmtDateTime(r.created_at, tz)}</td><td>{r.recipient}</td><td>{r.subject}{r.incident_id && <> · <Link to={`/incidents/${r.incident_id}`}>incident</Link></>}</td><td><Badge kind={r.status === 'suppressed' ? 'plain' : r.status} />{r.last_error && <div className="err-text">{r.last_error}</div>}</td><td className="num">{r.attempts}</td><td>{fmtDateTime(r.sent_at, tz)}</td></tr>)}</tbody></table></div>
      <Pager page={d.page} totalPages={d.totalPages} total={d.total} pageSize={25} onPage={setPage} />
    </>)}</Async></Card>;
}

function Maintenance() {
  const { isAdmin } = useAuth(); const tz = useTz(); const qc = useQueryClient(); const toast = useToast();
  const q = useApi<any>(['maint-all'], '/maintenance');
  const [adding, setAdding] = useState(false); const [del, setDel] = useState<any>(null);
  const rm = useMutation({ mutationFn: (id: string) => api(`/maintenance/${id}`, { method: 'DELETE' }), onSuccess: () => { setDel(null); qc.invalidateQueries({ queryKey: ['maint-all'] }); toast('ok', 'Removed'); } });
  return (
    <>
      <Card pad={false} title="Maintenance windows" tip="Failures inside a window are recorded but do not open incidents or reduce uptime." actions={isAdmin && <button className="btn primary sm" onClick={() => setAdding(true)}>Schedule</button>}>
        <Async q={q}>{(d) => !d.data.length ? <Empty title="No maintenance scheduled" /> : (
          <div className="table-wrap"><table><thead><tr><th>Scope</th><th>Starts</th><th>Ends</th><th>Reason</th><th /></tr></thead>
            <tbody>{d.data.map((m: any) => <tr key={m.id}><td>{m.website_name ?? 'All websites'}</td><td>{fmtDateTime(m.starts_at, tz)}</td><td>{fmtDateTime(m.ends_at, tz)}</td><td>{m.reason ?? '—'}</td><td>{isAdmin && <button className="btn sm" onClick={() => setDel(m)}>Remove</button>}</td></tr>)}</tbody></table></div>)}</Async>
      </Card>
      {adding && <MaintenanceModal onClose={() => { setAdding(false); qc.invalidateQueries({ queryKey: ['maint-all'] }); }} />}
      {del && <Confirm title="Remove maintenance window" danger message={<p>Remove this window?</p>} onCancel={() => setDel(null)} onConfirm={() => rm.mutate(del.id)} busy={rm.isPending} confirmLabel="Remove" />}
    </>
  );
}
