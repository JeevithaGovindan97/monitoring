# How uptime and status are calculated

- **Check**: an HTTP GET of the website (or its health-check URL) every `check_interval_seconds` (default 300 s), with a timeout, a redirect limit and an expected status range (default 200–399). Redirect targets are re-validated (SSRF guard) at every hop, and the connection is pinned to the validated IP address.
- **Response time**: time until response headers arrive.
- **Uptime %** = successful ÷ (successful + failed) scheduled checks in the period. Maintenance-window checks are excluded. A period with no observations shows **"No data"**, never 100 %.
- **Coverage** (website Uptime tab) = share of expected checks that were actually recorded. Low coverage means the worker was not running — treat the percentage with care.
- **Incident rule**: opens after `fail_threshold` consecutive failures (default 2), resolves after `recover_threshold` consecutive successes (default 2). One open incident per website and problem type (de-duplicated). Manual resolve while still failing opens a fresh incident on the next failed check.
- **Degraded**: a *successful* response slower than the degraded threshold (default 3000 ms). Degraded is not downtime.
- **Status "Unknown"**: no check yet, or the last check is older than 3 intervals (e.g. the worker stopped). **"Not monitored"**: disabled or archived. These never count as Online.
- **SSL**: certificate checked every 6 hours; alerts at 30/14/7 days and when expired/invalid. A certificate problem is not downtime unless the website is set to treat it as an outage.
- **Aggregates**: hourly summaries (≤14-day ranges) and daily summaries (longer); percentiles come from raw checks.
- **Limits**: single vantage point; a failure may be a network problem between this server and the site.
