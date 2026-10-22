import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { Field, Modal } from './ui';
import { useToast } from '../lib/toast';

const HOSTING = ['vps', 'docker', 'dokploy', 'managed', 'shared', 'cloud', 'other'];
const ENVS = ['production', 'staging', 'development'];
const CRIT = ['critical', 'high', 'medium', 'low'];
const FORMS = ['none', 'contact', 'login', 'booking', 'checkout', 'other'];

export function WebsiteFormModal({ site, onClose }: { site?: any; onClose: () => void }) {
  const edit = Boolean(site);
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState<any>(() => ({
    name: site?.name ?? '', url: site?.url ?? 'https://', health_check_url: site?.health_check_url ?? '',
    hosting_type: site?.hosting_type ?? 'other', environment: site?.environment ?? 'production', owner: site?.owner ?? '',
    criticality: site?.criticality ?? 'medium', monitoring_status: site?.monitoring_status ?? 'active',
    expected_status: site?.expected_status ?? '200-399', check_interval_seconds: site?.check_interval_seconds ?? 300,
    timeout_ms: site?.timeout_ms ?? 10000, max_redirects: site?.max_redirects ?? 5, fail_threshold: site?.fail_threshold ?? 2, recover_threshold: site?.recover_threshold ?? 2,
    degraded_threshold_ms: site?.degraded_threshold_ms ?? '', ssl_check_enabled: site?.ssl_check_enabled ?? true, ssl_failure_is_outage: site?.ssl_failure_is_outage ?? false,
    performance_audit_enabled: site?.performance_audit_enabled ?? true, form_type: site?.form_type ?? 'none',
    ga4_property_id: site?.ga4_property_id ?? '', gsc_property_url: site?.gsc_property_url ?? '', notes: site?.notes ?? '',
  }));
  const [err, setErr] = useState<ApiError | null>(null);
  const set = (k: string, v: unknown) => setF((p: any) => ({ ...p, [k]: v }));
  const m = useMutation({
    mutationFn: () => {
      const body: any = { ...f, degraded_threshold_ms: f.degraded_threshold_ms === '' ? null : Number(f.degraded_threshold_ms) };
      for (const k of ['health_check_url', 'owner', 'ga4_property_id', 'gsc_property_url', 'notes']) if (body[k] === '') body[k] = null;
      return edit ? api(`/websites/${site.id}`, { method: 'PATCH', body }) : api('/websites', { body });
    },
    onSuccess: () => { qc.invalidateQueries(); toast('ok', edit ? 'Website updated' : 'Website added'); onClose(); },
    onError: (e) => setErr(e as ApiError),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); setErr(null); m.mutate(); };
  const fieldErrors: Array<{ path?: Array<string | number>; message: string }> = Array.isArray((err?.details as any)?.issues) ? (err!.details as any).issues : Array.isArray(err?.details) ? (err!.details as any) : [];
  const sel = (k: string, opts: string[]) => <select value={f[k]} onChange={(e) => set(k, e.target.value)}>{opts.map((o) => <option key={o}>{o}</option>)}</select>;
  return (
    <Modal title={edit ? `Edit ${site.name}` : 'Add website'} onClose={onClose} wide
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button form="wf" className="btn primary" disabled={m.isPending}>{m.isPending ? 'Saving…' : edit ? 'Save changes' : 'Add website'}</button></>}>
      <form id="wf" onSubmit={submit}>
        {err && <div className="alert err" role="alert">{err.message}{fieldErrors.length > 0 && <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{fieldErrors.map((x, i) => <li key={i}>{(x.path ?? []).join('.')}: {x.message}</li>)}</ul>}</div>}
        <div className="form-grid">
          <Field label="Name"><input required value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="URL" hint="Public https:// address. Private/internal addresses are blocked."><input required value={f.url} onChange={(e) => set('url', e.target.value)} /></Field>
          <Field label="Health-check URL (optional)" hint="Checked instead of the main URL when set."><input value={f.health_check_url} onChange={(e) => set('health_check_url', e.target.value)} /></Field>
          <Field label="Owner"><input value={f.owner} onChange={(e) => set('owner', e.target.value)} /></Field>
          <Field label="Hosting type">{sel('hosting_type', HOSTING)}</Field>
          <Field label="Environment">{sel('environment', ENVS)}</Field>
          <Field label="Criticality">{sel('criticality', CRIT)}</Field>
          <Field label="Monitoring">{sel('monitoring_status', ['active', 'disabled', 'archived'])}</Field>
          <Field label="Expected status codes" hint='e.g. "200-399" or "200,204,301-302"'><input value={f.expected_status} onChange={(e) => set('expected_status', e.target.value)} /></Field>
          <Field label="Check interval (seconds)" hint="Default 300 (5 minutes). Minimum 60."><input type="number" min={60} value={f.check_interval_seconds} onChange={(e) => set('check_interval_seconds', e.target.value)} /></Field>
          <Field label="Timeout (ms)"><input type="number" min={1000} value={f.timeout_ms} onChange={(e) => set('timeout_ms', e.target.value)} /></Field>
          <Field label="Max redirects"><input type="number" min={0} max={20} value={f.max_redirects} onChange={(e) => set('max_redirects', e.target.value)} /></Field>
          <Field label="Failures before incident" hint="Consecutive failed checks needed to open an incident."><input type="number" min={1} value={f.fail_threshold} onChange={(e) => set('fail_threshold', e.target.value)} /></Field>
          <Field label="Successes before recovery"><input type="number" min={1} value={f.recover_threshold} onChange={(e) => set('recover_threshold', e.target.value)} /></Field>
          <Field label="Degraded above (ms)" hint="Blank = use system default."><input type="number" min={100} value={f.degraded_threshold_ms} onChange={(e) => set('degraded_threshold_ms', e.target.value)} /></Field>
          <Field label="Form / checkout type">{sel('form_type', FORMS)}</Field>
          <Field label="GA4 property ID" hint="Numeric, e.g. 123456789"><input value={f.ga4_property_id} onChange={(e) => set('ga4_property_id', e.target.value)} /></Field>
          <Field label="Search Console property" hint="sc-domain:example.com or https://example.com/"><input value={f.gsc_property_url} onChange={(e) => set('gsc_property_url', e.target.value)} /></Field>
          <Field label="Notes" full><textarea value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
          <label className="check"><input type="checkbox" checked={f.ssl_check_enabled} onChange={(e) => set('ssl_check_enabled', e.target.checked)} /> Check SSL certificate</label>
          <label className="check"><input type="checkbox" checked={f.ssl_failure_is_outage} onChange={(e) => set('ssl_failure_is_outage', e.target.checked)} /> Treat an invalid certificate as an outage</label>
          <label className="check"><input type="checkbox" checked={f.performance_audit_enabled} onChange={(e) => set('performance_audit_enabled', e.target.checked)} /> Run PageSpeed audits</label>
        </div>
      </form>
    </Modal>
  );
}
