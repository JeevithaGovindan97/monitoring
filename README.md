# Website Monitoring Dashboard

One self-hosted dashboard that watches many websites (27 today, more later): uptime and response time, SSL certificates, incidents and alerts, Google Analytics 4 and Search Console data, PageSpeed performance, form/checkout page-load checks, tasks and escalations, and PDF/Excel reports.

This platform runs **its own** HTTP/SSL checks and is the authoritative source of uptime. It does not duplicate or read Uptime Kuma.

## What is in the box

| Part | Technology |
|---|---|
| `web/` | React 19 + Vite + TypeScript, Recharts, React Query |
| `server/` | Node 22 + TypeScript, Express, zod validation, OpenAPI at `/api/v1/docs` |
| Database | PostgreSQL 15, forward-only SQL migrations (`server/migrations`) |
| Workers | `worker-monitor` (checks, incidents, e-mail delivery) and `worker-reports` (reports, syncs, retention, backups); jobs are claimed from Postgres with `FOR UPDATE SKIP LOCKED` leases, so extra replicas never double-check a site |
| Deploy | `deploy/docker-compose.yml` (db, one-shot migrate, api, two workers, nginx web) |

> **Deviation from the brief:** the data layer uses the `pg` driver with parameterised SQL and plain SQL migrations instead of an ORM (Prisma/Drizzle). This keeps queries (aggregates, `SKIP LOCKED`, advisory locks, append-only triggers) explicit. Nothing else depends on this choice.

## Quick start (local development)

```bash
npm install
createdb monitor && export DATABASE_URL=postgres://user:pass@localhost:5432/monitor
npm run migrate --workspace server
printf 'a-long-password-12+' | npm run cli --workspace server -- create-user --email you@example.com --name You --role admin --password-stdin
npm run dev:api    --workspace server     # http://localhost:4000/api/v1/docs
WORKER_MODE=all npm run dev:worker --workspace server
npm run dev --workspace web               # http://localhost:5173
```

Local targets such as `http://localhost:9001` are blocked by the SSRF guard unless you set `ALLOW_PRIVATE_TARGETS=true`.

## Tests and checks

```bash
createdb monitor_test        # test DB, schema is recreated on every run
npm test --workspace server  # integration tests against real Postgres
npm run typecheck --workspace server && npm run lint --workspace server
npm run typecheck --workspace web && npm run lint --workspace web && npm run build --workspace web
```

## Run locally with Docker (Windows/Mac/Linux)

1. Copy `.env.example` to `.env`; set `POSTGRES_PASSWORD`, `APP_BASE_URL=http://localhost:8080`, `COOKIE_SECURE=false`.
2. In `deploy/docker-compose.yml` uncomment `ports: ["8080:8080"]` under `web`.
3. `docker network create dokploy-network`
4. `docker compose --env-file .env -f deploy/docker-compose.yml up --build -d`
5. Create the admin: `docker compose --env-file .env -f deploy/docker-compose.yml exec api node dist/cli.js create-user --email you@example.com --name "You" --role admin --generate`
6. Open http://localhost:8080

(`--env-file .env` is required because Compose otherwise looks for `.env` next to the compose file.)

## Deploy

See **[docs/DOKPLOY_DEPLOYMENT.md](docs/DOKPLOY_DEPLOYMENT.md)**. Environment variables are documented in [.env.example](.env.example).

## Documentation

- [Dokploy deployment & rollback](docs/DOKPLOY_DEPLOYMENT.md)
- [Backup & restore](docs/BACKUP_RESTORE.md)
- [Roles & permissions](docs/PERMISSIONS.md)
- [E-mail & Google setup](docs/EMAIL_AND_GOOGLE_SETUP.md)
- [How uptime is calculated](docs/UPTIME_METHOD.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [What is verified and what is not](docs/STATUS.md)

## Importing your 27 websites

Inventory → Import → download the blank 27-row Excel template (also in `templates/website-inventory-template.xlsx`), fill it in, upload it, review the preview (row errors and duplicates are listed), then confirm.

## Honest limits

No monitoring system is 100% reliable. Checks run from one location; a failure there may be a network problem between the server and the site. Two consecutive failures are required before an incident opens, and a stopped worker is shown as "unknown", never as "online". See [docs/STATUS.md](docs/STATUS.md).
