# Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Everything shows **Unknown**, banner "Monitoring worker is not reporting" | `worker-monitor` is stopped/crashing. Dokploy → logs of `worker-monitor`. Statuses recover automatically once it runs. |
| `migrate` service failed, nothing starts | Read its log. Usually a wrong `POSTGRES_PASSWORD` after the volume was created with another one (the DB password is fixed at first init; change it with `ALTER USER`, or recreate the volume if no data matters). |
| Login works but you are immediately logged out / API returns `https_required` | `APP_BASE_URL` must be the public `https://` URL, and the domain must be served over HTTPS. Check `TRUST_PROXY` (2 with Traefik + nginx). |
| 403 on actions after a long idle time | Session expired (12 h default) or CSRF token stale → log in again. |
| Website shows Down but it is up in a browser | Look at the check log (website → Check log) for the error category (DNS, timeout, TLS, blocked target). Firewalls/WAFs may block the server's IP; allow-list it. "Blocked target" = URL resolves to a private address (see `ALLOW_PRIVATE_TARGETS`). |
| Website added but "private address" validation error | Intentional SSRF protection. Only set `ALLOW_PRIVATE_TARGETS=true` if you really monitor internal hosts. |
| GA4 / Search Console "Access required" | The service-account e-mail has not been added to that property (see EMAIL_AND_GOOGLE_SETUP.md); wait for the next daily sync or test access on the Integrations page. |
| GA4 / GSC "Not connected" everywhere | `GOOGLE_SERVICE_ACCOUNT_JSON` missing/invalid JSON on the server. |
| PageSpeed "Audit failed" with quota error | Add `PAGESPEED_API_KEY`; audits are throttled by design. |
| E-mails "failed" in the delivery log | SMTP credentials/host/port/TLS wrong, or `SMTP_FROM` not permitted. The sanitized error is shown; use *Send test e-mail*. |
| Report stuck on "queued" | `worker-reports` not running. |
| Report download 404 / expired | Reports are kept `retention_reports_days` (default 30); generate again. |
| Backup missing | `BACKUP_ENABLED=true`? Check System health → jobs for the `backup` job error (`pg_dump` version mismatch means the db image and server image majors differ). |
| Locked out | 5 failed logins lock for 15 min. An admin can reset a password; or via CLI: `node dist/cli.js reset-password --email … --generate`. |
| Disk filling up | Lower retention in Notifications → Alert settings; check the `backups` volume. |
