# Deploying on Dokploy

The compose file is `deploy/docker-compose.yml` (build context = repository root).

## 1. Prepare

1. Push this repository to a private Git repo that Dokploy can read.
2. Choose the public hostname (e.g. `monitor.yourdomain.com`) and create a DNS **A record** to the Dokploy server.
3. Generate secrets: `openssl rand -base64 36` for `POSTGRES_PASSWORD` and `BACKUP_ENCRYPTION_PASSPHRASE`.

## 2. Create the application

1. Dokploy → **Create Service → Compose** → provider Git, branch `main`, **Compose path** `deploy/docker-compose.yml`.
2. **Environment** tab: paste the contents of `.env.example` and fill in at least `POSTGRES_PASSWORD` and `APP_BASE_URL` (`https://monitor.yourdomain.com`). Add SMTP and Google values when ready (see [EMAIL_AND_GOOGLE_SETUP.md](EMAIL_AND_GOOGLE_SETUP.md)); the app works without them and clearly says "Not connected".
3. **Domains** tab: add your hostname → service **`web`** → port **`8080`** → HTTPS on, certificate provider Let's Encrypt.
4. **Deploy**. Startup order is enforced: `db` (healthy) → `migrate` (one-shot, must succeed) → `api`, `worker-monitor`, `worker-reports` → `web`.

The compose file references the external network `dokploy-network`, which exists on Dokploy servers. For a plain `docker compose` host run `docker network create dokploy-network` once.

## 3. Create the first administrator

There is no public sign-up. In Dokploy open a terminal on the `api` container (or `docker exec -it <api-container> sh`) and run:

```bash
node dist/cli.js create-user --email you@example.com --name "Your Name" --role admin --generate
```

The generated password is printed once; you must change it at first login. Other commands: `reset-password`, `list-users`.

## 4. Verify

- Open `https://monitor.yourdomain.com`, log in, change the password.
- **System health** shows the monitoring worker "Running" and the database OK.
- Add one website; within a minute its status changes from "Unknown" to Online/Down.
- Inventory → Import to load all 27 sites.
- Notifications → Alert settings → **Send test e-mail**.
- Google Integrations page shows the service-account address once configured.

## Updating

Redeploy in Dokploy. The `migrate` service applies new SQL migrations (forward-only, advisory-locked) before the API starts; a failed migration stops the rollout and the old containers keep running.

## Rollback

1. Make sure a recent backup exists (the nightly backup is in the `backups` volume; see [BACKUP_RESTORE.md](BACKUP_RESTORE.md)).
2. Code-only rollback (no new migration was applied): in Dokploy redeploy the previous Git commit.
3. If the release included a migration, migrations are **forward-only**: restore the pre-release backup into the database (docs/BACKUP_RESTORE.md) and then redeploy the previous commit.

## Operational notes

- Only `web` is routed publicly. `db` and `api` are reachable only on the internal Docker network.
- Containers drop all Linux capabilities, run as non-root where the base image allows (`node` user; `nginx-unprivileged`), and have restart policies and memory limits.
- Scale monitoring capacity by raising `CHECK_CONCURRENCY`; running a second `worker-monitor` replica is safe (leases prevent duplicate checks).
- `TRUST_PROXY=2` assumes Traefik + the bundled nginx. If you remove nginx from the path, set it to `1`.
- The Postgres image major version (15) must match the `postgresql-client` in the server image so `pg_dump` works. Upgrade both together.
