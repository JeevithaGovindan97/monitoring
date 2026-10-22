import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../lib/api';
import { Async, Badge, Card, Confirm, Empty, Field, Modal, PageHeader, Pager, Tabs } from '../components/ui';
import { Timeline } from '../components/shared';
import { useApi, useAuth } from '../lib/hooks';
import { fmtDateTime, title, useTz } from '../lib/format';
import { useToast } from '../lib/toast';

const STATUSES = ['open', 'in_progress', 'blocked', 'completed', 'cancelled'];
const PRI = ['critical', 'high', 'medium', 'low'];

export function TaskFormModal({ websiteId, incidentId, defaultTitle, onClose }: { websiteId?: string; incidentId?: string; defaultTitle?: string; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const users = useApi<any>(['users-dir'], '/users/directory');
  const sites = useApi<any>(['sites-all'], '/websites?pageSize=100', { enabled: !websiteId });
  const [f, setF] = useState({ title: defaultTitle ?? '', description: '', priority: 'medium', assigned_to: '', due_at: '', website_id: websiteId ?? '' });
  const m = useMutation({
    mutationFn: () => api('/tasks', { body: { title: f.title, description: f.description || null, priority: f.priority, assigned_to: f.assigned_to || null, due_at: f.due_at ? new Date(f.due_at).toISOString() : null, website_id: f.website_id || null, incident_id: incidentId ?? null } }),
    onSuccess: () => { qc.invalidateQueries(); toast('ok', 'Task created'); onClose(); }, onError: (e) => toast('err', (e as Error).message),
  });
  return (
    <Modal title="New task" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!f.title.trim() || m.isPending} onClick={() => m.mutate()}>Create task</button></>}>
      <div className="form-grid">
        <Field label="Title" full><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} autoFocus /></Field>
        <Field label="Description" full><textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="Priority"><select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{PRI.map((p) => <option key={p}>{p}</option>)}</select></Field>
        <Field label="Due"><input type="datetime-local" value={f.due_at} onChange={(e) => setF({ ...f, due_at: e.target.value })} /></Field>
        <Field label="Assignee"><select value={f.assigned_to} onChange={(e) => setF({ ...f, assigned_to: e.target.value })}><option value="">Unassigned</option>{users.data?.data.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
        {!websiteId && <Field label="Website"><select value={f.website_id} onChange={(e) => setF({ ...f, website_id: e.target.value })}><option value="">None</option>{sites.data?.data.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>}
      </div>
    </Modal>
  );
}

export function TasksPage() {
  const [tab, setTab] = useState('tasks');
  const { isAdmin } = useAuth();
  return (
    <>
      <PageHeader title="Tasks & escalations" sub="Track follow-up work and make sure unattended problems reach the right people." />
      <Tabs tabs={[{ key: 'tasks', label: 'Tasks' }, { key: 'rules', label: `Escalation rules${isAdmin ? '' : ' (view)'}` }]} value={tab} onChange={setTab} />
      {tab === 'tasks' ? <TaskList /> : <Rules />}
    </>
  );
}

function TaskList() {
  const [sp, setSp] = useSearchParams(); const tz = useTz();
  const page = Number(sp.get('page') ?? 1);
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); if (k !== 'page' && k !== 'open') n.delete('page'); setSp(n, { replace: true }); };
  const query = qs({ page, pageSize: 25, status: sp.get('status') ?? 'pending', priority: sp.get('priority'), assigned_to: sp.get('assigned_to'), overdue: sp.get('overdue') });
  const q = useApi<any>(['tasks', query], `/tasks${query}`);
  const [adding, setAdding] = useState(false);
  const open = sp.get('open');
  return (
    <>
      <Card pad={false} actions={<button className="btn primary sm" onClick={() => setAdding(true)}>New task</button>}>
        <div className="toolbar">
          <select aria-label="Status" value={sp.get('status') ?? 'pending'} onChange={(e) => set('status', e.target.value)}><option value="pending">Status: pending</option><option value="">All statuses</option>{STATUSES.map((s) => <option key={s} value={s}>{title(s)}</option>)}</select>
          <select aria-label="Priority" value={sp.get('priority') ?? ''} onChange={(e) => set('priority', e.target.value)}><option value="">Priority: all</option>{PRI.map((s) => <option key={s}>{s}</option>)}</select>
          <select aria-label="Assignee" value={sp.get('assigned_to') ?? ''} onChange={(e) => set('assigned_to', e.target.value)}><option value="">Assignee: anyone</option><option value="me">Assigned to me</option></select>
          <label className="check"><input type="checkbox" checked={sp.get('overdue') === 'true'} onChange={(e) => set('overdue', e.target.checked ? 'true' : '')} /> Overdue only</label>
        </div>
        <Async q={q}>{(d) => !d.data.length ? <Empty title="No tasks match">Create a task, or change the filters.</Empty> : (
          <>
            <div className="table-wrap"><table><thead><tr><th>Task</th><th>Website</th><th>Priority</th><th>Status</th><th>Assignee</th><th>Due</th></tr></thead>
              <tbody>{d.data.map((t: any) => <tr key={t.id}><td><button className="btn ghost sm" style={{ fontWeight: 600, padding: 0 }} onClick={() => set('open', t.id)}>{t.title}</button></td><td>{t.website_name ? <Link to={`/websites/${t.website_id}`}>{t.website_name}</Link> : '—'}</td><td><Badge kind={t.priority} /></td><td><Badge kind={t.status} /></td><td>{t.assigned_name ?? <span className="faint">Unassigned</span>}</td><td className={t.overdue ? 'err-text' : ''}>{t.due_at ? fmtDateTime(t.due_at, tz) : '—'}{t.overdue ? ' · overdue' : ''}</td></tr>)}</tbody></table></div>
            <Pager page={d.page} totalPages={d.totalPages} total={d.total} pageSize={25} onPage={(p) => set('page', String(p))} />
          </>)}</Async>
      </Card>
      {adding && <TaskFormModal onClose={() => setAdding(false)} />}
      {open && <TaskDetail id={open} onClose={() => set('open', '')} />}
    </>
  );
}

function TaskDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const tz = useTz(); const { isAdmin } = useAuth(); const qc = useQueryClient(); const toast = useToast();
  const q = useApi<any>(['task', id], `/tasks/${id}`);
  const users = useApi<any>(['users-dir'], '/users/directory');
  const [comment, setComment] = useState(''); const [del, setDel] = useState(false);
  const patch = useMutation({ mutationFn: (b: object) => api(`/tasks/${id}`, { method: 'PATCH', body: b }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['task', id] }); qc.invalidateQueries({ queryKey: ['tasks'] }); }, onError: (e) => toast('err', (e as Error).message) });
  const post = useMutation({ mutationFn: () => api(`/tasks/${id}/comments`, { body: { message: comment } }), onSuccess: () => { setComment(''); qc.invalidateQueries({ queryKey: ['task', id] }); } });
  const rm = useMutation({ mutationFn: () => api(`/tasks/${id}`, { method: 'DELETE' }), onSuccess: () => { qc.invalidateQueries(); toast('ok', 'Task deleted'); onClose(); } });
  return (
    <Modal title="Task" onClose={onClose} wide>
      <Async q={q}>{(t) => (
        <>
          <h2 style={{ fontSize: 18, marginBottom: 6 }}>{t.title}</h2>
          {t.description && <p style={{ whiteSpace: 'pre-wrap' }}>{t.description}</p>}
          <div className="form-grid" style={{ margin: '12px 0' }}>
            <Field label="Status"><select value={t.status} onChange={(e) => patch.mutate({ status: e.target.value })}>{STATUSES.map((s) => <option key={s} value={s}>{title(s)}</option>)}</select></Field>
            <Field label="Priority"><select value={t.priority} onChange={(e) => patch.mutate({ priority: e.target.value })}>{PRI.map((s) => <option key={s}>{s}</option>)}</select></Field>
            <Field label="Assignee"><select value={t.assigned_to ?? ''} onChange={(e) => patch.mutate({ assigned_to: e.target.value || null })}><option value="">Unassigned</option>{users.data?.data.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
            <Field label="Due"><input type="datetime-local" defaultValue={t.due_at ? new Date(new Date(t.due_at).getTime() - new Date(t.due_at).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''} onBlur={(e) => patch.mutate({ due_at: e.target.value ? new Date(e.target.value).toISOString() : null })} /></Field>
          </div>
          <p className="faint">{t.website_name && <>Website: <Link to={`/websites/${t.website_id}`}>{t.website_name}</Link> · </>}{t.incident_id && <><Link to={`/incidents/${t.incident_id}`}>Linked incident</Link> · </>}Created by {t.created_name ?? '—'} on {fmtDateTime(t.created_at, tz)}</p>
          <h3 style={{ margin: '14px 0 8px' }}>Activity</h3>
          <Timeline events={t.events.map((e: any) => ({ ...e, type: e.type }))} tz={tz} fmt={fmtDateTime} />
          <form className="row" onSubmit={(e) => { e.preventDefault(); if (comment.trim()) post.mutate(); }}>
            <input aria-label="Comment" placeholder="Add a comment…" value={comment} onChange={(e) => setComment(e.target.value)} style={{ flex: 1 }} /><button className="btn primary" disabled={!comment.trim()}>Comment</button>
            {isAdmin && <button type="button" className="btn danger" onClick={() => setDel(true)}>Delete task</button>}
          </form>
          {del && <Confirm title="Delete task" danger message={<p>Delete this task and its history permanently?</p>} onCancel={() => setDel(false)} onConfirm={() => rm.mutate()} busy={rm.isPending} confirmLabel="Delete" />}
        </>)}</Async>
    </Modal>
  );
}

function Rules() {
  const { isAdmin } = useAuth(); const qc = useQueryClient(); const toast = useToast();
  const q = useApi<any>(['rules'], '/escalation-rules');
  const users = useApi<any>(['users-dir'], '/users/directory');
  const [adding, setAdding] = useState(false); const [del, setDel] = useState<any>(null);
  const toggle = useMutation({ mutationFn: (r: any) => api(`/escalation-rules/${r.id}`, { method: 'PATCH', body: { enabled: !r.enabled } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['rules'] }) });
  const rm = useMutation({ mutationFn: (id: string) => api(`/escalation-rules/${id}`, { method: 'DELETE' }), onSuccess: () => { setDel(null); qc.invalidateQueries({ queryKey: ['rules'] }); toast('ok', 'Rule deleted'); } });
  const [f, setF] = useState({ name: '', subject: 'incident', min_severity: 'critical', after_minutes: 30, only_unacknowledged: true, target: 'role:admin' });
  const create = useMutation({
    mutationFn: () => api('/escalation-rules', { body: { name: f.name, subject: f.subject, min_severity: f.min_severity || null, after_minutes: Number(f.after_minutes), only_unacknowledged: f.only_unacknowledged, notify_role: f.target.startsWith('role:') ? f.target.slice(5) : null, notify_user_id: f.target.startsWith('user:') ? f.target.slice(5) : null } }),
    onSuccess: () => { setAdding(false); qc.invalidateQueries({ queryKey: ['rules'] }); toast('ok', 'Rule created'); }, onError: (e) => toast('err', (e as Error).message),
  });
  return (
    <>
      <Card pad={false} title="Escalation rules" tip="Each rule fires at most once per incident/task. Recipients get an in-app notification and an e-mail." actions={isAdmin && <button className="btn primary sm" onClick={() => setAdding(true)}>Add rule</button>}>
        <Async q={q}>{(d) => !d.data.length ? <Empty title="No rules">Without a rule, an unacknowledged incident only notifies the normal alert recipients.</Empty> : (
          <div className="table-wrap"><table><thead><tr><th>Rule</th><th>Applies to</th><th>After</th><th>Notify</th><th>Enabled</th><th /></tr></thead>
            <tbody>{d.data.map((r: any) => <tr key={r.id}><td>{r.name}</td><td>{title(r.subject)}{r.min_severity ? ` · ${r.min_severity}+` : ''}{r.only_unacknowledged ? ' · unacknowledged' : ''}</td><td>{r.after_minutes} min</td><td>{r.notify_user_name ?? `All ${r.notify_role}s`}</td>
              <td><input type="checkbox" aria-label={`Enable ${r.name}`} checked={r.enabled} disabled={!isAdmin} onChange={() => toggle.mutate(r)} /></td><td>{isAdmin && <button className="btn sm" onClick={() => setDel(r)}>Delete</button>}</td></tr>)}</tbody></table></div>)}</Async>
      </Card>
      {adding && <Modal title="Add escalation rule" onClose={() => setAdding(false)} footer={<><button className="btn" onClick={() => setAdding(false)}>Cancel</button><button className="btn primary" disabled={!f.name.trim() || create.isPending} onClick={() => create.mutate()}>Create rule</button></>}>
        <div className="form-grid">
          <Field label="Name" full><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Critical outage not acknowledged in 30 min" /></Field>
          <Field label="Applies to"><select value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })}><option value="incident">Incidents</option><option value="task">Overdue tasks</option></select></Field>
          <Field label="Minimum severity / priority"><select value={f.min_severity} onChange={(e) => setF({ ...f, min_severity: e.target.value })}><option value="">Any</option>{PRI.map((p) => <option key={p}>{p}</option>)}</select></Field>
          <Field label="After (minutes)"><input type="number" min={1} value={f.after_minutes} onChange={(e) => setF({ ...f, after_minutes: Number(e.target.value) })} /></Field>
          <Field label="Notify"><select value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })}><option value="role:admin">All administrators</option><option value="role:manager">All managers</option>{users.data?.data.map((u: any) => <option key={u.id} value={`user:${u.id}`}>{u.name}</option>)}</select></Field>
          <label className="check"><input type="checkbox" checked={f.only_unacknowledged} onChange={(e) => setF({ ...f, only_unacknowledged: e.target.checked })} /> Only if not yet acknowledged</label>
        </div></Modal>}
      {del && <Confirm title="Delete rule" danger message={<p>Delete “{del.name}”?</p>} onCancel={() => setDel(null)} onConfirm={() => rm.mutate(del.id)} busy={rm.isPending} confirmLabel="Delete" />}
    </>
  );
}
