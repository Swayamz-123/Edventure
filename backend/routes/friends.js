const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const { createRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();
const searchLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 30, keyPrefix: 'friend-search' });
const mutationLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 10, keyPrefix: 'friend-mutation' });

function requireAuth(req, res, next) {
  if (!req.user?._id) return res.status(401).json({ error: 'Authentication required.' });
  return next();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Search accepts a short literal query, never an arbitrary user-supplied regex.
router.get('/search', requireAuth, searchLimiter, async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 40) : '';
  if (query.length < 2) return res.json([]);

  try {
    const literal = escapeRegex(query);
    const users = await User.find({
      $and: [
        {
          $or: [
            { username: { $regex: literal, $options: 'i' } },
            { name: { $regex: literal, $options: 'i' } }
          ]
        },
        { _id: { $ne: req.user._id } }
      ]
    }).select('name username _id').limit(10).lean();

    return res.json(users.map(user => ({
      id: String(user._id),
      _id: String(user._id),
      name: user.name,
      username: user.username
    })));
  } catch (error) {
    console.error('Friend search failed:', error?.name || 'UnknownError');
    return res.status(500).json({ error: 'Unable to search for users.' });
  }
});

router.get('/', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).populate('friends', 'name username _id').lean();
    if (!user) return res.status(404).json({ error: 'User not found.' });
    return res.json((user.friends || []).map(friend => ({
      id: String(friend._id),
      _id: String(friend._id),
      name: friend.name,
      username: friend.username
    })));
  } catch (error) {
    console.error('Friend list read failed:', error?.name || 'UnknownError');
    return res.status(500).json({ error: 'Unable to load friends.' });
  }
});

router.post('/add/:friendId', requireAuth, mutationLimiter, async (req, res) => {
  const { friendId } = req.params;
  if (!mongoose.isValidObjectId(friendId)) return res.status(400).json({ error: 'Invalid user ID.' });
  if (String(req.user._id) === friendId) return res.status(400).json({ error: 'You cannot add yourself.' });

  try {
    const friend = await User.findById(friendId).select('_id name username').lean();
    if (!friend) return res.status(404).json({ error: 'User not found.' });

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $addToSet: { friends: friend._id } },
      { new: true, runValidators: true }
    ).select('_id');
    if (!user) return res.status(404).json({ error: 'User not found.' });

    return res.status(200).json({
      message: 'Friend added.',
      friend: { id: String(friend._id), name: friend.name, username: friend.username }
    });
  } catch (error) {
    console.error('Friend add failed:', error?.name || 'UnknownError');
    return res.status(500).json({ error: 'Unable to add this friend.' });
  }
});

router.delete('/remove/:friendId', requireAuth, mutationLimiter, async (req, res) => {
  const { friendId } = req.params;
  if (!mongoose.isValidObjectId(friendId)) return res.status(400).json({ error: 'Invalid user ID.' });

  try {
    const result = await User.updateOne(
      { _id: req.user._id },
      { $pull: { friends: friendId } }
    );
    if (result.matchedCount !== 1) return res.status(404).json({ error: 'User not found.' });
    return res.json({ message: 'Friend removed.' });
  } catch (error) {
    console.error('Friend removal failed:', error?.name || 'UnknownError');
    return res.status(500).json({ error: 'Unable to remove this friend.' });
  }
});

module.exports = router;

module.exports.escapeRegex = escapeRegex;
