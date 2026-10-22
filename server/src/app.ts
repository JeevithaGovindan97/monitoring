import cookieParser from 'cookie-parser';
import express, { type Request } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { config } from './config.js';
import { query } from './db.js';
import { requireAuth, sessionMiddleware } from './auth/middleware.js';
import { errorHandler, forbidden, HttpError, wrap } from './lib/errors.js';
import { buildOpenApi } from './openapi.js';
import { authRouter } from './routes/auth.js';
import { auditRouter, integrationsRouter, maintenanceRouter, systemRouter } from './routes/admin.js';
import { dashboardRouter } from './routes/dashboard.js';
import { incidentsRouter } from './routes/incidents.js';
import { notificationsRouter, settingsRouter } from './routes/notifications.js';
import { reportsRouter } from './routes/reports.js';
import { escalationRouter, tasksRouter } from './routes/tasks.js';
import { usersRouter } from './routes/users.js';
import { websitesRouter } from './routes/websites.js';

export function createApp() {
  const c = config();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', c.TRUST_PROXY);
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      hsts: c.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(
    rateLimit({
      windowMs: 60_000, limit: c.NODE_ENV === 'test' ? 100_000 : 600, standardHeaders: true, legacyHeaders: false,
      skip: (req) => req.path.startsWith('/api/v1/health'),
      message: { error: { code: 'rate_limited', message: 'Too many requests' } },
    }),
  );

  const api = express.Router();
  // ---- unauthenticated probes
  api.get('/health/live', (_req, res) => void res.json({ status: 'ok' }));
  api.get('/health/ready', wrap(async (_req, res) => {
    try {
      await query('SELECT 1');
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'not_ready' });
    }
  }));

  // HTTPS enforcement (TLS terminates at the reverse proxy, which must set X-Forwarded-Proto)
  if (c.NODE_ENV === 'production' && c.cookieSecure) {
    app.use((req, res, next) => {
      if (req.secure || req.path.startsWith('/api/v1/health')) return next();
      res.status(400).json({ error: { code: 'https_required', message: 'HTTPS is required' } });
    });
  }
  // Defence in depth against CSRF: state-changing requests must come from our own origin when an Origin header is present.
  const allowedHosts = new Set<string>();
  try { allowedHosts.add(new URL(c.APP_BASE_URL).host); } catch { /* ignore */ }
  api.use((req: Request, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (!origin) return next();
    try {
      const h = new URL(origin).host;
      if (h === req.get('host') || allowedHosts.has(h)) return next();
    } catch { /* fallthrough */ }
    next(forbidden('Cross-origin request blocked'));
  });

  api.get('/openapi.json', (_req, res) => void res.json(buildOpenApi()));
  api.use(sessionMiddleware);
  api.use('/auth', authRouter);

  const secured = express.Router();
  secured.use(requireAuth);
  secured.use('/users', usersRouter);
  secured.use('/dashboard', dashboardRouter);
  secured.use('/websites', websitesRouter);
  secured.use('/maintenance', maintenanceRouter);
  secured.use('/incidents', incidentsRouter);
  secured.use('/tasks', tasksRouter);
  secured.use('/escalation-rules', escalationRouter);
  secured.use('/notifications', notificationsRouter);
  secured.use('/settings', settingsRouter);
  secured.use('/reports', reportsRouter);
  secured.use('/integrations', integrationsRouter);
  secured.use('/audit-logs', auditRouter);
  secured.use('/system', systemRouter);
  api.use(secured);
  api.use((_req, _res, next) => next(new HttpError(404, 'Route not found', 'not_found')));

  app.use('/api/v1/docs', helmet({ contentSecurityPolicy: false }), swaggerUi.serve, swaggerUi.setup(buildOpenApi() as any));
  app.use('/api/v1', api);
  app.use(errorHandler);
  return app;
}
