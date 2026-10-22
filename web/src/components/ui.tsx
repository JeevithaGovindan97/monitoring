import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { RANGES, type RangeKey } from '../lib/hooks';
import { title } from '../lib/format';

export function Tip({ text }: { text: string }) {
  return <span className="tip" tabIndex={0} role="img" aria-label={text} data-tip={text}>?</span>;
}

export function Badge({ kind, children }: { kind: string; children?: ReactNode }) {
  return <span className={`badge ${kind}`}>{children ?? title(kind)}</span>;
}
const STATE_LABEL: Record<string, string> = { up: 'Online', down: 'Down', degraded: 'Degraded', unknown: 'Unknown', unmonitored: 'Not monitored' };
export const StateBadge = ({ state }: { state: string }) => <Badge kind={state}>{STATE_LABEL[state] ?? title(state)}</Badge>;
const INT_LABEL: Record<string, string> = { connected: 'Connected', access_required: 'Access required', not_connected: 'Not connected', error: 'Error', not_applicable: 'Not applicable' };
export const IntegrationBadge = ({ status }: { status: string }) => <Badge kind={status === 'not_connected' || status === 'not_applicable' ? 'plain' : status}>{INT_LABEL[status] ?? title(status)}</Badge>;

export function PageHeader({ title: t, sub, crumbs, actions }: { title: string; sub?: ReactNode; crumbs?: Array<{ label: string; to?: string }>; actions?: ReactNode }) {
  useEffect(() => { document.title = `${t} · Website Monitoring`; }, [t]);
  return (
    <div className="page-head">
      <div>
        {crumbs && (
          <nav className="crumbs" aria-label="Breadcrumb">
            {crumbs.map((c, i) => (
              <span key={i}>{c.to ? <Link to={c.to}>{c.label}</Link> : <span aria-current="page">{c.label}</span>}{i < crumbs.length - 1 ? ' /' : ''}</span>
            ))}
          </nav>
        )}
        <h1>{t}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Card({ title: t, actions, children, pad = true, tip }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; pad?: boolean; tip?: string }) {
  return (
    <section className="card">
      {(t || actions) && <div className="card-h"><h2>{t} {tip && <Tip text={tip} />}</h2><div className="row">{actions}</div></div>}
      <div className={pad ? 'card-b' : undefined}>{children}</div>
    </section>
  );
}

export function Kpi({ label, value, note, to, tone, tip }: { label: string; value: ReactNode; note?: ReactNode; to?: string; tone?: 'up' | 'down' | 'warn'; tip?: string }) {
  const inner = (
    <>
      <div className="label">{label} {tip && <Tip text={tip} />}</div>
      <div className="value">{value}</div>
      <div className="note">{note}</div>
    </>
  );
  return to ? <Link className={`kpi ${tone ?? ''}`} to={to}>{inner}</Link> : <div className={`kpi ${tone ?? ''}`}>{inner}</div>;
}

export function Skeleton({ h = 16, w = '100%' }: { h?: number; w?: number | string }) {
  return <div className="skeleton" style={{ height: h, width: w }} aria-hidden />;
}
export function LoadingBlock({ rows = 4 }: { rows?: number }) {
  return <div className="col" role="status" aria-label="Loading">{Array.from({ length: rows }, (_, i) => <Skeleton key={i} h={18} w={`${90 - i * 8}%`} />)}</div>;
}
export function Empty({ title: t, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty"><h3>{t}</h3>{children && <p>{children}</p>}{action}</div>;
}
export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = error instanceof ApiError ? error.message : (error as Error)?.message ?? 'Something went wrong';
  return <div className="alert err" role="alert">{msg}{retry && <> · <button className="btn sm" onClick={retry}>Retry</button></>}</div>;
}
export function Async({ q, children, skeleton }: { q: { isLoading: boolean; error: unknown; data: any; refetch: () => void }; children: (d: any) => ReactNode; skeleton?: ReactNode }) {
  if (q.isLoading) return <>{skeleton ?? <LoadingBlock />}</>;
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />;
  return <>{children(q.data)}</>;
}

export function Modal({ title: t, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input,select,textarea,button')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus(); };
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={t} ref={ref}>
        <div className="modal-h"><h2>{t}</h2><button className="btn ghost sm" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="modal-b">{children}</div>
        {footer && <div className="modal-f">{footer}</div>}
      </div>
    </div>
  );
}

export function Confirm({ title: t, message, confirmLabel = 'Confirm', danger, busy, onConfirm, onCancel }: { title: string; message: ReactNode; confirmLabel?: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Modal title={t} onClose={onCancel} footer={<><button className="btn" onClick={onCancel}>Cancel</button><button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm} disabled={busy}>{busy ? 'Working…' : confirmLabel}</button></>}>
      {message}
    </Modal>
  );
}

export function Tabs({ tabs, value, onChange }: { tabs: Array<{ key: string; label: string }>; value: string; onChange: (k: string) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => <button key={t.key} role="tab" aria-selected={value === t.key} className="tab" onClick={() => onChange(t.key)}>{t.label}</button>)}
    </div>
  );
}

export function RangeSelect({ value, onChange }: { value: RangeKey; onChange: (v: RangeKey) => void }) {
  return (
    <label className="row" style={{ gap: 6 }}>
      <span className="sr-only">Date range</span>
      <select aria-label="Date range" value={value} onChange={(e) => onChange(e.target.value as RangeKey)} style={{ width: 'auto' }}>
        {RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
      </select>
    </label>
  );
}

export function Pager({ page, totalPages, total, onPage, pageSize }: { page: number; totalPages: number; total: number; onPage: (p: number) => void; pageSize: number }) {
  const from = total ? (page - 1) * pageSize + 1 : 0;
  return (
    <div className="pager">
      <span>{from}–{Math.min(total, page * pageSize)} of {total.toLocaleString('en-GB')}</span>
      <span className="row">
        <button className="btn sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
        <span>Page {page} / {totalPages}</span>
        <button className="btn sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>Next</button>
      </span>
    </div>
  );
}

export function Field({ label, hint, children, full }: { label: string; hint?: string; children: ReactNode; full?: boolean }) {
  return <label className={`field ${full ? 'full' : ''}`}>{label}{children}{hint && <span className="hint">{hint}</span>}</label>;
}

export function useDebounced<T>(v: T, ms = 300) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

export function Toasts({ items }: { items: Array<{ id: number; kind: 'ok' | 'err'; text: string }> }) {
  return (
    <div aria-live="polite" style={{ position: 'fixed', right: 16, bottom: 16, display: 'flex', flexDirection: 'column', gap: 8, zIndex: 200 }}>
      {items.map((t) => <div key={t.id} className={`alert ${t.kind}`} style={{ margin: 0, boxShadow: '0 6px 20px rgba(0,0,0,.25)' }}>{t.text}</div>)}
    </div>
  );
}
