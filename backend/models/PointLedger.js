const mongoose = require('mongoose');

const pointLedgerSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  eventId: { type: String, required: true },
  points: { type: Number, required: true, min: 0 },
  reason: { type: String, required: true, maxlength: 80 },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

pointLedgerSchema.index({ userId: 1, eventId: 1 }, { unique: true });

module.exports = mongoose.model('PointLedger', pointLedgerSchema);
