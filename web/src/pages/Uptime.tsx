import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Async, Card, Empty, Kpi, PageHeader, RangeSelect, StateBadge } from '../components/ui';
import { TimeChart } from '../lib/charts';
import { useApi, useRange } from '../lib/hooks';
import { ms, num, pct, useTz } from '../lib/format';

export function UptimePage() {
  const [range, setRange] = useRange('30');
  const tz = useTz();
  const [sel, setSel] = useState('');
  const list = useApi<any>(['dash-sites', range], `/dashboard/websites?days=${range}`);
  const detail = useApi<any>(['w-uptime', sel, range], `/websites/${sel}/uptime?days=${range}`, { enabled: Boolean(sel) });
  const [sortAsc, setSortAsc] = useState(true);
  return (
    <>
      <PageHeader title="Uptime history" sub="Uptime = successful ÷ (successful + failed) scheduled checks. Maintenance windows are excluded; sites with no checks show “No data”, not 100%." actions={<RangeSelect value={range} onChange={setRange} />} />
      <Card title="Per-website uptime" pad={false}>
        <Async q={list}>{(d) => {
          if (!d.data.length) return <Empty title="No websites" />;
          const rows = [...d.data].sort((a: any, b: any) => { const x = a.uptime_pct ?? 101, y = b.uptime_pct ?? 101; return sortAsc ? x - y : y - x; });
          return (
            <div className="table-wrap"><table>
              <thead><tr><th>Website</th><th>Now</th><th className="sortable num" onClick={() => setSortAsc(!sortAsc)} aria-sort={sortAsc ? 'ascending' : 'descending'}>Uptime {sortAsc ? '▲' : '▼'}</th><th>Visual</th><th className="num">Checks</th><th className="num">Avg response</th><th /></tr></thead>
              <tbody>{rows.map((r: any) => (
                <tr key={r.id} style={sel === r.id ? { background: 'var(--accent-soft)' } : undefined}>
                  <td><Link to={`/websites/${r.id}`}><strong>{r.name}</strong></Link></td><td><StateBadge state={r.effective_state} /></td>
                  <td className="num">{pct(r.uptime_pct, 3, 'No data')}</td>
                  <td style={{ width: 160 }}><div className="bar" role="img" aria-label={`Uptime ${pct(r.uptime_pct)}`}><i style={{ width: `${r.uptime_pct ?? 0}%`, background: r.uptime_pct !== null && r.uptime_pct < 99 ? 'var(--warn)' : undefined }} /></div></td>
                  <td className="num">{num(r.observations)}</td><td className="num">{ms(r.avg_ms)}</td>
                  <td><button className="btn sm" onClick={() => setSel(sel === r.id ? '' : r.id)}>{sel === r.id ? 'Hide chart' : 'Chart'}</button></td></tr>))}</tbody></table></div>);
        }}</Async>
      </Card>
      {sel && (
        <div style={{ marginTop: 14 }}>
          <Async q={detail}>{(d) => {
            const data = d.points.map((p: any) => ({ x: p.bucket, uptime: p.uptime_pct, avg: p.avg_ms, p95: p.p95_ms }));
            return (
              <>
                <div className="kpis" style={{ marginBottom: 14 }}>
                  <Kpi label="Uptime" value={pct(d.summary.uptime_pct, 3)} note={`${d.summary.successful} ok / ${d.summary.failed} failed`} />
                  <Kpi label="p50 / p95" value={`${ms(d.percentiles?.p50_ms)} / ${ms(d.percentiles?.p95_ms)}`} />
                  <Kpi label="Coverage" value={d.coverage_pct === null ? '—' : `${d.coverage_pct}%`} note="of expected checks recorded" />
                </div>
                <Card title="Response time"><TimeChart data={data} tz={tz} withTime={d.granularity === 'hourly'} unit=" ms" series={[{ key: 'avg', label: 'Average' }, { key: 'p95', label: 'p95', dashed: true }]} /></Card>
              </>);
          }}</Async>
        </div>)}
    </>
  );
}
