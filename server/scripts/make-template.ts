// Regenerates templates/website-inventory-template.xlsx (blank, 27 rows, dropdowns). Run: npm run template --workspace server
import { writeFile } from 'node:fs/promises';
import { buildTemplate } from '../src/lib/inventory-io.js';
const buf = await buildTemplate(27);
await writeFile(new URL('../../templates/website-inventory-template.xlsx', import.meta.url), buf);
console.log('written templates/website-inventory-template.xlsx');
