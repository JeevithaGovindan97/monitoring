# E-mail and Google setup

## SMTP (alert e-mails)

Set `SMTP_HOST`, `SMTP_PORT` (587 + STARTTLS, or 465 with `SMTP_SECURE=true`), `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, and `ALERT_RECIPIENTS` (comma separated; more can be added in Notifications → Alert settings). Redeploy, then use **Send test e-mail**.

- A delivery is marked **sent** only after the SMTP server accepted it; otherwise it stays pending/retrying with backoff and finally **failed**, visible in the delivery log. Acceptance by the server is not proof of inbox delivery.
- Use an SMTP account that is allowed to send from `SMTP_FROM` and set SPF/DKIM for that domain so alerts do not land in spam.
- Alerts are de-duplicated and rate limited per incident (cooldown default 30 min).

## Google (GA4, Search Console, PageSpeed)

Official APIs only, using a **service account** (no personal Google passwords).

1. Google Cloud Console → create/select a project → **APIs & Services → Library**: enable *Google Analytics Data API*, *Google Search Console API* and *PageSpeed Insights API*.
2. **IAM & Admin → Service Accounts → Create**; then **Keys → Add key → JSON**. Keep the file private.
3. Provide it to the app as `GOOGLE_SERVICE_ACCOUNT_JSON` (the whole JSON on one line) in Dokploy's environment, then redeploy. The dashboard never shows the key, only the service-account e-mail (Integrations page).
4. **GA4**: for each property: Admin → Property access management → add the service-account e-mail as **Viewer**. Put the numeric Property ID on the website (Inventory → Edit → GA4 property ID).
5. **Search Console**: for each property: Settings → Users and permissions → add the service-account e-mail (**Restricted** is enough). Enter the property exactly as Search Console shows it (`sc-domain:example.com` or `https://example.com/`).
6. **PageSpeed**: create an API key (restricted to the PageSpeed Insights API) → `PAGESPEED_API_KEY`. Works without a key at a very low quota.
7. Integrations → **Test access**. A website with a property id but no access shows **Access required**; one with no property shows **Not connected**. Neither is ever displayed as zero traffic.

Data freshness: GA4 up to 24–48 h; Search Console 2–3 days; both are synced daily. Quotas and any Google Cloud charges are your responsibility; the daily syncs are small (a few requests per site).
