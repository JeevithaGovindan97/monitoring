<div align="center">

# Website Monitoring Dashboard

**One self-hosted dashboard for the health, traffic, SEO and performance of every website you run.**

Uptime · Response time · SSL · Incidents & alerts · Google Analytics 4 · Search Console · PageSpeed · Tasks · Reports

![Node](https://img.shields.io/badge/Node-22-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15-4169E1?logo=postgresql&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)
![Dokploy](https://img.shields.io/badge/Deploy-Dokploy-6C47FF)

</div>

---

## Table of contents

1. [Overview](#overview)
2. [Features](#features)
3. [Architecture](#architecture)
4. [Technology stack](#technology-stack)
5. [Quick start with Docker](#quick-start-with-docker-windows-mac-linux)
6. [First sign-in and users](#first-sign-in-and-users)
7. [Adding your websites](#adding-your-websites)
8. [Configuration reference](#configuration-reference)
9. [Optional integrations](#optional-integrations)
10. [Deploying on Dokploy](#deploying-on-dokploy)
11. [Local development](#local-development)
12. [Testing and quality checks](#testing-and-quality-checks)
13. [Backups and restore](#backups-and-restore)
14. [Security](#security)
15. [Project structure](#project-structure)
16. [Documentation](#documentation)
17. [Troubleshooting](#troubleshooting)
18. [Honest limits](#honest-limits)

---

## Overview

This platform watches many websites from a single place. It runs **its own** HTTP and SSL checks, so it is the authoritative source of uptime, and it does not read or duplicate Uptime Kuma. It was designed for a portfolio of about 27 websites and is expandable: add websites one by one or in bulk from an Excel/CSV file.

Everything runs in Docker. The same Compose file works on a laptop for evaluation and on a [Dokploy](https://dokploy.com) server for production.

## Features

| Area | What you get |
|---|---|
| **Uptime & response time** | Scheduled HTTP checks per website (default every 5 minutes), expected status codes, response-time thresholds, per-site and portfolio uptime history with charts |
| **Incidents & alerts** | An incident opens only after two consecutive failures, tracks acknowledgement and resolution with a timeline, and sends e-mail and in-app notifications |
| **SSL certificates** | Certificate expiry and validity checks every 6 hours, with warnings before a certificate expires |
| **Forms & checkout** | Page-load checks for contact forms, login and checkout pages |
| **Traffic (GA4)** | Sessions, users and top pages from Google Analytics 4 *(optional integration)* |
| **SEO (Search Console)** | Clicks, impressions, CTR and queries from Google Search Console *(optional integration)* |
| **Performance** | Lighthouse scores and Core Web Vitals through the PageSpeed Insights API *(optional API key)* |
| **Tasks & escalations** | Assign follow-up work to incidents and websites, with owners, status and due dates |
| **Reports** | Generated PDF and Excel reports on a schedule or on demand |
| **Inventory** | Central website register with owner, environment, hosting, check interval and expected status; bulk import from Excel/CSV with a validated preview |
| **Users & roles** | Admin and Manager roles, forced password change for generated passwords, full audit log |
| **System health** | Worker heartbeats, queue state, backup status and last-check ages, so you can see when monitoring itself is unhealthy |
| **Interface** | Responsive layout, light / dark / system theme, accessible forms, show-or-hide password on sign-in |

### Pages

Sign in · Overview · Inventory · Website detail · Uptime history · Incidents (and incident detail) · SSL certificates · Forms & checkout · Traffic (GA4) · SEO (Search Console) · Performance · Tasks & escalations · Reports · Notifications · Integrations · Users · Audit logs · System health · Change password

## Architecture

```mermaid
flowchart LR
    U[Browser] -->|HTTP :8080| W[web<br/>nginx]
    W -->|/api/*| A[api<br/>Express + zod]
    A --> D[(PostgreSQL 15)]
    M[worker-monitor<br/>checks, incidents, e-mail] --> D
    R[worker-reports<br/>reports, syncs, retention, backups] --> D
    M -->|HTTP / TLS checks| S[(Your websites)]
    R -->|optional| G[Google APIs<br/>GA4, Search Console, PageSpeed]
    M -->|SMTP| E[Mail server]
```

- **`web`** serves the React app and proxies `/api/` to the API. It resolves the API address on every request, so restarting the API never leaves it with a stale address.
- **`api`** exposes the REST API with zod validation and OpenAPI documentation at `/api/v1/docs`.
- **`worker-monitor`** and **`worker-reports`** are separate processes. Jobs are claimed from PostgreSQL with `FOR UPDATE SKIP LOCKED` leases, so extra replicas never check a site twice.
- **`migrate`** is a one-shot service that applies forward-only SQL migrations under an advisory lock before the API starts.
- A monitor whose last check is older than three intervals is shown as **Unknown**, never as Online.

## Technology stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite, TypeScript, React Query, Recharts |
| Backend | Node 22, TypeScript, Express 4, zod 4, OpenAPI |
| Database | PostgreSQL 15 with plain SQL migrations (`server/migrations`) |
| Auth | Argon2id password hashing, server-side hashed sessions, HttpOnly SameSite cookie, CSRF header, login lockout |
| Packaging | Docker multi-stage images, Docker Compose, nginx (unprivileged) |
| Deployment | Dokploy (Traefik) or any Docker host |

> **Design note:** the data layer uses the `pg` driver with parameterised SQL and plain SQL migrations rather than an ORM. This keeps aggregates, `SKIP LOCKED`, advisory locks and append-only audit triggers explicit.

## Quick start with Docker (Windows, Mac, Linux)

**Requirements:** Docker Desktop (or Docker Engine with the Compose plugin) and Git.

```bash
# 1. Get the code
git clone https://github.com/JeevithaGovindan97/monitoring.git
cd monitoring

# 2. Create your environment file
cp .env.example .env            # Windows PowerShell: Copy-Item .env.example .env
```

Edit `.env` and set at least:

```ini
POSTGRES_PASSWORD=<a long random string>
APP_BASE_URL=http://localhost:8080
COOKIE_SECURE=false      # only for local http; remove on a real HTTPS domain
TRUST_PROXY=2
```

In `deploy/docker-compose.yml`, under the `web` service, uncomment the port mapping so the app is reachable locally:

```yaml
ports: ["8080:8080"]
```

```bash
# 3. Create the shared network (once) and start everything
docker network create dokploy-network
docker compose --env-file .env -f deploy/docker-compose.yml up --build -d
```

> `--env-file .env` is required. Without it Compose looks for `.env` next to the compose file instead of the project root, and reports missing variables.

When the containers show **Healthy**, open **http://localhost:8080**.

## First sign-in and users

Create the first administrator (a one-time password is generated and printed):

```bash
docker compose --env-file .env -f deploy/docker-compose.yml exec api \
  node dist/cli.js create-user --email you@company.com --name "Your Name" --role admin --generate
```

You will be asked to choose your own password on first sign-in.

Other commands:

```bash
# list users
docker compose --env-file .env -f deploy/docker-compose.yml exec api node dist/cli.js list-users

# reset a password and clear a lockout (password read from stdin)
printf 'a-long-password-12+' | docker compose --env-file .env -f deploy/docker-compose.yml exec -T api \
  node dist/cli.js reset-password --email you@company.com --password-stdin
```

Roles and what each can do are listed in [docs/PERMISSIONS.md](docs/PERMISSIONS.md).

## Adding your websites

- **One at a time:** Inventory → Add website.
- **In bulk:** Inventory → Import. Use the blank Excel template (`templates/website-inventory-template.xlsx`) or a CSV such as `templates/igo-websites-import.csv`. The import shows a preview with row errors and duplicates before anything is saved.

Each website has a name, URL, environment, owner, hosting, check interval (default 300 s), response-time threshold (default 15 000 ms) and the HTTP status codes counted as healthy (default 200–399).

## Configuration reference

All settings are environment variables. Copy `.env.example` to `.env`; the file is git-ignored and must never be committed.

| Variable | Required | Purpose | Default |
|---|---|---|---|
| `POSTGRES_PASSWORD` | Yes | Database password | none |
| `APP_BASE_URL` | Yes | Public URL of the dashboard (used in links and cookie rules) | none |
| `POSTGRES_USER` / `POSTGRES_DB` | No | Database user and name | `monitor` |
| `COOKIE_SECURE` | No | Set `false` only when serving plain HTTP locally | `true` in production |
| `TRUST_PROXY` | No | Number of proxy hops (Dokploy + nginx = 2) | `2` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | No | Outgoing mail for alerts. Without SMTP, in-app alerts still work and e-mails are recorded as failed, never as sent | empty |
| `ALERT_RECIPIENTS` | No | Comma-separated alert addresses | empty |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | No | Service-account key (one line) for GA4 and Search Console | empty |
| `PAGESPEED_API_KEY` | No | Your own PageSpeed Insights API key | empty |
| `PAGESPEED_CONCURRENCY` | No | Parallel PageSpeed requests | `1` |
| `ALLOW_PRIVATE_TARGETS` | No | Allow monitoring private or loopback addresses | `false` |
| `CHECK_CONCURRENCY` | No | Parallel website checks per worker | `10` |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, `error` | `info` |
| `BACKUP_ENABLED`, `BACKUP_HOUR_UTC`, `BACKUP_RETENTION_DAYS` | No | Nightly `pg_dump` schedule and retention | `true`, `2`, `14` |
| `BACKUP_ENCRYPTION_PASSPHRASE` | Recommended | AES-256 passphrase for backups. Keep it in a password manager; backups cannot be restored without it | empty |
| `BACKUP_UPLOAD_COMMAND` | No | Command that copies each backup off the server (for example `rclone copy`) | empty |

## Optional integrations

The core monitoring works with no integrations. Add these when you need them.

**PageSpeed Insights (Performance page).** Without an API key the app uses Google's shared anonymous quota, which is often exhausted and shows *"Quota exceeded"*. To fix it:

1. In Google Cloud Console, create or select a project and enable **PageSpeed Insights API**.
2. Create an API key and restrict it to that API.
3. Add `PAGESPEED_API_KEY=<your key>` to `.env` and restart: `docker compose --env-file .env -f deploy/docker-compose.yml up -d`.
4. Open a website → Performance → **Run audit now**.

**Google Analytics 4 and Search Console.** Create a Google service account, add it as a viewer on each GA4 property and Search Console site, and set `GOOGLE_SERVICE_ACCOUNT_JSON`. Step by step: [docs/EMAIL_AND_GOOGLE_SETUP.md](docs/EMAIL_AND_GOOGLE_SETUP.md).

**E-mail alerts.** Set the `SMTP_*` variables and `ALERT_RECIPIENTS`. Details in the same guide.

## Deploying on Dokploy

The Compose file attaches to the external `dokploy-network`, so Traefik can route a domain to the `web` service on port 8080. Full steps, including domain, HTTPS, environment variables, persistent volumes and rollback, are in **[docs/DOKPLOY_DEPLOYMENT.md](docs/DOKPLOY_DEPLOYMENT.md)**.

Production checklist:

- [ ] Strong `POSTGRES_PASSWORD`
- [ ] `APP_BASE_URL` set to your HTTPS domain, and `COOKIE_SECURE` not set to `false`
- [ ] `BACKUP_ENCRYPTION_PASSPHRASE` set and stored safely
- [ ] SMTP configured and a test alert received
- [ ] A restore test completed (`scripts/restore-test.sh`)

## Local development

```bash
npm install
createdb monitor && export DATABASE_URL=postgres://user:pass@localhost:5432/monitor
npm run migrate --workspace server
printf 'a-long-password-12+' | npm run cli --workspace server -- create-user \
  --email you@example.com --name You --role admin --password-stdin

npm run dev:api  --workspace server              # http://localhost:4000/api/v1/docs
WORKER_MODE=all npm run dev:worker --workspace server
npm run dev --workspace web                       # http://localhost:5173
```

Targets such as `http://localhost:9001` are blocked by the SSRF guard unless `ALLOW_PRIVATE_TARGETS=true`.

## Testing and quality checks

```bash
createdb monitor_test                    # the schema is recreated on every run
npm test --workspace server              # integration tests against real PostgreSQL

npm run typecheck --workspace server && npm run lint --workspace server
npm run typecheck --workspace web    && npm run lint --workspace web && npm run build --workspace web
```

[docs/STATUS.md](docs/STATUS.md) states exactly what has been verified and what has not.

## Backups and restore

A nightly encrypted `pg_dump` is written to the `backups` volume and pruned after the retention period. An optional upload command copies each file off the server. Restore with `scripts/restore.sh`, and rehearse it with `scripts/restore-test.sh`. See [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md).

## Security

- Passwords hashed with **Argon2id**; sessions stored hashed server-side; HttpOnly, SameSite=Strict cookies; CSRF header on state-changing requests.
- Login lockout after 5 failures in 15 minutes; generated passwords must be changed on first sign-in.
- **SSRF protection:** private, loopback and metadata addresses are blocked by default, DNS is pinned per check, and every redirect hop is revalidated.
- Strict Content-Security-Policy and security headers from nginx; the web container runs unprivileged.
- Append-only audit log of administrative actions.
- Secrets live only in environment variables. `.env` and key files are git-ignored.

Report a vulnerability privately to the repository owner rather than opening a public issue.

## Project structure

```text
.
├── server/                 Node + TypeScript API, workers, CLI, migrations, tests
│   ├── src/routes/         REST endpoints
│   ├── src/monitor/        HTTP and SSL checks, incident logic
│   ├── src/integrations/   GA4, Search Console, PageSpeed
│   ├── src/reports/        PDF and Excel report generation
│   └── migrations/         Forward-only SQL migrations
├── web/                    React + Vite single-page app
│   └── src/pages/          Dashboard pages
├── deploy/                 docker-compose.yml for local and Dokploy use
├── docker/                 Dockerfiles and nginx configuration
├── docs/                   Operational documentation
├── scripts/                Backup restore and restore-test helpers
├── templates/              Inventory import templates (xlsx, csv)
└── .env.example            Documented environment variables
```

## Documentation

| Guide | Contents |
|---|---|
| [Dokploy deployment & rollback](docs/DOKPLOY_DEPLOYMENT.md) | Domain, HTTPS, volumes, updates, rollback |
| [Backup & restore](docs/BACKUP_RESTORE.md) | Encryption, off-server copies, restore drill |
| [Roles & permissions](docs/PERMISSIONS.md) | What each role can see and do |
| [E-mail & Google setup](docs/EMAIL_AND_GOOGLE_SETUP.md) | SMTP, service account, GA4, Search Console |
| [How uptime is calculated](docs/UPTIME_METHOD.md) | Formula, maintenance windows, "No data" rules |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Common problems and fixes |
| [Verified vs not verified](docs/STATUS.md) | Honest status of every capability |

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Compose says `required variable APP_BASE_URL/POSTGRES_PASSWORD is missing` | Add `--env-file .env` to the command |
| Sign-in says "Invalid email or password" | Re-type the password carefully, or reset it with the `reset-password` command above (also clears a lockout) |
| Sign-in shows **Request failed (502)** | The API was restarting. Wait a few seconds and retry; if it persists, check `docker compose --env-file .env -f deploy/docker-compose.yml logs --tail 40 api` |
| Performance shows *Quota exceeded … Queries per day* | Add your own `PAGESPEED_API_KEY` (see [Optional integrations](#optional-integrations)) |
| A website shows Down with a TLS error such as `EPROTO` / `ERR_SSL_PROTOCOL_ERROR` | The site's own HTTPS or certificate is misconfigured at its hosting provider. This is a real failure, not a dashboard bug |
| Statuses show **Unknown** | The monitoring worker is stopped or behind. Check System health and `worker-monitor` logs |
| Alert e-mails are marked *failed* | SMTP is not configured or rejected the message. Set the `SMTP_*` variables |

More in [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Honest limits

No monitoring system is 100% reliable. Checks run from a single location, so a failure may be a network problem between the server and the site rather than an outage everyone sees. Two consecutive failures are required before an incident opens, and a stopped worker is shown as **Unknown**, never as Online. Sites with no checks show "No data", never 100%. See [docs/STATUS.md](docs/STATUS.md).

---

<div align="center">

Built for **IGO Groups** · Private repository · All rights reserved

</div>
