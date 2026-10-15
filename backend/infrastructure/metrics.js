const crypto = require('node:crypto');

const BUCKET_SECONDS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
const MAX_SERIES = 200;
const series = new Map();

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function safeRoute(req) {
  const route = req.route?.path;
  const base = req.baseUrl || '';
  if (route) return (base + (route === '/' ? '' : route)) || '/';

  return String(req.path || '/')
    .split('/')
    .map(segment => {
      if (/^[a-f\\d]{24}$/i.test(segment) ||
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segment) ||
          /^\\d{2,}$/.test(segment)) return ':id';
      return segment.length > 48 ? ':segment' : segment;
    })
    .join('/') || '/';
}

function recordRequest({ method, route, status, durationSeconds }) {
  const safeMethod = String(method || 'UNKNOWN').toUpperCase().slice(0, 12);
  const safePath = String(route || '/').slice(0, 160);
  const safeStatus = Number.isInteger(Number(status)) ? Number(status) : 500;
  const labelsKey = `${safeMethod}|${safePath}|${safeStatus}`;
  let item = series.get(labelsKey);

  if (!item) {
    if (series.size >= MAX_SERIES) {
      const overflowKey = 'OVERFLOW|/__overflow__|500';
      item = series.get(overflowKey);
      if (!item) {
        item = { method: 'OVERFLOW', route: '/__overflow__', status: 500, count: 0, sum: 0, buckets: Array(BUCKET_SECONDS.length + 1).fill(0) };
        series.set(overflowKey, item);
      }
    } else {
      item = { method: safeMethod, route: safePath, status: safeStatus, count: 0, sum: 0, buckets: Array(BUCKET_SECONDS.length + 1).fill(0) };
      series.set(labelsKey, item);
    }
  }

  const duration = Number.isFinite(durationSeconds) && durationSeconds >= 0 ? durationSeconds : 0;
  item.count += 1;
  item.sum += duration;
  BUCKET_SECONDS.forEach((boundary, index) => {
    if (duration <= boundary) item.buckets[index] += 1;
  });
  item.buckets[BUCKET_SECONDS.length] += 1;
}

function requestMetricsMiddleware(req, res, next) {
  const startedAt = process.hrtime.bigint();
  res.once('finish', () => {
    const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    recordRequest({
      method: req.method,
      route: safeRoute(req),
      status: res.statusCode,
      durationSeconds
    });
  });
  return next();
}

function renderPrometheus() {
  const lines = [
    '# HELP edventure_http_requests_total Total HTTP requests observed by this process.',
    '# TYPE edventure_http_requests_total counter',
    '# HELP edventure_http_request_duration_seconds HTTP request latency histogram (process-local).',
    '# TYPE edventure_http_request_duration_seconds histogram'
  ];

  for (const item of series.values()) {
    const labels = `method="${escapeLabel(item.method)}",route="${escapeLabel(item.route)}",status="${item.status}"`;
    lines.push(`edventure_http_requests_total{${labels}} ${item.count}`);
    BUCKET_SECONDS.forEach((boundary, index) => {
      lines.push(`edventure_http_request_duration_seconds_bucket{${labels},le="${boundary}"} ${item.buckets[index]}`);
    });
    lines.push(`edventure_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${item.buckets[BUCKET_SECONDS.length]}`);
    lines.push(`edventure_http_request_duration_seconds_sum{${labels}} ${item.sum.toFixed(6)}`);
    lines.push(`edventure_http_request_duration_seconds_count{${labels}} ${item.count}`);
  }

  return lines.join('\n') + '\n';
}

function metricsHandler(req, res) {
  if (process.env.METRICS_ENABLED !== 'true' || !process.env.METRICS_TOKEN) {
    return res.sendStatus(404);
  }

  const provided = String(req.get('authorization') || '').replace(/^Bearer\\s+/i, '');
  const expected = process.env.METRICS_TOKEN;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  const allowed = providedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(providedBuffer, expectedBuffer);

  if (!allowed) return res.sendStatus(404);
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  return res.send(renderPrometheus());
}

module.exports = {
  recordRequest,
  requestMetricsMiddleware,
  renderPrometheus,
  metricsHandler,
  safeRoute,
  // Exposed for isolated unit tests only; not used by request handlers.
  _resetForTests: () => series.clear()
};
