const mongoose = require('mongoose');

const topicMasterySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  subject: { type: String, required: true, maxlength: 60 },
  topic: { type: String, required: true, maxlength: 80 },
  attempts: { type: Number, default: 0, min: 0 },
  correctCount: { type: Number, default: 0, min: 0 },
  accuracy: { type: Number, default: 0, min: 0, max: 1 },
  mastery: { type: Number, default: 0, min: 0, max: 1 },
  intervalDays: { type: Number, default: 1, min: 1, max: 30 },
  lastPracticedAt: { type: Date, default: null },
  nextReviewAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { versionKey: false });

topicMasterySchema.index({ userId: 1, subject: 1, topic: 1 }, { unique: true });
topicMasterySchema.index({ userId: 1, nextReviewAt: 1 });

module.exports = mongoose.model('TopicMastery', topicMasterySchema);
