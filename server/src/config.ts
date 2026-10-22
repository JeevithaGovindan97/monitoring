import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().default(4000),
  // Public URL of the dashboard (used in e-mail links and for secure-cookie decisions).
  APP_BASE_URL: z.string().default('http://localhost:5173'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),
  LOG_LEVEL: z.string().default('info'),
  // SMTP
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  SMTP_SECURE: bool,
  ALERT_RECIPIENTS: z.string().default(''),
  // Monitoring
  CHECK_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
  SCHEDULER_TICK_MS: z.coerce.number().int().min(500).default(5000),
  /** Explicit internal-monitoring policy. When false (default) private/loopback targets are blocked. */
  ALLOW_PRIVATE_TARGETS: bool,
  // Integrations
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_FILE: z.string().optional(),
  PAGESPEED_API_KEY: z.string().optional(),
  PAGESPEED_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  UPTIME_KUMA_URL: z.string().optional(),
  // Reports / backups
  REPORTS_DIR: z.string().default('./data/reports'),
  BACKUP_DIR: z.string().default('./data/backups'),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().positive().default(14),
  BACKUP_ENCRYPTION_PASSPHRASE: z.string().optional(),
  BACKUP_UPLOAD_COMMAND: z.string().optional(),
  BACKUP_ENABLED: bool,
  BACKUP_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(2),
  // Worker
  WORKER_MODE: z.enum(['monitor', 'reports', 'all']).default('all'),
  WORKER_NAME: z.string().optional(),
  DEMO_MODE: bool,
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  const c = parsed.data;
  const cookieSecure = c.COOKIE_SECURE ? c.COOKIE_SECURE === 'true' : c.NODE_ENV === 'production';
  return {
    ...c,
    cookieSecure,
    alertRecipients: c.ALERT_RECIPIENTS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    smtpConfigured: Boolean(c.SMTP_HOST && c.SMTP_FROM),
  };
}

let cached: Config | undefined;
export function config(): Config {
  cached ??= loadConfig();
  return cached;
}
export function resetConfigForTests() {
  cached = undefined;
}
