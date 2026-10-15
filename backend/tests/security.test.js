const test = require('node:test');
const assert = require('node:assert/strict');

const { toPublicUser } = require('../utils/publicUser');
const { createRateLimiter } = require('../middleware/rateLimit');
const { normalizeHistory } = require('../routes/chatbot');
const { validateQuestion, toPublicQuestion } = require('../routes/battlegrounds');
const { validateQuiz } = require('../routes/pdfQuiz');

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
