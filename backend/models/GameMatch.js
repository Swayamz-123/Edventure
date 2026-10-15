const mongoose = require('mongoose');

const matchPlayerSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username: { type: String, required: true, maxlength: 80 },
  score: { type: Number, default: 0, min: 0 },
  answers: { type: [mongoose.Schema.Types.Mixed], default: [] },
  completed: { type: Boolean, default: false }
}, { _id: false });

const gameMatchSchema = new mongoose.Schema({
  gameId: { type: String, required: true, unique: true, maxlength: 80 },
  subject: { type: String, required: true, maxlength: 60 },
  difficulty: { type: String, required: true, maxlength: 30 },
  classLevel: { type: Number, required: true, min: 1, max: 12 },
  mode: { type: String, required: true, maxlength: 30 },
  status: { type: String, enum: ['active', 'completed', 'abandoned'], default: 'active', index: true },
  players: { type: [matchPlayerSchema], required: true, validate: value => value.length === 2 },
  // Answer keys remain server-side; the history API deliberately returns a safe summary only.
  questions: { type: [mongoose.Schema.Types.Mixed], required: true, select: false },
  winnerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  startedAt: { type: Date, required: true },
  completedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { versionKey: false });

gameMatchSchema.index({ 'players.userId': 1, createdAt: -1 });
gameMatchSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('GameMatch', gameMatchSchema);
