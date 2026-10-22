import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db.js';
import { get, login, makeSite, resetDb } from './helpers.js';

beforeEach(resetDb);

const CSV = [
  'Name,URL,Hosting type,Environment,Owner,Criticality,Analytics access,GA4 property ID,Form type,Form / checkout page URL',
  'Alpha,https://alpha.example.com,dokploy,production,Ana,critical,yes,123456789,checkout,https://alpha.example.com/checkout',
  'Beta,https://beta.example.com,vps,production,Bo,high,no,,none,',
  'Bad URL,ftp://beta2.example.com,vps,,,,,,,',
  'Private,http://192.168.0.10,vps,,,,,,,',
  'Bad enum,https://gamma.example.com,mainframe,,,,,,,',
  'Dup in file,https://beta.example.com,vps,,,,,,,',
  ',,,,,,,,,',
].join('\n');

const upload = (s: Awaited<ReturnType<typeof login>>, q: string, buf: Buffer, name: string) =>
  s.agent.post(`/api/v1/websites/import${q}`).set('X-CSRF-Token', s.csrf).attach('file', buf, name);

describe('inventory import', () => {
  it('previews rows with row-level errors and duplicate detection without saving anything', async () => {
    const a = await login('admin');
    await makeSite({ url: 'https://alpha.example.com', name: 'Existing' });
    const res = await upload(a, '?mode=preview', Buffer.from(CSV), 'sites.csv');
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ totalRows: 6, valid: 1, invalid: 5 });
    const byName = Object.fromEntries(res.body.rows.map((r: any) => [r.name, r]));
    expect(byName['Alpha'].duplicateOf).toBe('database');
    expect(byName['Beta'].ok).toBe(true);
    expect(byName['Bad URL'].errors.join()).toMatch(/scheme/i);
    expect(byName['Private'].errors.join()).toMatch(/private|reserved/i);
    expect(byName['Bad enum'].errors.join()).toMatch(/Hosting type/);
    expect(byName['Dup in file'].duplicateOf).toBe('file');
    expect(byName['Dup in file'].row).toBe(7);
    expect((await query('SELECT count(*)::int n FROM websites'))[0].n).toBe(1); // preview wrote nothing
  });

  it('refuses to commit when rows are invalid unless skipInvalid is set', async () => {
    const a = await login('admin');
    const refused = await upload(a, '?mode=commit', Buffer.from(CSV), 'sites.csv');
    expect(refused.status).toBe(422);
    expect((await query('SELECT count(*)::int n FROM websites'))[0].n).toBe(0);
    const ok = await upload(a, '?mode=commit&skipInvalid=true', Buffer.from(CSV), 'sites.csv');
    expect(ok.status).toBe(201);
    expect(ok.body.created).toBe(2);
    const alpha = (await query("SELECT * FROM websites WHERE name='Alpha'"))[0];
    expect(alpha.ga4_property_id).toBe('123456789');
    expect(alpha.ga4_status).toBe('access_required');
    expect(alpha.form_type).toBe('checkout');
    expect((await query('SELECT url, type FROM form_checks WHERE website_id=$1', [alpha.id]))[0]).toMatchObject({ url: 'https://alpha.example.com/checkout', type: 'checkout' });
    const beta = (await query("SELECT * FROM websites WHERE name='Beta'"))[0];
    expect(beta.monitoring_status).toBe('active'); // a site without analytics is still monitored
    expect(beta.ga4_status).toBe('not_connected');
  });

  it('is atomic: a DB conflict in the middle rolls everything back', async () => {
    const a = await login('admin');
    const csv = 'Name,URL\nOne,https://one.example.com\nTwo,https://two.example.com';
    expect((await upload(a, '?mode=commit', Buffer.from(csv), 'x.csv')).body.created).toBe(2);
    const again = await upload(a, '?mode=commit', Buffer.from('Name,URL\nThree,https://three.example.com\nTwo,https://two.example.com'), 'x.csv');
    expect(again.status).toBe(422);
    expect((await query("SELECT count(*)::int n FROM websites WHERE name='Three'"))[0].n).toBe(0);
  });

  it('rejects unsupported files, missing columns and oversized uploads', async () => {
    const a = await login('admin');
    expect((await upload(a, '', Buffer.from('x'), 'evil.exe')).status).toBe(400);
    expect((await upload(a, '', Buffer.from('Foo,Bar\n1,2'), 'x.csv')).status).toBe(400);
    expect((await upload(a, '', Buffer.alloc(6 * 1024 * 1024, 'a'), 'big.csv')).status).toBe(413);
    expect((await a.agent.post('/api/v1/websites/import').set('X-CSRF-Token', a.csrf)).status).toBe(400);
  });

  it('only administrators can import', async () => {
    const m = await login('manager');
    expect((await upload(m, '?mode=preview', Buffer.from(CSV), 'sites.csv')).status).toBe(403);
  });

  it('generates a 27-row template with instructions and dropdown validations that round-trips through import', async () => {
    const a = await login('admin');
    const res = await a.agent.get('/api/v1/websites/import-template').buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Instructions', 'Lists', 'Inventory']);
    const inv = wb.getWorksheet('Inventory')!;
    const hosting = inv.getRow(1).values as string[];
    expect(hosting.join('|')).toMatch(/Hosting type/);
    const col = (hosting as any[]).findIndex((h) => h === 'Hosting type');
    expect(inv.getCell(28, col).dataValidation.type).toBe('list'); // 27 data rows
    expect(inv.getCell(29, col).dataValidation).toBeUndefined();
    inv.getCell(2, 1).value = 'From template';
    inv.getCell(2, 2).value = 'https://template.example.com';
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const prev = await upload(a, '?mode=preview', buf, 'filled.xlsx');
    expect(prev.body.summary).toMatchObject({ totalRows: 1, valid: 1 });
  });

  it('exports CSV and XLSX and neutralises spreadsheet formula injection', async () => {
    const a = await login('admin');
    await makeSite({ name: '=HYPERLINK("http://evil","x")', url: 'https://inj.example.com', owner: '@SUM(1+1)', notes: '+cmd|calc' });
    const csv = await get(a, '/websites/export?format=csv');
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csv.text).toContain("'@SUM(1+1)");
    expect(csv.text).toContain("'+cmd|calc");
    const x = await a.agent.get('/api/v1/websites/export?format=xlsx').buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.body);
    const v = wb.getWorksheet('Inventory')!.getCell(2, 1).value;
    expect(String(v).startsWith("'=")).toBe(true);
  });

  it('imports an Excel file', async () => {
    const a = await login('admin');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Inventory');
    ws.addRow(['Name', 'URL', 'Criticality', 'Check interval (s)']);
    ws.addRow(['Excel Site', 'https://excel.example.com', 'critical', 120]);
    const res = await upload(a, '?mode=commit', Buffer.from(await wb.xlsx.writeBuffer()), 'sites.xlsx');
    expect(res.status).toBe(201);
    expect((await query("SELECT check_interval_seconds, criticality FROM websites WHERE name='Excel Site'"))[0]).toEqual({ check_interval_seconds: 120, criticality: 'critical' });
  });

  it('supports more than 27 websites (no fixed limit)', async () => {
    const a = await login('admin');
    const lines = ['Name,URL', ...Array.from({ length: 120 }, (_, i) => `Site ${i},https://site${i}.example.com`)];
    const res = await upload(a, '?mode=commit', Buffer.from(lines.join('\n')), 'many.csv');
    expect(res.body.created).toBe(120);
  });
});
