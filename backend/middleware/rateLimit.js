/**
 * Lightweight process-local limiter used until the Redis-backed limiter is
 * configured. It prevents bursts on a single instance; it is NOT a shared
 * limit across replicas. Production deployments should use the Redis adapter.
 */
function createRateLimiter({ windowMs = 60_000, max = 60, keyPrefix = 'api', keyGenerator } = {}) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new TypeError('windowMs must be positive');
  if (!Number.isInteger(max) || max < 1) throw new TypeError('max must be a positive integer');

  const buckets = new Map();
  let operations = 0;

  return function rateLimit(req, res, next) {
    const now = Date.now();
    const identity = keyGenerator
      ? keyGenerator(req)
      : (req.user?._id ? String(req.user._id) : (req.ip || req.socket?.remoteAddress || 'unknown'));
    const key = `${keyPrefix}:${identity}`;
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
