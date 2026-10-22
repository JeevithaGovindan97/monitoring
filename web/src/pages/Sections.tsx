import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Async, Badge, Card, Empty, IntegrationBadge, Kpi, PageHeader, RangeSelect, StateBadge } from '../components/ui';
import { sslBadge } from './WebsiteDetail';
import { useApi, useRange, type RangeKey } from '../lib/hooks';
import { ago, fmtDate, fmtDateTime, ms, num, pct, useTz } from '../lib/format';

function useSections(range: RangeKey) { return useApi<any>(['sections', range], `/dashboard/sections?days=${range}`); }
const nameLink = (r: any) => <Link to={`/websites/${r.website_id}`}>{r.website_name}</Link>;

function MissingBanner({ list }: { list: string[] }) {
  if (!list?.length) return null;
  return <div className="alert warn">Some data sources are not connected: {list.join('; ')}. Those sites are shown as “Not connected” instead of zero.</div>;
}

export function TrafficPage() {
  const [range, setRange] = useRange('30'); const q = useSections(range);
  return (
    <>
      <PageHeader title="Traffic (Google Analytics 4)" sub="Sessions, users and key events per website from the GA4 Data API. GA4 data can lag 24–48 hours." actions={<RangeSelect value={range} onChange={setRange} />} />
      <Async q={q}>{(d) => {
        const connected = d.analytics.filter((a: any) => a.ga4_status === 'connected' && a.days > 0);
        const tot = (k: string) => connected.reduce((s: number, a: any) => s + Number(a[k] ?? 0), 0);
        return (
          <>
            <div className="kpis" style={{ marginBottom: 14 }}>
              <Kpi label="Sessions" value={connected.length ? num(tot('sessions')) : 'No data'} note={`from ${connected.length} of ${d.analytics.length} sites`} />
              <Kpi label="Active users" value={connected.length ? num(tot('active_users')) : 'No data'} note="summed per site (not de-duplicated)" tip="Users are summed across websites and days, so the same person can be counted more than once." />
              <Kpi label="Page views" value={connected.length ? num(tot('page_views')) : 'No data'} /><Kpi label="Key events" value={connected.length ? num(tot('conversions')) : 'No data'} />
            </div>
            <Card pad={false}>
              {!d.analytics.length ? <Empty title="No websites" /> : (
                <div className="table-wrap"><table><thead><tr><th>Website</th><th>GA4</th><th className="num">Sessions</th><th className="num">Users</th><th className="num">Page views</th><th className="num">Engagement</th><th className="num">Key events</th><th>Last sync</th></tr></thead>
                  <tbody>{d.analytics.map((a: any) => { const has = a.ga4_status === 'connected' && a.days > 0; return (
                    <tr key={a.website_id}><td>{nameLink(a)}</td><td><IntegrationBadge status={a.ga4_status} /></td>
                      {has ? <><td className="num">{num(a.sessions)}</td><td className="num">{num(a.active_users)}</td><td className="num">{num(a.page_views)}</td><td className="num">{a.engagement_rate === null ? '—' : pct(a.engagement_rate * 100, 1)}</td><td className="num">{num(Number(a.conversions))}</td><td>{ago(a.last_sync)}</td></>
                        : <td colSpan={6} className="faint">{a.ga4_status === 'connected' ? 'No rows in this period' : a.ga4_status === 'access_required' ? 'Access required' : 'No data — not connected'}</td>}</tr>); })}</tbody></table></div>)}
            </Card>
            <MissingBanner list={d.missing.filter((m: string) => /ga4|analytics/i.test(m))} />
          </>);
      }}</Async>
    </>
  );
}

export function SeoPage() {
  const [range, setRange] = useRange('30'); const q = useSections(range);
  return (
    <>
      <PageHeader title="SEO (Google Search Console)" sub="Clicks, impressions, CTR and average position. Search Console data typically lags 2–3 days." actions={<RangeSelect value={range} onChange={setRange} />} />
      <Async q={q}>{(d) => {
        const conn = d.seo.filter((a: any) => a.gsc_status === 'connected' && a.days > 0);
        const clicks = conn.reduce((s: number, a: any) => s + a.clicks, 0), imp = conn.reduce((s: number, a: any) => s + a.impressions, 0);
        return (
          <>
            <div className="kpis" style={{ marginBottom: 14 }}>
              <Kpi label="Clicks" value={conn.length ? num(clicks) : 'No data'} note={`from ${conn.length} of ${d.seo.length} sites`} /><Kpi label="Impressions" value={conn.length ? num(imp) : 'No data'} />
              <Kpi label="CTR" value={imp ? pct((clicks / imp) * 100, 2) : 'No data'} />
            </div>
            <Card pad={false}>{!d.seo.length ? <Empty title="No websites" /> : (
              <div className="table-wrap"><table><thead><tr><th>Website</th><th>Search Console</th><th className="num">Clicks</th><th className="num">Impressions</th><th className="num">CTR</th><th className="num">Avg position</th><th>Data through</th></tr></thead>
                <tbody>{d.seo.map((a: any) => { const has = a.gsc_status === 'connected' && a.days > 0; return (
                  <tr key={a.website_id}><td>{nameLink(a)}</td><td><IntegrationBadge status={a.gsc_status} /></td>
                    {has ? <><td className="num">{num(a.clicks)}</td><td className="num">{num(a.impressions)}</td><td className="num">{a.ctr === null ? '—' : pct(Number(a.ctr) * 100, 2)}</td><td className="num">{a.position === null ? '—' : Number(a.position).toFixed(1)}</td><td>{fmtDate(a.data_through, 'UTC')}</td></>
                      : <td colSpan={5} className="faint">{a.gsc_status === 'connected' ? 'No rows in this period' : a.gsc_status === 'access_required' ? 'Access required' : 'No data — not connected'}</td>}</tr>); })}</tbody></table></div>)}</Card>
            <MissingBanner list={d.missing.filter((m: string) => /search|gsc/i.test(m))} />
          </>);
      }}</Async>
    </>
  );
}

export function PerformancePage() {
  const q = useSections('30');
  const [sortBy, setSortBy] = useState<'name' | 'score'>('score');
  return (
    <>
      <PageHeader title="Performance (PageSpeed Insights)" sub="Latest mobile lab audit per website, compared with the saved baseline. Lab scores are simulated and vary between runs." />
      <Async q={q}>{(d) => {
        const rows = [...d.performance].sort((a: any, b: any) => sortBy === 'name' ? a.website_name.localeCompare(b.website_name) : (a.performance_score ?? 999) - (b.performance_score ?? 999));
        const audited = rows.filter((r: any) => r.status === 'ok');
        const missing = d.websites.filter((w: any) => !d.performance.some((p: any) => p.website_id === w.id));
        return (
          <>
            <div className="kpis" style={{ marginBottom: 14 }}>
              <Kpi label="Audited" value={`${audited.length} / ${d.websites.length}`} note="websites with a successful audit" />
              <Kpi label="Average score" value={audited.length ? Math.round(audited.reduce((s: number, r: any) => s + r.performance_score, 0) / audited.length) : 'No data'} />
              <Kpi label="Poor (&lt;50)" value={audited.filter((r: any) => r.performance_score < 50).length} tone="warn" />
            </div>
            <Card pad={false} actions={<select aria-label="Sort" value={sortBy} onChange={(e) => setSortBy(e.target.value as any)} style={{ width: 'auto' }}><option value="score">Worst first</option><option value="name">Name</option></select>}>
              {!rows.length ? <Empty title="No audits yet">PageSpeed audits run on a schedule. Nothing has been stored yet, so no scores are shown.</Empty> : (
                <div className="table-wrap"><table><thead><tr><th>Website</th><th>Perf</th><th>A11y</th><th>Best pr.</th><th>SEO</th><th className="num">LCP</th><th className="num">CLS</th><th className="num">FCP</th><th>Vs baseline</th><th>Audited</th></tr></thead>
                  <tbody>{rows.map((r: any) => (
                    <tr key={r.website_id}><td>{nameLink(r)}</td>
                      {r.status === 'ok' ? <>
                        <td><Badge kind={r.performance_score >= 90 ? 'up' : r.performance_score >= 50 ? 'degraded' : 'down'}>{r.performance_score}</Badge></td><td>{r.accessibility_score ?? '—'}</td><td>{r.best_practices_score ?? '—'}</td><td>{r.seo_score ?? '—'}</td>
                        <td className="num">{ms(r.lcp_ms)}</td><td className="num">{r.cls ?? '—'}</td><td className="num">{ms(r.fcp_ms)}</td>
                        <td>{r.baseline_performance === null || r.baseline_performance === undefined ? <span className="faint">no baseline</span> : `${r.performance_score - r.baseline_performance >= 0 ? '+' : ''}${r.performance_score - r.baseline_performance}`}</td>
                      </> : <td colSpan={8} className="err-text">Audit failed: {r.error ?? 'unknown error'}</td>}
                      <td>{ago(r.audited_at)}</td></tr>))}</tbody></table></div>)}
            </Card>
            {missing.length > 0 && <p className="faint">{missing.length} website(s) have no audit stored yet: {missing.map((w: any) => w.name).slice(0, 8).join(', ')}{missing.length > 8 ? '…' : ''}.</p>}
          </>);
      }}</Async>
    </>
  );
}

export function SslPage() {
  const q = useSections('30'); const tz = useTz();
  const [filter, setFilter] = useState('all');
  return (
    <>
      <PageHeader title="SSL certificates" sub="Certificates are checked every 6 hours. Alerts fire at 30, 14 and 7 days and when expired or invalid. A certificate problem is not counted as downtime unless configured." />
      <Async q={q}>{(d) => {
        const all = d.ssl;
        const rows = all.filter((s: any) => filter === 'all' || (filter === 'invalid' && !s.valid) || (filter === '30' && s.valid && s.days_remaining <= 30) || (filter === 'ok' && s.valid && s.days_remaining > 30));
        const checked = new Set(all.map((s: any) => s.website_id));
        const unchecked = d.websites.filter((w: any) => !checked.has(w.id) && /^https:/i.test(w.url));
        return (
          <>
            <div className="kpis" style={{ marginBottom: 14 }}>
              <Kpi label="Invalid / expired" value={all.filter((s: any) => !s.valid).length} tone={all.some((s: any) => !s.valid) ? 'down' : 'up'} />
              <Kpi label="Expiring ≤30 days" value={all.filter((s: any) => s.valid && s.days_remaining <= 30).length} tone="warn" />
              <Kpi label="Healthy" value={all.filter((s: any) => s.valid && s.days_remaining > 30).length} note={`of ${all.length} checked`} />
              <Kpi label="Not checked yet" value={unchecked.length} />
            </div>
            <Card pad={false} actions={<select aria-label="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 'auto' }}><option value="all">All</option><option value="invalid">Invalid</option><option value="30">Expiring ≤30d</option><option value="ok">Healthy</option></select>}>
              {!rows.length ? <Empty title="Nothing to show" /> : (
                <div className="table-wrap"><table><thead><tr><th>Website</th><th>Status</th><th>Expires</th><th>Issuer</th><th>Last checked</th><th>Error</th></tr></thead>
                  <tbody>{rows.map((s: any) => <tr key={s.website_id}><td>{nameLink(s)}</td><td>{sslBadge(s)}</td><td>{fmtDate(s.valid_to, tz)}</td><td>{s.issuer ?? '—'}</td><td>{fmtDateTime(s.checked_at, tz)}</td><td className="err-text">{s.error ?? ''}</td></tr>)}</tbody></table></div>)}
            </Card>
          </>);
      }}</Async>
    </>
  );
}

export function FormsPage() {
  const q = useSections('7'); const tz = useTz();
  const sites = useMemo(() => q.data, [q.data]);
  return (
    <>
      <PageHeader title="Forms & checkout pages" sub="Page-load checks only. This release does not run browser-based synthetic tests, submit forms or create orders." />
      <Async q={q}>{() => {
        const forms = sites.forms;
        return (
          <Card pad={false}>{!forms.length ? <Empty title="No form pages configured">Add pages from a website's “Forms” tab, or include a form URL when importing.</Empty> : (
            <div className="table-wrap"><table><thead><tr><th>Website</th><th>Page</th><th>Type</th><th>Status</th><th>Last check</th><th className="num">HTTP</th><th className="num">Response</th><th className="num">Failures (7d)</th></tr></thead>
              <tbody>{forms.map((f: any) => <tr key={f.id}><td>{f.website_name}</td><td>{f.label}<div className="faint mono">{f.url}</div></td><td>{f.type}</td><td>{f.enabled ? <StateBadge state={f.state} /> : <Badge kind="plain">Disabled</Badge>}</td><td>{fmtDateTime(f.last_check_at, tz)}</td><td className="num">{f.last_status_code ?? '—'}</td><td className="num">{ms(f.last_response_ms)}</td><td className="num">{f.failures}/{f.checks}</td></tr>)}</tbody></table></div>)}</Card>);
      }}</Async>
    </>
  );
}
