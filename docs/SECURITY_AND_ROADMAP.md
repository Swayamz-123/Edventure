# Edventure 2.0: Security Baseline and Engineering Roadmap

## Current architecture

Edventure remains a modular monolith: React/Vite serves the learner UI, Express exposes HTTP APIs, Socket.IO provides live game events, and MongoDB persists users and learning records. The next infrastructure step is Redis and a worker queue; microservices are not a prerequisite.

## Security work in this branch

- Public user responses are serialized through an allow-list and omit password hashes, Google provider IDs, and other internal fields.
- Login and registration validate input, use generic login failures, increase bcrypt work factor, and have endpoint rate limits.
- API JSON/form payloads are bounded, CORS is restricted to configured origins plus local development, mutation requests with a foreign Origin are rejected, and common security headers are set.
- AI provider calls are on the backend. The PDF quiz endpoint requires a session, validates extracted text size, limits request volume, validates the model's JSON output, and never exposes provider failure details.
- Tutor requests have schema, message-count, and total-size validation, plus a request limit and provider timeouts.
- Quiz attempts are owner-scoped. The browser submits option indexes only; the backend determines correctness, stores results, calculates earned points, and deduplicates awards through a unique point-ledger event.
- Course costs are configured on the server. Client-provided newPoints is ignored; an atomic MongoDB update checks affordability and duplicate unlocks.
- Multiplayer joins are bound to Passport session identity. The server scores answers, ignores client-supplied time values, rejects invalid or repeated answer indexes, hides correct answers until match completion, and makes completion award idempotent.

## Known limits to close next

The current rate limiter is deliberately process-local. It is a defense-in-depth baseline for one instance and is not shared across replicas; distributed deployments need Redis-backed counters. Socket game state is still held in process memory, so a restart or multi-instance deployment is not durable. MongoDB writes are durable, but match creation and reconnect handling need more work. Solo scoring uses fixed server-calculated points per correct answer; a future answer-by-answer timing protocol can add trusted speed bonuses.

The AI tutor still answers from its prompt and conversation history; retrieval-augmented generation (RAG) over learner-owned materials has not yet been implemented. The analytics dashboard and spaced-repetition engine are also future phases. No load-test or live-provider integration result is claimed by this branch.

## Local setup

1. Copy backend/.env.example to backend/.env and set MONGO_URI, SESSION_SECRET, and the provider key(s) you use.
2. Set FRONTEND_URL and BACKEND_URL to the actual local or deployment URLs.
3. From backend, run npm ci, npm test, npm run check, and npm start.
4. From frontend, run npm ci and npm run dev.
5. The frontend needs only VITE_BACKEND_URL. Never put provider keys in VITE_* variables. Rotate any provider key that was previously exposed in a frontend bundle.

## Phase plan

### Phase 1 — Security and correctness
Complete session-backed authorization, public DTOs, request limits, authoritative scoring, owner-scoped quiz attempts, input validation, idempotent reward ledger, tests, and CI. Audit every legacy endpoint and Socket.IO event for user-controlled IDs or answer keys before production release.

### Phase 2 — Shared infrastructure
Introduce a Redis client and a Redis-backed rate limiter, BullMQ with idempotent jobs and retry/dead-letter policy, Docker Compose for local API/worker/Redis/MongoDB, centralized configuration, structured logs, and basic metrics. Use a Socket.IO Redis adapter only when deploying multiple API instances; do not treat Redis Pub/Sub as durable game storage.

### Phase 3 — Document-grounded ERA (RAG)
Add a user-owned document model and object storage, secure upload validation, async extraction/chunking/embedding jobs, page-linked chunk metadata, hybrid vector and keyword retrieval, and an answer endpoint that returns citations. Every query must enforce owner/document ACLs before context reaches the model. The tutor must abstain when retrieved evidence is insufficient and treat document contents as untrusted input.

Evaluate RAG on a fixed set of answerable and unanswerable questions using Recall@5, MRR/nDCG, citation correctness, faithfulness, latency, and cost. Add tests for cross-user retrieval, prompt injection embedded in documents, malformed PDFs, and oversized uploads before broad rollout.

### Phase 4 — Adaptive learning
Persist quiz attempts, topic tags, mastery estimates, and incorrect answers. Add a mistake notebook, revision planner, and spaced repetition inspired by SM-2. Keep mastery updates in backend services and measure delayed recall rather than reporting fabricated progress.

### Phase 5 — Durable multiplayer
Move ephemeral matchmaking and coordination into Redis, persist completed match metadata and answer records, add reconnect/resume support and a state machine, and load-test match concurrency. The server remains authoritative for identity, round state, answer acceptance, scoring, and rewards.

### Phase 6 — Portfolio-grade delivery
Add integration and security tests, a seeded demo environment, CI gates, Docker deployment documentation, observability, RAG evaluation reports, architecture diagrams, and measured p50/p95 latency/error-rate results. Resume claims should describe only code and metrics that are actually implemented and verified.
