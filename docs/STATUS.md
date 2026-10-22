# What is done, what is verified, what is not

## Implemented

Inventory (CRUD, CSV/XLSX import with preview/row errors/duplicate detection, CSV/XLSX export with formula-injection protection, blank 27-row template with dropdowns, bulk actions) · real HTTP checks every 5 minutes by default with per-site interval/timeout/redirects/expected status · SSRF and DNS-rebinding protection · 2-fail/2-success incident rules with de-duplication and an append-only timeline · maintenance windows · hourly/daily aggregates · rate-limited "check now" · SSL monitoring (30/14/7-day and expired/invalid alerts; warning ≠ outage) · GA4, Search Console and PageSpeed via official APIs with honest "Not connected / Access required" states · form/checkout page-load checks · tasks and escalation rules · in-app + e-mail notifications with delivery tracking, cooldown and retry · PDF and Excel reports generated in the background with authenticated downloads and retention · audit log · admin/manager roles, Argon2id, secure cookies, CSRF, rate limiting, lockout · OpenAPI docs · all 17 UI pages · Docker/Dokploy files · encrypted backups, restore and restore-test scripts · documentation.

## Verified in the build environment

| Check | Result |
|---|---|
| Server integration tests (real PostgreSQL, 11 files) | **115 / 115 pass** |
| Server typecheck + lint, web typecheck + lint, web production build | clean |
| HTTP checker against real local servers (OK, 5xx, refused, timeout, redirect chains, redirect-to-private-IP) | tested |
| SSRF block lists incl. IPv4-mapped IPv6, metadata addresses, DNS pinning | tested |
| TLS certificate reading with a generated self-signed certificate | tested |
| Concurrent scheduler claims (no duplicate checks across workers) | tested |
| Incident open / de-dupe / auto-resolve / manual resolve / reopen; append-only triggers | tested |
| Notifications: cooldown, dedupe, retry, failed-SMTP is never marked "sent" | tested (SMTP mocked) |
| Report PDF/XLSX generation and authorised download | tested |
| Backup → AES-256 encrypt → decrypt → `pg_restore` round trip on real Postgres | tested |
| Compiled server (`dist/`) builds; compiled migration runner runs | verified |
| Full UI in a real browser (Playwright/Chromium) against a live API + worker: login, add sites, all 17 pages, all 10 website tabs; the worker detected a dead site, opened an incident, and honestly recorded the e-mail as *failed* (no SMTP) | verified, no UI errors |

## NOT verified (needs your environment or access)

- **Docker images and `docker compose up`** – no Docker daemon was available; the Dockerfiles, nginx config and compose file are written and the YAML parses, but they have not been built or started. Expect to fix small things on the first Dokploy deploy.
- **Dokploy deployment, domain, DNS, HTTPS certificates, Traefik headers** – not testable here.
- **Real Google APIs** (GA4, Search Console, PageSpeed) – implemented against the documented REST APIs and tested with mocked responses only. Response parsing may need adjustment against live data. Needs your service account and property access.
- **Real SMTP delivery** – tested with a mock transport only.
- **Long-running worker behaviour** (days/weeks): memory, connection pool, retention jobs under real volume. Only short runs were done.
- **Load**: designed for ~27–100 sites at a 5-minute interval; not load-tested.
- **Browser coverage**: only Chromium, desktop width, was exercised. Mobile layout and screen readers were not tested (semantic markup, labels, focus handling and keyboard support are in place).
- **Not implemented**: Uptime Kuma integration (this platform is the authoritative engine; the setting is shown as "not used"), browser-based synthetic form/checkout tests (page-load checks only, by design), an ORM (plain `pg`), multi-factor authentication, SSO.

## Things you must configure

`POSTGRES_PASSWORD`, `APP_BASE_URL`, domain/DNS, SMTP + alert recipients, Google service account and per-property access, optional PageSpeed key, backup passphrase and an off-server backup destination. Review Google Cloud / SMTP provider quotas and costs yourself.

## Reliability statement

This is a monitoring tool with one vantage point and no guarantee of 100 % reliability. Alerts can be delayed or missed if the server, its network, the database, the worker or the mail provider fails. The dashboard shows a "worker not reporting" banner and "Unknown" statuses when it cannot vouch for the data, but you should still run an independent external check on the dashboard itself (e.g. a free external uptime ping on `/api/v1/health/live`).
