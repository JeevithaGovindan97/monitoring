import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { query } from '../db.js';
import { sanitizeCell, toCsv } from '../security/sanitize.js';
import { createWebsiteSchema, CRITICALITY, ENVIRONMENTS, FORM_TYPES, HOSTING, MON_STATUS, normalizeUrl, type CreateWebsite } from './website-schema.js';

/** Columns of the import template, in order. */
export const TEMPLATE_COLUMNS = [
  { key: 'name', header: 'Name', required: true, width: 28 },
  { key: 'url', header: 'URL', required: true, width: 40 },
  { key: 'hosting_type', header: 'Hosting type', width: 16 },
  { key: 'environment', header: 'Environment', width: 14 },
  { key: 'owner', header: 'Owner', width: 20 },
  { key: 'criticality', header: 'Criticality', width: 13 },
  { key: 'monitoring_status', header: 'Monitoring status', width: 18 },
  { key: 'expected_status', header: 'Expected status', width: 16 },
  { key: 'check_interval_seconds', header: 'Check interval (s)', width: 18 },
  { key: 'timeout_ms', header: 'Timeout (ms)', width: 14 },
  { key: 'health_check_url', header: 'Health check URL', width: 36 },
  { key: 'analytics_access', header: 'Analytics access', width: 18 },
  { key: 'ga4_property_id', header: 'GA4 property ID', width: 18 },
  { key: 'gsc_property_url', header: 'Search Console property', width: 30 },
  { key: 'form_type', header: 'Form type', width: 13 },
  { key: 'form_url', header: 'Form / checkout page URL', width: 36 },
  { key: 'notes', header: 'Notes', width: 40 },
] as const;

export const ANALYTICS_ACCESS = ['yes', 'partial', 'no', 'not applicable'] as const;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const HEADER_ALIASES: Record<string, string> = Object.fromEntries([
  ...TEMPLATE_COLUMNS.flatMap((c) => [[norm(c.header), c.key], [norm(c.key), c.key]]),
  [norm('Website'), 'name'], [norm('Site name'), 'name'], [norm('Domain'), 'url'], [norm('Interval'), 'check_interval_seconds'],
  [norm('Check interval'), 'check_interval_seconds'], [norm('Timeout'), 'timeout_ms'], [norm('Hosting'), 'hosting_type'],
  [norm('Status'), 'monitoring_status'], [norm('GA4'), 'ga4_property_id'], [norm('Search Console'), 'gsc_property_url'],
  [norm('Form URL'), 'form_url'], [norm('Checkout URL'), 'form_url'],
]);

export interface ParsedRow {
  row: number; // 1-based spreadsheet row number (header is row 1)
  raw: Record<string, string>;
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if ('text' in v && typeof (v as any).text === 'string') return (v as any).text.trim();
    if ('result' in v) return String((v as any).result ?? '').trim();
    if ('richText' in v) return (v as any).richText.map((r: any) => r.text).join('').trim();
    if (v instanceof Date) return v.toISOString();
    if ('hyperlink' in v) return String((v as any).hyperlink);
  }
  return String(v).trim();
}

export async function parseInventoryFile(buf: Buffer, filename: string): Promise<{ rows: ParsedRow[]; unknownHeaders: string[] }> {
  const lower = filename.toLowerCase();
  let grid: string[][];
  if (lower.endsWith('.xlsx')) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as any);
    const ws = wb.getWorksheet('Inventory') ?? wb.worksheets.find((s) => s.name.toLowerCase() !== 'instructions' && s.name !== 'Lists') ?? wb.worksheets[0];
    if (!ws) throw new Error('The workbook has no worksheets');
    grid = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const arr: string[] = [];
      for (let i = 1; i <= ws.columnCount; i++) arr.push(cellText(row.getCell(i).value));
      grid[row.number - 1] = arr;
    });
    grid = Array.from(grid, (r) => r ?? []);
  } else if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    const text = buf.toString('utf8').replace(/^\uFEFF/, '');
    grid = parse(text, { skip_empty_lines: false, relax_column_count: true, bom: true }) as string[][];
  } else {
    throw new Error('Unsupported file type. Upload a .csv or .xlsx file.');
  }
  if (!grid.length) throw new Error('The file is empty');
  const headerRow = grid[0]!.map((h) => String(h ?? '').trim());
  const keys = headerRow.map((h) => HEADER_ALIASES[norm(h)]);
  const unknownHeaders = headerRow.filter((h, i) => h && !keys[i]);
  if (!keys.includes('name') || !keys.includes('url')) throw new Error('The file must contain "Name" and "URL" columns');
  const rows: ParsedRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const line = grid[r] ?? [];
    const raw: Record<string, string> = {};
    keys.forEach((k, i) => {
      if (k) raw[k] = String(line[i] ?? '').trim();
    });
    if (Object.values(raw).every((v) => v === '')) continue; // blank template rows
    rows.push({ row: r + 1, raw });
  }
  if (rows.length > 5000) throw new Error('Too many rows (limit 5000 per import)');
  return { rows, unknownHeaders };
}

const lowerOrUndef = (v?: string) => (v ? v.trim().toLowerCase() : undefined);
function pick<T extends string>(v: string | undefined, allowed: readonly T[], label: string, errors: string[]): T | undefined {
  const l = lowerOrUndef(v);
  if (!l) return undefined;
  const m = allowed.find((a) => a === l);
  if (!m) errors.push(`${label}: "${v}" is not one of ${allowed.join(', ')}`);
  return m;
}
function num(v: string | undefined, label: string, errors: string[]) {
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) errors.push(`${label}: "${v}" is not a number`);
  return n;
}

export interface RowResult {
  row: number;
  name: string;
  url: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
  duplicateOf?: 'database' | 'file';
  data?: CreateWebsite;
  formUrl?: string;
}

export async function validateRows(rows: ParsedRow[]): Promise<RowResult[]> {
  const existing = new Set(
    (await query<{ url_normalized: string }>("SELECT url_normalized FROM websites WHERE monitoring_status <> 'archived'")).map((r) => r.url_normalized),
  );
  const seen = new Map<string, number>();
  const out: RowResult[] = [];
  for (const { row, raw } of rows) {
    const errors: string[] = [];
    const warnings: string[] = [];
    const candidate: Record<string, unknown> = {
      name: raw.name,
      url: raw.url,
      owner: raw.owner || null,
      notes: raw.notes || null,
      health_check_url: raw.health_check_url || null,
      expected_status: raw.expected_status || undefined,
      ga4_property_id: raw.ga4_property_id || null,
      gsc_property_url: raw.gsc_property_url || null,
    };
    const set = (k: string, v: unknown) => v !== undefined && (candidate[k] = v);
    set('hosting_type', pick(raw.hosting_type, HOSTING, 'Hosting type', errors));
    set('environment', pick(raw.environment, ENVIRONMENTS, 'Environment', errors));
    set('criticality', pick(raw.criticality, CRITICALITY, 'Criticality', errors));
    set('monitoring_status', pick(raw.monitoring_status, MON_STATUS, 'Monitoring status', errors));
    set('form_type', pick(raw.form_type, FORM_TYPES, 'Form type', errors));
    set('check_interval_seconds', num(raw.check_interval_seconds, 'Check interval', errors));
    set('timeout_ms', num(raw.timeout_ms, 'Timeout', errors));

    const access = pick(raw.analytics_access, ANALYTICS_ACCESS, 'Analytics access', errors);
    if (access === 'not applicable') {
      candidate.ga4_status = 'not_applicable';
      candidate.gsc_status = 'not_applicable';
    } else if (access === 'no') {
      if (raw.ga4_property_id || raw.gsc_property_url) warnings.push('Analytics access is "no" but a property is set; it will show "Access required"');
    }

    const parsed = createWebsiteSchema.safeParse(candidate);
    let duplicateOf: RowResult['duplicateOf'];
    if (!parsed.success) {
      for (const i of parsed.error.issues) errors.push(`${i.path.join('.') || 'row'}: ${i.message}`);
    } else {
      const n = normalizeUrl(parsed.data.url);
      if (existing.has(n)) {
        duplicateOf = 'database';
        errors.push('Duplicate: a website with this URL already exists');
      } else if (seen.has(n)) {
        duplicateOf = 'file';
        errors.push(`Duplicate: same URL as row ${seen.get(n)} of this file`);
      } else seen.set(n, row);
    }
    let formUrl: string | undefined;
    if (raw.form_url) {
      const f = z.string().url().safeParse(raw.form_url);
      if (!f.success || !/^https?:/i.test(raw.form_url)) errors.push('Form / checkout page URL: must be an http(s) URL');
      else formUrl = raw.form_url;
    }
    if (formUrl && (!parsed.success || parsed.data.form_type === 'none')) warnings.push('A form URL was given without a form type; it will be saved as type "other"');
    out.push({ row, name: raw.name ?? '', url: raw.url ?? '', ok: errors.length === 0, errors, warnings, duplicateOf, data: parsed.success ? parsed.data : undefined, formUrl });
  }
  return out;
}

// ----------------------------------------------------------------- export

const EXPORT_HEADERS = TEMPLATE_COLUMNS.map((c) => c.header);

function exportRow(w: any, formUrl: string | null): unknown[] {
  const access =
    w.ga4_status === 'not_applicable' && w.gsc_status === 'not_applicable' ? 'not applicable'
    : w.ga4_status === 'connected' && w.gsc_status === 'connected' ? 'yes'
    : w.ga4_status === 'connected' || w.gsc_status === 'connected' ? 'partial'
    : 'no';
  return [
    w.name, w.url, w.hosting_type, w.environment, w.owner, w.criticality, w.monitoring_status, w.expected_status,
    w.check_interval_seconds, w.timeout_ms, w.health_check_url, access, w.ga4_property_id, w.gsc_property_url,
    w.form_type, formUrl, w.notes,
  ];
}

async function exportData() {
  const sites = await query(
    `SELECT w.*, (SELECT url FROM form_checks f WHERE f.website_id = w.id ORDER BY created_at LIMIT 1) AS form_url
       FROM websites w ORDER BY lower(w.name)`,
  );
  return sites.map((w) => exportRow(w, w.form_url));
}

export async function exportCsv() {
  return toCsv(EXPORT_HEADERS, await exportData());
}

export async function exportXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Inventory', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = TEMPLATE_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  for (const r of await exportData()) ws.addRow(r.map((v) => sanitizeCell(v as any)));
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: TEMPLATE_COLUMNS.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Blank 27-row template with instructions and dropdown validations. */
export async function buildTemplate(rowsCount = 27): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const info = wb.addWorksheet('Instructions');
  info.columns = [{ width: 110 }];
  [
    'Website inventory import template',
    '',
    '1. Fill one website per row on the "Inventory" sheet. Only Name and URL are required; everything else has a safe default.',
    '2. URL must start with http:// or https://. Internal / private addresses (localhost, 10.x, 192.168.x ...) are rejected.',
    '3. Dropdown columns (hosting type, environment, criticality, monitoring status, analytics access, form type) only accept the listed values.',
    '4. Expected status: status codes or ranges, e.g. 200-399 (default) or 200,204,301-302.',
    '5. Check interval is in seconds (minimum 60, default 300 = 5 minutes). Timeout is in milliseconds (default 10000).',
    '6. Analytics access: "no" / "not applicable" is fine. Websites without analytics access are still monitored for uptime.',
    '7. GA4 property ID is the numeric ID only (e.g. 123456789). Search Console property is "sc-domain:example.com" or a full URL.',
    '8. Leave unused rows blank. Upload the file under Inventory > Import; you will see a row-by-row preview before anything is saved.',
    '9. Values that start with = + - @ are treated as text on export to prevent spreadsheet formula injection.',
  ].forEach((t, i) => {
    const r = info.addRow([t]);
    if (i === 0) r.font = { bold: true, size: 14 };
    r.alignment = { wrapText: true, vertical: 'top' };
  });

  const lists = wb.addWorksheet('Lists', { state: 'hidden' });
  const listDefs: Record<string, readonly string[]> = {
    hosting_type: HOSTING, environment: ENVIRONMENTS, criticality: CRITICALITY, monitoring_status: MON_STATUS,
    analytics_access: ANALYTICS_ACCESS, form_type: FORM_TYPES,
  };
  const listCols: Record<string, string> = {};
  Object.entries(listDefs).forEach(([k, vals], i) => {
    const col = String.fromCharCode(65 + i);
    listCols[k] = `Lists!$${col}$1:$${col}$${vals.length}`;
    vals.forEach((v, j) => (lists.getCell(`${col}${j + 1}`).value = v));
  });

  const ws = wb.addWorksheet('Inventory', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = TEMPLATE_COLUMNS.map((c) => ({ header: c.header + ('required' in c && c.required ? ' *' : ''), key: c.key, width: c.width }));
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  for (let r = 2; r <= rowsCount + 1; r++) {
    TEMPLATE_COLUMNS.forEach((c, i) => {
      const cell = ws.getCell(r, i + 1);
      if (listCols[c.key]) {
        cell.dataValidation = { type: 'list', allowBlank: true, formulae: [listCols[c.key]!], showErrorMessage: true, errorTitle: 'Invalid value', error: 'Pick a value from the list' };
      } else if (c.key === 'check_interval_seconds') {
        cell.dataValidation = { type: 'whole', operator: 'between', formulae: [60, 86400], allowBlank: true, showErrorMessage: true, error: 'Whole number of seconds between 60 and 86400' };
      } else if (c.key === 'timeout_ms') {
        cell.dataValidation = { type: 'whole', operator: 'between', formulae: [1000, 60000], allowBlank: true, showErrorMessage: true, error: 'Whole number of milliseconds between 1000 and 60000' };
      }
      if (c.key === 'ga4_property_id') cell.numFmt = '@';
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
