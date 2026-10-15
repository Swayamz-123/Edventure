const mongoose = require('mongoose');

const mistakeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  attemptId: { type: mongoose.Schema.Types.ObjectId, ref: 'QuizAttempt', required: true },
  questionIndex: { type: Number, required: true, min: 0 },
  subject: { type: String, required: true, maxlength: 60 },
  topic: { type: String, required: true, maxlength: 80 },
  question: { type: String, required: true, maxlength: 1000 },
  options: { type: [String], required: true },
  selectedAnswer: { type: Number, required: true, min: -1, max: 3 },
  correctAnswer: { type: Number, required: true, min: 0, max: 3 },
  status: { type: String, enum: ['open', 'reviewed'], default: 'open' },
  reviewCount: { type: Number, default: 0, min: 0 },
  nextReviewAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
  reviewedAt: { type: Date, default: null },
  updatedAt: { type: Date, default: Date.now }
}, { versionKey: false });

mistakeSchema.index({ userId: 1, attemptId: 1, questionIndex: 1 }, { unique: true });
mistakeSchema.index({ userId: 1, status: 1, nextReviewAt: 1 });

module.exports = mongoose.model('Mistake', mistakeSchema);
