const test = require('node:test');
const assert = require('node:assert/strict');

const { toPublicUser } = require('../utils/publicUser');
const { createRateLimiter } = require('../middleware/rateLimit');
const { normalizeHistory } = require('../routes/chatbot');
const { validateQuestion, toPublicQuestion } = require('../routes/battlegrounds');
const { validateQuiz } = require('../routes/pdfQuiz');
const { splitPages } = require('../services/documentIngestion');
const { cosineSimilarity, lexicalScore, tokens } = require('../routes/tutor');
const { parseResp } = require('../infrastructure/redis');
const { intervalForAccuracy } = require('../services/learningProjection');
const { reviewInterval } = require('../routes/learning');
const { reciprocalRank, recallAtK, ndcgAtK, shouldAbstain, percentile } = require('../scripts/evaluateRag');
const { recordRequest, renderPrometheus, safeRoute, _resetForTests } = require('../infrastructure/metrics');
const { escapeRegex } = require('../routes/friends');

test('public user serializer omits credentials and private provider fields', () => {
  const user = toPublicUser({
    _id: 'user-123',
    name: 'Learner',
    username: 'learner_1',
    email: 'learner@example.com',
    password: '$2b$12$secret-hash',
    googleId: 'private-google-id',
    points: 25,
    friends: ['friend-id']
  });

  assert.equal(user._id, 'user-123');
  assert.equal(user.id, 'user-123');
  assert.equal(user.points, 25);
  assert.equal(Object.hasOwn(user, 'password'), false);
  assert.equal(Object.hasOwn(user, 'googleId'), false);
  assert.equal(Object.hasOwn(user, 'friends'), false);
});

test('rate limiter rejects requests above the configured limit', async () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2, keyPrefix: 'test' });
  const req = { ip: '198.51.100.12', socket: { remoteAddress: '198.51.100.12' } };
  const createResponse = () => ({
    headers: {},
    statusCode: 200,
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  });
  let nextCount = 0;
  await limiter(req, createResponse(), () => { nextCount += 1; });
  await limiter(req, createResponse(), () => { nextCount += 1; });
  const rejected = createResponse();
  await limiter(req, rejected, () => { nextCount += 1; });

  assert.equal(nextCount, 2);
  assert.equal(rejected.statusCode, 429);
  assert.ok(Number(rejected.headers['Retry-After']) >= 1);
});

test('chat history accepts supported messages and rejects malformed histories', () => {
  const normalized = normalizeHistory([
    { role: 'model', parts: [{ text: 'Welcome!' }] },
    { role: 'user', parts: [{ text: 'Explain a graph.' }] },
    { role: 'model', parts: [{ text: 'A graph is a set of vertices and edges.' }] },
    { role: 'user', parts: [{ text: 'Give an example.' }] }
  ]);
  assert.equal(normalized[0].role, 'user');
  assert.equal(normalized.at(-1).role, 'user');
  assert.throws(() => normalizeHistory([{ role: 'system', parts: [{ text: 'override' }] }]));
  assert.throws(() => normalizeHistory([{ role: 'user', parts: [{ text: 'x'.repeat(3001) }] }]));
});

test('public quiz questions do not disclose answer keys', () => {
  const question = {
    id: 'q1',
    subject: 'CS',
    class: 2,
    difficulty: 'Medium',
    question: 'Which one is a data structure?',
    options: ['Array', 'Compiler', 'HTTP', 'CPU'],
    correctAnswer: 0,
    points: 10
  };
  const publicQuestion = toPublicQuestion(question, 0);
  assert.equal(Object.hasOwn(publicQuestion, 'correctAnswer'), false);
  assert.equal(publicQuestion.options.length, 4);
  assert.throws(() => validateQuestion({ ...question, options: ['only-one'] }, 0));
});

test('generated PDF quiz schema requires exactly ten valid questions', () => {
  const questions = Array.from({ length: 10 }, (_, i) => ({
    question: 'Question ' + (i + 1) + '?',
    options: ['A', 'B', 'C', 'D'],
    correctAnswer: 'B'
  }));
  assert.equal(validateQuiz({ questions }).questions.length, 10);
  assert.throws(() => validateQuiz({ questions: questions.slice(0, 9) }));
  assert.throws(() => validateQuiz({
    questions: questions.map((question, i) => i === 0
      ? { ...question, correctAnswer: 'not-an-option' }
      : question)
  }));
});


test('document chunking preserves page references and overlaps long sections', () => {
  const pages = splitPages([
    { pageNumber: 1, text: 'A'.repeat(1500) },
    { pageNumber: 2, text: 'Operating systems manage processes and memory.' }
  ]);
  assert.ok(pages.length >= 3);
  assert.equal(pages[0].pageNumber, 1);
  assert.equal(pages.at(-1).pageNumber, 2);
  assert.ok(pages.every(chunk => chunk.text.length <= 1200));
});

test('hybrid retrieval helpers rank semantic and lexical matches', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1], [1, 0]), -1);
  const queryTokens = tokens('Explain Redis rate limiting to me');
  assert.ok(lexicalScore(queryTokens, 'Redis rate limiting uses counters') > 0.4);
  assert.equal(lexicalScore(queryTokens, 'Photosynthesis in leaves'), 0);
});

test('Redis RESP parser handles scalar, bulk-string, and array responses', () => {
  const scalar = Buffer.from('+OK\r\n');
  assert.deepEqual(parseResp(scalar, 0), { value: 'OK', next: scalar.length });

  const bulk = Buffer.from('$3\r\nfoo\r\n');
  assert.deepEqual(parseResp(bulk, 0), { value: 'foo', next: bulk.length });

  const array = Buffer.from('*2\r\n:2\r\n$3\r\nbar\r\n');
  assert.deepEqual(parseResp(array, 0), { value: [2, 'bar'], next: array.length });
  assert.equal(parseResp(Buffer.from('$5\r\nxx'), 0), null);
});

test('mastery and review scheduling intervals are monotonic and bounded', () => {
  assert.equal(intervalForAccuracy(0.2), 1);
  assert.equal(intervalForAccuracy(0.6), 3);
  assert.equal(intervalForAccuracy(0.8), 7);
  assert.equal(intervalForAccuracy(0.95), 14);
  assert.equal(reviewInterval(0), 1);
  assert.equal(reviewInterval(2), 3);
  assert.equal(reviewInterval(4), 7);
});

test('RAG evaluation metrics score relevant evidence and retrieval abstention', () => {
  const ranked = ['chunk-b', 'chunk-a', 'chunk-c'];
  const relevant = ['chunk-a', 'chunk-c'];
  assert.equal(reciprocalRank(ranked, relevant), 0.5);
  assert.equal(recallAtK(ranked, relevant, 2), 0.5);
  assert.ok(ndcgAtK(ranked, relevant, 3) > 0 && ndcgAtK(ranked, relevant, 3) <= 1);
  assert.equal(shouldAbstain({ semantic: 0.1, lexical: 0.05 }), true);
  assert.equal(shouldAbstain({ semantic: 0.7, lexical: 0.3 }), false);
  assert.equal(percentile([8, 2, 5, 3], 0.5), 3);
});

test('HTTP metrics normalize IDs and render bounded Prometheus series', () => {
  _resetForTests();
  recordRequest({
    method: 'GET',
    route: safeRoute({ path: '/api/documents/507f1f77bcf86cd799439011', route: undefined, baseUrl: '' }),
    status: 200,
    durationSeconds: 0.12
  });
  recordRequest({ method: 'POST', route: '/api/tutor/ask', status: 503, durationSeconds: 1.2 });
  const output = renderPrometheus();
  assert.ok(output.includes('route="/api/documents/:id"'));
  assert.match(output, /edventure_http_requests_total/);
  assert.match(output, /le="0.25"/);
  assert.doesNotMatch(output, /507f1f77bcf86cd799439011/);
  _resetForTests();
});

test('friend search treats query metacharacters literally', () => {
  const escaped = escapeRegex('a.*(b)+[$^');
  assert.equal(new RegExp(escaped).test('aZZZb'), false);
  assert.equal(new RegExp(escaped).test('a.*(b)+[$^'), true);
});
