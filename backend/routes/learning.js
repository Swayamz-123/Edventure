const express = require('express');
const mongoose = require('mongoose');
const TopicMastery = require('../models/TopicMastery');
const Mistake = require('../models/Mistake');
const LearningAnswer = require('../models/LearningAnswer');
const { createRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();
const reviewLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 30, keyPrefix: 'learning-review' });
const DAY_MS = 24 * 60 * 60 * 1000;

function requireAuth(req, res, next) {
  if (!req.user?._id) return res.status(401).json({ error: 'Authentication required.' });
  return next();
}

function reviewInterval(reviewCount) {
  if (reviewCount <= 0) return 1;
  if (reviewCount <= 2) return 3;
  return 7;
}

router.get('/overview', requireAuth, async (req, res) => {
  try {
    const userId = req.user._id;
    const now = new Date();
    const [topics, openMistakes, dueMistakes, answerCount] = await Promise.all([
      TopicMastery.find({ userId }).sort({ nextReviewAt: 1 }).limit(100).lean(),
      Mistake.countDocuments({ userId, status: 'open' }),
      Mistake.countDocuments({ userId, status: 'open', nextReviewAt: { $lte: now } }),
      LearningAnswer.countDocuments({ userId, source: 'generated' })
    ]);

    const averageMastery = topics.length
      ? topics.reduce((sum, topic) => sum + (Number(topic.mastery) || 0), 0) / topics.length
      : 0;
    const dueTopics = topics.filter(topic => new Date(topic.nextReviewAt) <= now);
    const weakTopics = [...topics]
      .sort((a, b) => (Number(a.mastery) || 0) - (Number(b.mastery) || 0))
      .slice(0, 5);

    return res.json({
      summary: {
        topicsTracked: topics.length,
        averageMastery: Number(averageMastery.toFixed(3)),
        verifiedAnswers: answerCount,
        openMistakes,
        dueMistakes
      },
      topics,
      dueTopics,
      weakTopics
    });
  } catch (error) {
    console.error('Learning overview failed:', error?.name || 'UnknownError');
    return res.status(500).json({ error: 'Unable to load learning progress.' });
  }
});

router.get('/mistakes', requireAuth, async (req, res) => {
  const status = req.query.status === 'resolved' ? 'resolved' : 'open';
  const filter = { userId: req.user._id, status };
  if (req.query.dueOnly === 'true') filter.nextReviewAt = { $lte: new Date() };

  try {
    const mistakes = await Mistake.find(filter)
      .sort({ nextReviewAt: 1, createdAt: -1 })
      .limit(100)
      .lean();
    return res.json({
      mistakes: mistakes.map(mistake => ({
        id: String(mistake._id),
        attemptId: String(mistake.attemptId),
        questionIndex: mistake.questionIndex,
        subject: mistake.subject,
        topic: mistake.topic,
        question: mistake.question,
        options: mistake.options,
        selectedAnswer: mistake.selectedAnswer,
        correctAnswer: mistake.correctAnswer,
        status: mistake.status,
        reviewCount: mistake.reviewCount,
        nextReviewAt: mistake.nextReviewAt,
        createdAt: mistake.createdAt
      }))
    });
  } catch (_error) {
    return res.status(500).json({ error: 'Unable to load the mistake notebook.' });
  }
});

router.post('/mistakes/:mistakeId/review', requireAuth, reviewLimiter, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.mistakeId)) {
    return res.status(400).json({ error: 'Invalid mistake ID.' });
  }

  try {
    const mistake = await Mistake.findOne({
      _id: req.params.mistakeId,
      userId: req.user._id,
      status: 'open'
    });
    if (!mistake) return res.status(404).json({ error: 'Open mistake not found.' });

    const now = new Date();
    const intervalDays = reviewInterval(mistake.reviewCount);
    const updated = await Mistake.findOneAndUpdate(
      {
        _id: mistake._id,
        userId: req.user._id,
        status: 'open',
        reviewCount: mistake.reviewCount
      },
      {
        $inc: { reviewCount: 1 },
        $set: {
          reviewedAt: now,
          nextReviewAt: new Date(now.getTime() + intervalDays * DAY_MS),
          updatedAt: now
        }
      },
      { new: true }
    );

    if (!updated) return res.status(409).json({ error: 'This mistake was updated in another request. Refresh and retry.' });
    return res.json({
      success: true,
      intervalDays,
      nextReviewAt: updated.nextReviewAt
    });
  } catch (_error) {
    return res.status(500).json({ error: 'Unable to schedule the next mistake review.' });
  }
});

router.post('/mistakes/:mistakeId/resolve', requireAuth, reviewLimiter, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.mistakeId)) {
    return res.status(400).json({ error: 'Invalid mistake ID.' });
  }

  try {
    const updated = await Mistake.findOneAndUpdate(
      { _id: req.params.mistakeId, userId: req.user._id, status: 'open' },
      { $set: { status: 'resolved', reviewedAt: new Date(), updatedAt: new Date() } },
      { new: true }
    );
    if (!updated) return res.status(404).json({ error: 'Open mistake not found.' });
    return res.json({ success: true, id: String(updated._id), status: updated.status });
  } catch (_error) {
    return res.status(500).json({ error: 'Unable to resolve this mistake.' });
  }
});

module.exports = router;
module.exports.reviewInterval = reviewInterval;
