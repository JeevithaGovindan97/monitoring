import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../lib/api';
import { Async, Badge, Card, Confirm, Empty, Field, Modal, PageHeader, Pager } from '../components/ui';
import { Timeline } from '../components/shared';
import { TaskFormModal } from './Tasks';
import { useApi } from '../lib/hooks';
import { ago, dur, fmtDateTime, title, useTz } from '../lib/format';
import { useToast } from '../lib/toast';

export function IncidentsPage() {
  const [sp, setSp] = useSearchParams(); const tz = useTz();
  const page = Number(sp.get('page') ?? 1);
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); if (k !== 'page') n.delete('page'); setSp(n, { replace: true }); };
  const query = qs({ page, pageSize: 25, open: sp.get('open'), status: sp.get('status'), severity: sp.get('severity'), kind: sp.get('kind'), website_id: sp.get('website_id'), assigned_to: sp.get('assigned_to') });
  const q = useApi<any>(['incidents', query], `/incidents${query}`, { refetchMs: 30_000 });
  const sel = (k: string, label: string, opts: string[]) => <select aria-label={label} value={sp.get(k) ?? ''} onChange={(e) => set(k, e.target.value)}><option value="">{label}: all</option>{opts.map((o) => <option key={o} value={o}>{title(o)}</option>)}</select>;
  return (
    <>
      <PageHeader title="Incidents" sub="An incident opens after consecutive failed checks and resolves after consecutive successes. Every change is kept in an append-only timeline." />
      <Card pad={false}>
        <div className="toolbar">
          <select aria-label="Scope" value={sp.get('open') ? 'open' : ''} onChange={(e) => set('open', e.target.value ? 'true' : '')}><option value="">All incidents</option><option value="open">Open only</option></select>
          {sel('severity', 'Severity', ['critical', 'high', 'medium', 'low'])}
          {sel('status', 'Status', ['open', 'acknowledged', 'investigating', 'resolved', 'reopened'])}
          {sel('kind', 'Type', ['outage', 'ssl', 'form'])}
          {sel('assigned_to', 'Assignee', ['me', 'none'])}
          {sp.get('website_id') && <button className="btn sm" onClick={() => set('website_id', '')}>Clear website filter ✕</button>}
        </div>
        <Async q={q}>{(d) => !d.data.length ? <Empty title="No incidents found">{sp.size ? 'No incidents match these filters.' : 'Nothing has gone wrong yet.'}</Empty> : (
          <>
            <div className="table-wrap"><table><thead><tr><th>Incident</th><th>Website</th><th>Severity</th><th>Status</th><th>Started</th><th>Duration</th><th>Assignee</th></tr></thead>
              <tbody>{d.data.map((i: any) => <tr key={i.id}><td><Link to={`/incidents/${i.id}`}><strong>{i.title}</strong></Link><div className="faint">{title(i.kind)}</div></td><td><Link to={`/websites/${i.website_id}`}>{i.website_name}</Link></td><td><Badge kind={i.severity} /></td><td><Badge kind={i.status} /></td><td className="nowrap">{fmtDateTime(i.started_at, tz)}</td><td>{i.status === 'resolved' ? dur(i.duration_seconds) : <span className="err-text">ongoing {ago(i.started_at).replace(' ago', '')}</span>}</td><td>{i.assigned_name ?? <span className="faint">Unassigned</span>}</td></tr>)}</tbody></table></div>
            <Pager page={d.page} totalPages={d.totalPages} total={d.total} pageSize={25} onPage={(p) => set('page', String(p))} />
          </>)}</Async>
      </Card>
    </>
  );
}

export function IncidentDetailPage() {
  const { id } = useParams(); const tz = useTz(); const qc = useQueryClient(); const toast = useToast();
  const q = useApi<any>(['incident', id], `/incidents/${id}`, { refetchMs: 20_000 });
  const users = useApi<any>(['users-dir'], '/users/directory');
  const [note, setNote] = useState(''); const [dlg, setDlg] = useState<null | 'resolve' | 'reopen' | 'assign' | 'task'>(null);
  const [text, setText] = useState(''); const [assignee, setAssignee] = useState('');
  const act = useMutation({
    mutationFn: (v: { path: string; body?: unknown }) => api(`/incidents/${id}/${v.path}`, { body: v.body ?? {} }),
    onSuccess: () => { qc.invalidateQueries(); setDlg(null); setText(''); setNote(''); toast('ok', 'Done'); }, onError: (e) => toast('err', (e as Error).message),
  });
  return (
    <Async q={q}>{(i) => {
      const resolved = i.status === 'resolved';
      return (
        <>
          <PageHeader title={i.title} crumbs={[{ label: 'Incidents', to: '/incidents' }, { label: i.website_name }]}
            sub={<span className="row"><Badge kind={i.severity} /><Badge kind={i.status} /><Link to={`/websites/${i.website_id}`}>{i.website_name}</Link><span className="mono">{i.website_url}</span></span>}
            actions={<>
              {!resolved && !i.acknowledged_at && <button className="btn" onClick={() => act.mutate({ path: 'acknowledge' })}>Acknowledge</button>}
              {!resolved && i.status !== 'investigating' && <button className="btn" onClick={() => act.mutate({ path: 'investigate' })}>Start investigating</button>}
              <button className="btn" onClick={() => { setAssignee(i.assigned_to ?? ''); setDlg('assign'); }}>Assign</button>
              <button className="btn" onClick={() => setDlg('task')}>Create task</button>
              {resolved ? <button className="btn" onClick={() => setDlg('reopen')}>Reopen</button> : <button className="btn primary" onClick={() => setDlg('resolve')}>Resolve</button>}
            </>} />
          <div className="grid g2" style={{ gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)', alignItems: 'start' }}>
            <Card title="Timeline" tip="Append-only: entries cannot be edited or deleted.">
              <Timeline events={i.events} tz={tz} fmt={fmtDateTime} />
              <form onSubmit={(e) => { e.preventDefault(); if (note.trim()) act.mutate({ path: 'notes', body: { message: note } }); }} className="row" style={{ marginTop: 6 }}>
                <input aria-label="Add a note" placeholder="Add a note to the timeline…" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1 }} />
                <button className="btn primary" disabled={!note.trim() || act.isPending}>Add note</button>
              </form>
            </Card>
            <div className="col">
              <Card title="Details"><table><tbody>
                {[['Type', title(i.kind)], ['Started', fmtDateTime(i.started_at, tz)], ['Resolved', resolved ? `${fmtDateTime(i.resolved_at, tz)}${i.auto_resolved ? ' (auto)' : ''}` : 'Ongoing'], ['Duration', resolved ? dur(i.duration_seconds) : ago(i.started_at).replace(' ago', '')], ['Acknowledged', i.acknowledged_at ? `${fmtDateTime(i.acknowledged_at, tz)} by ${i.acknowledged_name ?? '—'}` : 'Not yet'], ['Assignee', i.assigned_name ?? 'Unassigned']].map(([k, v]) => <tr key={k}><th style={{ position: 'static', textTransform: 'none' }}>{k}</th><td>{v}</td></tr>)}
              </tbody></table></Card>
              <Card title="Notifications sent" pad={false}>{i.deliveries.length ? <table><tbody>{i.deliveries.map((d: any) => <tr key={d.id}><td>{d.recipient}<div className="faint">{d.kind}</div></td><td><Badge kind={d.status} />{d.last_error && <div className="err-text">{d.last_error}</div>}</td></tr>)}</tbody></table> : <Empty title="None" />}</Card>
              <Card title="Tasks" pad={false}>{i.tasks.length ? <table><tbody>{i.tasks.map((t: any) => <tr key={t.id}><td><Link to={`/tasks?open=${t.id}`}>{t.title}</Link></td><td><Badge kind={t.status} /></td></tr>)}</tbody></table> : <Empty title="No tasks" />}</Card>
            </div>
          </div>
          {dlg === 'resolve' && <Modal title="Resolve incident" onClose={() => setDlg(null)} footer={<><button className="btn" onClick={() => setDlg(null)}>Cancel</button><button className="btn primary" onClick={() => act.mutate({ path: 'resolve', body: { note: text || undefined } })}>Resolve</button></>}>
            <p className="muted">If the website is still failing, a new incident will open on the next failed check.</p><Field label="Resolution note (optional)"><textarea value={text} onChange={(e) => setText(e.target.value)} /></Field></Modal>}
          {dlg === 'reopen' && <Confirm title="Reopen incident" message={<Field label="Reason (optional)"><input value={text} onChange={(e) => setText(e.target.value)} /></Field>} confirmLabel="Reopen" onCancel={() => setDlg(null)} onConfirm={() => act.mutate({ path: 'reopen', body: { reason: text || undefined } })} />}
          {dlg === 'assign' && <Modal title="Assign incident" onClose={() => setDlg(null)} footer={<><button className="btn" onClick={() => setDlg(null)}>Cancel</button><button className="btn primary" onClick={() => act.mutate({ path: 'assign', body: { user_id: assignee || null } })}>Save</button></>}>
            <Field label="Assignee"><select value={assignee} onChange={(e) => setAssignee(e.target.value)}><option value="">Unassigned</option>{users.data?.data.map((u: any) => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}</select></Field></Modal>}
          {dlg === 'task' && <TaskFormModal websiteId={i.website_id} incidentId={i.id} defaultTitle={`Follow up: ${i.title}`} onClose={() => setDlg(null)} />}
        </>);
    }}</Async>
  );
}
