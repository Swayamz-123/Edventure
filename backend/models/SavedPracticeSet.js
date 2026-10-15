const mongoose = require('mongoose');

const savedPracticeSetSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  sourceGameId: { type: String, required: true, maxlength: 120 },
  subject: { type: String, required: true, maxlength: 60 },
  difficulty: { type: String, required: true, maxlength: 30 },
  classLevel: { type: Number, required: true, min: 1, max: 12 },
  questions: { type: [mongoose.Schema.Types.Mixed], required: true },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

savedPracticeSetSchema.index({ userId: 1, sourceGameId: 1 }, { unique: true });
savedPracticeSetSchema.index({ userId: 1, subject: 1, difficulty: 1, classLevel: 1, createdAt: -1 });

module.exports = mongoose.model('SavedPracticeSet', savedPracticeSetSchema);
