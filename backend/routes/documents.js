const express = require('express');
const mongoose = require('mongoose');
const Document = require('../models/Document');
const DocumentChunk = require('../models/DocumentChunk');
const { processDocument } = require('../services/documentIngestion');
const { createRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();
const ingestionLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 5, keyPrefix: 'document-ingestion' });

function requireAuth(req, res, next) {
  if (!req.user?._id) return res.status(401).json({ error: 'Authentication required.' });
  return next();
}

function publicDocument(document) {
  return {
    id: String(document._id),
    title: document.title,
    status: document.status,
    statusMessage: document.statusMessage,
    pageCount: document.pageCount,
    characterCount: document.characterCount,
    chunkCount: document.chunkCount,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt
  };
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const documents = await Document.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(100)
      .select('-sourcePages')
      .lean();
    return res.json({ documents: documents.map(publicDocument) });
  } catch (_error) {
    return res.status(500).json({ error: 'Unable to load your documents.' });
  }
});

router.post('/', requireAuth, ingestionLimiter, async (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 120) : '';
  const sourcePages = req.body?.pages;
  if (!title || !Array.isArray(sourcePages) || sourcePages.length < 1 || sourcePages.length > 80) {
    return res.status(400).json({ error: 'Provide a title and 1–80 extracted PDF pages.' });
  }

  let totalCharacters = 0;
  const pages = [];
  for (let index = 0; index < sourcePages.length; index += 1) {
    const page = sourcePages[index];
    if (!page || !Number.isInteger(page.pageNumber) || page.pageNumber !== index + 1 ||
        typeof page.text !== 'string' || page.text.length > 120000) {
      return res.status(400).json({ error: 'Each page must have a sequential page number and extracted text.' });
    }
    const text = page.text.replace(/\u0000/g, '').trim();
    totalCharacters += text.length;
    if (totalCharacters > 120000) {
      return res.status(413).json({ error: 'This document exceeds the 120,000 character ingestion limit.' });
    }
    pages.push({ pageNumber: page.pageNumber, text });
  }

  if (totalCharacters < 100) {
    return res.status(400).json({ error: 'Not enough selectable text was found in this PDF.' });
  }

  try {
    const document = await Document.create({
      userId: req.user._id,
      title,
      mimeType: 'application/pdf',
      status: 'processing',
      statusMessage: 'Extracted text accepted; creating searchable chunks.',
      pageCount: pages.length,
      characterCount: totalCharacters,
      sourcePages: pages
    });

    // The job state is persisted in MongoDB before work begins. Server startup
    // resumes any document left in "processing" if this process restarts.
    setImmediate(() => {
      processDocument(document._id).catch(error => {
        console.error('Document ingestion scheduling failed:', error?.name || 'UnknownError');
      });
    });

    return res.status(202).json({ document: publicDocument(document) });
  } catch (_error) {
    return res.status(500).json({ error: 'Unable to queue this document for indexing.' });
  }
});

router.get('/:documentId', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.documentId)) {
    return res.status(400).json({ error: 'Invalid document ID.' });
  }
  try {
    const document = await Document.findOne({
      _id: req.params.documentId,
      userId: req.user._id
    }).select('-sourcePages').lean();
    if (!document) return res.status(404).json({ error: 'Document not found.' });
    return res.json({ document: publicDocument(document) });
  } catch (_error) {
    return res.status(500).json({ error: 'Unable to load this document.' });
  }
});

router.delete('/:documentId', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.documentId)) {
    return res.status(400).json({ error: 'Invalid document ID.' });
  }
  try {
    const document = await Document.findOneAndDelete({
      _id: req.params.documentId,
      userId: req.user._id
    });
    if (!document) return res.status(404).json({ error: 'Document not found.' });
    await DocumentChunk.deleteMany({ documentId: document._id, userId: req.user._id });
    return res.sendStatus(204);
  } catch (_error) {
    return res.status(500).json({ error: 'Unable to delete this document.' });
  }
});

module.exports = router;
