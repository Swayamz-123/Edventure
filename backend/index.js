require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const session = require('express-session');
const passport = require('passport');
const { createServer } = require('http');
const { Server } = require('socket.io');
const authRoutes = require('./routes/auth');
const battlegroundsRoutes = require('./routes/battlegrounds');
const friendsRoutes = require('./routes/friends');
const chatbotRoutes = require('./routes/chatbot');
const pdfQuizRoutes = require('./routes/pdfQuiz');
const documentsRoutes = require('./routes/documents');
const tutorRoutes = require('./routes/tutor');
const { resumePendingDocuments } = require('./services/documentIngestion');
const redis = require('./infrastructure/redis');
const { startDocumentQueueWorker } = require('./infrastructure/jobQueue');
const RedisSessionStore = require('./infrastructure/redisSessionStore');
const User = require('./models/User');
const { generateQuestions } = require('./routes/battlegrounds');
const { createRateLimiter } = require('./middleware/rateLimit');

const app = express();
const server = createServer(app);
const PORT = Number(process.env.PORT) || 5000;
const allowedOrigins = [...new Set([
  process.env.FRONTEND_URL,
  'http://localhost:5173',
  'http://localhost:3000'
].filter(Boolean))];

const sessionSecret = process.env.SESSION_SECRET || process.env.JWT_SECRET;
if (!sessionSecret) {
  throw new Error('SESSION_SECRET must be configured (use a long, random secret).');
}

if (process.env.TRUST_PROXY === 'true') {
  // Enable only when the deployment has exactly one trusted reverse proxy.
  app.set('trust proxy', 1);
} else {
  app.set('trust proxy', false);
}

const sessionMiddleware = session({
  name: 'connect.sid',
  store: redis.isConfigured() ? new RedisSessionStore() : undefined,
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 24 * 60 * 60 * 1000
  },
  proxy: process.env.TRUST_PROXY === 'true'
});

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Attach the same session and Passport middleware to Socket.IO handshakes so
// socket handlers can use a server-verified identity rather than client IDs.
io.engine.use(sessionMiddleware);
io.engine.use(passport.initialize());
io.engine.use(passport.session());

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

// CORS alone is not CSRF protection. Reject browser mutations with a foreign Origin.
app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const origin = req.get('origin');
    if (origin && !allowedOrigins.includes(origin)) {
      return res.status(403).json({ error: 'Request origin is not allowed.' });
    }
  }
  return next();
});

const apiLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 120, keyPrefix: 'api' });
app.use('/auth', apiLimiter);
app.use('/api', apiLimiter);

app.get('/', (_req, res) => res.json({ service: 'Edventure API', status: 'ok' }));
app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
app.get('/health/ready', async (_req, res) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ status: 'not-ready', database: 'disconnected' });
  }

  let redisStatus = 'not-configured';
  if (redis.isConfigured()) {
    try {
      await redis.command(['PING']);
      redisStatus = 'connected';
    } catch (_error) {
      return res.status(503).json({ status: 'not-ready', database: 'connected', redis: 'disconnected' });
    }
  }

  return res.json({ status: 'ready', database: 'connected', redis: redisStatus });
});

app.use('/auth', authRoutes);
app.use('/api', battlegroundsRoutes);
app.use('/api/friends', friendsRoutes);
app.use('/api/chatbot', chatbotRoutes);
app.use('/api/pdf-quiz', pdfQuizRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/tutor', tutorRoutes);

const registerGameHandlers = require('./gameRooms');
registerGameHandlers(io, generateQuestions, User);

app.use((error, _req, res, _next) => {
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body is too large.' });
  }
  if (error?.message === 'Origin is not allowed by CORS') {
    return res.status(403).json({ error: 'Request origin is not allowed.' });
  }
  console.error('Unhandled request error:', error?.name || 'UnknownError');
  return res.status(500).json({ error: 'Internal server error.' });
});

async function start() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI must be configured.');
  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 10_000
  });
  console.log('MongoDB connected');
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '0.0.0.0', () => {
      server.off('error', reject);
      console.log(`Edventure API listening on port ${PORT}`);
      if (redis.isConfigured()) {
        if (process.env.RUN_DOCUMENT_WORKER !== 'false') {
          try {
            startDocumentQueueWorker();
          } catch (error) {
            console.error('Unable to start the Redis document queue worker:', error.message);
          }
        }
      } else {
        // Without Redis, process durable pending documents in-process after a restart.
        resumePendingDocuments().catch(error => {
          console.error('Unable to resume pending document jobs:', error?.name || 'UnknownError');
        });
      }
      resolve();
    });
  });
}

if (require.main === module) {
  start().catch(error => {
    console.error('Unable to start Edventure API:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { app, server, start, io };
