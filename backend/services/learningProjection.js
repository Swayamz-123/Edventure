const LearningAnswer = require('../models/LearningAnswer');
const TopicMastery = require('../models/TopicMastery');
const Mistake = require('../models/Mistake');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ANSWERS_FOR_MASTERY = 2000;

function intervalForAccuracy(accuracy) {
  if (accuracy >= 0.9) return 14;
  if (accuracy >= 0.75) return 7;
  if (accuracy >= 0.55) return 3;
  return 1;
}

async function projectAttempt(attempt) {
  if (!attempt || attempt.kind !== 'generated' || !attempt.submittedAt ||
      !attempt.userId || !Array.isArray(attempt.questions) || !Array.isArray(attempt.answers)) {
    return { projected: 0, mistakes: 0, topics: 0 };
  }

  let projected = 0;
  let mistakes = 0;
  const userId = attempt.userId;

  for (let index = 0; index < attempt.questions.length; index += 1) {
    const question = attempt.questions[index];
    const answer = attempt.answers[index];
    if (!question || !answer || !Number.isInteger(answer.correctAnswer)) continue;

    const selectedAnswer = Number.isInteger(answer.answerIndex) ? answer.answerIndex : -1;
    const isCorrect = Boolean(answer.isCorrect);
    const subject = String(question.subject || attempt.subject || 'General').slice(0, 60);
    const topic = String(question.topic || subject || 'General').slice(0, 80);
    const event = {
      userId,
      attemptId: attempt._id,
      questionIndex: index,
      source: 'generated',
      subject,
      topic,
      question: String(question.question || '').slice(0, 1000),
      selectedAnswer,
      correctAnswer: answer.correctAnswer,
      isCorrect,
      createdAt: attempt.submittedAt
    };

    await LearningAnswer.updateOne(
      { userId, attemptId: attempt._id, questionIndex: index },
      { $setOnInsert: event },
      { upsert: true }
    );
    projected += 1;

    if (!isCorrect) {
      await Mistake.updateOne(
        { userId, attemptId: attempt._id, questionIndex: index },
        {
          $setOnInsert: {
            userId,
            attemptId: attempt._id,
            questionIndex: index,
            subject,
            topic,
            question: event.question,
            options: Array.isArray(question.options) ? question.options.map(option => String(option).slice(0, 500)) : [],
            selectedAnswer,
            correctAnswer: answer.correctAnswer,
            status: 'open',
            reviewCount: 0,
            nextReviewAt: attempt.submittedAt,
            createdAt: attempt.submittedAt,
            updatedAt: attempt.submittedAt
          }
        },
        { upsert: true }
      );
      mistakes += 1;
    }
  }

  const summary = await LearningAnswer.aggregate([
    { $match: { userId, source: 'generated' } },
    { $sort: { createdAt: -1 } },
    { $limit: MAX_ANSWERS_FOR_MASTERY },
    {
      $group: {
        _id: { subject: '$subject', topic: '$topic' },
        attempts: { $sum: 1 },
        correctCount: { $sum: { $cond: ['$isCorrect', 1, 0] } },
        lastPracticedAt: { $max: '$createdAt' }
      }
    }
  ]);

  for (const stats of summary) {
    const attempts = Number(stats.attempts) || 0;
    const correctCount = Number(stats.correctCount) || 0;
    if (!attempts) continue;
    const accuracy = correctCount / attempts;
    // Require repeated evidence before mastery approaches 1.0.
    const mastery = accuracy * Math.min(1, attempts / 5);
    const intervalDays = intervalForAccuracy(accuracy);
    const lastPracticedAt = new Date(stats.lastPracticedAt || attempt.submittedAt);
    const nextReviewAt = new Date(lastPracticedAt.getTime() + intervalDays * DAY_MS);

    await TopicMastery.updateOne(
      {
        userId,
        subject: stats._id.subject,
        topic: stats._id.topic
      },
      {
        $set: {
          attempts,
          correctCount,
          accuracy,
          mastery,
          intervalDays,
          lastPracticedAt,
          nextReviewAt,
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );
  }

  return { projected, mistakes, topics: summary.length };
}

module.exports = { projectAttempt, intervalForAccuracy };
