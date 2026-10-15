const crypto = require('node:crypto');
const redis = require('../infrastructure/redis');

/**
 * Redis-backed fixed-window limiter when REDIS_URL or Upstash REST credentials
 * are configured. The process-local fallback keeps local development runnable,
 * but it does not provide a shared limit across API instances.
 */
function createRateLimiter({ windowMs = 60_000, max = 60, keyPrefix = 'api', keyGenerator } = {}) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new TypeError('windowMs must be positive');
  if (!Number.isInteger(max) || max < 1) throw new TypeError('max must be a positive integer');

  const buckets = new Map();
  const windowSeconds = Math.max(1, Math.ceil(windowMs / 1000));
  let operations = 0;

  return async function rateLimit(req, res, next) {
    const now = Date.now();
    const identity = keyGenerator
      ? String(keyGenerator(req) || 'unknown')
      : (req.user?._id ? String(req.user._id) : (req.ip || req.socket?.remoteAddress || 'unknown'));
    const hashedIdentity = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32);

    if (redis.isConfigured()) {
      const key = `edventure:rate-limit:${keyPrefix}:${hashedIdentity}`;
      try {
        const result = await redis.incrementWindow(key, windowSeconds);
        const remaining = Math.max(0, max - result.count);
        const ttl = Math.max(1, result.ttl > 0 ? result.ttl : windowSeconds);
        res.set('RateLimit-Limit', String(max));
        res.set('RateLimit-Remaining', String(remaining));
        res.set('RateLimit-Reset', String(Math.ceil((now + ttl * 1000) / 1000)));

        if (result.count > max) {
          res.set('Retry-After', String(ttl));
          return res.status(429).json({
            error: 'Too many requests. Please wait before trying again.',
            retryAfterSeconds: ttl
          });
        }
        return next();
      } catch (error) {
        // Fail closed: a configured but unavailable shared limiter should not
        // silently fall back to per-process limits on a multi-instance service.
        console.error('Redis rate limiter unavailable:', error?.name || 'UnknownError');
        return res.status(503).json({ error: 'Request protection is temporarily unavailable. Please retry.' });
      }
    }

    const key = `${keyPrefix}:${hashedIdentity}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, max - bucket.count);
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(remaining));
    res.set('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    // Amortize cleanup rather than scanning every bucket for every request.
    operations += 1;
    if (operations % 250 === 0) {
      for (const [storedKey, storedBucket] of buckets) {
        if (storedBucket.resetAt <= now) buckets.delete(storedKey);
      }
    }

    if (bucket.count > max) {
      res.set('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        error: 'Too many requests. Please wait before trying again.',
        retryAfterSeconds
      });
    }

    return next();
  };
}

module.exports = { createRateLimiter };
