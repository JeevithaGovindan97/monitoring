import { useState } from 'react';
import { Async, Badge, Card, Empty, Kpi, PageHeader } from '../components/ui';
import { useApi, useAuth } from '../lib/hooks';
import { ago, fmtDateTime, num, title, useTz } from '../lib/format';

export function SystemPage() {
  const q = useApi<any>(['health'], '/system/health', { refetchMs: 15_000 }); const tz = useTz(); const { isAdmin } = useAuth();
  const [jobsOpen, setJobsOpen] = useState(false);
  const jobs = useApi<any>(['jobs'], '/system/jobs?pageSize=50', { enabled: isAdmin && jobsOpen });
  return (
    <>
      <PageHeader title="System health" sub="Health of the monitoring platform itself. If the worker is down, website statuses become “unknown” — a stopped worker is never reported as a website outage." />
      <Async q={q}>{(d) => (
        <>
          {!d.monitoring_worker.alive && <div className="alert err" role="alert">{d.monitoring_worker.note}</div>}
          <div className="kpis" style={{ marginBottom: 14 }}>
            <Kpi label="Database" value={d.database.ok ? 'OK' : 'Down'} note={`${d.database.latency_ms} ms`} tone={d.database.ok ? 'up' : 'down'} />
            <Kpi label="Monitoring worker" value={d.monitoring_worker.alive ? 'Running' : 'Not reporting'} note={`last heartbeat ${ago(d.monitoring_worker.last_heartbeat)}`} tone={d.monitoring_worker.alive ? 'up' : 'down'} />
            <Kpi label="Overdue checks" value={d.queue.overdue_checks} note={`of ${d.queue.active_websites} active websites`} tone={d.queue.overdue_checks ? 'warn' : 'up'} />
            <Kpi label="E-mails pending / failed" value={`${d.queue.pending_emails} / ${d.queue.failed_emails}`} tone={d.queue.failed_emails ? 'warn' : undefined} />
            <Kpi label="Reports in progress" value={d.queue.reports_in_flight} />
            <Kpi label="Last check stored" value={ago(d.queue.last_check_stored)} note={fmtDateTime(d.queue.last_check_stored, tz)} />
            <Kpi label="Version" value={d.version} note={`server time ${fmtDateTime(d.time, tz)}`} />
          </div>
          <div className="grid g2">
            <Card title="Worker processes" pad={false}>{d.workers.length ? <table><thead><tr><th>Worker</th><th>Role</th><th>Status</th><th>Heartbeat</th></tr></thead><tbody>{d.workers.map((w: any) => <tr key={w.worker}><td className="mono">{w.worker}</td><td>{w.role}</td><td><Badge kind={w.alive ? 'up' : 'down'}>{w.alive ? 'Alive' : 'Stale'}</Badge></td><td>{ago(w.last_beat_at)}</td></tr>)}</tbody></table> : <Empty title="No workers have reported">Start the worker containers. Until then no checks run.</Empty>}</Card>
            <Card title="Background jobs (latest run)" pad={false}>{d.jobs.length ? <table><thead><tr><th>Job</th><th>Result</th><th>Started</th></tr></thead><tbody>{d.jobs.map((j: any) => <tr key={j.job_name}><td className="mono">{j.job_name}</td><td><Badge kind={j.status === 'success' || j.status === 'ok' ? 'up' : j.status === 'failed' ? 'down' : 'degraded'}>{title(j.status)}</Badge>{j.error && <div className="err-text">{j.error}</div>}</td><td>{ago(j.started_at)}</td></tr>)}</tbody></table> : <Empty title="No job runs yet" />}</Card>
          </div>
          {d.failed_jobs_24h.length > 0 && <Card title="Failed jobs in the last 24 hours"><ul style={{ margin: 0, paddingLeft: 18 }}>{d.failed_jobs_24h.map((j: any, i: number) => <li key={i}><span className="mono">{j.job_name}</span> · {fmtDateTime(j.started_at, tz)} · <span className="err-text">{j.error}</span></li>)}</ul></Card>}
          {isAdmin && <p><button className="btn" onClick={() => setJobsOpen(!jobsOpen)}>{jobsOpen ? 'Hide' : 'Show'} job run history</button></p>}
          {jobsOpen && <Card pad={false}><Async q={jobs}>{(j) => <div className="table-wrap"><table><thead><tr><th>Job</th><th>Status</th><th>Started</th><th>Finished</th><th>Error</th></tr></thead><tbody>{j.data.map((r: any) => <tr key={r.id}><td className="mono">{r.job_name}</td><td>{r.status}</td><td>{fmtDateTime(r.started_at, tz)}</td><td>{fmtDateTime(r.finished_at, tz)}</td><td className="err-text">{r.error}</td></tr>)}</tbody></table></div>}</Async></Card>}
          <p className="faint">{num(d.queue.active_websites)} active websites monitored. This page refreshes every 15 seconds.</p>
        </>)}</Async>
    </>
  );
}
