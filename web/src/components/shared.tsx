import { Link } from 'react-router-dom';
import { Empty, IntegrationBadge } from './ui';
import { delta } from '../lib/format';

export function NotConnected({ status, detail, what, websiteId }: { status: string; detail?: string | null; what: string; websiteId?: string }) {
  const msg: Record<string, string> = {
    not_connected: `${what} is not connected for this website. No data is shown rather than zeros.`,
    access_required: `${what} property is mapped, but the service account has no access yet. Add the service-account email as a viewer on the property, then it syncs automatically.`,
    error: `${what} sync is failing. ${detail ?? ''}`,
    not_applicable: `${what} is marked not applicable for this website.`,
  };
  return (
    <Empty title={status === 'access_required' ? 'Access required' : status === 'error' ? 'Sync error' : status === 'not_applicable' ? 'Not applicable' : 'Not connected'}>
      <IntegrationBadge status={status} /><br />{msg[status] ?? msg.not_connected}
      {websiteId && <><br /><Link to="/integrations">Open integration settings</Link></>}
    </Empty>
  );
}

export function Delta({ cur, prev, invert, suffix = '%' }: { cur: number | null | undefined; prev: number | null | undefined; invert?: boolean; suffix?: string }) {
  const d = delta(cur, prev);
  if (d === null) return <span className="faint">no comparison</span>;
  const good = invert ? d < 0 : d > 0;
  return <span className={Math.abs(d) < 0.5 ? 'muted' : good ? 'dot-up' : 'dot-down'}>{d > 0 ? '▲' : d < 0 ? '▼' : '•'} {Math.abs(d).toFixed(1)}{suffix} vs previous period</span>;
}

export function Timeline({ events, tz, fmt }: { events: any[]; tz: string; fmt: (v: any, tz: string) => string }) {
  const cls = (t: string) => (t === 'resolved' || t === 'recovered' ? 'good' : t === 'opened' || t === 'escalated' || t === 'reopened' ? 'bad' : t === 'notification_failed' ? 'warn' : '');
  return (
    <ol className="timeline">
      {events.map((e) => (
        <li key={e.id} className={cls(e.type)}>
          <div><strong>{e.type.replace(/_/g, ' ')}</strong> <span className="faint">· {fmt(e.at, tz)}{e.actor_name ? ` · ${e.actor_name}` : ''}</span></div>
          {e.message && <div>{e.message}</div>}
        </li>))}
    </ol>
  );
}
