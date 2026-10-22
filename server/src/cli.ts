import readline from 'node:readline';
import { Writable } from 'node:stream';
import { closePool, one, query } from './db.js';
import { generatePassword, hashPassword, passwordProblems } from './auth/password.js';
import { revokeAllSessions } from './auth/sessions.js';
import { audit } from './lib/audit.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const flag = (n: string) => process.argv.includes(`--${n}`);

async function readHidden(prompt: string): Promise<string> {
  const muted = new Writable({ write(_c, _e, cb) { cb(); } });
  process.stdout.write(prompt);
  const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
  return new Promise((resolve) => rl.question('', (a) => { rl.close(); process.stdout.write('\n'); resolve(a); }));
}
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function getPassword(): Promise<{ password: string; generated: boolean }> {
  if (flag('generate')) return { password: generatePassword(), generated: true };
  if (flag('password-stdin')) return { password: await readStdin(), generated: false };
  if (!process.stdin.isTTY) throw new Error('No TTY: use --generate or --password-stdin');
  const a = await readHidden('Password: ');
  const b = await readHidden('Repeat password: ');
  if (a !== b) throw new Error('Passwords do not match');
  return { password: a, generated: false };
}

const USAGE = `Usage:
  cli create-user --email <e> --name <n> --role admin|manager [--generate | --password-stdin]
  cli reset-password --email <e> [--generate | --password-stdin]
  cli list-users`;

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'create-user') {
    const email = arg('email'), name = arg('name'), role = arg('role');
    if (!email || !name || (role !== 'admin' && role !== 'manager')) throw new Error(USAGE);
    if (await one('SELECT 1 FROM users WHERE lower(email)=lower($1)', [email])) throw new Error('A user with this e-mail already exists');
    const { password, generated } = await getPassword();
    const problem = passwordProblems(password);
    if (problem) throw new Error(problem);
    const u = await one("INSERT INTO users (email,name,role,password_hash,must_change_password) VALUES ($1,$2,$3,$4,$5) RETURNING id", [email, name, role, await hashPassword(password), generated]);
    await audit(null, 'user.created_cli', 'user', u.id, { email, role });
    console.log(`Created ${role} ${email}.`);
    if (generated) console.log(`Temporary password (shown once, must be changed at first login): ${password}`);
  } else if (cmd === 'reset-password') {
    const email = arg('email');
    if (!email) throw new Error(USAGE);
    const u = await one('SELECT id FROM users WHERE lower(email)=lower($1)', [email]);
    if (!u) throw new Error('No such user');
    const { password, generated } = await getPassword();
    const problem = passwordProblems(password);
    if (problem) throw new Error(problem);
    await query('UPDATE users SET password_hash=$2, must_change_password=$3, failed_login_count=0, locked_until=NULL, updated_at=now() WHERE id=$1', [u.id, await hashPassword(password), generated]);
    await revokeAllSessions(u.id);
    await audit(null, 'user.password_reset_cli', 'user', u.id);
    console.log('Password updated; all sessions revoked.');
    if (generated) console.log(`Temporary password (shown once): ${password}`);
  } else if (cmd === 'list-users') {
    console.table(await query('SELECT email, name, role, is_active, last_login_at FROM users ORDER BY created_at'));
  } else {
    console.log(USAGE);
    process.exitCode = 1;
  }
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => closePool());
