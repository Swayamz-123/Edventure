const net = require('node:net');
const tls = require('node:tls');

class RedisCommandError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RedisCommandError';
  }
}

function isConfigured() {
  return Boolean(
    process.env.REDIS_URL ||
    (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  );
}

function parseResp(buffer, offset) {
  if (offset >= buffer.length) return null;
  const prefix = String.fromCharCode(buffer[offset]);
  const lineEnd = buffer.indexOf('\r\n', offset + 1);
  if (lineEnd < 0) return null;
  const line = buffer.toString('utf8', offset + 1, lineEnd);
  const nextLine = lineEnd + 2;

  if (prefix === '+') return { value: line, next: nextLine };
  if (prefix === '-') return { value: { redisError: line }, next: nextLine };
  if (prefix === ':') return { value: Number(line), next: nextLine };

  if (prefix === '$') {
    const length = Number(line);
    if (length === -1) return { value: null, next: nextLine };
    if (!Number.isInteger(length) || length < 0) throw new RedisCommandError('Invalid Redis bulk response length.');
    const bodyEnd = nextLine + length;
    if (buffer.length < bodyEnd + 2) return null;
    return { value: buffer.toString('utf8', nextLine, bodyEnd), next: bodyEnd + 2 };
  }

  if (prefix === '*') {
    const count = Number(line);
    if (count === -1) return { value: null, next: nextLine };
    if (!Number.isInteger(count) || count < 0 || count > 100000) throw new RedisCommandError('Invalid Redis array response length.');
    const values = [];
    let cursor = nextLine;
    for (let index = 0; index < count; index += 1) {
      const item = parseResp(buffer, cursor);
      if (!item) return null;
      values.push(item.value);
      cursor = item.next;
    }
    return { value: values, next: cursor };
  }

  throw new RedisCommandError('Received an unsupported Redis response type.');
}

function encodeCommand(args) {
  const parts = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    const value = String(arg);
    const bytes = Buffer.from(value, 'utf8');
    parts.push(Buffer.from(`$${bytes.length}\r\n`), bytes, Buffer.from('\r\n'));
  }
  return Buffer.concat(parts);
}

async function executeTcp(args) {
  if (!process.env.REDIS_URL) throw new Error('REDIS_URL is not configured.');
  const url = new URL(process.env.REDIS_URL);
  if (!['redis:', 'rediss:'].includes(url.protocol)) throw new Error('REDIS_URL must use redis:// or rediss://.');
  const host = url.hostname;
  const port = Number(url.port) || 6379;
  const commands = [];

  if (url.password) {
    const username = decodeURIComponent(url.username || '');
    const password = decodeURIComponent(url.password);
    commands.push(username ? ['AUTH', username, password] : ['AUTH', password]);
  }
  const dbPath = url.pathname.replace(/^\//, '');
  if (dbPath && dbPath !== '0') commands.push(['SELECT', dbPath]);
  commands.push(args);

  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    let offset = 0;
    const replies = [];
    const socket = url.protocol === 'rediss:'
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: true })
      : net.createConnection({ host, port });

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };

    socket.setTimeout(5000, () => finish(new Error('Redis command timed out.')));
    socket.once('error', error => finish(error));
    socket.once(url.protocol === 'rediss:' ? 'secureConnect' : 'connect', () => {
      try {
        socket.write(Buffer.concat(commands.map(encodeCommand)));
      } catch (error) {
        finish(error);
      }
    });

    socket.on('data', chunk => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      try {
        while (replies.length < commands.length) {
          const response = parseResp(buffer, offset);
          if (!response) return;
          replies.push(response.value);
          offset = response.next;
        }
        const commandError = replies.find(value => value && value.redisError);
        if (commandError) return finish(new RedisCommandError(commandError.redisError));
        return finish(null, replies[replies.length - 1]);
      } catch (error) {
        return finish(error);
      }
    });
  });
}

async function executeRest(args) {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error('Upstash REST credentials are not configured.');
  }
  const url = process.env.UPSTASH_REDIS_REST_URL.replace(/\/$/, '');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(5000)
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new RedisCommandError(data.error || `Redis REST request failed: ${response.status}`);
  return data.result;
}

async function command(...args) {
  if (!Array.isArray(args[0]) || args.length === 0) throw new TypeError('Redis command arguments are required.');
  if (process.env.REDIS_URL) return executeTcp(args[0]);
  return executeRest(args[0]);
}

const WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
return { count, ttl }
`;

async function incrementWindow(key, windowSeconds) {
  const result = await command(['EVAL', WINDOW_SCRIPT, 1, key, windowSeconds]);
  if (!Array.isArray(result) || result.length < 2) throw new RedisCommandError('Unexpected rate limit response.');
  return { count: Number(result[0]), ttl: Number(result[1]) };
}

async function enqueueOnce(queueName, dedupeKey, payload, ttlSeconds = 604800) {
  const serialized = JSON.stringify(payload);
  const script = `
if redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1]) then
  redis.call('LPUSH', KEYS[2], ARGV[2])
  return 1
end
return 0
`;
  const result = await command(['EVAL', script, 2, dedupeKey, queueName, ttlSeconds, serialized]);
  return Number(result) === 1;
}

module.exports = {
  isConfigured,
  command,
  incrementWindow,
  enqueueOnce,
  RedisCommandError,
  parseResp
};
