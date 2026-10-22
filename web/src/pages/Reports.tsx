import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, downloadUrl } from '../lib/api';
import { Async, Badge, Card, Empty, Field, Modal, PageHeader, Pager } from '../components/ui';
import { useApi } from '../lib/hooks';
import { fmtDateTime, title, useTz } from '../lib/format';
import { useToast } from '../lib/toast';

const TYPES: Array<[string, string]> = [['daily', 'Daily summary (last 24h)'], ['weekly', 'Weekly summary (last 7 days)'], ['monthly', 'Monthly summary (last 30 days)'], ['custom', 'Custom date range'], ['website', 'Single website'], ['incidents', 'Incident report'], ['traffic_seo', 'Traffic & SEO'], ['performance_ssl', 'Performance & SSL'], ['tasks', 'Tasks & escalations']];
const size = (n: number | null) => (n === null ? '—' : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function ReportsPage() {
  const tz = useTz(); const [page, setPage] = useState(1); const [open, setOpen] = useState(false);
  const q = useApi<any>(['reports', page], `/reports?page=${page}&pageSize=20`, { refetchMs: 4000 });
  return (
    <>
      <PageHeader title="Reports" sub="PDF and Excel reports are generated in the background from stored data. Downloads require you to be logged in and are recorded in the audit log." actions={<button className="btn primary" onClick={() => setOpen(true)}>New report</button>} />
      <Card pad={false}>
        <Async q={q}>{(d) => !d.data.length ? <Empty title="No reports yet" action={<button className="btn primary" onClick={() => setOpen(true)}>Create your first report</button>}>Reports appear here once generated and are kept for the retention period.</Empty> : (
          <>
            <div className="table-wrap"><table><thead><tr><th>Report</th><th>Format</th><th>Status</th><th>Requested</th><th>Size</th><th>Expires</th><th /></tr></thead>
              <tbody>{d.data.map((r: any) => (
                <tr key={r.id}><td>{title(r.type)}<div className="faint">by {r.requested_by_name ?? '—'}</div></td><td>{r.format.toUpperCase()}</td>
                  <td><Badge kind={r.status} />{r.status === 'running' && <div className="bar" style={{ marginTop: 4, width: 90 }}><i style={{ width: `${r.progress}%` }} /></div>}{r.error && <div className="err-text">{r.error}</div>}</td>
                  <td>{fmtDateTime(r.created_at, tz)}</td><td>{size(r.file_size)}</td><td>{fmtDateTime(r.expires_at, tz)}</td>
                  <td>{r.status === 'done' || r.status === 'completed' ? <a className="btn sm" href={downloadUrl(`/reports/${r.id}/download`)}>Download</a> : null}</td></tr>))}</tbody></table></div>
            <Pager page={d.page} totalPages={d.totalPages} total={d.total} pageSize={20} onPage={setPage} />
          </>)}</Async>
      </Card>
      {open && <NewReport onClose={() => setOpen(false)} />}
    </>
  );
}

function NewReport({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const sites = useApi<any>(['sites-all'], '/websites?pageSize=100');
  const [f, setF] = useState({ type: 'weekly', format: 'pdf', from: '', to: '', websiteId: '' });
  const m = useMutation({
    mutationFn: () => api('/reports', { body: { type: f.type, format: f.format, from: f.from ? new Date(f.from).toISOString() : undefined, to: f.to ? new Date(f.to + 'T23:59:59').toISOString() : undefined, websiteId: f.websiteId || undefined } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['reports'] }); toast('ok', 'Report queued — it will appear as ready shortly'); onClose(); }, onError: (e) => toast('err', (e as Error).message),
  });
  const needRange = f.type === 'custom';
  return (
    <Modal title="New report" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={m.isPending || (f.type === 'website' && !f.websiteId) || (needRange && (!f.from || !f.to))} onClick={() => m.mutate()}>Generate</button></>}>
      <div className="form-grid">
        <Field label="Report" full><select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Format"><select value={f.format} onChange={(e) => setF({ ...f, format: e.target.value })}><option value="pdf">PDF</option><option value="xlsx">Excel (XLSX)</option></select></Field>
        {f.type === 'website' && <Field label="Website"><select value={f.websiteId} onChange={(e) => setF({ ...f, websiteId: e.target.value })}><option value="">Select…</option>{sites.data?.data.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>}
        {['custom', 'website', 'incidents', 'traffic_seo', 'performance_ssl', 'tasks'].includes(f.type) && <>
          <Field label={`From${needRange ? '' : ' (optional)'}`}><input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
          <Field label={`To${needRange ? '' : ' (optional)'}`}><input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field></>}
      </div>
      <p className="faint">Sections without a connected data source say “not connected” in the report; they are never filled with zeros.</p>
    </Modal>
  );
}
