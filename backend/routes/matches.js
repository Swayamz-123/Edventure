const express = require('express');
const GameMatch = require('../models/GameMatch');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.user?._id) return res.status(401).json({ error: 'Authentication required.' });
  return next();
}

router.get('/history', requireAuth, async (req, res) => {
  try {
    const userId = String(req.user._id);
    const matches = await GameMatch.find({ 'players.userId': req.user._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .select('-questions')
      .lean();

    return res.json({
      matches: matches.map(match => {
        const own = match.players.find(player => String(player.userId) === userId);
        const opponent = match.players.find(player => String(player.userId) !== userId);
        const status = match.status;
        const winner = status !== 'completed'
          ? null
          : !match.winnerUserId
            ? 'tie'
            : String(match.winnerUserId) === userId
              ? 'you'
              : 'opponent';

        return {
          gameId: match.gameId,
          subject: match.subject,
          difficulty: match.difficulty,
          classLevel: match.classLevel,
          mode: match.mode,
          status,
          startedAt: match.startedAt,
          completedAt: match.completedAt,
          durationMs: match.completedAt && match.startedAt
            ? Math.max(0, new Date(match.completedAt).getTime() - new Date(match.startedAt).getTime())
            : null,
          score: own?.score || 0,
          opponent: opponent ? { username: opponent.username, score: opponent.score || 0 } : null,
          winner,
          answered: own?.answers?.length || 0,
          questionCount: match.questions?.length || 0
        };
      })
    });
  } catch (error) {
    console.error('Match history read failed:', error?.name || 'UnknownError');
    return res.status(500).json({ error: 'Unable to load match history.' });
  }
});

module.exports = router;
