const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const User = require('../models/User');
const bcrypt = require('bcryptjs');
const { toPublicUser } = require('../utils/publicUser');
const { createRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();
const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10, keyPrefix: 'login' });
const registerLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 5, keyPrefix: 'register' });

// This must be configured explicitly for the deployed backend; local development
// defaults to localhost. Never hard-code a production host in application code.
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  const backendUrl = (process.env.BACKEND_URL ||
    (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5000')).replace(/\/$/, '');
  if (!backendUrl) {
    console.error('BACKEND_URL must be configured when Google OAuth is enabled in production.');
  } else {
    passport.use(new GoogleStrategy({
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${backendUrl}/auth/google/callback`
    }, async (_accessToken, _refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value?.toLowerCase();
        if (!email) return done(new Error('Google profile did not include an email.'));
        let user = await User.findOne({ googleId: profile.id });
        if (!user) {
          user = await User.findOne({ email });
          if (user) {
            // Do not silently link accounts without a verified linking flow.
            return done(null, false, { message: 'An account with this email already exists.' });
          }
          user = await User.create({
            googleId: profile.id,
            name: profile.displayName || 'Learner',
            email,
            profilePicture: profile.photos?.[0]?.value || ''
          });
        }
        return done(null, user);
      } catch (error) {
        return done(error, null);
      }
    }));
  }
} else {
  console.warn('Google OAuth disabled: GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are not configured.');
}

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user || false);
  } catch (error) {
    done(error, null);
  }
});

router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
router.get('/google/callback', passport.authenticate('google', { failureRedirect: '/login' }), (req, res) => {
  res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/dashboard`);
});

function destroySession(req, res, redirect = false) {
  const finish = () => {
    res.clearCookie('connect.sid', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'
    });
    if (redirect) return res.redirect(process.env.FRONTEND_URL || '/');
    return res.sendStatus(204);
  };

  if (req.logout) {
    return req.logout(() => {
      if (req.session) return req.session.destroy(() => finish());
      return finish();
    });
  }
  if (req.session) return req.session.destroy(() => finish());
  return finish();
}

router.get('/logout', (req, res) => destroySession(req, res, true));
router.post('/logout', (req, res) => destroySession(req, res));

router.get('/current_user', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  return res.json(toPublicUser(req.user));
});

router.post('/update_profile', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const { username, age, class: classLevel, subjects } = req.body || {};
  const update = {};
  if (username !== undefined) {
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
      return res.status(400).json({ error: 'Username must be 3–24 letters, numbers, or underscores.' });
    }
    update.username = username;
  }
  if (age !== undefined) {
    if (!Number.isInteger(age) || age < 5 || age > 120) {
      return res.status(400).json({ error: 'Age is invalid.' });
    }
    update.age = age;
  }
  if (classLevel !== undefined) {
    if (!Number.isInteger(classLevel) || classLevel < 1 || classLevel > 12) {
      return res.status(400).json({ error: 'Class must be between 1 and 12.' });
    }
    update.class = classLevel;
  }
  if (subjects !== undefined) {
    if (!Array.isArray(subjects) || subjects.length > 20 ||
        subjects.some(subject => typeof subject !== 'string' || subject.trim().length < 1 || subject.length > 60)) {
      return res.status(400).json({ error: 'Subjects must be an array of at most 20 short strings.' });
    }
    update.subjects = [...new Set(subjects.map(subject => subject.trim()))];
  }
  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: 'Provide at least one profile field to update.' });
  }

  try {
    const user = await User.findByIdAndUpdate(req.user._id, { $set: update }, {
      new: true, runValidators: true
    });
    if (!user) return res.status(404).json({ error: 'User not found.' });
    return res.json({ message: 'Profile updated', user: toPublicUser(user) });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: 'That username is already in use.' });
    return res.status(400).json({ error: 'Profile could not be updated with those values.' });
  }
});

// Intentionally disabled: accepting a points delta from the browser makes scores
// forgeable. Verified quiz/game completion handlers must award points server-side.
router.post('/update_points', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  return res.status(410).json({
    error: 'Client-submitted point updates are disabled. Points must come from a verified server-side attempt.'
  });
});

router.get('/leaderboard', async (req, res) => {
  try {
    const top = await User.find({}).sort({ points: -1 }).limit(10)
      .select('name username points badges');
    let rank = null;
    if (req.user) {
      const better = await User.countDocuments({ points: { $gt: req.user.points } });
      rank = better + 1;
    }
    return res.json({ top, rank });
  } catch (_error) {
    return res.status(500).json({ error: 'Unable to load the leaderboard.' });
  }
});

router.post('/register', registerLimiter, async (req, res) => {
  const body = req.body || {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = body.password;
  const { age, subjects } = body;
  const classLevel = body.class;

  if (name.length < 1 || name.length > 80 ||
      !/^[a-zA-Z0-9_]{3,24}$/.test(username) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      typeof password !== 'string' || password.length < 8 || password.length > 128) {
    return res.status(400).json({
      error: 'Provide a name, a valid username/email, and a password between 8 and 128 characters.'
    });
  }
  if (age !== undefined && (!Number.isInteger(age) || age < 5 || age > 120)) {
    return res.status(400).json({ error: 'Age is invalid.' });
  }
  if (classLevel !== undefined && (!Number.isInteger(classLevel) || classLevel < 1 || classLevel > 12)) {
    return res.status(400).json({ error: 'Class must be between 1 and 12.' });
  }
  if (subjects !== undefined && (!Array.isArray(subjects) || subjects.length > 20 ||
      subjects.some(subject => typeof subject !== 'string' || subject.length > 60))) {
    return res.status(400).json({ error: 'Subjects are invalid.' });
  }

  try {
    const existing = await User.findOne({ $or: [{ email }, { username }] }).select('_id');
    if (existing) return res.status(409).json({ error: 'An account with this email or username already exists.' });
    const user = await User.create({
      name, username, email, password: await bcrypt.hash(password, 12),
      age, class: classLevel,
      subjects: Array.isArray(subjects) ? subjects.map(subject => subject.trim()) : []
    });
    return req.login(user, error => {
      if (error) return res.status(500).json({ error: 'Unable to establish a session.' });
      return res.status(201).json({
        message: 'User registered successfully',
        user: toPublicUser(user)
      });
    });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: 'An account with this email or username already exists.' });
    return res.status(400).json({ error: 'Registration could not be completed.' });
  }
});

router.post('/login', loginLimiter, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = req.body?.password;
  if (!email || typeof password !== 'string' || password.length > 128) {
    return res.status(400).json({ error: 'Invalid credentials.' });
  }

  try {
    const user = await User.findOne({ email });
    if (!user || !user.password || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    return req.login(user, error => {
      if (error) return res.status(500).json({ error: 'Unable to establish a session.' });
      return res.json({ message: 'Login successful', user: toPublicUser(user) });
    });
  } catch (_error) {
    return res.status(500).json({ error: 'Login could not be completed.' });
  }
});

// Server-owned prices. The browser sends only the requested course ID.
const COURSE_COSTS = Object.freeze({ 1: 0, 2: 200, 3: 500, 4: 800, 5: 1200, 6: 1500 });
router.post('/unlock-course', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const courseId = req.body?.courseId;
  if (!Number.isInteger(courseId) || !Object.prototype.hasOwnProperty.call(COURSE_COSTS, courseId)) {
    return res.status(400).json({ error: 'Invalid course ID.' });
  }

  const cost = COURSE_COSTS[courseId];
  try {
    const updatedUser = await User.findOneAndUpdate(
      {
        _id: req.user._id,
        points: { $gte: cost },
        unlockedCourses: { $ne: courseId }
      },
      { $inc: { points: -cost }, $addToSet: { unlockedCourses: courseId } },
      { new: true, runValidators: true }
    );
    if (updatedUser) return res.json(toPublicUser(updatedUser));

    const current = await User.findById(req.user._id).select('points unlockedCourses');
    if (!current) return res.status(404).json({ error: 'User not found.' });
    if (current.unlockedCourses?.includes(courseId)) {
      return res.status(409).json({ error: 'This course is already unlocked.' });
    }
    return res.status(403).json({ error: 'Not enough points to unlock this course.' });
  } catch (_error) {
    return res.status(500).json({ error: 'Unable to unlock this course.' });
  }
});

router.post('/update-avatar', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const avatarUrl = req.body?.avatarUrl;
  if (typeof avatarUrl !== 'string' || avatarUrl.length > 2048) {
    return res.status(400).json({ error: 'Invalid avatar URL.' });
  }
  let parsedUrl;
  try { parsedUrl = new URL(avatarUrl); } catch (_error) {
    return res.status(400).json({ error: 'Avatar must be a valid HTTPS URL.' });
  }
  if (parsedUrl.protocol !== 'https:') {
    return res.status(400).json({ error: 'Avatar must be a valid HTTPS URL.' });
  }
  try {
    const user = await User.findByIdAndUpdate(req.user._id, { $set: { avatar: avatarUrl } }, {
      new: true, runValidators: true
    });
    if (!user) return res.status(404).json({ error: 'User not found.' });
    return res.json(toPublicUser(user));
  } catch (_error) {
    return res.status(500).json({ error: 'Unable to update avatar.' });
  }
});

module.exports = router;
