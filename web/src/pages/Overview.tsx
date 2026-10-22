import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Async, Card, Empty, Kpi, PageHeader, RangeSelect, StateBadge, Badge, IntegrationBadge } from '../components/ui';
import { useApi, useRange } from '../lib/hooks';
import { ago, ms, num, pct, useTz, fmtDateTime, title } from '../lib/format';

export function OverviewPage() {
  const [range, setRange] = useRange('7');
  const tz = useTz();
  const sum = useApi<any>(['summary', range], `/dashboard/summary?days=${range}`, { refetchMs: 60_000 });
  const sites = useApi<any>(['dash-sites', range], `/dashboard/websites?days=${range}`, { refetchMs: 60_000 });
  const inc = useApi<any>(['inc-open'], '/incidents?open=true&pageSize=8', { refetchMs: 60_000 });
  const [q, setQ] = useState('');

  return (
    <>
      <PageHeader title="Overview" sub="A real-time view of every monitored website. Each figure shows what it is measured against." actions={<RangeSelect value={range} onChange={setRange} />} />
      <Async q={sum}>{(s) => {
        const w = s.websites;
        const upDenom = `${w.online} of ${w.total} websites`;
        return (
          <>
            {!s.worker.alive && <div className="alert warn" role="alert">The monitoring worker has not reported recently, so statuses below may be out of date.</div>}
            <div className="kpis" style={{ marginBottom: 18 }}>
              <Kpi label="Online" value={w.online} note={`of ${w.total} websites`} to="/inventory?state=up" tone={w.online === w.total && w.total > 0 ? 'up' : undefined} />
              <Kpi label="Down" value={w.down} note={w.down ? 'needs attention' : 'none right now'} to="/inventory?state=down" tone={w.down ? 'down' : 'up'} />
              <Kpi label="Degraded" value={w.degraded} note="slow but responding" to="/inventory?state=degraded" tone={w.degraded ? 'warn' : undefined} tip={`Successful responses slower than the degraded threshold.`} />
              <Kpi label="Unknown / stale" value={w.unknown} note={w.disabled ? `${w.disabled} not monitored` : 'no recent check'} to="/inventory?state=unknown" tone={w.unknown ? 'warn' : undefined} tip="Websites with no check yet, or whose last check is older than 3 intervals. Not counted as online." />
              <Kpi label="Uptime" value={pct(s.uptime.pct, 2, 'No data')} note={s.uptime.observations ? `${num(s.uptime.observations)} checks · ${s.uptime.websites_with_data}/${s.uptime.websites_in_scope} sites` : 'no checks in period'} to="/uptime" tip="Successful ÷ (successful + failed) scheduled checks across all sites. Maintenance windows are excluded." />
              <Kpi label="Avg response" value={ms(s.response_ms?.avg_ms)} note={s.response_ms?.p95_ms ? `p95 ${ms(s.response_ms.p95_ms)}` : ''} to="/uptime" tip="Time to first response bytes (headers), over successful checks." />
              <Kpi label="Open incidents" value={s.incidents.open} note={`${s.incidents.critical} critical · ${s.incidents.unacknowledged} unacknowledged`} to="/incidents?open=true" tone={s.incidents.critical ? 'down' : s.incidents.open ? 'warn' : 'up'} />
              <Kpi label="SSL expiring ≤30d" value={s.ssl.expiring_soon} note={`${s.ssl.invalid} invalid · ${s.ssl.checked} checked`} to="/ssl" tone={s.ssl.invalid ? 'down' : s.ssl.expiring_soon ? 'warn' : undefined} />
              <Kpi label="Performance (mobile)" value={s.performance.avg_score === null ? 'No data' : s.performance.avg_score} note={s.performance.audited ? `avg of ${s.performance.audited} audited · ${s.performance.poor} poor` : 'PageSpeed not run yet'} to="/performance" />
              <Kpi label="Sessions (GA4)" value={s.traffic ? num(s.traffic.sessions) : 'Not connected'} note={s.traffic ? `${s.traffic.properties} of ${w.total} properties` : `${s.integrations.ga4_connected}/${w.total} sites connected`} to="/traffic" />
              <Kpi label="Organic clicks" value={s.organic ? num(s.organic.clicks) : 'Not connected'} note={s.organic ? `${s.organic.properties} of ${w.total} properties` : `${s.integrations.gsc_connected}/${w.total} sites connected`} to="/seo" />
              <Kpi label="Tasks pending" value={s.tasks.pending} note={`${s.tasks.overdue} overdue`} to="/tasks?status=pending" tone={s.tasks.overdue ? 'warn' : undefined} />
              <Kpi label="Integration issues" value={s.integrations.errors + s.integrations.ga4_access_required + s.integrations.gsc_access_required} note={`${s.integrations.ga4_access_required} GA4 · ${s.integrations.gsc_access_required} GSC need access`} to="/integrations" />
              <Kpi label="Failed jobs (24h)" value={s.jobs.failed_24h} note={s.jobs.stale_integrations ? `${s.jobs.stale_integrations} stale integration(s)` : ''} to="/system" tone={s.jobs.failed_24h ? 'warn' : undefined} />
            </div>
            <span className="sr-only">{upDenom}</span>
          </>
        );
      }}</Async>

      <div className="grid g2" style={{ gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)', alignItems: 'start' }}>
        <Card title="Websites" pad={false} actions={<input type="search" placeholder="Filter…" aria-label="Filter websites" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 180 }} />}>
          <Async q={sites}>{(d) => {
            const rows = d.data.filter((r: any) => !q || (r.name + r.url).toLowerCase().includes(q.toLowerCase()));
            if (!d.data.length) return <Empty title="No websites yet" action={<Link className="btn primary" to="/inventory">Add websites in Inventory</Link>}>Import your inventory to start monitoring.</Empty>;
            if (!rows.length) return <Empty title="No matches" />;
            return (
              <div className="table-wrap"><table>
                <thead><tr><th>Website</th><th>Status</th><th className="num">Uptime</th><th className="num">Response</th><th>Last check</th></tr></thead>
                <tbody>{rows.map((r: any) => (
                  <tr key={r.id}>
                    <td><Link to={`/websites/${r.id}`}><strong>{r.name}</strong></Link><div className="faint mono">{r.url}</div></td>
                    <td><StateBadge state={r.effective_state} /></td>
                    <td className="num">{pct(r.uptime_pct, 2, '—')}{r.observations ? <div className="faint" style={{ fontSize: 11 }}>{r.observations} checks</div> : null}</td>
                    <td className="num">{r.last_response_ms !== null ? ms(r.last_response_ms) : '—'}</td>
                    <td className="muted" title={fmtDateTime(r.last_check_at, tz)}>{ago(r.last_check_at)}</td>
                  </tr>))}
                </tbody></table></div>
            );
          }}</Async>
        </Card>
        <Card title="Open incidents" actions={<Link to="/incidents?open=true">All</Link>} pad={false}>
          <Async q={inc}>{(d) => d.data.length ? (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{d.data.map((i: any) => (
              <li key={i.id} style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
                <div className="row"><Badge kind={i.severity} /><Badge kind={i.status} /></div>
                <Link to={`/incidents/${i.id}`}><strong>{i.title}</strong></Link>
                <div className="faint" style={{ fontSize: 12 }}>{i.website_name} · {ago(i.started_at)}</div>
              </li>))}</ul>
          ) : <Empty title="No open incidents">Everything that is being monitored is healthy.</Empty>}</Async>
        </Card>
      </div>
      <p className="faint" style={{ marginTop: 14 }}>Status is computed from this system's own checks. {title('uptime')} excludes maintenance windows. <IntegrationBadge status="not_connected" /> means no data source is linked — never zero traffic.</p>
    </>
  );
}
