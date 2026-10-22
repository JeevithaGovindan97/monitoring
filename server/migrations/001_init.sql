-- Initial schema. All timestamps are timestamptz (stored as UTC).

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'manager')),
  password_hash text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT false,
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  notify_email boolean NOT NULL DEFAULT true,
  notify_in_app boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE sessions (
  id text PRIMARY KEY,                       -- sha256 of the session token
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip text,
  user_agent text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE websites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  url text NOT NULL,
  url_normalized text NOT NULL,
  health_check_url text,
  hosting_type text NOT NULL DEFAULT 'other'
    CHECK (hosting_type IN ('vps','docker','dokploy','managed','shared','cloud','other')),
  environment text NOT NULL DEFAULT 'production'
    CHECK (environment IN ('production','staging','development')),
  owner text,
  criticality text NOT NULL DEFAULT 'medium'
    CHECK (criticality IN ('critical','high','medium','low')),
  monitoring_status text NOT NULL DEFAULT 'active'
    CHECK (monitoring_status IN ('active','disabled','archived')),
  expected_status text NOT NULL DEFAULT '200-399',
  check_interval_seconds integer NOT NULL DEFAULT 300 CHECK (check_interval_seconds BETWEEN 60 AND 86400),
  timeout_ms integer NOT NULL DEFAULT 10000 CHECK (timeout_ms BETWEEN 1000 AND 60000),
  max_redirects integer NOT NULL DEFAULT 5 CHECK (max_redirects BETWEEN 0 AND 20),
  degraded_threshold_ms integer CHECK (degraded_threshold_ms IS NULL OR degraded_threshold_ms >= 100),
  fail_threshold integer NOT NULL DEFAULT 2 CHECK (fail_threshold BETWEEN 1 AND 20),
  recover_threshold integer NOT NULL DEFAULT 2 CHECK (recover_threshold BETWEEN 1 AND 20),
  ssl_check_enabled boolean NOT NULL DEFAULT true,
  ssl_failure_is_outage boolean NOT NULL DEFAULT false,
  performance_audit_enabled boolean NOT NULL DEFAULT true,
  performance_interval_hours integer NOT NULL DEFAULT 24 CHECK (performance_interval_hours BETWEEN 1 AND 720),
  form_type text NOT NULL DEFAULT 'none'
    CHECK (form_type IN ('none','contact','login','booking','checkout','other')),
  ga4_property_id text,
  ga4_status text NOT NULL DEFAULT 'not_connected'
    CHECK (ga4_status IN ('connected','access_required','not_connected','error','not_applicable')),
  ga4_status_detail text,
  gsc_property_url text,
  gsc_status text NOT NULL DEFAULT 'not_connected'
    CHECK (gsc_status IN ('connected','access_required','not_connected','error','not_applicable')),
  gsc_status_detail text,
  notes text,
  alert_preferences jsonb NOT NULL DEFAULT '{"email":true,"in_app":true}'::jsonb,
  -- live monitoring state
  state text NOT NULL DEFAULT 'unknown' CHECK (state IN ('up','down','degraded','unknown')),
  state_since timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  consecutive_successes integer NOT NULL DEFAULT 0,
  streak_first_failure_at timestamptz,
  streak_first_success_at timestamptz,
  last_check_at timestamptz,
  last_status_code integer,
  last_response_ms integer,
  last_error text,
  -- scheduling / locking
  next_check_at timestamptz NOT NULL DEFAULT now(),
  lock_until timestamptz,
  lock_owner text,
  internal_error_count integer NOT NULL DEFAULT 0,
  ssl_next_check_at timestamptz NOT NULL DEFAULT now(),
  ssl_lock_until timestamptz,
  ssl_last_alert_level integer,
  perf_next_audit_at timestamptz NOT NULL DEFAULT now(),
  perf_lock_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX websites_url_uq ON websites (url_normalized) WHERE monitoring_status <> 'archived';
CREATE INDEX websites_due_idx ON websites (next_check_at) WHERE monitoring_status = 'active';
CREATE INDEX websites_state_idx ON websites (state);
CREATE INDEX websites_status_idx ON websites (monitoring_status);
CREATE INDEX websites_criticality_idx ON websites (criticality);

CREATE TABLE form_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  website_id uuid NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  label text NOT NULL,
  type text NOT NULL DEFAULT 'contact' CHECK (type IN ('contact','login','booking','checkout','other')),
  url text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  check_mode text NOT NULL DEFAULT 'page_load' CHECK (check_mode IN ('page_load','synthetic')),
  expected_status text NOT NULL DEFAULT '200-399',
  interval_seconds integer NOT NULL DEFAULT 900 CHECK (interval_seconds BETWEEN 60 AND 86400),
  timeout_ms integer NOT NULL DEFAULT 10000,
  state text NOT NULL DEFAULT 'unknown' CHECK (state IN ('up','down','unknown')),
  consecutive_failures integer NOT NULL DEFAULT 0,
  consecutive_successes integer NOT NULL DEFAULT 0,
  streak_first_failure_at timestamptz,
  streak_first_success_at timestamptz,
  last_check_at timestamptz,
  last_status_code integer,
  last_response_ms integer,
  last_error text,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  lock_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX form_checks_website_idx ON form_checks (website_id);
CREATE INDEX form_checks_due_idx ON form_checks (next_check_at) WHERE enabled;

CREATE TABLE website_checks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  website_id uuid NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  form_check_id uuid REFERENCES form_checks(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'http' CHECK (kind IN ('http','form')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  success boolean NOT NULL,
  status_code integer,
  response_ms integer,
  error_category text CHECK (error_category IN
    ('dns','connect','tls','timeout','http_status','redirect','ssrf_blocked','internal','other')),
  error_message text,
  redirect_count integer NOT NULL DEFAULT 0,
  final_url text,
  in_maintenance boolean NOT NULL DEFAULT false
);
CREATE INDEX website_checks_site_time_idx ON website_checks (website_id, started_at DESC);
CREATE INDEX website_checks_time_idx ON website_checks (started_at);
CREATE INDEX website_checks_form_idx ON website_checks (form_check_id, started_at DESC) WHERE form_check_id IS NOT NULL;

CREATE TABLE uptime_hourly (
  website_id uuid NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  bucket timestamptz NOT NULL,
  total integer NOT NULL,
  successful integer NOT NULL,
  failed integer NOT NULL,
  maintenance integer NOT NULL DEFAULT 0,
  avg_ms integer,
  p95_ms integer,
  min_ms integer,
  max_ms integer,
  PRIMARY KEY (website_id, bucket)
);
CREATE TABLE uptime_daily (
  website_id uuid NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  bucket date NOT NULL,
  total integer NOT NULL,
  successful integer NOT NULL,
  failed integer NOT NULL,
  maintenance integer NOT NULL DEFAULT 0,
  avg_ms integer,
  p95_ms integer,
  min_ms integer,
  max_ms integer,
  PRIMARY KEY (website_id, bucket)
);

CREATE TABLE ssl_checks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  website_id uuid NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  checked_at timestamptz NOT NULL,
  valid boolean NOT NULL,
  subject text,
  issuer text,
  valid_from timestamptz,
  valid_to timestamptz,
  days_remaining integer,
  protocol text,
  error text
);
CREATE INDEX ssl_checks_site_idx ON ssl_checks (website_id, checked_at DESC);

CREATE TABLE integrations (
  kind text PRIMARY KEY CHECK (kind IN ('ga4','search_console','pagespeed','smtp','uptime_kuma')),
  enabled boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'not_connected',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,   -- never holds secrets
  last_success_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE analytics_daily (
  website_id uuid NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  date date NOT NULL,
  active_users integer,
  sessions integer,
  page_views integer,
  engagement_rate numeric(6,4),
  conversions numeric(14,2),
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (website_id, date)
);
CREATE TABLE search_console_daily (
  website_id uuid NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  date date NOT NULL,
  clicks integer NOT NULL,
  impressions integer NOT NULL,
  ctr numeric(8,6),
  position numeric(8,3),
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (website_id, date)
);
CREATE TABLE search_console_top (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  website_id uuid NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  dimension text NOT NULL CHECK (dimension IN ('query','page')),
  key text NOT NULL,
  clicks integer NOT NULL,
  impressions integer NOT NULL,
  ctr numeric(8,6),
  position numeric(8,3),
  synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (website_id, period_start, period_end, dimension, key)
);

CREATE TABLE performance_audits (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  website_id uuid NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  strategy text NOT NULL CHECK (strategy IN ('mobile','desktop')),
  audited_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('ok','error')),
  error text,
  performance_score smallint,
  accessibility_score smallint,
  best_practices_score smallint,
  seo_score smallint,
  lcp_ms integer,
  cls numeric(8,4),
  inp_ms integer,
  fcp_ms integer,
  ttfb_ms integer,
  tbt_ms integer,
  field_data jsonb,          -- CrUX field data; NULL when Google reports none
  lab_data jsonb,
  raw_summary jsonb,
  is_baseline boolean NOT NULL DEFAULT false
);
CREATE INDEX performance_audits_site_idx ON performance_audits (website_id, audited_at DESC);
CREATE UNIQUE INDEX performance_audits_baseline_uq ON performance_audits (website_id, strategy) WHERE is_baseline;

CREATE TABLE incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  website_id uuid NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'outage' CHECK (kind IN ('outage','ssl','form')),
  dedupe_key text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('critical','high','medium','low')),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','acknowledged','investigating','resolved','reopened')),
  title text NOT NULL,
  summary text,
  started_at timestamptz NOT NULL,
  last_failure_at timestamptz,
  detected_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES users(id) ON DELETE SET NULL,
  assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  duration_seconds integer,
  auto_resolved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- deduplication: at most one unresolved incident per (website, key)
CREATE UNIQUE INDEX incidents_open_dedupe_uq ON incidents (website_id, dedupe_key) WHERE status <> 'resolved';
CREATE INDEX incidents_status_idx ON incidents (status, started_at DESC);
CREATE INDEX incidents_site_idx ON incidents (website_id, started_at DESC);
CREATE INDEX incidents_assigned_idx ON incidents (assigned_to) WHERE assigned_to IS NOT NULL;

CREATE TABLE incident_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  type text NOT NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  message text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX incident_events_incident_idx ON incident_events (incident_id, at);

-- Append-only: rows can be inserted but never updated (cascade delete with the parent incident is allowed).
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed (append-only)', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER incident_events_no_update BEFORE UPDATE ON incident_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  website_id uuid REFERENCES websites(id) ON DELETE SET NULL,
  incident_id uuid REFERENCES incidents(id) ON DELETE SET NULL,
  assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('critical','high','medium','low')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','blocked','completed','cancelled')),
  due_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_status_idx ON tasks (status, due_at);
CREATE INDEX tasks_assigned_idx ON tasks (assigned_to);
CREATE INDEX tasks_website_idx ON tasks (website_id);

CREATE TABLE task_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  type text NOT NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  message text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX task_events_task_idx ON task_events (task_id, at);

CREATE TABLE escalation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  subject text NOT NULL CHECK (subject IN ('incident','task')),
  min_severity text CHECK (min_severity IN ('critical','high','medium','low')),
  after_minutes integer NOT NULL CHECK (after_minutes >= 1),
  only_unacknowledged boolean NOT NULL DEFAULT true,
  notify_role text CHECK (notify_role IN ('admin','manager')),
  notify_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (notify_role IS NOT NULL OR notify_user_id IS NOT NULL)
);
-- one escalation message per rule per subject, ever (prevents loops/duplicates)
CREATE TABLE escalations_sent (
  rule_id uuid NOT NULL REFERENCES escalation_rules(id) ON DELETE CASCADE,
  subject_type text NOT NULL CHECK (subject_type IN ('incident','task')),
  subject_id uuid NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id, subject_type, subject_id)
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL,
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  title text NOT NULL,
  body text,
  link text,
  website_id uuid REFERENCES websites(id) ON DELETE CASCADE,
  incident_id uuid REFERENCES incidents(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  dedupe_key text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;
CREATE UNIQUE INDEX notifications_dedupe_uq ON notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL DEFAULT 'email' CHECK (channel IN ('email')),
  recipient text NOT NULL,
  subject text NOT NULL,
  body_text text NOT NULL,
  body_html text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','suppressed')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  last_error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  dedupe_key text,
  kind text NOT NULL DEFAULT 'alert',
  website_id uuid REFERENCES websites(id) ON DELETE CASCADE,
  incident_id uuid REFERENCES incidents(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deliveries_pending_idx ON notification_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX deliveries_incident_idx ON notification_deliveries (incident_id);
CREATE UNIQUE INDEX deliveries_dedupe_uq ON notification_deliveries (dedupe_key, recipient) WHERE dedupe_key IS NOT NULL;

CREATE TABLE report_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL CHECK (type IN
    ('daily','weekly','monthly','custom','website','incidents','traffic_seo','performance_ssl','tasks')),
  format text NOT NULL CHECK (format IN ('pdf','xlsx')),
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  progress integer NOT NULL DEFAULT 0,
  file_name text,
  file_path text,
  file_size bigint,
  error text,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  lock_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz,
  download_count integer NOT NULL DEFAULT 0
);
CREATE INDEX report_jobs_status_idx ON report_jobs (status, created_at);

CREATE TABLE audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  user_email text,
  action text NOT NULL,
  entity_type text,
  entity_id text,
  ip text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_logs_at_idx ON audit_logs (at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, at DESC);
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE maintenance_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  website_id uuid REFERENCES websites(id) ON DELETE CASCADE,   -- NULL = applies to all websites
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX maintenance_range_idx ON maintenance_windows (starts_at, ends_at);
CREATE INDEX maintenance_site_idx ON maintenance_windows (website_id);

CREATE TABLE system_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE scheduled_job_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_name text NOT NULL,
  worker text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','failed')),
  error text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX job_runs_name_idx ON scheduled_job_runs (job_name, started_at DESC);

CREATE TABLE worker_heartbeats (
  worker text PRIMARY KEY,
  role text NOT NULL,
  started_at timestamptz NOT NULL,
  last_beat_at timestamptz NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Singleton rows describing the optional integrations (status only; secrets stay in env).
INSERT INTO integrations (kind, status) VALUES
  ('ga4', 'not_connected'), ('search_console', 'not_connected'),
  ('pagespeed', 'not_connected'), ('smtp', 'not_connected'), ('uptime_kuma', 'not_connected');

INSERT INTO system_settings (key, value) VALUES
  ('timezone', '"UTC"'),
  ('alert_cooldown_minutes', '30'),
  ('degraded_threshold_ms', '3000'),
  ('ssl_alert_days', '[30,14,7]'),
  ('alert_recipients', '[]'),
  ('retention_checks_days', '90'),
  ('retention_hourly_days', '400'),
  ('retention_reports_days', '30'),
  ('retention_audit_days', '365'),
  ('retention_notifications_days', '180');
