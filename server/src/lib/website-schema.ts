import { z } from 'zod';
import { config } from '../config.js';
import { isValidExpectedStatus } from './status.js';
import { SsrfError, validateMonitorUrl } from '../security/ssrf.js';

export const HOSTING = ['vps', 'docker', 'dokploy', 'managed', 'shared', 'cloud', 'other'] as const;
export const ENVIRONMENTS = ['production', 'staging', 'development'] as const;
export const CRITICALITY = ['critical', 'high', 'medium', 'low'] as const;
export const MON_STATUS = ['active', 'disabled', 'archived'] as const;
export const FORM_TYPES = ['none', 'contact', 'login', 'booking', 'checkout', 'other'] as const;
export const INTEGRATION_STATUS = ['connected', 'access_required', 'not_connected', 'error', 'not_applicable'] as const;

export function normalizeUrl(raw: string): string {
  const u = new URL(raw.trim());
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = '';
  let s = u.toString();
  if (u.pathname === '/' && !u.search) s = s.replace(/\/$/, '');
  return s;
}

export const urlField = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .superRefine((v, ctx) => {
    try {
      validateMonitorUrl(v, { allowPrivate: config().ALLOW_PRIVATE_TARGETS });
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: e instanceof SsrfError ? e.message : 'Invalid URL' });
    }
  });

const statusExpr = z.string().trim().refine(isValidExpectedStatus, 'Use status codes or ranges like "200-399" or "200,204,301-302"');
const propertyId = z
  .string()
  .trim()
  .regex(/^(properties\/)?\d{5,15}$/, 'GA4 property ID must be numeric (e.g. 123456789)')
  .transform((v) => v.replace(/^properties\//, ''));

export const websiteFields = {
  name: z.string().trim().min(1).max(200),
  url: urlField,
  health_check_url: urlField.nullish().or(z.literal('').transform(() => null)),
  hosting_type: z.enum(HOSTING),
  environment: z.enum(ENVIRONMENTS),
  owner: z.string().trim().max(200).nullish(),
  criticality: z.enum(CRITICALITY),
  monitoring_status: z.enum(MON_STATUS),
  expected_status: statusExpr,
  check_interval_seconds: z.coerce.number().int().min(60).max(86400),
  timeout_ms: z.coerce.number().int().min(1000).max(60000),
  max_redirects: z.coerce.number().int().min(0).max(20),
  degraded_threshold_ms: z.coerce.number().int().min(100).nullish(),
  fail_threshold: z.coerce.number().int().min(1).max(20),
  recover_threshold: z.coerce.number().int().min(1).max(20),
  ssl_check_enabled: z.boolean(),
  ssl_failure_is_outage: z.boolean(),
  performance_audit_enabled: z.boolean(),
  performance_interval_hours: z.coerce.number().int().min(1).max(720),
  form_type: z.enum(FORM_TYPES),
  ga4_property_id: propertyId.nullish().or(z.literal('').transform(() => null)),
  gsc_property_url: z
    .string()
    .trim()
    .max(2048)
    .refine((v) => v === '' || /^(sc-domain:[^\s/]+|https?:\/\/\S+)$/.test(v), 'Use "sc-domain:example.com" or a full URL property')
    .nullish()
    .transform((v) => (v ? v : null)),
  ga4_status: z.enum(INTEGRATION_STATUS),
  gsc_status: z.enum(INTEGRATION_STATUS),
  notes: z.string().max(5000).nullish(),
  alert_preferences: z
    .object({ email: z.boolean(), in_app: z.boolean() })
    .partial()
    .optional(),
};

export const websiteDefaults = {
  hosting_type: 'other' as const,
  environment: 'production' as const,
  criticality: 'medium' as const,
  monitoring_status: 'active' as const,
  expected_status: '200-399',
  check_interval_seconds: 300,
  timeout_ms: 10000,
  max_redirects: 5,
  fail_threshold: 2,
  recover_threshold: 2,
  ssl_check_enabled: true,
  ssl_failure_is_outage: false,
  performance_audit_enabled: true,
  performance_interval_hours: 24,
  form_type: 'none' as const,
  ga4_status: 'not_connected' as const,
  gsc_status: 'not_connected' as const,
};

export const createWebsiteSchema = z.object({
  ...websiteFields,
  hosting_type: websiteFields.hosting_type.default(websiteDefaults.hosting_type),
  environment: websiteFields.environment.default(websiteDefaults.environment),
  criticality: websiteFields.criticality.default(websiteDefaults.criticality),
  monitoring_status: websiteFields.monitoring_status.default(websiteDefaults.monitoring_status),
  expected_status: websiteFields.expected_status.default(websiteDefaults.expected_status),
  check_interval_seconds: websiteFields.check_interval_seconds.default(websiteDefaults.check_interval_seconds),
  timeout_ms: websiteFields.timeout_ms.default(websiteDefaults.timeout_ms),
  max_redirects: websiteFields.max_redirects.default(websiteDefaults.max_redirects),
  fail_threshold: websiteFields.fail_threshold.default(websiteDefaults.fail_threshold),
  recover_threshold: websiteFields.recover_threshold.default(websiteDefaults.recover_threshold),
  ssl_check_enabled: websiteFields.ssl_check_enabled.default(true),
  ssl_failure_is_outage: websiteFields.ssl_failure_is_outage.default(false),
  performance_audit_enabled: websiteFields.performance_audit_enabled.default(true),
  performance_interval_hours: websiteFields.performance_interval_hours.default(24),
  form_type: websiteFields.form_type.default('none'),
  ga4_status: websiteFields.ga4_status.default('not_connected'),
  gsc_status: websiteFields.gsc_status.default('not_connected'),
});
export type CreateWebsite = z.infer<typeof createWebsiteSchema>;

export const updateWebsiteSchema = z.object(websiteFields).partial();
