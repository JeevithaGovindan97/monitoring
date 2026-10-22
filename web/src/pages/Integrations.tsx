import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Async, Badge, Card, Field, IntegrationBadge, Kpi, PageHeader } from '../components/ui';
import { useApi } from '../lib/hooks';
import { ago, fmtDateTime, title, useTz } from '../lib/format';
import { useToast } from '../lib/toast';

export function IntegrationsPage() {
  const q = useApi<any>(['integrations'], '/integrations');
  const tz = useTz(); const toast = useToast(); const qc = useQueryClient();
  const [result, setResult] = useState<{ title: string; ok: boolean; message: string } | null>(null);
  const [propId, setPropId] = useState(''); const [gscProp, setGscProp] = useState('');
  const test = useMutation({
    mutationFn: (v: { path: string; body: object; label: string }) => api(v.path, { body: v.body }).then((r) => ({ ...r, label: v.label })),
    onSuccess: (r: any) => setResult({ title: r.label, ok: Boolean(r.ok), message: r.message ?? (r.ok ? 'Access confirmed.' : r.kind ?? 'Failed') }),
    onError: (e) => setResult({ title: 'Test', ok: false, message: (e as Error).message }),
  });
  const sites = useApi<any>(['gsc-sites'], '/integrations/search-console/sites', { enabled: false });
  const sitesList = useMutation({ mutationFn: () => api('/integrations/search-console/sites'), onError: (e) => toast('err', (e as Error).message) });
  const ps = useMutation({ mutationFn: (strategies: string[]) => api('/integrations/pagespeed', { method: 'PATCH', body: { strategies } }), onSuccess: () => { toast('ok', 'Saved'); qc.invalidateQueries({ queryKey: ['integrations'] }); } });
  void sites;
  return (
    <>
      <PageHeader title="Integration settings" sub="Google data is read through an official service account — no passwords or personal Google logins are stored. Secrets live in server environment variables, never in the database or the browser." />
      <Async q={q}>{(d) => {
        const by: Record<string, any> = Object.fromEntries(d.integrations.map((i: any) => [i.kind, i]));
        const c = d.counts;
        return (
          <>
            {!d.google.credentials_configured && <div className="alert warn">Google service-account credentials are <strong>not configured</strong> on the server. GA4 and Search Console will show “Not connected” until <code>GOOGLE_SERVICE_ACCOUNT_JSON</code> (or <code>_FILE</code>) is set. See docs/EMAIL_AND_GOOGLE_SETUP.md.</div>}
            <div className="grid g2">
              <Card title="Google service account" actions={<IntegrationBadge status={d.google.credentials_configured ? 'connected' : 'not_connected'} />}>
                {d.google.service_account_email ? <><p>Grant this e-mail <strong>Viewer</strong> access on each GA4 property, and add it as a user on each Search Console property:</p><p className="mono" style={{ userSelect: 'all', wordBreak: 'break-all' }}>{d.google.service_account_email}</p></> : <p className="muted">No service account loaded.</p>}
              </Card>
              <Card title="SMTP (e-mail alerts)" actions={<IntegrationBadge status={d.smtp.configured ? 'connected' : 'not_connected'} />}>
                <p className="muted">{d.smtp.configured ? 'SMTP is configured through environment variables. Send a test from Notifications → Alert settings.' : 'SMTP is not configured. In-app notifications work, but e-mails are not sent and are never shown as delivered.'}</p>
              </Card>
              <Card title="Google Analytics 4" actions={<IntegrationBadge status={by.ga4?.status ?? 'not_connected'} />}>
                <div className="kpis" style={{ marginBottom: 10 }}>
                  <Kpi label="Mapped" value={c.ga4_mapped} /><Kpi label="Connected" value={c.ga4_connected} tone="up" /><Kpi label="Need access" value={c.ga4_access_required} tone={c.ga4_access_required ? 'warn' : undefined} /><Kpi label="Errors" value={c.ga4_error} tone={c.ga4_error ? 'down' : undefined} />
                </div>
                <p className="faint">Last successful sync: {by.ga4?.last_success_at ? `${fmtDateTime(by.ga4.last_success_at, tz)} (${ago(by.ga4.last_success_at)})` : 'never'}</p>
                {by.ga4?.last_error && <p className="err-text">Last error: {by.ga4.last_error}</p>}
                <div className="row"><input aria-label="GA4 property ID" placeholder="Test a property ID, e.g. 123456789" value={propId} onChange={(e) => setPropId(e.target.value)} style={{ flex: 1 }} />
                  <button className="btn" disabled={!/^\d{5,15}$/.test(propId) || test.isPending} onClick={() => test.mutate({ path: '/integrations/ga4/test', body: { property_id: propId }, label: 'GA4 test' })}>Test access</button></div>
              </Card>
              <Card title="Google Search Console" actions={<IntegrationBadge status={by.search_console?.status ?? 'not_connected'} />}>
                <div className="kpis" style={{ marginBottom: 10 }}>
                  <Kpi label="Mapped" value={c.gsc_mapped} /><Kpi label="Connected" value={c.gsc_connected} tone="up" /><Kpi label="Need access" value={c.gsc_access_required} tone={c.gsc_access_required ? 'warn' : undefined} /><Kpi label="Errors" value={c.gsc_error} tone={c.gsc_error ? 'down' : undefined} />
                </div>
                <p className="faint">Last successful sync: {by.search_console?.last_success_at ? ago(by.search_console.last_success_at) : 'never'}</p>
                {by.search_console?.last_error && <p className="err-text">Last error: {by.search_console.last_error}</p>}
                <div className="row"><input aria-label="Search Console property" placeholder="sc-domain:example.com" value={gscProp} onChange={(e) => setGscProp(e.target.value)} style={{ flex: 1 }} />
                  <button className="btn" disabled={!gscProp || test.isPending} onClick={() => test.mutate({ path: '/integrations/search-console/test', body: { property: gscProp }, label: 'Search Console test' })}>Test access</button>
                  <button className="btn" disabled={sitesList.isPending || !d.google.credentials_configured} onClick={() => sitesList.mutate()}>List visible properties</button></div>
                {sitesList.data && <ul className="mono" style={{ margin: '8px 0 0', paddingLeft: 18 }}>{(sitesList.data as any).data.length ? (sitesList.data as any).data.map((s: any) => <li key={s.siteUrl ?? s}>{s.siteUrl ?? s} <span className="faint">{s.permissionLevel}</span></li>) : <li>No properties are shared with the service account yet.</li>}</ul>}
              </Card>
              <Card title="PageSpeed Insights" actions={<IntegrationBadge status={by.pagespeed?.status ?? 'not_connected'} />}>
                <p className="muted">{d.pagespeed.api_key_configured ? 'An API key is configured (higher quota).' : 'No API key configured — works at a low anonymous quota. Add PAGESPEED_API_KEY for reliable scheduled audits.'}</p>
                <div className="row"><label className="check"><input type="checkbox" defaultChecked={(by.pagespeed?.config?.strategies ?? ['mobile']).includes('mobile')} onChange={(e) => ps.mutate([...(e.target.checked ? ['mobile'] : []), ...(by.pagespeed?.config?.strategies ?? ['mobile']).includes('desktop') ? ['desktop'] : []])} /> Mobile</label>
                  <label className="check"><input type="checkbox" defaultChecked={(by.pagespeed?.config?.strategies ?? []).includes('desktop')} onChange={(e) => ps.mutate([...((by.pagespeed?.config?.strategies ?? ['mobile']).includes('mobile') ? ['mobile'] : []), ...(e.target.checked ? ['desktop'] : [])])} /> Desktop</label></div>
                <p className="faint">Last successful audit: {by.pagespeed?.last_success_at ? ago(by.pagespeed.last_success_at) : 'never'}</p>
              </Card>
              <Card title="Uptime Kuma">
                <Badge kind="plain">{d.uptime_kuma.url_configured ? 'URL configured, not used' : 'Not used'}</Badge>
                <p className="muted" style={{ marginTop: 8 }}>{d.uptime_kuma.authoritative}</p>
              </Card>
            </div>
            <p className="faint" style={{ marginTop: 12 }}>Map each website to its GA4 property / Search Console property from Inventory → Edit. {title('status')} shows “Access required” until a sync proves access.</p>
          </>);
      }}</Async>
      {result && <div className={`alert ${result.ok ? 'ok' : 'err'}`} role="status" style={{ marginTop: 12 }}><strong>{result.title}:</strong> {result.message} <button className="btn sm" onClick={() => setResult(null)}>Dismiss</button></div>}
      <Field label=""><span /></Field>
    </>
  );
}
