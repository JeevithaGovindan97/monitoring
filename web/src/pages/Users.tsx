import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Async, Badge, Card, Confirm, Field, Modal, PageHeader } from '../components/ui';
import { useApi, useAuth } from '../lib/hooks';
import { ago, fmtDateTime, useTz } from '../lib/format';
import { useToast } from '../lib/toast';

export function UsersPage() {
  const q = useApi<any>(['users'], '/users'); const { me } = useAuth(); const tz = useTz(); const qc = useQueryClient(); const toast = useToast();
  const [adding, setAdding] = useState(false); const [secret, setSecret] = useState<{ email: string; pw: string } | null>(null);
  const [confirm, setConfirm] = useState<{ u: any; kind: 'reset' | 'deactivate' | 'activate' } | null>(null);
  const [f, setF] = useState({ name: '', email: '', role: 'manager' });
  const create = useMutation({ mutationFn: () => api('/users', { body: f }), onSuccess: (r: any) => { setAdding(false); qc.invalidateQueries({ queryKey: ['users'] }); setSecret({ email: r.user.email, pw: r.temporaryPassword }); setF({ name: '', email: '', role: 'manager' }); }, onError: (e) => toast('err', (e as Error).message) });
  const patch = useMutation({ mutationFn: (v: { id: string; body: object }) => api(`/users/${v.id}`, { method: 'PATCH', body: v.body }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); setConfirm(null); toast('ok', 'Updated'); }, onError: (e) => { toast('err', (e as Error).message); setConfirm(null); } });
  const reset = useMutation({ mutationFn: (id: string) => api(`/users/${id}/reset-password`, { method: 'POST' }), onSuccess: (r: any) => { setSecret({ email: confirm!.u.email, pw: r.temporaryPassword }); setConfirm(null); }, onError: (e) => toast('err', (e as Error).message) });
  return (
    <>
      <PageHeader title="Users" sub="There is no public sign-up. Administrators create accounts; new users must change their temporary password at first login." actions={<button className="btn primary" onClick={() => setAdding(true)}>Add user</button>} />
      <Card pad={false}><Async q={q}>{(d) => (
        <div className="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Last login</th><th /></tr></thead>
          <tbody>{d.data.map((u: any) => (
            <tr key={u.id}><td><strong>{u.name}</strong><div className="faint">{u.email}</div></td>
              <td><select aria-label={`Role for ${u.name}`} value={u.role} disabled={u.id === me.id} onChange={(e) => patch.mutate({ id: u.id, body: { role: e.target.value } })} style={{ width: 'auto' }}><option value="admin">Admin</option><option value="manager">Manager</option></select></td>
              <td>{u.is_active ? <Badge kind="up">Active</Badge> : <Badge kind="plain">Deactivated</Badge>}{u.must_change_password && <div className="faint">must change password</div>}{u.locked_until && new Date(u.locked_until) > new Date() && <div className="err-text">locked until {fmtDateTime(u.locked_until, tz)}</div>}</td>
              <td title={fmtDateTime(u.last_login_at, tz)}>{ago(u.last_login_at)}</td>
              <td><span className="row"><button className="btn sm" onClick={() => setConfirm({ u, kind: 'reset' })}>Reset password</button>{u.id !== me.id && <button className="btn sm" onClick={() => setConfirm({ u, kind: u.is_active ? 'deactivate' : 'activate' })}>{u.is_active ? 'Deactivate' : 'Activate'}</button>}</span></td></tr>))}</tbody></table></div>)}</Async></Card>
      <Card title="Roles" ><ul style={{ margin: 0, paddingLeft: 18 }}><li><strong>Admin</strong> — everything: users, inventory changes, integrations, settings, audit logs, deletions.</li><li><strong>Manager</strong> — view all dashboards, acknowledge/resolve incidents, manage tasks they own or created, request reports. Cannot change inventory, integrations, users or settings.</li></ul></Card>
      {adding && <Modal title="Add user" onClose={() => setAdding(false)} footer={<><button className="btn" onClick={() => setAdding(false)}>Cancel</button><button className="btn primary" disabled={!f.name || !f.email || create.isPending} onClick={() => create.mutate()}>Create user</button></>}>
        <div className="form-grid"><Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field><Field label="E-mail"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Role"><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="manager">Manager</option><option value="admin">Admin</option></select></Field></div>
        <p className="faint">A strong temporary password is generated and shown once.</p></Modal>}
      {secret && <Modal title="Temporary password" onClose={() => setSecret(null)} footer={<button className="btn primary" onClick={() => setSecret(null)}>I have copied it</button>}>
        <p>Give this to <strong>{secret.email}</strong> through a secure channel. It is shown only once and must be changed at first login.</p><p className="mono" style={{ fontSize: 16, userSelect: 'all', padding: 12, background: 'var(--surface-2)', borderRadius: 8 }}>{secret.pw}</p></Modal>}
      {confirm && <Confirm title={confirm.kind === 'reset' ? 'Reset password' : confirm.kind === 'deactivate' ? 'Deactivate user' : 'Activate user'} danger={confirm.kind === 'deactivate'} busy={patch.isPending || reset.isPending}
        message={<p>{confirm.kind === 'reset' ? `Generate a new temporary password for ${confirm.u.email}? Their current password and sessions stop working.` : confirm.kind === 'deactivate' ? `${confirm.u.email} will be logged out and unable to sign in.` : `Allow ${confirm.u.email} to sign in again?`}</p>}
        onCancel={() => setConfirm(null)} onConfirm={() => confirm.kind === 'reset' ? reset.mutate(confirm.u.id) : patch.mutate({ id: confirm.u.id, body: { is_active: confirm.kind === 'activate' } })} />}
    </>
  );
}
