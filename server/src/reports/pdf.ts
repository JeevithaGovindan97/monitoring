import PDFDocument from 'pdfkit';
import type { ReportData } from './data.js';

const C = { ink: '#1a2433', muted: '#5b6b7f', line: '#d8dee6', head: '#1e3a5f', headText: '#ffffff', ok: '#16794c', bad: '#b42318', warn: '#a15c07', zebra: '#f5f7fa' };

function fmt(d: Date | string | null | undefined, tz: string) {
  if (!d) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(d));
  } catch {
    return new Date(d).toISOString();
  }
}
const dur = (s: number | null | undefined) => (s === null || s === undefined ? '—' : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
const pctS = (v: number | null | undefined) => (v === null || v === undefined ? 'no data' : `${v.toFixed(2)}%`);
const n = (v: any) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-GB'));

type Col = { header: string; w: number; get: (r: any) => string; align?: 'left' | 'right'; color?: (r: any) => string | undefined };

export function renderPdf(data: ReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: data.title, Author: 'Website Monitoring Dashboard' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const tz = data.timezone;
    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom - 10;
    const ensure = (h: number) => { if (doc.y + h > bottom()) doc.addPage(); };

    const h1 = (t: string) => { ensure(40); doc.moveDown(0.8).font('Helvetica-Bold').fontSize(13).fillColor(C.head).text(t, left, doc.y); doc.moveTo(left, doc.y + 2).lineTo(left + width, doc.y + 2).strokeColor(C.line).stroke(); doc.moveDown(0.5); };
    const para = (t: string, opts: { color?: string; size?: number; bold?: boolean } = {}) => { ensure(18); doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size ?? 9.5).fillColor(opts.color ?? C.ink).text(t, left, doc.y, { width }); };
    const bullet = (t: string) => { ensure(16); doc.font('Helvetica').fontSize(9.5).fillColor(C.ink).text(`•  ${t}`, left + 6, doc.y, { width: width - 6 }); };

    function table(cols: Col[], rows: any[], empty: string) {
      if (!rows.length) { para(empty, { color: C.muted }); return; }
      const total = cols.reduce((a, c) => a + c.w, 0);
      const scale = width / total;
      const widths = cols.map((c) => c.w * scale);
      const header = () => {
        ensure(30);
        const y = doc.y;
        doc.rect(left, y, width, 16).fill(C.head);
        let x = left;
        cols.forEach((c, i) => { doc.font('Helvetica-Bold').fontSize(8).fillColor(C.headText).text(c.header, x + 3, y + 4, { width: widths[i]! - 6, align: c.align ?? 'left', lineBreak: false }); x += widths[i]!; });
        doc.y = y + 18;
      };
      header();
      rows.forEach((r, ri) => {
        const cells = cols.map((c) => c.get(r));
        doc.font('Helvetica').fontSize(8);
        const h = Math.max(13, ...cells.map((t, i) => doc.heightOfString(t, { width: widths[i]! - 6 }) + 5));
        if (doc.y + h > bottom()) { doc.addPage(); header(); }
        const y = doc.y;
        if (ri % 2) doc.rect(left, y, width, h).fill(C.zebra);
        let x = left;
        cells.forEach((t, i) => { doc.font('Helvetica').fontSize(8).fillColor(cols[i]!.color?.(r) ?? C.ink).text(t, x + 3, y + 3, { width: widths[i]! - 6, align: cols[i]!.align ?? 'left' }); x += widths[i]!; });
        doc.y = y + h;
      });
      doc.moveDown(0.3);
    }

    // ---- title block
    doc.font('Helvetica-Bold').fontSize(20).fillColor(C.head).text(data.title, left, 40);
    if (data.scope.websiteName) doc.font('Helvetica-Bold').fontSize(12).fillColor(C.ink).text(data.scope.websiteName);
    doc.font('Helvetica').fontSize(9.5).fillColor(C.muted)
      .text(`Reporting period: ${fmt(data.period.from, tz)} – ${fmt(data.period.to, tz)}  (${tz})`)
      .text(`Generated: ${fmt(data.generatedAt, tz)}   ·   Scope: ${data.scope.websiteCount} website(s)`);

    const s = data.summary;
    h1('Executive summary');
    para(`Of ${s.websites_total} monitored website(s): ${s.online} online, ${s.down} down, ${s.degraded} degraded, ${s.unknown} unknown${s.unmonitored ? `, ${s.unmonitored} not monitored` : ''}.`);
    if (data.sections.has('uptime')) {
      para(`Overall uptime for the period: ${pctS(s.uptime_pct)} (${n(s.observations)} valid check observations; maintenance windows excluded; sites without observations are not counted).`);
      para(`Response time: avg ${n(s.response.avg)} ms · p50 ${n(s.response.p50)} ms · p95 ${n(s.response.p95)} ms · p99 ${n(s.response.p99)} ms.`);
      para(`Incidents: ${s.incidents_total} in period (${s.incidents_open} open, ${s.incidents_critical} critical); total outage time ${dur(s.outage_seconds)}.`);
    }
    if (data.sections.has('ssl')) para(`SSL: ${s.ssl_expiring_30} certificate(s) expiring within 30 days, ${s.ssl_invalid} invalid/expired.`);
    if (data.sections.has('tasks')) para(`Tasks: ${s.tasks_pending} pending (${s.tasks_overdue} overdue), ${s.tasks_completed} completed in period.`);

    if (data.sections.has('uptime')) {
      h1('Uptime & response time by website');
      table([
        { header: 'Website', w: 34, get: (r) => r.name },
        { header: 'Crit.', w: 11, get: (r) => r.criticality },
        { header: 'State', w: 12, get: (r) => r.effective_state, color: (r) => (r.effective_state === 'down' ? C.bad : r.effective_state === 'up' ? C.ok : C.warn) },
        { header: 'Uptime', w: 13, align: 'right', get: (r) => pctS(r.uptime_pct), color: (r) => (r.uptime_pct !== null && r.uptime_pct < 99 ? C.bad : undefined) },
        { header: 'Checks', w: 11, align: 'right', get: (r) => n(r.observations) },
        { header: 'Avg ms', w: 11, align: 'right', get: (r) => n(r.avg_ms) },
        { header: 'Outages', w: 10, align: 'right', get: (r) => n(r.outages) },
        { header: 'Downtime', w: 14, align: 'right', get: (r) => dur(r.downtime_seconds) },
      ], data.websites, 'No websites in scope.');
    }
    if (data.sections.has('incidents')) {
      h1('Incidents');
      table([
        { header: 'Website', w: 24, get: (r) => r.website_name },
        { header: 'Incident', w: 30, get: (r) => r.title },
        { header: 'Sev.', w: 10, get: (r) => r.severity },
        { header: 'Status', w: 12, get: (r) => r.status },
        { header: 'Started', w: 20, get: (r) => fmt(r.started_at, tz) },
        { header: 'Duration', w: 12, align: 'right', get: (r) => dur(r.duration_seconds) },
      ], data.incidents, 'No incidents in this period.');
    }
    if (data.sections.has('ssl')) {
      h1('SSL certificates');
      table([
        { header: 'Website', w: 28, get: (r) => r.website_name },
        { header: 'Issuer', w: 24, get: (r) => r.issuer ?? '—' },
        { header: 'Expires', w: 18, get: (r) => fmt(r.valid_to, tz) },
        { header: 'Days', w: 8, align: 'right', get: (r) => n(r.days_remaining), color: (r) => (!r.valid || r.days_remaining <= 14 ? C.bad : r.days_remaining <= 30 ? C.warn : undefined) },
        { header: 'Status', w: 22, get: (r) => (r.valid ? 'valid' : r.error ?? 'invalid') },
      ], data.ssl, 'No SSL checks recorded yet.');
    }
    if (data.sections.has('analytics')) {
      h1('Traffic (Google Analytics 4)');
      table([
        { header: 'Website', w: 30, get: (r) => r.website_name },
        { header: 'Status', w: 16, get: (r) => r.ga4_status.replace('_', ' ') },
        { header: 'Users', w: 12, align: 'right', get: (r) => (r.days ? n(r.active_users) : 'n/a') },
        { header: 'Sessions', w: 12, align: 'right', get: (r) => (r.days ? n(r.sessions) : 'n/a') },
        { header: 'Views', w: 12, align: 'right', get: (r) => (r.days ? n(r.page_views) : 'n/a') },
        { header: 'Eng. rate', w: 12, align: 'right', get: (r) => (r.days && r.engagement_rate !== null ? `${(Number(r.engagement_rate) * 100).toFixed(1)}%` : 'n/a') },
      ], data.analytics, '');
      para('"n/a" means no analytics data is stored (not connected, access required or not yet synced) — it does not mean zero visits.', { color: C.muted, size: 8.5 });
    }
    if (data.sections.has('seo')) {
      h1('Organic search (Google Search Console)');
      table([
        { header: 'Website', w: 30, get: (r) => r.website_name },
        { header: 'Status', w: 16, get: (r) => r.gsc_status.replace('_', ' ') },
        { header: 'Clicks', w: 11, align: 'right', get: (r) => (r.days ? n(r.clicks) : 'n/a') },
        { header: 'Impr.', w: 12, align: 'right', get: (r) => (r.days ? n(r.impressions) : 'n/a') },
        { header: 'CTR', w: 9, align: 'right', get: (r) => (r.days && r.ctr !== null ? `${(Number(r.ctr) * 100).toFixed(1)}%` : 'n/a') },
        { header: 'Avg pos.', w: 11, align: 'right', get: (r) => (r.days && r.position !== null ? Number(r.position).toFixed(1) : 'n/a') },
        { header: 'Data through', w: 14, get: (r) => (r.data_through ? String(r.data_through).slice(0, 10) : 'n/a') },
      ], data.seo, '');
      para('Search Console data is not real-time and typically lags by 2-3 days.', { color: C.muted, size: 8.5 });
    }
    if (data.sections.has('performance')) {
      h1('Performance audits (mobile)');
      table([
        { header: 'Website', w: 26, get: (r) => r.website_name },
        { header: 'Perf.', w: 8, align: 'right', get: (r) => (r.status === 'ok' ? n(r.performance_score) : 'err') },
        { header: 'A11y', w: 8, align: 'right', get: (r) => n(r.accessibility_score) },
        { header: 'BP', w: 7, align: 'right', get: (r) => n(r.best_practices_score) },
        { header: 'SEO', w: 7, align: 'right', get: (r) => n(r.seo_score) },
        { header: 'LCP ms', w: 10, align: 'right', get: (r) => n(r.lcp_ms) },
        { header: 'CLS', w: 8, align: 'right', get: (r) => (r.cls === null || r.cls === undefined ? '—' : Number(r.cls).toFixed(3)) },
        { header: 'Field data', w: 11, get: (r) => (r.has_field_data ? 'yes' : 'none') },
        { header: 'Audited', w: 18, get: (r) => fmt(r.audited_at, tz) },
      ], data.performance, 'No performance audits stored yet.');
      para('Scores are Lighthouse lab data. "Field data: none" means Google reported no real-user (CrUX) data for the page.', { color: C.muted, size: 8.5 });
    }
    if (data.sections.has('forms')) {
      h1('Forms & checkout page checks');
      table([
        { header: 'Website', w: 22, get: (r) => r.website_name },
        { header: 'Page', w: 22, get: (r) => `${r.label} (${r.type})` },
        { header: 'State', w: 10, get: (r) => r.state },
        { header: 'HTTP', w: 8, align: 'right', get: (r) => n(r.last_status_code) },
        { header: 'Checks', w: 9, align: 'right', get: (r) => n(r.checks) },
        { header: 'Failures', w: 9, align: 'right', get: (r) => n(r.failures), color: (r) => (r.failures ? C.bad : undefined) },
        { header: 'Last check', w: 18, get: (r) => fmt(r.last_check_at, tz) },
      ], data.forms, 'No form/checkout page checks configured.');
    }
    if (data.sections.has('tasks')) {
      h1('Tasks');
      table([
        { header: 'Task', w: 34, get: (r) => r.title },
        { header: 'Website', w: 18, get: (r) => r.website_name ?? '—' },
        { header: 'Assignee', w: 14, get: (r) => r.assigned_name ?? 'unassigned' },
        { header: 'Priority', w: 9, get: (r) => r.priority },
        { header: 'Status', w: 11, get: (r) => r.status },
        { header: 'Due', w: 16, get: (r) => fmt(r.due_at, tz), color: (r) => (r.overdue ? C.bad : undefined) },
      ], data.tasks, 'No tasks.');
    }
    if (data.sections.has('integrations')) {
      h1('Integration status');
      table([
        { header: 'Integration', w: 16, get: (r) => r.kind },
        { header: 'Status', w: 14, get: (r) => r.status },
        { header: 'Last success', w: 20, get: (r) => fmt(r.last_success_at, tz) },
        { header: 'Last error', w: 40, get: (r) => r.last_error ?? '—' },
      ], data.integrations, '');
    }
    h1('Missing data');
    if (data.missing.length) data.missing.forEach(bullet); else para('No data gaps detected.', { color: C.muted });
    h1('Recommendations');
    data.recommendations.forEach(bullet);

    // footer with page numbers
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const prev = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(8).fillColor(C.muted).text(`${data.title} · generated ${fmt(data.generatedAt, tz)} · page ${i + 1} of ${range.count}`, left, doc.page.height - 28, { width, align: 'center', lineBreak: false });
      doc.page.margins.bottom = prev;
    }
    doc.end();
  });
}
