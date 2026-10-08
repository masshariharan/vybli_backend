'use strict';

const { JWT } = require('google-auth-library');

const env = require('../../config/env');

/**
 * Read-only access to Google Cloud for the SMS dashboard: Cloud Monitoring
 * for what Firebase sent, the BigQuery billing export for what it cost.
 *
 * Plain REST through `google-auth-library` (already a dependency for Play
 * Billing) rather than two more client SDKs for four endpoints.
 *
 * Nothing here is on the sign-in path. A failure surfaces on the dashboard as
 * "usage unavailable" and touches nothing else.
 */

const SCOPES = [
  'https://www.googleapis.com/auth/monitoring.read',
  // `bigquery.readonly` cannot create query jobs; IAM is what keeps this
  // account read-only (jobUser + dataViewer), not the scope.
  'https://www.googleapis.com/auth/bigquery',
];

const MONITORING = 'https://monitoring.googleapis.com/v3';
const BIGQUERY = 'https://bigquery.googleapis.com/bigquery/v2';
const TIMEOUT_MS = 30_000;

let client = null;

function jwt() {
  const cfg = env.smsMonitoring;
  if (!cfg.hasCredentials) return null;
  if (!client) {
    client = new JWT({
      email: cfg.clientEmail,
      // Same "\n travels literally through an env var" fix as firebase.service.
      key: cfg.privateKey.replace(/\\n/g, '\n'),
      scopes: SCOPES,
    });
  }
  return client;
}

/** An error whose message is safe to show the operator. */
class GcpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GcpError';
    this.status = status;
  }
}

async function call(url, { method = 'GET', body } = {}) {
  const auth = jwt();
  if (!auth) throw new GcpError('No Google Cloud service account is configured.');

  let token;
  try {
    ({ token } = await auth.getAccessToken());
  } catch (err) {
    console.error('[gcp] could not obtain an access token', err.message);
    throw new GcpError('Google rejected the service-account key.');
  }

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new GcpError(err.name === 'TimeoutError' ? 'Google Cloud timed out.' : 'Could not reach Google Cloud.');
  }

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const reason = payload?.error?.message || `HTTP ${res.status}`;
    // 403 is by far the common one — a missing IAM role — so say which.
    const hint =
      res.status === 403
        ? url.startsWith(MONITORING)
          ? ' (grant the service account roles/monitoring.viewer on the project)'
          : ' (grant roles/bigquery.jobUser and roles/bigquery.dataViewer)'
        : '';
    throw new GcpError(`${reason}${hint}`.slice(0, 500), res.status);
  }
  return payload ?? {};
}

// ── Cloud Monitoring ────────────────────────────────────────────────────────

/**
 * Sums a DELTA metric into fixed buckets, grouped by labels.
 *
 * Buckets are `periodSec` long and **end at `end`**, counting backwards —
 * that is how Monitoring aligns them — so with `start` and `end` both on a
 * bucket boundary every bucket falls wholly inside one billing day.
 *
 * @returns {Array<{ labels: object, end: Date, value: number }>}
 */
async function sumMetric({ filter, start, end, periodSec, groupBy = [] }) {
  const projectId = env.smsMonitoring.projectId;
  const out = [];
  let pageToken = '';

  do {
    const q = new URLSearchParams({
      filter,
      'interval.startTime': start.toISOString(),
      'interval.endTime': end.toISOString(),
      'aggregation.alignmentPeriod': `${periodSec}s`,
      'aggregation.perSeriesAligner': 'ALIGN_SUM',
      'aggregation.crossSeriesReducer': 'REDUCE_SUM',
      pageSize: '1000',
    });
    for (const g of groupBy) q.append('aggregation.groupByFields', g);
    if (pageToken) q.set('pageToken', pageToken);

    const page = await call(`${MONITORING}/projects/${encodeURIComponent(projectId)}/timeSeries?${q}`);
    for (const series of page.timeSeries ?? []) {
      const labels = { ...(series.metric?.labels ?? {}), ...(series.resource?.labels ?? {}) };
      for (const p of series.points ?? []) {
        const v = p.value?.int64Value ?? p.value?.doubleValue ?? 0;
        out.push({ labels, end: new Date(p.interval.endTime), value: Number(v) || 0 });
      }
    }
    pageToken = page.nextPageToken || '';
  } while (pageToken);

  return out;
}

/** The Identity Platform usage metrics, documented under "identitytoolkit". */
const SMS_METRICS = {
  sent: 'identitytoolkit.googleapis.com/usage/sent_sms_count',
  verified: 'identitytoolkit.googleapis.com/usage/verification_sms_count',
  blocked: 'identitytoolkit.googleapis.com/usage/blocked_sms_count',
};

function smsMetric(kind, window) {
  return sumMetric({
    ...window,
    filter: `metric.type="${SMS_METRICS[kind]}" AND resource.type="identitytoolkit_project"`,
    groupBy: ['metric.label.region_code'],
  });
}

/**
 * `sendVerificationCode` calls that Google answered with an error — the
 * attempts that never became an SMS. From the API's own request metrics,
 * grouped by response class; the 2xx series is dropped by the caller.
 */
function sendRequestsByClass(window) {
  return sumMetric({
    ...window,
    filter:
      'metric.type="serviceruntime.googleapis.com/api/request_count" AND ' +
      'resource.type="consumed_api" AND ' +
      'resource.labels.service="identitytoolkit.googleapis.com" AND ' +
      'resource.labels.method=monitoring.regex.full_match(".*SendVerificationCode.*")',
    groupBy: ['metric.label.response_code_class'],
  });
}

// ── BigQuery billing export ─────────────────────────────────────────────────

/** `project.dataset.table`, and nothing that could escape the backticks. */
const TABLE_RE = /^[A-Za-z0-9-]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/;

function param(name, type, value) {
  return { name, parameterType: { type }, parameterValue: { value } };
}

/**
 * Runs one parameterised query and returns every row as an object.
 * Polls while BigQuery is still working rather than failing on a slow job.
 */
async function query(sql, params) {
  const cfg = env.smsMonitoring;
  const project = cfg.billingQueryProject || cfg.billingExportTable.split('.')[0];
  const location = cfg.billingLocation || undefined;

  let page = await call(`${BIGQUERY}/projects/${encodeURIComponent(project)}/queries`, {
    method: 'POST',
    body: {
      query: sql,
      useLegacySql: false,
      parameterMode: 'NAMED',
      queryParameters: params,
      timeoutMs: 20_000,
      ...(location ? { location } : {}),
    },
  });

  const job = page.jobReference;
  const rows = [];
  let schema = page.schema;
  const deadline = Date.now() + 90_000;

  for (;;) {
    if (page.jobComplete) {
      schema = page.schema ?? schema;
      rows.push(...(page.rows ?? []));
      if (!page.pageToken) break;
    } else if (Date.now() > deadline) {
      throw new GcpError('The billing query did not finish in time.');
    }
    const q = new URLSearchParams({ timeoutMs: '20000' });
    if (job.location) q.set('location', job.location);
    if (page.jobComplete && page.pageToken) q.set('pageToken', page.pageToken);
    page = await call(
      `${BIGQUERY}/projects/${encodeURIComponent(job.projectId)}/queries/${encodeURIComponent(job.jobId)}?${q}`
    );
  }

  const names = (schema?.fields ?? []).map((f) => f.name);
  return rows.map((r) => Object.fromEntries(names.map((n, i) => [n, r.f[i]?.v ?? null])));
}

/**
 * SMS charges per billing day since `since`.
 *
 * Matched on the SKU rather than an exact SKU id, because Google files phone
 * auth SMS under Identity Platform and has renamed services before; the
 * matched SKU names come back so the dashboard can show what was counted.
 */
async function smsBilling({ since, timeZone, projectId }) {
  const table = env.smsMonitoring.billingExportTable;
  if (!TABLE_RE.test(table)) {
    throw new GcpError('GCP_BILLING_EXPORT_TABLE must look like project.dataset.table.');
  }

  const sql = `
    SELECT
      FORMAT_TIMESTAMP('%Y-%m-%d', usage_start_time, @tz) AS day,
      currency,
      SUM(cost) AS cost,
      SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) AS c), 0)) AS credits,
      SUM(usage.amount) AS usage_amount,
      MAX(currency_conversion_rate) AS conversion_rate,
      MAX(export_time) AS exported_at,
      STRING_AGG(DISTINCT sku.description, ' | ') AS skus
    FROM \`${table}\`
    WHERE project.id = @project
      AND usage_start_time >= @since
      AND LOWER(sku.description) LIKE '%sms%'
      AND (LOWER(service.description) LIKE '%identity%'
           OR LOWER(service.description) LIKE '%firebase%')
    GROUP BY day, currency
    ORDER BY day`;

  const rows = await query(sql, [
    param('tz', 'STRING', timeZone),
    param('since', 'TIMESTAMP', since.toISOString()),
    param('project', 'STRING', projectId),
  ]);

  return rows.map((r) => ({
    day: r.day,
    currency: r.currency,
    cost: Number(r.cost) || 0,
    credits: Number(r.credits) || 0,
    billedSms: Number(r.usage_amount) || 0,
    conversionRate: r.conversion_rate == null ? null : Number(r.conversion_rate),
    // BigQuery returns TIMESTAMP as epoch seconds in a string.
    exportedAt: r.exported_at == null ? null : new Date(Number(r.exported_at) * 1000),
    skus: r.skus ?? '',
  }));
}

module.exports = { smsMetric, sendRequestsByClass, smsBilling, GcpError };
