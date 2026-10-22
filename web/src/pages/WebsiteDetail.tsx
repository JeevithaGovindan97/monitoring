import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../lib/api';
import { Async, Badge, Card, Confirm, Empty, Field, IntegrationBadge, Kpi, Modal, PageHeader, Pager, RangeSelect, StateBadge, Tabs } from '../components/ui';
import { WebsiteFormModal } from '../components/WebsiteForm';
import { Delta, NotConnected } from '../components/shared';
import { TimeChart } from '../lib/charts';
import { useApi, useAuth, useRange } from '../lib/hooks';
import { ago, dur, fmtDateTime, fmtDate, ms, num, pct, title, useTz } from '../lib/format';
import { useToast } from '../lib/toast';
import { TaskFormModal } from './Tasks';

const TABS = [
  { key: 'overview', label: 'Overview' }, { key: 'uptime', label: 'Uptime & response' }, { key: 'checks', label: 'Check log' }, { key: 'incidents', label: 'Incidents' },
  { key: 'traffic', label: 'Traffic' }, { key: 'seo', label: 'SEO' }, { key: 'performance', label: 'Performance' }, { key: 'ssl', label: 'SSL' }, { key: 'forms', label: 'Forms' }, { key: 'tasks', label: 'Tasks' },
];

export function WebsiteDetailPage() {
  const { id } = useParams();
  const { isAdmin } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') ?? 'overview';
  const [range, setRange] = useRange('7');
  const [editing, setEditing] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const site = useApi<any>(['website', id], `/websites/${id}`, { refetchMs: 30_000 });
  const checkNow = useMutation({
    mutationFn: () => api(`/websites/${id}/check-now`, { method: 'POST' }),
    onSuccess: () => { toast('ok', 'Check queued — result appears within a minute'); setTimeout(() => qc.invalidateQueries({ queryKey: ['website', id] }), 8000); },
    onError: (e) => toast('err', (e as Error).message),
  });
  return (
    <Async q={site}>{(w) => (
      <>
        <PageHeader title={w.name} crumbs={[{ label: 'Inventory', to: '/inventory' }, { label: w.name }]}
          sub={<span className="row"><a href={w.url} target="_blank" rel="noreferrer noopener" className="mono">{w.url}</a><StateBadge state={w.effective_state} /><Badge kind={w.criticality} /></span>}
          actions={<>
            {tab !== 'overview' && ['uptime', 'checks', 'traffic', 'seo', 'performance'].includes(tab) && <RangeSelect value={range} onChange={setRange} />}
            <button className="btn" disabled={checkNow.isPending || w.monitoring_status !== 'active'} onClick={() => checkNow.mutate()} title={w.monitoring_status !== 'active' ? 'Monitoring is not active' : 'Queue an immediate check'}>Check now</button>
            {isAdmin && <button className="btn primary" onClick={() => setEditing(true)}>Edit</button>}
          </>} />
        <Tabs tabs={TABS} value={tab} onChange={(k) => setSp({ tab: k }, { replace: true })} />
        {tab === 'overview' && <OverviewTab w={w} />}
        {tab === 'uptime' && <UptimeTab id={w.id} range={range} />}
        {tab === 'checks' && <ChecksTab id={w.id} range={range} />}
        {tab === 'incidents' && <IncidentsTab id={w.id} />}
        {tab === 'traffic' && <TrafficTab id={w.id} range={range} w={w} />}
        {tab === 'seo' && <SeoTab id={w.id} range={range} />}
        {tab === 'performance' && <PerfTab id={w.id} range={range} />}
        {tab === 'ssl' && <SslTab id={w.id} />}
        {tab === 'forms' && <FormsTab id={w.id} />}
        {tab === 'tasks' && <TasksTab id={w.id} />}
        {editing && <WebsiteFormModal site={w} onClose={() => setEditing(false)} />}
      </>)}</Async>
  );
}

function OverviewTab({ w }: { w: any }) {
  const tz = useTz();
  const { isAdmin } = useAuth();
  const maint = useApi<any>(['w-maint', w.id], `/websites/${w.id}/maintenance`);
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [del, setDel] = useState<any>(null);
  const rm = useMutation({ mutationFn: (mid: string) => api(`/websites/${w.id}/maintenance/${mid}`, { method: 'DELETE' }), onSuccess: () => { setDel(null); qc.invalidateQueries({ queryKey: ['w-maint', w.id] }); toast('ok', 'Maintenance window removed'); } });
  const row = (k: string, v: any) => <tr><th style={{ width: 220, position: 'static', textTransform: 'none' }}>{k}</th><td>{v ?? '—'}</td></tr>;
  return (
    <>
      <div className="kpis" style={{ marginBottom: 16 }}>
        <Kpi label="Status" value={<StateBadge state={w.effective_state} />} note={w.state_since ? `since ${fmtDateTime(w.state_since, tz)}` : ''} />
        <Kpi label="Last check" value={ago(w.last_check_at)} note={fmtDateTime(w.last_check_at, tz)} />
        <Kpi label="Last response" value={ms(w.last_response_ms)} note={w.last_status_code ? `HTTP ${w.last_status_code}` : ''} />
        <Kpi label="Consecutive failures" value={w.consecutive_failures} note={`incident opens at ${w.fail_threshold}`} tone={w.consecutive_failures ? 'warn' : undefined} />
      </div>
      {w.last_error && <div className="alert err">Last error: <span className="mono">{w.last_error}</span></div>}
      <div className="grid g2">
        <Card title="Configuration" pad={false}><table><tbody>
          {row('Owner', w.owner)}{row('Hosting', title(w.hosting_type))}{row('Environment', title(w.environment))}{row('Monitoring', title(w.monitoring_status))}
          {row('Check interval', `${w.check_interval_seconds / 60} min`)}{row('Timeout', `${w.timeout_ms} ms`)}{row('Expected status', w.expected_status)}{row('Max redirects', w.max_redirects)}
          {row('Incident rule', `${w.fail_threshold} failures to open · ${w.recover_threshold} successes to resolve`)}{row('Health-check URL', w.health_check_url)}
          {row('SSL check', w.ssl_check_enabled ? (w.ssl_failure_is_outage ? 'On (invalid cert = outage)' : 'On (warnings only)') : 'Off')}{row('GA4', <IntegrationBadge status={w.ga4_status} />)}{row('Search Console', <IntegrationBadge status={w.gsc_status} />)}{row('Notes', w.notes)}
        </tbody></table></Card>
        <Card title="Maintenance windows" tip="Checks during a maintenance window are recorded but excluded from uptime and never open incidents." actions={isAdmin && <button className="btn sm" onClick={() => setAdding(true)}>Schedule</button>}>
          <Async q={maint}>{(d) => d.data.length ? (
            <table><tbody>{d.data.map((m: any) => (
              <tr key={m.id}><td>{fmtDateTime(m.starts_at, tz)} → {fmtDateTime(m.ends_at, tz)}<div className="faint">{m.reason ?? ''}</div></td>
                <td>{isAdmin && <button className="btn sm" onClick={() => setDel(m)}>Remove</button>}</td></tr>))}</tbody></table>
          ) : <Empty title="None scheduled" />}</Async>
        </Card>
      </div>
      {adding && <MaintenanceModal websiteId={w.id} onClose={() => setAdding(false)} />}
      {del && <Confirm title="Remove maintenance window" message={<p>Remove this window? Failures during it will count again.</p>} danger onCancel={() => setDel(null)} onConfirm={() => rm.mutate(del.id)} busy={rm.isPending} confirmLabel="Remove" />}
    </>
  );
}

export function MaintenanceModal({ websiteId, onClose }: { websiteId?: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const now = new Date(Date.now() + 3600_000); now.setMinutes(0, 0, 0);
  const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const [s, setS] = useState(iso(now)); const [e, setE] = useState(iso(new Date(now.getTime() + 3600_000))); const [reason, setReason] = useState('');
  const sites = useApi<any>(['sites-all'], '/websites?pageSize=100', { enabled: websiteId === undefined });
  const [wid, setWid] = useState('');
  const m = useMutation({
    mutationFn: () => api(websiteId ? `/websites/${websiteId}/maintenance` : '/maintenance', { body: { website_id: websiteId ?? (wid || null), starts_at: new Date(s).toISOString(), ends_at: new Date(e).toISOString(), reason: reason || undefined } }),
    onSuccess: () => { qc.invalidateQueries(); toast('ok', 'Maintenance window scheduled'); onClose(); }, onError: (x) => toast('err', (x as Error).message),
  });
  return (
    <Modal title="Schedule maintenance" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={m.isPending} onClick={() => m.mutate()}>Schedule</button></>}>
      <p className="muted">Times are in your browser's local time zone and stored in UTC.</p>
      <div className="form-grid">
        {websiteId === undefined && <Field label="Website" full><select value={wid} onChange={(x) => setWid(x.target.value)}><option value="">All websites</option>{sites.data?.data.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>}
        <Field label="Starts"><input type="datetime-local" value={s} onChange={(x) => setS(x.target.value)} /></Field>
        <Field label="Ends"><input type="datetime-local" value={e} onChange={(x) => setE(x.target.value)} /></Field>
        <Field label="Reason" full><input value={reason} onChange={(x) => setReason(x.target.value)} placeholder="e.g. Server upgrade" /></Field>
      </div>
    </Modal>
  );
}

function UptimeTab({ id, range }: { id: string; range: string }) {
  const tz = useTz();
  const q = useApi<any>(['w-uptime', id, range], `/websites/${id}/uptime?days=${range}`);
  return <Async q={q}>{(d) => {
    const sm = d.summary;
    const data = d.points.map((p: any) => ({ x: p.bucket, uptime: p.uptime_pct, avg: p.avg_ms, p95: p.p95_ms }));
    return (
      <>
        <div className="kpis" style={{ marginBottom: 16 }}>
          <Kpi label="Uptime" value={pct(sm.uptime_pct)} note={sm.total ? `${sm.successful} ok / ${sm.failed} failed of ${sm.total}` : 'no checks in period'} tip={d.method} />
          <Kpi label="Avg response" value={ms(sm.avg_ms)} note={`p50 ${ms(d.percentiles?.p50_ms)} · p95 ${ms(d.percentiles?.p95_ms)}`} />
          <Kpi label="Maintenance checks" value={sm.maintenance} note="excluded from uptime" />
          <Kpi label="Check coverage" value={d.coverage_pct === null ? '—' : `${d.coverage_pct}%`} note="share of expected checks recorded" tip="If this is low, the worker was not running — treat uptime with care." />
        </div>
        <Card title="Response time" tip={`Aggregated ${d.granularity}.`}><TimeChart data={data} tz={tz} series={[{ key: 'avg', label: 'Average (ms)' }, { key: 'p95', label: 'p95 (ms)', dashed: true }]} unit=" ms" withTime={d.granularity === 'hourly'} /></Card>
        <div style={{ height: 14 }} />
        <Card title="Uptime % per period"><TimeChart data={data} tz={tz} series={[{ key: 'uptime', label: 'Uptime %', type: 'bar' }]} unit="%" withTime={d.granularity === 'hourly'} emptyText="No checks recorded in this period." /></Card>
      </>
    );
  }}</Async>;
}

function ChecksTab({ id, range }: { id: string; range: string }) {
  const tz = useTz();
  const [page, setPage] = useState(1); const [failed, setFailed] = useState(false);
  const q = useApi<any>(['w-checks', id, range, page, failed], `/websites/${id}/checks${qs({ days: range, page, pageSize: 50, failed: failed ? 'true' : undefined })}`);
  return (
    <Card pad={false} title="Check log" actions={<label className="check"><input type="checkbox" checked={failed} onChange={(e) => { setFailed(e.target.checked); setPage(1); }} /> Failures only</label>}>
      <Async q={q}>{(d) => !d.data.length ? <Empty title="No checks" >No checks recorded for these filters.</Empty> : (
        <>
          <div className="table-wrap"><table><thead><tr><th>Time</th><th>Result</th><th>HTTP</th><th className="num">Response</th><th>Redirects</th><th>Detail</th></tr></thead>
            <tbody>{d.data.map((c: any) => (
              <tr key={c.id}><td className="nowrap">{fmtDateTime(c.started_at, tz)}</td>
                <td>{c.in_maintenance ? <Badge kind="plain">Maintenance</Badge> : c.success ? <Badge kind="up">OK</Badge> : <Badge kind="down">Failed</Badge>}</td>
                <td>{c.status_code ?? '—'}</td><td className="num">{ms(c.response_ms)}</td><td>{c.redirect_count}</td>
                <td className="err-text">{c.error_category ? `${title(c.error_category)}: ${c.error_message ?? ''}` : ''}</td></tr>))}</tbody></table></div>
          <Pager page={d.page} totalPages={d.totalPages} total={d.total} pageSize={50} onPage={setPage} />
        </>)}</Async>
    </Card>
  );
}

function IncidentsTab({ id }: { id: string }) {
  const tz = useTz();
  const q = useApi<any>(['w-inc', id], `/incidents?website_id=${id}&pageSize=50`);
  return <Card pad={false}><Async q={q}>{(d) => !d.data.length ? <Empty title="No incidents">None recorded for this website.</Empty> : (
    <div className="table-wrap"><table><thead><tr><th>Incident</th><th>Severity</th><th>Status</th><th>Started</th><th>Duration</th></tr></thead>
      <tbody>{d.data.map((i: any) => <tr key={i.id}><td><Link to={`/incidents/${i.id}`}>{i.title}</Link></td><td><Badge kind={i.severity} /></td><td><Badge kind={i.status} /></td><td>{fmtDateTime(i.started_at, tz)}</td><td>{i.status === 'resolved' ? dur(i.duration_seconds) : `ongoing · ${ago(i.started_at).replace(' ago', '')}`}</td></tr>)}</tbody></table></div>
  )}</Async></Card>;
}

function TrafficTab({ id, range, w }: { id: string; range: string; w: any }) {
  const tz = useTz();
  const q = useApi<any>(['w-traffic', id, range], `/websites/${id}/analytics?days=${range}`);
  return <Async q={q}>{(d) => {
    if (!d.connected && !d.series.length) return <NotConnected status={d.status} detail={d.status_detail} what="Google Analytics 4" websiteId={w.id} />;
    if (!d.series.length) return <Empty title="No data in this period">GA4 is connected but returned no rows for this period. GA4 data can lag 24–48 hours.</Empty>;
    const t = d.totals, p = d.previous_totals;
    return (
      <>
        <div className="kpis" style={{ marginBottom: 16 }}>
          <Kpi label="Active users" value={num(t.active_users)} note={<Delta cur={t.active_users} prev={p?.active_users} />} />
          <Kpi label="Sessions" value={num(t.sessions)} note={<Delta cur={t.sessions} prev={p?.sessions} />} />
          <Kpi label="Page views" value={num(t.page_views)} note={<Delta cur={t.page_views} prev={p?.page_views} />} />
          <Kpi label="Key events" value={num(t.conversions)} note={<Delta cur={t.conversions} prev={p?.conversions} />} tip="GA4 key events (formerly conversions)." />
          <Kpi label="Engagement rate" value={t.engagement_rate === null ? '—' : pct(t.engagement_rate * 100, 1)} />
        </div>
        <Card title="Daily sessions & users" actions={<span className="faint">Last sync {ago(d.last_sync_at)}</span>}>
          <TimeChart data={d.series.map((r: any) => ({ x: String(r.date).slice(0, 10), sessions: r.sessions, users: r.active_users, views: r.page_views }))} tz={tz} withTime={false} series={[{ key: 'sessions', label: 'Sessions' }, { key: 'users', label: 'Active users' }, { key: 'views', label: 'Page views', dashed: true }]} />
        </Card>
        <p className="faint">{d.note}</p>
      </>);
  }}</Async>;
}

function SeoTab({ id, range }: { id: string; range: string }) {
  const tz = useTz();
  const q = useApi<any>(['w-seo', id, range], `/websites/${id}/seo?days=${range}`);
  return <Async q={q}>{(d) => {
    if (!d.connected && !d.series.length) return <NotConnected status={d.status} detail={d.status_detail} what="Search Console" websiteId={id} />;
    if (!d.series.length) return <Empty title="No data in this period">Search Console data usually lags 2–3 days.</Empty>;
    const t = d.totals, p = d.previous_totals;
    const tbl = (rows: any[], label: string) => (
      <Card title={`Top ${label}`} pad={false}>{rows.length ? <div className="table-wrap" style={{ maxHeight: 360, overflow: 'auto' }}><table><thead><tr><th>{label}</th><th className="num">Clicks</th><th className="num">Impr.</th><th className="num">CTR</th><th className="num">Pos.</th></tr></thead>
        <tbody>{rows.map((r: any) => <tr key={r.key}><td style={{ wordBreak: 'break-all' }}>{r.key}</td><td className="num">{num(r.clicks)}</td><td className="num">{num(r.impressions)}</td><td className="num">{pct(Number(r.ctr) * 100, 1)}</td><td className="num">{Number(r.position).toFixed(1)}</td></tr>)}</tbody></table></div> : <Empty title="No data" />}</Card>
    );
    return (
      <>
        <div className="kpis" style={{ marginBottom: 16 }}>
          <Kpi label="Clicks" value={num(t.clicks)} note={<Delta cur={t.clicks} prev={p?.clicks} />} />
          <Kpi label="Impressions" value={num(t.impressions)} note={<Delta cur={t.impressions} prev={p?.impressions} />} />
          <Kpi label="CTR" value={t.ctr === null ? '—' : pct(t.ctr * 100, 2)} />
          <Kpi label="Avg position" value={t.position === null ? '—' : t.position.toFixed(1)} note={<Delta cur={t.position} prev={p?.position} invert />} tip="Lower is better." />
        </div>
        <Card title="Clicks & impressions" actions={<span className="faint">Data through {d.data_through ? fmtDate(d.data_through, 'UTC') : '—'}</span>}>
          <TimeChart data={d.series.map((r: any) => ({ x: String(r.date).slice(0, 10), clicks: r.clicks, impressions: r.impressions }))} tz={tz} withTime={false} series={[{ key: 'clicks', label: 'Clicks' }, { key: 'impressions', label: 'Impressions', yAxisId: 'right' }]} />
        </Card>
        <div className="grid g2" style={{ marginTop: 14 }}>{tbl(d.top_queries, 'queries')}{tbl(d.top_pages, 'pages')}</div>
        <p className="faint">{d.note}</p>
      </>);
  }}</Async>;
}

function PerfTab({ id, range }: { id: string; range: string }) {
  const tz = useTz(); const { isAdmin } = useAuth(); const toast = useToast(); const qc = useQueryClient();
  const [strategy, setStrategy] = useState('mobile');
  const q = useApi<any>(['w-perf', id, strategy, range], `/websites/${id}/performance?strategy=${strategy}&days=${range}`);
  const run = useMutation({ mutationFn: () => api(`/websites/${id}/performance/run`, { method: 'POST' }), onSuccess: () => toast('ok', 'Audit queued — takes a minute or two'), onError: (e) => toast('err', (e as Error).message) });
  const base = useMutation({ mutationFn: (audit_id: number) => api(`/websites/${id}/performance/baseline`, { body: { audit_id } }), onSuccess: () => { toast('ok', 'Baseline set'); qc.invalidateQueries({ queryKey: ['w-perf', id] }); } });
  const score = (v: number | null) => <Badge kind={v === null ? 'plain' : v >= 90 ? 'up' : v >= 50 ? 'degraded' : 'down'}>{v ?? '—'}</Badge>;
  return <Async q={q}>{(d) => (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <select aria-label="Strategy" value={strategy} onChange={(e) => setStrategy(e.target.value)} style={{ width: 'auto' }}><option value="mobile">Mobile</option><option value="desktop">Desktop</option></select>
        {isAdmin && <button className="btn" onClick={() => run.mutate()} disabled={run.isPending}>Run audit now</button>}
        {d.last_attempt?.status === 'error' && <span className="err-text">Last audit failed: {d.last_attempt.error}</span>}
      </div>
      {!d.latest ? <Empty title="No audit yet">No successful PageSpeed audit is stored for this website. {d.last_attempt?.error ?? 'Audits run on a schedule once PageSpeed is available.'}</Empty> : (
        <>
          <div className="kpis" style={{ marginBottom: 16 }}>
            <Kpi label="Performance" value={d.latest.performance_score ?? '—'} note={d.comparison ? `${d.comparison.performance_score >= 0 ? '+' : ''}${d.comparison.performance_score} vs baseline` : 'no baseline set'} />
            <Kpi label="Accessibility" value={d.latest.accessibility_score ?? '—'} /><Kpi label="Best practices" value={d.latest.best_practices_score ?? '—'} /><Kpi label="SEO" value={d.latest.seo_score ?? '—'} />
            <Kpi label="LCP" value={ms(d.latest.lcp_ms)} tip="Largest Contentful Paint (lab). Good ≤ 2500 ms." /><Kpi label="CLS" value={d.latest.cls ?? '—'} tip="Cumulative Layout Shift (lab). Good ≤ 0.1." />
            <Kpi label="TBT" value={ms(d.latest.tbt_ms)} /><Kpi label="TTFB" value={ms(d.latest.ttfb_ms)} />
          </div>
          <p className="faint">Lab data, audited {fmtDateTime(d.latest.audited_at, tz)}. {d.latest.has_field_data ? 'Real-user (CrUX) field data was returned by Google and is stored.' : 'Google returned no real-user field data for this site (not enough traffic) — none is shown.'}</p>
          <Card title="Performance score over time"><TimeChart data={[...d.audits].reverse().filter((a: any) => a.status === 'ok').map((a: any) => ({ x: a.audited_at, score: a.performance_score, lcp: a.lcp_ms }))} tz={tz} series={[{ key: 'score', label: 'Score' }, { key: 'lcp', label: 'LCP (ms)', yAxisId: 'right', dashed: true }]} /></Card>
          <div style={{ height: 14 }} />
          <Card title="Audit history" pad={false}><div className="table-wrap"><table><thead><tr><th>When</th><th>Status</th><th>Perf</th><th>A11y</th><th>BP</th><th>SEO</th><th className="num">LCP</th><th className="num">CLS</th><th /></tr></thead>
            <tbody>{d.audits.slice(0, 30).map((a: any) => <tr key={a.id}><td>{fmtDateTime(a.audited_at, tz)}</td><td><Badge kind={a.status} /></td><td>{score(a.performance_score)}</td><td>{a.accessibility_score ?? '—'}</td><td>{a.best_practices_score ?? '—'}</td><td>{a.seo_score ?? '—'}</td><td className="num">{ms(a.lcp_ms)}</td><td className="num">{a.cls ?? '—'}</td>
              <td>{a.is_baseline ? <Badge kind="info">Baseline</Badge> : isAdmin && a.status === 'ok' && <button className="btn sm" onClick={() => base.mutate(a.id)}>Set baseline</button>}</td></tr>)}</tbody></table></div></Card>
        </>)}
      <p className="faint">{d.note}</p>
    </>
  )}</Async>;
}

export function sslBadge(s: any) {
  if (!s) return <Badge kind="unknown">Not checked</Badge>;
  if (!s.valid) return <Badge kind="down">Invalid</Badge>;
  if (s.days_remaining <= 7) return <Badge kind="down">Expires in {s.days_remaining}d</Badge>;
  if (s.days_remaining <= 30) return <Badge kind="degraded">Expires in {s.days_remaining}d</Badge>;
  return <Badge kind="up">Valid · {s.days_remaining}d</Badge>;
}
function SslTab({ id }: { id: string }) {
  const tz = useTz();
  const q = useApi<any>(['w-ssl', id], `/websites/${id}/ssl`);
  return <Async q={q}>{(d) => {
    if (!d.applicable) return <Empty title="Not applicable">This website is not served over HTTPS.</Empty>;
    if (!d.latest) return <Empty title="Not checked yet">{d.enabled ? 'The first certificate check will run shortly.' : 'SSL checks are disabled for this website.'}</Empty>;
    const l = d.latest;
    return (
      <>
        <Card title="Current certificate" actions={sslBadge(l)}><table><tbody>
          <tr><th style={{ width: 200, position: 'static' }}>Subject</th><td>{l.subject ?? '—'}</td></tr><tr><th style={{ position: 'static' }}>Issuer</th><td>{l.issuer ?? '—'}</td></tr>
          <tr><th style={{ position: 'static' }}>Valid from</th><td>{fmtDate(l.valid_from, tz)}</td></tr><tr><th style={{ position: 'static' }}>Valid to</th><td>{fmtDate(l.valid_to, tz)}</td></tr>
          <tr><th style={{ position: 'static' }}>Protocol</th><td>{l.protocol ?? '—'}</td></tr><tr><th style={{ position: 'static' }}>Last checked</th><td>{fmtDateTime(l.checked_at, tz)}</td></tr>
          {l.error && <tr><th style={{ position: 'static' }}>Error</th><td className="err-text">{l.error}</td></tr>}
        </tbody></table></Card>
        <p className="faint">An SSL warning is not counted as downtime unless this website is set to treat an invalid certificate as an outage.</p>
      </>);
  }}</Async>;
}

function FormsTab({ id }: { id: string }) {
  const tz = useTz(); const { isAdmin } = useAuth(); const qc = useQueryClient(); const toast = useToast();
  const q = useApi<any>(['w-forms', id], `/websites/${id}/form-checks`);
  const [edit, setEdit] = useState<any | 'new' | null>(null); const [del, setDel] = useState<any>(null);
  const rm = useMutation({ mutationFn: (fid: string) => api(`/websites/${id}/form-checks/${fid}`, { method: 'DELETE' }), onSuccess: () => { setDel(null); qc.invalidateQueries({ queryKey: ['w-forms', id] }); toast('ok', 'Removed'); } });
  return (
    <>
      <Async q={q}>{(d) => (
        <>
          <div className="alert info">{d.synthetic_tests.note}</div>
          <Card title="Form & checkout pages" pad={false} actions={isAdmin && <button className="btn sm primary" onClick={() => setEdit('new')}>Add page</button>}>
            {!d.data.length ? <Empty title="No form pages configured">Add the URL of a contact, booking or checkout page to check that it loads.</Empty> : (
              <div className="table-wrap"><table><thead><tr><th>Label</th><th>Type</th><th>URL</th><th>Status</th><th>Last check</th><th className="num">Response</th><th /></tr></thead>
                <tbody>{d.data.map((f: any) => <tr key={f.id}><td>{f.label}</td><td>{title(f.type)}</td><td className="mono">{f.url}</td><td>{f.enabled ? <StateBadge state={f.state} /> : <Badge kind="plain">Disabled</Badge>}{f.last_error && <div className="err-text">{f.last_error}</div>}</td><td>{fmtDateTime(f.last_check_at, tz)}</td><td className="num">{ms(f.last_response_ms)}</td>
                  <td>{isAdmin && <span className="row"><button className="btn sm" onClick={() => setEdit(f)}>Edit</button><button className="btn sm" onClick={() => setDel(f)}>Remove</button></span>}</td></tr>)}</tbody></table></div>)}
          </Card>
        </>)}</Async>
      {edit && <FormCheckModal websiteId={id} item={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
      {del && <Confirm title="Remove page check" danger message={<p>Remove “{del.label}” and stop checking it?</p>} onCancel={() => setDel(null)} onConfirm={() => rm.mutate(del.id)} busy={rm.isPending} confirmLabel="Remove" />}
    </>
  );
}
function FormCheckModal({ websiteId, item, onClose }: { websiteId: string; item: any; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const [f, setF] = useState({ label: item?.label ?? '', type: item?.type ?? 'contact', url: item?.url ?? 'https://', enabled: item?.enabled ?? true, expected_status: item?.expected_status ?? '200-399', interval_seconds: item?.interval_seconds ?? 900 });
  const [err, setErr] = useState('');
  const m = useMutation({
    mutationFn: () => item ? api(`/websites/${websiteId}/form-checks/${item.id}`, { method: 'PATCH', body: { ...f, interval_seconds: Number(f.interval_seconds) } }) : api(`/websites/${websiteId}/form-checks`, { body: { ...f, interval_seconds: Number(f.interval_seconds) } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['w-forms', websiteId] }); toast('ok', 'Saved'); onClose(); }, onError: (e) => setErr((e as Error).message),
  });
  return (
    <Modal title={item ? 'Edit page check' : 'Add page check'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={m.isPending} onClick={() => m.mutate()}>Save</button></>}>
      {err && <div className="alert err">{err}</div>}
      <p className="muted">Page-load check only: the URL is fetched and its status and speed recorded. No form is submitted and no order is created.</p>
      <div className="form-grid">
        <Field label="Label"><input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></Field>
        <Field label="Type"><select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{['contact', 'login', 'booking', 'checkout', 'other'].map((t) => <option key={t}>{t}</option>)}</select></Field>
        <Field label="URL" full><input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></Field>
        <Field label="Expected status"><input value={f.expected_status} onChange={(e) => setF({ ...f, expected_status: e.target.value })} /></Field>
        <Field label="Interval (seconds)"><input type="number" min={60} value={f.interval_seconds} onChange={(e) => setF({ ...f, interval_seconds: Number(e.target.value) })} /></Field>
        <label className="check"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Enabled</label>
      </div>
    </Modal>
  );
}

function TasksTab({ id }: { id: string }) {
  const tz = useTz(); const [adding, setAdding] = useState(false);
  const q = useApi<any>(['w-tasks', id], `/tasks?website_id=${id}&pageSize=50`);
  return (
    <>
      <Card title="Tasks for this website" pad={false} actions={<button className="btn sm primary" onClick={() => setAdding(true)}>New task</button>}>
        <Async q={q}>{(d) => !d.data.length ? <Empty title="No tasks" /> : (
          <div className="table-wrap"><table><thead><tr><th>Task</th><th>Priority</th><th>Status</th><th>Assignee</th><th>Due</th></tr></thead>
            <tbody>{d.data.map((t: any) => <tr key={t.id}><td><Link to={`/tasks?open=${t.id}`}>{t.title}</Link></td><td><Badge kind={t.priority} /></td><td><Badge kind={t.status} /></td><td>{t.assigned_name ?? 'Unassigned'}</td><td className={t.overdue ? 'err-text' : ''}>{fmtDateTime(t.due_at, tz)}{t.overdue ? ' (overdue)' : ''}</td></tr>)}</tbody></table></div>)}</Async>
      </Card>
      {adding && <TaskFormModal websiteId={id} onClose={() => setAdding(false)} />}
    </>
  );
}
