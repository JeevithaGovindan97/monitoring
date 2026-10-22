# Backup & restore

## What is backed up

The worker (`worker-reports`) runs nightly at `BACKUP_HOUR_UTC` (default 02:00 UTC) when `BACKUP_ENABLED=true`:

1. `pg_dump --format=custom` of the whole database (users, inventory, checks, incidents, tasks, audit logs, settings).
2. Optional AES-256 encryption (`openssl enc -aes-256-cbc -pbkdf2`) when `BACKUP_ENCRYPTION_PASSPHRASE` is set → file ends in `.enc`.
3. Old files older than `BACKUP_RETENTION_DAYS` (default 14) are removed.
4. Optional off-server copy: `BACKUP_UPLOAD_COMMAND` runs with `BACKUP_FILE` set, e.g. `rclone copy "$BACKUP_FILE" remote:bucket/`.
5. On failure, administrators receive an in-app notification and the failure shows in **System health**.

Files live in the `backups` Docker volume (`/data/backups` in `worker-reports`). **A backup stored only on the same server does not protect you from losing the server** — configure `BACKUP_UPLOAD_COMMAND` or copy the volume elsewhere.

Not included: generated report files (`reports` volume; re-generate them) and `.env` secrets (keep those in your password manager — in particular the **encryption passphrase**; without it encrypted backups cannot be restored).

## Restore into production

1. Stop writers: in Dokploy stop `api`, `worker-monitor`, `worker-reports` (leave `db` running).
2. Get the file onto a machine with `pg_restore` (+ `openssl` for `.enc`): e.g. `docker cp <worker-reports>:/data/backups/<file> .`
3. Run:
   ```bash
   DATABASE_URL=postgres://monitor:PASSWORD@<db-host>:5432/monitor \
   BACKUP_ENCRYPTION_PASSPHRASE=... \
   scripts/restore.sh monitor-<timestamp>.dump.enc
   ```
   (Run it inside the `db` container network, e.g. `docker run --rm --network igo-monitoring_internal -v $PWD:/b -e DATABASE_URL=... -e BACKUP_ENCRYPTION_PASSPHRASE postgres:15-bookworm bash /b/scripts/restore.sh /b/<file> --yes`.)
4. Start `api` and the workers. Check **System health** and the latest check times.

The script validates the archive, asks for typed confirmation, and restores in a single transaction (all-or-nothing).

## Prove your backups work (do this quarterly)

```bash
ADMIN_DATABASE_URL=postgres://postgres:PASSWORD@host:5432/postgres \
BACKUP_ENCRYPTION_PASSPHRASE=... scripts/restore-test.sh <backup-file>
```

It restores into a temporary database, prints row counts, and drops it. Production is never touched.

The automated test suite also performs a real backup → decrypt → `pg_restore` round-trip (`server/test/platform.test.ts`).
