# Edventure 2.0: Architecture, Security, and Remaining Work

## Architecture today

Edventure remains a modular monolith: React/Vite is the learner UI, Express provides HTTP endpoints, Socket.IO handles real-time events, and MongoDB stores user and learning records. Optional Redis enables shared rate limits, shared sessions, and queued document ingestion. Avoid a premature microservices rewrite; prioritize domain boundaries, tests, ownership checks, and measurable behavior.

## Implemented on this branch

### Security and correctness

- Public-user responses pass through an allow-list and omit password hashes, Google provider IDs, and internal data.
- Registration/login validate input, return generic login failures, hash passwords with bcrypt, and have endpoint limits.
- JSON/form payloads are bounded. CORS origins are restricted, foreign-Origin mutations are rejected, and security headers and health endpoints are provided.
- AI provider keys stay on the backend. PDF quiz generation validates text size and generated output schema; tutor history is limited and validated.
- Quiz attempts are owner-scoped. The browser submits selected option indexes only; the backend calculates correctness and score. Unique point-ledger events protect awards against duplicate submissions.
- Course prices live on the server and atomic MongoDB updates check affordability and existing unlocks.
- Multiplayer identity derives from the Passport session. The server rejects out-of-order/duplicate answers, uses server time instead of client-reported time, and hides answer keys until a match ends.

### Shared infrastructure and delivery

- A custom Redis RESP client supports direct Redis TCP/TLS and an Upstash-compatible REST endpoint.
- Rate-limit counters use an atomic Redis Lua script when configured. Express sessions are stored in Redis when configured.
- Document ingestion can be queued through a Redis list. Job de-duplication/status writes are atomic; worker leases, retries, periodic recovery, and a dedicated worker command are included.
- Dockerfiles and Compose config provide MongoDB, password-protected Redis, the API, and an Nginx-served frontend. GitHub Actions checks backend syntax/tests and the frontend production build.
- This is a small custom Redis-list queue, not BullMQ. It is an educational queue baseline and has fewer mature scheduling, observability, and delivery guarantees than a production queue library.

### ERA RAG baseline

- A document belongs to an authenticated user and has processing/ready/failed states.
- Browser-side PDF.js extracts selectable text from up to 80 pages and 120,000 characters. Text is posted to the backend; there is no OCR for scanned PDFs.
- Page-aware chunks with overlap are embedded and stored with model identifier, owner ID, document ID, page number, and chunk index.
- Retrieval combines cosine similarity and lexical token overlap across a bounded MongoDB chunk scan and returns up to five cited passages. Queries filter by the current user and selected owned documents. The answer prompt treats document text as untrusted data and asks for citations; the API abstains when the top relevance score is low.
- The study UI provides upload/index status, document selection, ERA questions, citations, and document deletion.

### Adaptive learning baseline

- Server-verified generated-quiz answers are persisted as idempotent events. Incorrect answers populate a private mistake notebook.
- Topic mastery uses confidence-adjusted accuracy, with a simple 1/3/7/14-day review interval based on recent aggregate accuracy. Users can record a review or mark a mistake learned.
- The dashboard presents mastery, verified answer counts, due reviews, and lowest-mastery topics.
- Legacy saved practice sets do not contribute to mastery or points because their answer keys may originate from user-controlled data.

## Important limitations

- RAG indexing is not a hardened production file-ingestion pipeline. Parsing happens in the browser; there is no OCR, server-side malware scan, upload quarantine, or object-storage lifecycle.
- Retrieval scans and ranks a bounded MongoDB result set; it does not use Atlas Vector Search or a scalable vector index. RAG quality has not yet been scored on a labelled evaluation set. Similarity thresholds are starter heuristics.
- The Redis client/queue has parser tests, but has not been tested against hosted Redis fault modes, worker crashes under load, or multi-region deployment. There is no dead-letter dashboard or full distributed tracing.
- When Redis is not configured, rate limits fall back to process-local memory and are not shared across replicas.
- If RUN_DOCUMENT_WORKER=false, a worker must run separately using npm run worker; otherwise queued jobs wait until a worker starts.
- Accepted answers, scores, and match records are persisted in MongoDB, and an owner-scoped match-history API is available. Live matchmaking/game state remains in a process-local Map, so active matches do not resume after server restart and state is not shared across API instances. Redis sessions are not multiplayer-state persistence; no Socket.IO Redis adapter or resume protocol is wired yet.
- Solo generated quizzes use server-side fixed scoring without a trusted per-answer speed bonus. Multiplayer's speed bonus uses server-side timestamps.
- The mastery estimate and review schedule are instructional heuristics, not validated learning-science outcomes.
- Legacy routes and interactions outside these additions still need a complete security review, cross-user authorization regression tests, dependency auditing, and deployment-specific cookie/CORS tests.
- No real-provider integration test, RAG quality result, p95 latency, cost result, or concurrency benchmark is claimed until run.

## Local setup

### Without Docker

1. Copy backend/.env.example to backend/.env.
2. Set MONGO_URI, a long random SESSION_SECRET, FRONTEND_URL=http://localhost:5173, BACKEND_URL=http://localhost:5000, and the server-side Gemini key(s) you need.
3. Optional Redis: configure REDIS_URL=redis://localhost:6379 or both Upstash REST variables.
4. From backend, run npm ci, npm run check, npm test, and npm start.
5. In another terminal, from frontend, copy .env.example to .env, keep VITE_BACKEND_URL=http://localhost:5000, then run npm ci and npm run dev.

### Docker Compose

1. Copy .env.docker.example to the repository root .env.
2. Replace REDIS_PASSWORD with a random strong value (for example, generate one with openssl rand -hex 32).
3. Copy backend/.env.example to backend/.env and set SESSION_SECRET and GEMINI_API_KEY.
4. Run docker compose config -q, then docker compose up --build.
5. Frontend: http://localhost:4173; API: http://localhost:5000.

Use docker compose down to stop containers while preserving volumes. docker compose down -v also deletes the local data volumes.

### Production secrets

Never commit .env files. Never use VITE_* for provider keys because Vite embeds those values in browser bundles. If a key was previously published as a Vite variable, rotate it before deployment. Configure the real frontend/backend hostnames, secure cookie/SameSite behavior, HTTPS and proxy-trust settings for your deployment topology.

## Next engineering work

### Phase A — Close the security foundation
Audit every legacy route and socket event for broken object-level authorization, property exposure, unauthorized state changes, and resource exhaustion. Add route integration tests with two distinct users. Verify login/logout, session persistence, concurrent course unlocks, point-ledger idempotency, and upload ownership against a disposable MongoDB.

### Phase B — Strengthen shared infrastructure
Choose whether to retain the custom Redis queue or adopt BullMQ. Add worker fault tests, queue-depth/retry/job-duration metrics, and structured request logs. Add a Socket.IO Redis adapter for multi-instance deployment only once tested. Make active-match state transitions recoverable and implement reconnect/resume; completed match records and accepted answer history are already persisted.

### Phase C — RAG quality and ingestion
Move binary uploads behind a validated multipart endpoint and private object storage. Retain strict limits, parsing isolation, and deletion rules. Add Atlas Vector Search or another scalable index. Build a labelled evaluation set and report Recall@5, MRR/nDCG@5, citation correctness, faithfulness, abstention accuracy, p50/p95 latency, and cost per question. Test cross-user access, document prompt injection, empty/scanned PDFs, malformed/oversized files, and provider failures.

### Phase D — Adaptive learning
Use a reviewed topic taxonomy instead of relying only on model-generated topic labels. Add attempt timing, item difficulty, delayed-recall evaluation, and a more rigorous spaced-repetition model. Version the mastery formula so historical dashboards remain interpretable.

### Phase E — Portfolio delivery
Document APIs and invariants, add seeded demo data that contains no credentials, diagrams, threat model, dependency audit reporting, and repeatable load tests. Publish benchmark values only after running them in a named environment; resume bullets must match implemented code and measured results.


## RAG evaluation workflow

The live retrieval harness is backend/scripts/evaluateRag.js. Copy backend/evaluation/rag-cases.example.json to a private/custom dataset, upload the relevant benchmark source material to a dedicated evaluation account, and annotate each answerable case with the correct MongoDB chunk IDs in relevantChunkIds. Optionally provide documentIds to restrict retrieval and citedChunkIds plus acceptableCitationChunkIds for human-annotated citation precision. Set RAG_EVAL_USER_ID, RAG_EVAL_DATASET, MONGO_URI and GEMINI_API_KEY, then run npm run evaluate:rag from backend. The report includes Recall@5, MRR, nDCG@5, configured-threshold abstention accuracy and retrieval latency percentiles. Claim-level faithfulness/citation support still require an external human or validated-grader rubric; no quality metric is fabricated by the script.

The optional Prometheus-compatible /metrics endpoint is disabled by default; enable it with METRICS_ENABLED=true and a strong METRICS_TOKEN. It uses a bounded set of process-local HTTP series. For multi-instance operations, connect to a metrics collector and choose appropriate service-level retention and alerting rather than treating these counters as distributed.
