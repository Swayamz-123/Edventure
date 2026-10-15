const express = require('express');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const QuizAttempt = require('../models/QuizAttempt');
const SavedPracticeSet = require('../models/SavedPracticeSet');
const PointLedger = require('../models/PointLedger');
const User = require('../models/User');
const { createRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();
const generatedQuestions = new Map();
const questionLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 12, keyPrefix: 'quiz-generate' });
const submitLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 20, keyPrefix: 'quiz-submit' });
const saveLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 30, keyPrefix: 'practice-save' });

function requireAuth(req, res, next) {
  if (!req.user?._id) return res.status(401).json({ error: 'Authentication required.' });
  return next();
}

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function parseJsonResponse(text) {
  const cleaned = String(text || '').trim()
    .replace(/^`{3}(?:json)?\s*/i, '')
    .replace(/\s*`{3}$/, '');
  return JSON.parse(cleaned);
}

function normalizeCorrectAnswer(question) {
  if (Number.isInteger(question?.correctAnswer) &&
      question.correctAnswer >= 0 && question.correctAnswer < 4) {
    return question.correctAnswer;
  }
  if (typeof question?.correctAnswer === 'string' && Array.isArray(question.options)) {
    return question.options.indexOf(question.correctAnswer);
  }
  return -1;
}

function validateQuestion(question, index) {
  if (!question || typeof question.question !== 'string' ||
      !question.question.trim() || question.question.length > 1000 ||
      !Array.isArray(question.options) || question.options.length !== 4 ||
      question.options.some(option => typeof option !== 'string' || !option.trim() || option.length > 500) ||
      new Set(question.options).size !== 4 ||
      normalizeCorrectAnswer(question) < 0) {
    throw new Error(`Invalid question schema at index ${index}.`);
  }

  return {
    id: cleanText(question.id, 100) || `question-${index + 1}`,
    subject: cleanText(question.subject, 60),
    class: Number(question.class) || undefined,
    difficulty: cleanText(question.difficulty, 30),
    topic: cleanText(question.topic, 80) || cleanText(question.subject, 60) || 'General',
    question: question.question.trim(),
    options: question.options.map(option => option.trim()),
    correctAnswer: normalizeCorrectAnswer(question),
    points: Number.isFinite(Number(question.points)) ? Math.max(0, Math.min(100, Number(question.points))) : 10,
    timeLimit: 30
  };
}

function toPublicQuestion(question, index) {
  const validated = validateQuestion(question, index);
  const { correctAnswer, ...publicFields } = validated;
  return publicFields;
}

async function generateQuestions(subject, difficulty, classLevel) {
  const cacheKey = `${subject.toLowerCase()}|${difficulty.toLowerCase()}|${classLevel}`;
  const cached = generatedQuestions.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.questions;

  if (!process.env.GEMINI_API_KEY) {
    throw new Error('AI question generation is not configured.');
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_QUIZ_MODEL || 'gemini-2.5-flash',
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
  });
  const prompt = `Create exactly 5 multiple-choice questions for subject "${subject}" at "${difficulty}" difficulty for class ${classLevel}.
  Return JSON only in this shape: {"questions":[{"id":"q1","subject":"...","class":${classLevel},"difficulty":"...","topic":"one specific topic","question":"...","options":["A","B","C","D"],"correctAnswer":0,"points":10,"timeLimit":30}]}.
  Each question must have four distinct options and correctAnswer must be an integer from 0 to 3. Keep every question appropriate for the selected class level.`;
  const result = await model.generateContent(prompt);
  const parsed = parseJsonResponse(result.response.text());
  if (!Array.isArray(parsed.questions) || parsed.questions.length !== 5) {
    throw new Error('AI response did not contain five questions.');
  }
  const questions = parsed.questions.map((question, index) => validateQuestion({
    ...question, subject, class: classLevel, difficulty
  }, index));
  generatedQuestions.set(cacheKey, { questions, expiresAt: Date.now() + 10 * 60 * 1000 });
  return questions;
}

function readFallbackQuestions(subject, difficulty, classLevel) {
  const filePath = path.join(__dirname, '../battlegrounds-questions.json');
  if (!fs.existsSync(filePath)) return [];
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const allQuestions = data.questions || data;
  return allQuestions
    .filter(question =>
      cleanText(question.subject, 60).toLowerCase() === subject.toLowerCase() &&
      cleanText(question.difficulty, 30).toLowerCase() === difficulty.toLowerCase() &&
      Number(question.class) === classLevel
    )
    .slice(0, 10)
    .map(validateQuestion);
}

async function questionsFor(subject, difficulty, classLevel) {
  try {
    return await generateQuestions(subject, difficulty, classLevel);
  } catch (error) {
    const fallback = readFallbackQuestions(subject, difficulty, classLevel);
    if (fallback.length) return fallback;
    throw error;
  }
}

async function createAttempt(req, res, { subject, difficulty, classLevel, kind, questions }) {
  if (!questions.length) return res.status(404).json({ error: 'No questions are available for those settings.' });
  const attempt = await QuizAttempt.create({
    userId: req.user._id,
    kind,
    subject,
    difficulty,
    classLevel,
    questions: questions.slice(0, 10)
  });
  return res.json({
    quizId: String(attempt._id),
    questions: attempt.questions.map(toPublicQuestion)
  });
}

router.get('/battlegrounds-questions', async (_req, res) => {
  try {
    const filePath = path.join(__dirname, '../battlegrounds-questions.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const questions = (data.questions || data).slice(0, 100).map(toPublicQuestion);
    return res.json(questions);
  } catch (_error) {
    return res.status(500).json({ error: 'Failed to load questions.' });
  }
});

router.get('/battlegrounds-questions/filter', requireAuth, questionLimiter, async (req, res) => {
  const subject = cleanText(req.query.subject, 60);
  const difficulty = cleanText(req.query.difficulty, 30);
  const classLevel = Number.parseInt(req.query.class, 10);
  if (!subject || !/^[\p{L}\p{N} .&'()_+-]{1,60}$/u.test(subject) ||
      !difficulty || !/^[\p{L}\p{N} ._-]{1,30}$/u.test(difficulty) ||
      !Number.isInteger(classLevel) || classLevel < 1 || classLevel > 12) {
    return res.status(400).json({ error: 'Valid subject, difficulty, and class (1–12) are required.' });
  }

  try {
    const questions = (await questionsFor(subject, difficulty, classLevel)).slice(0, 10);
    return await createAttempt(req, res, { subject, difficulty, classLevel, kind: 'generated', questions });
  } catch (error) {
    console.error('Quiz creation failed:', error?.name || 'UnknownError');
    return res.status(503).json({ error: 'Questions could not be prepared. Please try again.' });
  }
});

// Legacy game IDs are not accepted as authorization. Quiz attempts have random Mongo IDs
// and every read or submission is scoped to the authenticated owner.
router.get('/battlegrounds-questions/game/:gameId', requireAuth, (_req, res) => {
  return res.status(410).json({ error: 'This legacy route has been retired. Start a new quiz instead.' });
});

router.post('/quiz-attempts/:attemptId/submit', requireAuth, submitLimiter, async (req, res) => {
  const { attemptId } = req.params;
  const answers = req.body?.answers;
  if (!/^[a-f\d]{24}$/i.test(attemptId)) {
    return res.status(400).json({ error: 'Invalid quiz attempt ID.' });
  }
  if (!Array.isArray(answers) || answers.length < 1 || answers.length > 10 ||
      answers.some(answer => !Number.isInteger(answer) || answer < -1 || answer > 3)) {
    return res.status(400).json({ error: 'Answers must be an array of option indexes from -1 to 3.' });
  }

  try {
    const attempt = await QuizAttempt.findOne({ _id: attemptId, userId: req.user._id });
    if (!attempt) return res.status(404).json({ error: 'Quiz attempt not found.' });
    if (attempt.submittedAt) return res.json({ score: attempt.score, answers: attempt.answers, alreadySubmitted: true });
    if (answers.length !== attempt.questions.length) {
      return res.status(400).json({ error: 'Submit one answer for each question.' });
    }

    let score = 0;
    const checkedAnswers = attempt.questions.map((question, index) => {
      const selected = answers[index];
      const correctAnswer = normalizeCorrectAnswer(question);
      const isCorrect = selected !== -1 && selected === correctAnswer;
      const points = isCorrect
        ? Math.max(0, Math.min(100, Number(question.points) || 10))
        : 0;
      score += points;
      return {
        questionIndex: index,
        answerIndex: selected,
        correctAnswer,
        isCorrect,
        points,
        timeTaken: null
      };
    });

    const submittedAt = new Date();
    const saved = await QuizAttempt.findOneAndUpdate(
      { _id: attempt._id, userId: req.user._id, submittedAt: null },
      { $set: { answers: checkedAnswers, score, submittedAt } },
      { new: true }
    );
    if (!saved) {
      const existing = await QuizAttempt.findOne({ _id: attempt._id, userId: req.user._id });
      if (existing?.submittedAt) return res.json({
        score: existing.score, answers: existing.answers, alreadySubmitted: true
      });
      return res.status(409).json({ error: 'This quiz attempt has already been submitted.' });
    }

    // Points are awarded only for backend-generated quizzes, never for user-uploaded
    // or client-saved practice questions whose answer keys cannot be trusted.
    if (saved.kind === 'generated' && score > 0) {
      const eventId = `quizattempt:${saved._id}`;
      try {
        const ledger = await PointLedger.updateOne(
          { userId: saved.userId, eventId },
          { $setOnInsert: {
            userId: saved.userId,
            eventId,
            points: score,
            reason: 'verified-generated-quiz'
          } },
          { upsert: true }
        );
        if (ledger.upsertedCount === 1) {
          const updated = await User.updateOne({ _id: saved.userId }, { $inc: { points: score } });
          if (updated.matchedCount !== 1) await PointLedger.deleteOne({ userId: saved.userId, eventId });
        }
      } catch (error) {
        if (error?.code !== 11000) console.error('Verified quiz score persistence failed:', error?.name || 'UnknownError');
      }
    }

    return res.json({ score, answers: checkedAnswers, awardedPoints: saved.kind === 'generated' ? score : 0 });
  } catch (error) {
    console.error('Quiz submission failed:', error?.name || 'UnknownError');
    return res.status(500).json({ error: 'Quiz submission could not be saved.' });
  }
});

router.post('/battlegrounds-questions/save-practice', requireAuth, saveLimiter, async (req, res) => {
  const { gameId, subject, difficulty, classLevel, questions } = req.body || {};
  const sourceGameId = cleanText(gameId, 120);
  const cleanSubject = cleanText(subject, 60);
  const cleanDifficulty = cleanText(difficulty, 30);
  const parsedClassLevel = Number.parseInt(classLevel, 10);

  if (!sourceGameId ||
      !/^[\p{L}\p{N} .&'()_+-]{1,60}$/u.test(cleanSubject) ||
      !/^[\p{L}\p{N} ._-]{1,30}$/u.test(cleanDifficulty) ||
      !Number.isInteger(parsedClassLevel) || parsedClassLevel < 1 || parsedClassLevel > 12 ||
      !Array.isArray(questions) || questions.length < 1 || questions.length > 10) {
    return res.status(400).json({ error: 'Invalid practice set.' });
  }

  let sanitized;
  try {
    sanitized = questions.map((question, index) => validateQuestion({
      ...question,
      subject: cleanSubject,
      difficulty: cleanDifficulty,
      class: parsedClassLevel
    }, index));
  } catch (_error) {
    return res.status(400).json({ error: 'Every saved question must have four options and a valid answer.' });
  }

  try {
    await SavedPracticeSet.findOneAndUpdate(
      { userId: req.user._id, sourceGameId },
      {
        $setOnInsert: {
          userId: req.user._id, sourceGameId,
          subject: cleanSubject, difficulty: cleanDifficulty,
          classLevel: parsedClassLevel, questions: sanitized
        }
      },
      { upsert: true, new: true, runValidators: true }
    );
    return res.status(201).json({ success: true, message: 'Practice set saved.' });
  } catch (error) {
    console.error('Practice set save failed:', error?.name || 'UnknownError');
    return res.status(500).json({ error: 'Practice set could not be saved.' });
  }
});

router.get('/battlegrounds-questions/practice', requireAuth, questionLimiter, async (req, res) => {
  const subject = cleanText(req.query.subject, 60);
  const difficulty = cleanText(req.query.difficulty, 30);
  const classLevel = Number.parseInt(req.query.class, 10);
  if (!subject || !difficulty || !Number.isInteger(classLevel) || classLevel < 1 || classLevel > 12) {
    return res.status(400).json({ error: 'Valid subject, difficulty, and class (1–12) are required.' });
  }

  try {
    let questions = [];
    const saved = await SavedPracticeSet.find({
      userId: req.user._id,
      subject,
      difficulty,
      classLevel
    }).sort({ createdAt: -1 }).limit(20).lean();
    for (const set of saved) questions.push(...set.questions);

    // An empty personal collection falls back to newly generated content, but a
    // practice attempt does not earn points because it may include user-saved data.
    if (!questions.length) questions = await questionsFor(subject, difficulty, classLevel);
    questions = questions.slice(0, 10).map(validateQuestion);
    return await createAttempt(req, res, { subject, difficulty, classLevel, kind: 'practice', questions });
  } catch (error) {
    console.error('Practice quiz creation failed:', error?.name || 'UnknownError');
    return res.status(503).json({ error: 'Practice questions could not be prepared. Please try again.' });
  }
});

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of generatedQuestions.entries()) {
    if (value.expiresAt <= now) generatedQuestions.delete(key);
  }
}, 60_000);
cleanup.unref?.();

module.exports = router;
module.exports.generateQuestions = generateQuestions;
module.exports.validateQuestion = validateQuestion;
module.exports.toPublicQuestion = toPublicQuestion;
