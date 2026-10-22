import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, downloadUrl, qs } from '../lib/api';
import { Async, Badge, Card, Confirm, Empty, IntegrationBadge, Modal, PageHeader, Pager, StateBadge, useDebounced } from '../components/ui';
import { WebsiteFormModal } from '../components/WebsiteForm';
import { useApi, useAuth } from '../lib/hooks';
import { ago, title } from '../lib/format';
import { useToast } from '../lib/toast';

const PAGE_SIZE = 25;

export function InventoryPage() {
  const { isAdmin } = useAuth();
  const [sp, setSp] = useSearchParams();
  const toast = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState(sp.get('q') ?? '');
  const dq = useDebounced(search);
  const get = (k: string) => sp.get(k) ?? '';
  const page = Number(sp.get('page') ?? 1);
  const sort = get('sort') || 'name';
  const dir = get('dir') || 'asc';
  const setParam = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); if (k !== 'page') n.delete('page'); setSp(n, { replace: true }); };
  const query = qs({ page, pageSize: PAGE_SIZE, q: dq, state: get('state'), criticality: get('criticality'), hosting_type: get('hosting_type'), environment: get('environment'), monitoring_status: get('monitoring_status'), ga4_status: get('ga4_status'), gsc_status: get('gsc_status'), sort, dir });
  const list = useApi<any>(['websites', query], `/websites${query}`, { refetchMs: 60_000 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<any | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [confirm, setConfirm] = useState<{ action: string; value?: unknown; label: string } | null>(null);

  const bulk = useMutation({
    mutationFn: (v: { action: string; value?: unknown }) => api('/websites/bulk', { body: { ids: [...selected], ...v } }),
    onSuccess: (r: any) => { toast('ok', `${r.affected} website(s) updated`); setSelected(new Set()); setConfirm(null); qc.invalidateQueries({ queryKey: ['websites'] }); },
    onError: (e) => { toast('err', (e as Error).message); setConfirm(null); },
  });
  const sortBy = (k: string) => { const n = new URLSearchParams(sp); n.set('sort', k); n.set('dir', sort === k && dir === 'asc' ? 'desc' : 'asc'); n.delete('page'); setSp(n, { replace: true }); };
  const th = (k: string, label: string, cls = '') => <th className={`sortable ${cls}`} aria-sort={sort === k ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'} onClick={() => sortBy(k)}>{label}{sort === k ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>;
  const sel = (k: string, label: string, opts: string[]) => (
    <select aria-label={label} value={get(k)} onChange={(e) => setParam(k, e.target.value)}><option value="">{label}: all</option>{opts.map((o) => <option key={o} value={o}>{title(o)}</option>)}</select>
  );
  const rows: any[] = list.data?.data ?? [];
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = () => setSelected((s) => { const n = new Set(s); rows.forEach((r) => (allOnPage ? n.delete(r.id) : n.add(r.id))); return n; });

  return (
    <>
      <PageHeader title="Website inventory" sub="Every monitored website. Click a row for details, history and settings."
        actions={<>
          <a className="btn" href={downloadUrl('/websites/export?format=csv')}>Export CSV</a>
          <a className="btn" href={downloadUrl('/websites/export?format=xlsx')}>Export Excel</a>
          {isAdmin && <><button className="btn" onClick={() => setImporting(true)}>Import…</button><button className="btn primary" onClick={() => setEditing('new')}>Add website</button></>}
        </>} />
      <Card pad={false}>
        <div className="toolbar" role="search">
          <input type="search" placeholder="Search name, URL, owner…" aria-label="Search" value={search} onChange={(e) => { setSearch(e.target.value); setParam('q', e.target.value); }} />
          {sel('state', 'Status', ['up', 'down', 'degraded', 'unknown', 'unmonitored'])}
          {sel('criticality', 'Criticality', ['critical', 'high', 'medium', 'low'])}
          {sel('hosting_type', 'Hosting', ['vps', 'docker', 'dokploy', 'managed', 'shared', 'cloud', 'other'])}
          {sel('environment', 'Environment', ['production', 'staging', 'development'])}
          {sel('monitoring_status', 'Monitoring', ['active', 'disabled', 'archived'])}
          {sel('ga4_status', 'GA4', ['connected', 'access_required', 'not_connected', 'error', 'not_applicable'])}
          {sel('gsc_status', 'Search Console', ['connected', 'access_required', 'not_connected', 'error', 'not_applicable'])}
          {[...sp.keys()].some((k) => k !== 'page') && <button className="btn ghost sm" onClick={() => { setSearch(''); setSp({}, { replace: true }); }}>Clear filters</button>}
        </div>
        {isAdmin && selected.size > 0 && (
          <div className="toolbar" style={{ background: 'var(--accent-soft)' }}>
            <strong>{selected.size} selected</strong>
            <button className="btn sm" onClick={() => setConfirm({ action: 'enable', label: 'Enable monitoring' })}>Enable</button>
            <button className="btn sm" onClick={() => setConfirm({ action: 'disable', label: 'Disable monitoring' })}>Disable</button>
            <button className="btn sm" onClick={() => setConfirm({ action: 'archive', label: 'Archive' })}>Archive</button>
            <select aria-label="Set criticality" value="" onChange={(e) => e.target.value && setConfirm({ action: 'set_criticality', value: e.target.value, label: `Set criticality to ${e.target.value}` })}><option value="">Set criticality…</option>{['critical', 'high', 'medium', 'low'].map((c) => <option key={c}>{c}</option>)}</select>
            <select aria-label="Set interval" value="" onChange={(e) => e.target.value && setConfirm({ action: 'set_interval', value: Number(e.target.value), label: `Set check interval to ${Number(e.target.value) / 60} min` })}><option value="">Set interval…</option>{[60, 300, 600, 900, 1800, 3600].map((c) => <option key={c} value={c}>{c / 60} min</option>)}</select>
            <button className="btn sm danger" onClick={() => setConfirm({ action: 'delete', label: 'Permanently delete' })}>Delete</button>
            <button className="btn ghost sm" onClick={() => setSelected(new Set())}>Clear selection</button>
          </div>)}
        <Async q={list}>{(d) => !d.data.length ? (
          <Empty title={get('q') || sp.size ? 'No websites match these filters' : 'No websites yet'} action={isAdmin && !sp.size ? <button className="btn primary" onClick={() => setImporting(true)}>Import your websites</button> : undefined}>
            {sp.size ? 'Try removing a filter.' : 'Import a CSV/Excel file (a blank 27-row template is available in the import dialog) or add a website manually.'}
          </Empty>
        ) : (
          <>
            <div className="table-wrap"><table>
              <thead><tr>
                {isAdmin && <th style={{ width: 32 }}><input type="checkbox" aria-label="Select all on page" checked={allOnPage} onChange={toggleAll} /></th>}
                {th('name', 'Website')}{th('state', 'Status')}{th('criticality', 'Criticality')}<th>Hosting</th><th>Env</th><th>Owner</th>
                <th>GA4</th><th>Search Console</th>{th('last_check_at', 'Last check')}<th>Open incidents</th>{isAdmin && <th><span className="sr-only">Actions</span></th>}
              </tr></thead>
              <tbody>{d.data.map((r: any) => (
                <tr key={r.id}>
                  {isAdmin && <td><input type="checkbox" aria-label={`Select ${r.name}`} checked={selected.has(r.id)} onChange={() => setSelected((s) => { const n = new Set(s); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })} /></td>}
                  <td><Link to={`/websites/${r.id}`}><strong>{r.name}</strong></Link><div className="faint mono">{r.url}</div></td>
                  <td><StateBadge state={r.effective_state} />{r.monitoring_status !== 'active' && <div className="faint" style={{ fontSize: 11 }}>{title(r.monitoring_status)}</div>}</td>
                  <td><Badge kind={r.criticality} /></td><td>{title(r.hosting_type)}</td><td>{title(r.environment)}</td><td>{r.owner ?? '—'}</td>
                  <td><IntegrationBadge status={r.ga4_status} /></td><td><IntegrationBadge status={r.gsc_status} /></td>
                  <td className="muted">{ago(r.last_check_at)}</td>
                  <td>{r.open_incidents > 0 ? <Link to={`/incidents?website_id=${r.id}&open=true`}>{r.open_incidents}</Link> : '0'}</td>
                  {isAdmin && <td><button className="btn sm" onClick={() => setEditing(r)}>Edit</button></td>}
                </tr>))}</tbody>
            </table></div>
            <Pager page={d.page} totalPages={d.totalPages} total={d.total} pageSize={PAGE_SIZE} onPage={(p) => setParam('page', String(p))} />
          </>
        )}</Async>
      </Card>
      {editing && <WebsiteFormModal site={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      {importing && <ImportModal onClose={() => setImporting(false)} />}
      {confirm && (
        <Confirm title={confirm.label} danger={confirm.action === 'delete'} busy={bulk.isPending} confirmLabel={confirm.action === 'delete' ? 'Delete permanently' : 'Apply'}
          message={<p>{confirm.action === 'delete' ? `This permanently deletes ${selected.size} website(s) and ALL of their check history, incidents and reports data. This cannot be undone. Consider archiving instead.` : `Apply "${confirm.label}" to ${selected.size} selected website(s)?`}</p>}
          onCancel={() => setConfirm(null)} onConfirm={() => bulk.mutate({ action: confirm.action, value: confirm.value })} />)}
    </>
  );
}

function ImportModal({ onClose }: { onClose: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [err, setErr] = useState('');
  const [skipInvalid, setSkip] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  const send = async (mode: 'preview' | 'commit') => {
    if (!file) return;
    const fd = new FormData(); fd.append('file', file);
    return api(`/websites/import${qs({ mode, skipInvalid: skipInvalid ? 'true' : undefined })}`, { form: fd });
  };
  const prev = useMutation({ mutationFn: () => send('preview'), onSuccess: (r) => { setPreview(r); setErr(''); }, onError: (e) => { setPreview(null); setErr((e as ApiError).message); } });
  const commit = useMutation({
    mutationFn: () => send('commit'),
    onSuccess: (r: any) => { toast('ok', `Imported ${r.created} website(s)${r.skipped ? `, skipped ${r.skipped}` : ''}`); qc.invalidateQueries(); onClose(); },
    onError: (e) => { const x = e as ApiError; setErr(x.message); if ((x.details as any)?.rows) setPreview({ summary: (x.details as any).summary, rows: (x.details as any).rows }); },
  });
  const s = preview?.summary;
  return (
    <Modal title="Import websites" onClose={onClose} wide
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={!file || prev.isPending} onClick={() => prev.mutate()}>{prev.isPending ? 'Checking…' : 'Preview'}</button>
        <button className="btn primary" disabled={!preview || commit.isPending || (s?.valid ?? 0) === 0 || (s?.invalid > 0 && !skipInvalid)} onClick={() => commit.mutate()}>{commit.isPending ? 'Importing…' : `Import ${s?.valid ?? 0} valid row(s)`}</button></>}>
      <p>Upload a <strong>.csv</strong> or <strong>.xlsx</strong> file. Nothing is saved until you review the preview and confirm. <a href={downloadUrl('/websites/import-template')}>Download the blank 27-row Excel template</a> (with dropdowns).</p>
      <div className="row" style={{ marginBottom: 12 }}>
        <input ref={fileRef} type="file" accept=".csv,.xlsx" aria-label="Inventory file" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); setErr(''); }} />
      </div>
      {err && <div className="alert err" role="alert">{err}</div>}
      {s && (
        <>
          <div className="row" style={{ marginBottom: 8 }}>
            <Badge kind="info">{s.totalRows} rows</Badge><Badge kind="ok">{s.valid} valid</Badge>{s.invalid > 0 && <Badge kind="error">{s.invalid} with errors</Badge>}{s.duplicates > 0 && <Badge kind="warn">{s.duplicates} duplicate(s)</Badge>}
          </div>
          {s.unknownHeaders?.length > 0 && <div className="alert warn">Ignored unknown columns: {s.unknownHeaders.join(', ')}</div>}
          {s.invalid > 0 && <label className="check" style={{ marginBottom: 8 }}><input type="checkbox" checked={skipInvalid} onChange={(e) => setSkip(e.target.checked)} /> Import valid rows only and skip rows with errors</label>}
          <div className="table-wrap" style={{ maxHeight: 340, overflow: 'auto' }}><table>
            <thead><tr><th>Row</th><th>Name</th><th>URL</th><th>Result</th></tr></thead>
            <tbody>{preview.rows.map((r: any) => (
              <tr key={r.row}><td>{r.row}</td><td>{r.name ?? '—'}</td><td className="mono">{r.url ?? '—'}</td>
                <td>{r.ok ? <Badge kind="ok">OK</Badge> : <Badge kind="error">Error</Badge>}{r.duplicateOf && <> <Badge kind="warn">Duplicate</Badge></>}
                  {r.errors?.length > 0 && <ul className="err-text" style={{ margin: '4px 0 0', paddingLeft: 16 }}>{r.errors.map((e: any, i: number) => <li key={i}>{typeof e === 'string' ? e : `${e.field ? e.field + ': ' : ''}${e.message}`}</li>)}</ul>}</td></tr>))}</tbody>
          </table></div>
        </>)}
    </Modal>
  );
}
