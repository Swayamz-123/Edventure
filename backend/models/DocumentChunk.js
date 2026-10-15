const mongoose = require('mongoose');

const documentChunkSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', required: true },
  chunkIndex: { type: Number, required: true, min: 0 },
  pageNumber: { type: Number, required: true, min: 1 },
  text: { type: String, required: true, maxlength: 2400 },
  embeddingModel: { type: String, required: true, default: 'gemini-embedding-001' },
  embedding: { type: [Number], required: true, select: false },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

documentChunkSchema.index({ userId: 1, documentId: 1, chunkIndex: 1 }, { unique: true });
documentChunkSchema.index({ userId: 1, documentId: 1, pageNumber: 1 });

module.exports = mongoose.model('DocumentChunk', documentChunkSchema);
