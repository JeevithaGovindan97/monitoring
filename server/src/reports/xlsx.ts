import ExcelJS from 'exceljs';
import { sanitizeCell } from '../security/sanitize.js';
import type { ReportData } from './data.js';

const HEAD = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FF1E3A5F' } };
const DT = 'yyyy-mm-dd hh:mm';

type Def = { header: string; key: string; width?: number; fmt?: string; map?: (r: any) => any };

function sheet(wb: ExcelJS.Workbook, name: string, cols: Def[], rows: any[]) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 16, style: c.fmt ? { numFmt: c.fmt } : {} }));
  const hr = ws.getRow(1);
  hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  hr.fill = HEAD;
  hr.alignment = { vertical: 'middle' };
  for (const r of rows) {
    const o: Record<string, any> = {};
    for (const c of cols) {
      const v = c.map ? c.map(r) : r[c.key];
      if (v instanceof Date || v === null || v === undefined) o[c.key] = v ?? null;
      else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) o[c.key] = new Date(v);
      else o[c.key] = sanitizeCell(v); // formula-injection safe
    }
    ws.addRow(o);
  }
  if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  else ws.addRow({ [cols[0]!.key]: 'No data for this period' });
  return ws;
}

const d = (v: any) => (v ? new Date(v) : null);
const nz = (v: any) => (v === null || v === undefined ? null : Number(v));

export async function renderXlsx(data: ReportData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Website Monitoring Dashboard';
  wb.created = data.generatedAt;
  const s = data.summary;

  const ex = wb.addWorksheet('Executive Summary');
  ex.columns = [{ width: 38 }, { width: 28 }, { width: 60 }];
  ex.addRow([data.title]).font = { bold: true, size: 16 };
  ex.addRow(['Period from (UTC)', data.period.from, `Display time zone setting: ${data.timezone}`]);
  ex.addRow(['Period to (UTC)', data.period.to]);
  ex.addRow(['Generated (UTC)', data.generatedAt]);
  if (data.scope.websiteName) ex.addRow(['Website', data.scope.websiteName]);
  ex.addRow([]);
  const kv: Array<[string, any, string?]> = [
    ['Websites in scope', s.websites_total], ['Online', s.online], ['Down', s.down], ['Degraded', s.degraded], ['Unknown', s.unknown], ['Not monitored', s.unmonitored],
    ['Overall uptime %', s.uptime_pct ?? 'no data', `${s.observations} valid observations; maintenance excluded`],
    ['Avg response (ms)', s.response.avg ?? 'no data'], ['p50 (ms)', s.response.p50 ?? 'no data'], ['p95 (ms)', s.response.p95 ?? 'no data'], ['p99 (ms)', s.response.p99 ?? 'no data'],
    ['Incidents in period', s.incidents_total], ['Open incidents', s.incidents_open], ['Critical incidents', s.incidents_critical], ['Total outage time (min)', Math.round(s.outage_seconds / 60)],
    ['SSL expiring ≤30 days', s.ssl_expiring_30], ['SSL invalid/expired', s.ssl_invalid],
    ['Tasks pending', s.tasks_pending], ['Tasks overdue', s.tasks_overdue], ['Tasks completed in period', s.tasks_completed],
  ];
  kv.forEach(([k, v, note]) => ex.addRow([k, v, note]));
  ex.addRow([]);
  ex.addRow(['Missing data']).font = { bold: true };
  (data.missing.length ? data.missing : ['No data gaps detected.']).forEach((m) => ex.addRow([m]));
  ex.addRow([]);
  ex.addRow(['Recommendations']).font = { bold: true };
  data.recommendations.forEach((m) => ex.addRow([sanitizeCell(m)]));
  [2, 3, 4].forEach((r) => (ex.getRow(r).getCell(2).numFmt = DT));

  if (data.inventory.length || data.sections.has('uptime')) {
    sheet(wb, 'Website Inventory', [
      { header: 'Name', key: 'name', width: 28 }, { header: 'URL', key: 'url', width: 40 }, { header: 'Hosting', key: 'hosting_type' }, { header: 'Environment', key: 'environment' },
      { header: 'Owner', key: 'owner' }, { header: 'Criticality', key: 'criticality' }, { header: 'Monitoring', key: 'monitoring_status' }, { header: 'State', key: 'effective_state' },
      { header: 'Interval (s)', key: 'check_interval_seconds', fmt: '0' }, { header: 'GA4', key: 'ga4_status' }, { header: 'Search Console', key: 'gsc_status' }, { header: 'Last check (UTC)', key: 'last_check_at', fmt: DT, width: 20 },
    ], data.websites);
  }
  if (data.sections.has('uptime')) {
    sheet(wb, 'Uptime Summary', [
      { header: 'Website', key: 'name', width: 28 }, { header: 'State', key: 'effective_state' }, { header: 'Observations', key: 'observations', fmt: '#,##0' }, { header: 'Successful', key: 'successful', fmt: '#,##0' },
      { header: 'Failed', key: 'failed', fmt: '#,##0' }, { header: 'Uptime %', key: 'uptime_pct', fmt: '0.000', map: (r) => nz(r.uptime_pct) }, { header: 'Avg response (ms)', key: 'avg_ms', fmt: '#,##0', map: (r) => nz(r.avg_ms) },
      { header: 'Outages', key: 'outages', fmt: '0' }, { header: 'Downtime (min)', key: 'downtime', fmt: '0.0', map: (r) => Math.round(r.downtime_seconds / 6) / 10 },
    ], data.websites);
  }
  if (data.sections.has('incidents')) {
    sheet(wb, 'Incidents', [
      { header: 'Website', key: 'website_name', width: 26 }, { header: 'Incident', key: 'title', width: 38 }, { header: 'Kind', key: 'kind' }, { header: 'Severity', key: 'severity' }, { header: 'Status', key: 'status' },
      { header: 'Started (UTC)', key: 'started_at', fmt: DT, width: 20, map: (r) => d(r.started_at) }, { header: 'Detected (UTC)', key: 'detected_at', fmt: DT, width: 20, map: (r) => d(r.detected_at) },
      { header: 'Acknowledged (UTC)', key: 'acknowledged_at', fmt: DT, width: 20, map: (r) => d(r.acknowledged_at) }, { header: 'Resolved (UTC)', key: 'resolved_at', fmt: DT, width: 20, map: (r) => d(r.resolved_at) },
      { header: 'Duration (min)', key: 'dur', fmt: '0.0', map: (r) => (r.duration_seconds === null ? null : Math.round(r.duration_seconds / 6) / 10) }, { header: 'Assigned to', key: 'assigned_name' },
    ], data.incidents);
  }
  if (data.sections.has('analytics')) {
    sheet(wb, 'Analytics', [
      { header: 'Website', key: 'website_name', width: 28 }, { header: 'GA4 status', key: 'ga4_status' }, { header: 'Days with data', key: 'days', fmt: '0' },
      { header: 'Active users', key: 'active_users', fmt: '#,##0', map: (r) => (r.days ? nz(r.active_users) : null) }, { header: 'Sessions', key: 'sessions', fmt: '#,##0', map: (r) => (r.days ? nz(r.sessions) : null) },
      { header: 'Page views', key: 'page_views', fmt: '#,##0', map: (r) => (r.days ? nz(r.page_views) : null) }, { header: 'Engagement rate', key: 'engagement_rate', fmt: '0.0%', map: (r) => (r.days ? nz(r.engagement_rate) : null) },
      { header: 'Key events', key: 'conversions', fmt: '#,##0', map: (r) => (r.days ? nz(r.conversions) : null) }, { header: 'Last sync (UTC)', key: 'last_sync', fmt: DT, width: 20, map: (r) => d(r.last_sync) },
    ], data.analytics);
  }
  if (data.sections.has('seo')) {
    sheet(wb, 'SEO', [
      { header: 'Website', key: 'website_name', width: 28 }, { header: 'Search Console status', key: 'gsc_status', width: 20 }, { header: 'Days with data', key: 'days', fmt: '0' },
      { header: 'Clicks', key: 'clicks', fmt: '#,##0', map: (r) => (r.days ? nz(r.clicks) : null) }, { header: 'Impressions', key: 'impressions', fmt: '#,##0', map: (r) => (r.days ? nz(r.impressions) : null) },
      { header: 'CTR', key: 'ctr', fmt: '0.00%', map: (r) => (r.days ? nz(r.ctr) : null) }, { header: 'Avg position', key: 'position', fmt: '0.0', map: (r) => (r.days ? nz(r.position) : null) },
      { header: 'Data through', key: 'data_through', width: 14, map: (r) => (r.data_through ? String(r.data_through).slice(0, 10) : null) }, { header: 'Last sync (UTC)', key: 'last_sync', fmt: DT, width: 20, map: (r) => d(r.last_sync) },
    ], data.seo);
  }
  if (data.sections.has('performance')) {
    sheet(wb, 'Performance', [
      { header: 'Website', key: 'website_name', width: 28 }, { header: 'Strategy', key: 'strategy' }, { header: 'Status', key: 'status' }, { header: 'Audited (UTC)', key: 'audited_at', fmt: DT, width: 20, map: (r) => d(r.audited_at) },
      { header: 'Performance', key: 'performance_score', fmt: '0' }, { header: 'Accessibility', key: 'accessibility_score', fmt: '0' }, { header: 'Best practices', key: 'best_practices_score', fmt: '0' }, { header: 'SEO', key: 'seo_score', fmt: '0' },
      { header: 'LCP (ms)', key: 'lcp_ms', fmt: '#,##0' }, { header: 'CLS', key: 'cls', fmt: '0.000', map: (r) => nz(r.cls) }, { header: 'INP (ms)', key: 'inp_ms', fmt: '#,##0' }, { header: 'FCP (ms)', key: 'fcp_ms', fmt: '#,##0' },
      { header: 'TTFB (ms)', key: 'ttfb_ms', fmt: '#,##0' }, { header: 'Field data available', key: 'has_field_data', map: (r) => (r.has_field_data ? 'yes' : 'no') }, { header: 'Baseline perf.', key: 'baseline_performance', fmt: '0' }, { header: 'Error', key: 'error', width: 30 },
    ], data.performance);
  }
  if (data.sections.has('ssl')) {
    sheet(wb, 'SSL', [
      { header: 'Website', key: 'website_name', width: 28 }, { header: 'Subject', key: 'subject', width: 26 }, { header: 'Issuer', key: 'issuer', width: 26 }, { header: 'Valid', key: 'valid', map: (r) => (r.valid ? 'yes' : 'no') },
      { header: 'Expires (UTC)', key: 'valid_to', fmt: DT, width: 20, map: (r) => d(r.valid_to) }, { header: 'Days remaining', key: 'days_remaining', fmt: '0' },
      { header: 'Checked (UTC)', key: 'checked_at', fmt: DT, width: 20, map: (r) => d(r.checked_at) }, { header: 'Error', key: 'error', width: 34 },
    ], data.ssl);
  }
  if (data.sections.has('forms')) {
    sheet(wb, 'Forms & Checkout', [
      { header: 'Website', key: 'website_name', width: 26 }, { header: 'Label', key: 'label', width: 22 }, { header: 'Type', key: 'type' }, { header: 'URL', key: 'url', width: 40 }, { header: 'State', key: 'state' },
      { header: 'Last HTTP', key: 'last_status_code', fmt: '0' }, { header: 'Last response (ms)', key: 'last_response_ms', fmt: '#,##0' }, { header: 'Checks in period', key: 'checks', fmt: '0' }, { header: 'Failures in period', key: 'failures', fmt: '0' },
      { header: 'Last check (UTC)', key: 'last_check_at', fmt: DT, width: 20, map: (r) => d(r.last_check_at) }, { header: 'Last error', key: 'last_error', width: 34 },
    ], data.forms);
  }
  if (data.sections.has('tasks')) {
    sheet(wb, 'Tasks', [
      { header: 'Task', key: 'title', width: 40 }, { header: 'Website', key: 'website_name', width: 24 }, { header: 'Assignee', key: 'assigned_name' }, { header: 'Priority', key: 'priority' }, { header: 'Status', key: 'status' },
      { header: 'Due (UTC)', key: 'due_at', fmt: DT, width: 20, map: (r) => d(r.due_at) }, { header: 'Overdue', key: 'overdue', map: (r) => (r.overdue ? 'yes' : 'no') },
      { header: 'Created (UTC)', key: 'created_at', fmt: DT, width: 20, map: (r) => d(r.created_at) }, { header: 'Completed (UTC)', key: 'completed_at', fmt: DT, width: 20, map: (r) => d(r.completed_at) },
    ], data.tasks);
  }
  sheet(wb, 'Integration Status', [
    { header: 'Integration', key: 'kind', width: 18 }, { header: 'Status', key: 'status' }, { header: 'Enabled', key: 'enabled', map: (r) => (r.enabled ? 'yes' : 'no') },
    { header: 'Last success (UTC)', key: 'last_success_at', fmt: DT, width: 20, map: (r) => d(r.last_success_at) }, { header: 'Last error', key: 'last_error', width: 50 }, { header: 'Last error at (UTC)', key: 'last_error_at', fmt: DT, width: 20, map: (r) => d(r.last_error_at) },
  ], data.integrations);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
