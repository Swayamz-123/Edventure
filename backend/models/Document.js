const mongoose = require('mongoose');

const sourcePageSchema = new mongoose.Schema({
  pageNumber: { type: Number, required: true, min: 1, max: 100 },
  text: { type: String, required: true, maxlength: 120000 }
}, { _id: false });

const documentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 120 },
  mimeType: { type: String, enum: ['application/pdf', 'text/plain'], default: 'application/pdf' },
  status: { type: String, enum: ['processing', 'ready', 'failed'], default: 'processing', index: true },
  statusMessage: { type: String, maxlength: 240, default: '' },
  pageCount: { type: Number, default: 0, min: 0, max: 100 },
  characterCount: { type: Number, default: 0, min: 0, max: 120000 },
  chunkCount: { type: Number, default: 0, min: 0 },
  sourcePages: { type: [sourcePageSchema], select: false, default: [] },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { versionKey: false });

documentSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Document', documentSchema);
