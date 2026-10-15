const mongoose = require('mongoose');

const learningAnswerSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  attemptId: { type: mongoose.Schema.Types.ObjectId, ref: 'QuizAttempt', required: true },
  questionIndex: { type: Number, required: true, min: 0 },
  source: { type: String, enum: ['generated', 'practice', 'multiplayer'], required: true },
  subject: { type: String, required: true, maxlength: 60 },
  topic: { type: String, required: true, maxlength: 80 },
  question: { type: String, required: true, maxlength: 1000 },
  selectedAnswer: { type: Number, required: true, min: -1, max: 3 },
  correctAnswer: { type: Number, required: true, min: 0, max: 3 },
  isCorrect: { type: Boolean, required: true },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

learningAnswerSchema.index({ userId: 1, attemptId: 1, questionIndex: 1 }, { unique: true });
learningAnswerSchema.index({ userId: 1, createdAt: -1 });
learningAnswerSchema.index({ userId: 1, subject: 1, topic: 1, createdAt: -1 });

module.exports = mongoose.model('LearningAnswer', learningAnswerSchema);
