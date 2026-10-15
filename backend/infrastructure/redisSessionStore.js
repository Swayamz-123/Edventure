const session = require('express-session');
const redis = require('./redis');

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

class RedisSessionStore extends session.Store {
  constructor({ prefix = 'edventure:session:', client = redis } = {}) {
    super();
    this.prefix = prefix;
    this.client = client;
  }

  key(sessionId) {
    return this.prefix + sessionId;
  }

  ttlFor(sessionData) {
    const expires = sessionData?.cookie?.expires ? new Date(sessionData.cookie.expires).getTime() : NaN;
    if (Number.isFinite(expires)) return Math.max(1, Math.ceil((expires - Date.now()) / 1000));
    const maxAge = Number(sessionData?.cookie?.maxAge);
    if (Number.isFinite(maxAge) && maxAge > 0) return Math.max(1, Math.ceil(maxAge / 1000));
    return DEFAULT_TTL_SECONDS;
  }

  get(sessionId, callback) {
    this.client.command(['GET', this.key(sessionId)])
      .then(raw => {
        if (!raw) return callback(null, null);
        try {
          return callback(null, JSON.parse(raw));
        } catch (_error) {
          return callback(new Error('Stored session data is invalid.'));
        }
      })
      .catch(error => callback(error));
  }

  set(sessionId, sessionData, callback = () => {}) {
    const ttl = this.ttlFor(sessionData);
    this.client.command([
      'SET',
      this.key(sessionId),
      JSON.stringify(sessionData),
      'EX',
      ttl
    ]).then(() => callback(null)).catch(error => callback(error));
  }

  touch(sessionId, sessionData, callback = () => {}) {
    // Rewriting the same session refreshes its TTL in a single Redis command.
    this.set(sessionId, sessionData, callback);
  }

  destroy(sessionId, callback = () => {}) {
    this.client.command(['DEL', this.key(sessionId)])
      .then(() => callback(null))
      .catch(error => callback(error));
  }
}

module.exports = RedisSessionStore;
