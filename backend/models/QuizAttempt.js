const mongoose = require('mongoose');

const quizAttemptSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  kind: { type: String, enum: ['generated', 'practice'], required: true },
  subject: { type: String, required: true, maxlength: 60 },
  difficulty: { type: String, required: true, maxlength: 30 },
  classLevel: { type: Number, required: true, min: 1, max: 12 },
  // Mixed preserves provider question shape while access is constrained by owner ID.
  questions: { type: [mongoose.Schema.Types.Mixed], required: true },
  answers: { type: [mongoose.Schema.Types.Mixed], default: [] },
  score: { type: Number, default: 0, min: 0 },
  submittedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

quizAttemptSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('QuizAttempt', quizAttemptSchema);
