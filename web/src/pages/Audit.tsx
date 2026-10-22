import { useState } from 'react';
import { qs } from '../lib/api';
import { Async, Card, Empty, PageHeader, Pager } from '../components/ui';
import { useApi } from '../lib/hooks';
import { fmtDateTime, useTz } from '../lib/format';

export function AuditPage() {
  const tz = useTz(); const [page, setPage] = useState(1); const [action, setAction] = useState(''); const [entity, setEntity] = useState('');
  const query = qs({ page, pageSize: 50, action, entity_type: entity });
  const q = useApi<any>(['audit', query], `/audit-logs${query}`);
  return (
    <>
      <PageHeader title="Audit logs" sub="Append-only record of who did what. Entries cannot be edited or deleted through the application. Secrets and passwords are never logged." />
      <Card pad={false}>
        <div className="toolbar">
          <input type="search" aria-label="Action prefix" placeholder="Action starts with… (e.g. auth., website.)" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} />
          <select aria-label="Entity" value={entity} onChange={(e) => { setEntity(e.target.value); setPage(1); }}><option value="">Entity: all</option>{['user', 'website', 'incident', 'task', 'report', 'settings', 'integration', 'maintenance', 'escalation_rule'].map((e) => <option key={e}>{e}</option>)}</select>
        </div>
        <Async q={q}>{(d) => !d.data.length ? <Empty title="No entries" /> : (
          <>
            <div className="table-wrap"><table><thead><tr><th>When</th><th>User</th><th>Action</th><th>Entity</th><th>IP</th><th>Details</th></tr></thead>
              <tbody>{d.data.map((a: any) => <tr key={a.id}><td className="nowrap">{fmtDateTime(a.at, tz)}</td><td>{a.user_email ?? <span className="faint">system</span>}</td><td className="mono">{a.action}</td><td>{a.entity_type}{a.entity_id ? <div className="faint mono">{String(a.entity_id).slice(0, 8)}</div> : null}</td><td className="mono">{a.ip ?? ''}</td><td className="mono" style={{ maxWidth: 360, wordBreak: 'break-all' }}>{a.data && Object.keys(a.data).length ? JSON.stringify(a.data) : ''}</td></tr>)}</tbody></table></div>
            <Pager page={d.page} totalPages={d.totalPages} total={d.total} pageSize={50} onPage={setPage} />
          </>)}</Async>
      </Card>
    </>
  );
}
