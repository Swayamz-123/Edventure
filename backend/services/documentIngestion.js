const { GoogleGenerativeAI } = require('@google/generative-ai');
const Document = require('../models/Document');
const DocumentChunk = require('../models/DocumentChunk');
const redis = require('../infrastructure/redis');

const MAX_CHUNK_CHARS = 1_200;
const CHUNK_OVERLAP_CHARS = 180;
const MAX_DOCUMENT_CHARS = 120_000;
const activeJobs = new Set();

function splitPage(page) {
  const text = String(page.text || '').replace(/\r\n/g, '\n').trim();
  if (!text) return [];

  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + MAX_CHUNK_CHARS);
    if (end < text.length) {
      const boundary = Math.max(
        text.lastIndexOf('\n', end),
        text.lastIndexOf('. ', end),
        text.lastIndexOf(' ', end)
      );
      if (boundary > start + MAX_CHUNK_CHARS * 0.65) end = boundary + 1;
    }

    const chunkText = text.slice(start, end).trim();
    if (chunkText) chunks.push({ pageNumber: page.pageNumber, text: chunkText });
    if (end >= text.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP_CHARS);
  }
  return chunks;
}

function splitPages(pages) {
  return pages.flatMap(splitPage).map((chunk, chunkIndex) => ({ ...chunk, chunkIndex }));
}

async function embedChunks(chunks) {
  if (!process.env.GEMINI_API_KEY) throw new Error('Embedding provider is not configured.');
  const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const embeddingModel = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';
  const model = client.getGenerativeModel({ model: embeddingModel });

  const result = new Array(chunks.length);
  const batchSize = 4;
  for (let offset = 0; offset < chunks.length; offset += batchSize) {
    const batch = chunks.slice(offset, offset + batchSize);
    const embeddings = await Promise.all(batch.map(chunk => model.embedContent(chunk.text)));
    embeddings.forEach((response, index) => {
      const values = response?.embedding?.values;
      if (!Array.isArray(values) || values.length < 128 || values.some(value => !Number.isFinite(value))) {
        throw new Error('Embedding provider returned an invalid vector.');
      }
      result[offset + index] = values;
    });
  }
  return { vectors: result, modelName: process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001' };
}

async function processDocument(documentId, { lockAlreadyHeld = false } = {}) {
  const key = String(documentId);
  if (activeJobs.has(key)) return;
  activeJobs.add(key);
  const lockKey = `edventure:lock:document:${key}`;
  const lockToken = `inline:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  let acquiredLock = false;

  try {
    if (redis.isConfigured() && !lockAlreadyHeld) {
      const result = await redis.command(['SET', lockKey, lockToken, 'NX', 'EX', 900]);
      if (result !== 'OK') return;
      acquiredLock = true;
    }
    const document = await Document.findOne({
      _id: documentId,
      status: 'processing'
    }).select('+sourcePages');
    if (!document || !Array.isArray(document.sourcePages) || !document.sourcePages.length) return;

    const pages = document.sourcePages.map(page => ({
      pageNumber: page.pageNumber,
      text: page.text
    }));
    const totalCharacters = pages.reduce((sum, page) => sum + page.text.length, 0);
    if (totalCharacters > MAX_DOCUMENT_CHARS) throw new Error('Document exceeds the ingestion limit.');

    const chunks = splitPages(pages);
    if (!chunks.length) throw new Error('No extractable text was found in this document.');
    const { vectors: embeddings, modelName: embeddingModel } = await embedChunks(chunks);
    const docs = chunks.map((chunk, index) => ({
      userId: document.userId,
      documentId: document._id,
      chunkIndex: chunk.chunkIndex,
      pageNumber: chunk.pageNumber,
      text: chunk.text,
      embedding: embeddings[index],
      embeddingModel
    }));

    await DocumentChunk.deleteMany({ userId: document.userId, documentId: document._id });
    // Write in bounded batches to keep individual Mongo requests modest.
    for (let offset = 0; offset < docs.length; offset += 50) {
      await DocumentChunk.insertMany(docs.slice(offset, offset + 50), { ordered: true });
    }

    const transition = await Document.updateOne(
      { _id: document._id, userId: document.userId, status: 'processing' },
      {
        $set: {
          status: 'ready',
          statusMessage: 'Indexed and ready for questions.',
          pageCount: pages.length,
          characterCount: totalCharacters,
          chunkCount: docs.length,
          updatedAt: new Date()
        },
        $unset: { sourcePages: 1 }
      }
    );

    // If the owner deleted the document while embeddings were being generated,
    // do not leave orphaned searchable chunks behind.
    if (transition.matchedCount !== 1) {
      await DocumentChunk.deleteMany({ userId: document.userId, documentId: document._id });
    }
  } catch (error) {
    console.error('Document ingestion failed:', error?.name || 'UnknownError');
    await DocumentChunk.deleteMany({ documentId, userId: (await Document.findById(documentId).select('userId').lean())?.userId }).catch(() => {});
    await Document.updateOne(
      { _id: documentId },
      {
        $set: {
          status: 'failed',
          statusMessage: 'This document could not be indexed. Try a text-based PDF or re-upload it.',
          updatedAt: new Date()
        }
      }
    );
  } finally {
    if (acquiredLock) {
      try {
        await redis.command([
          'EVAL',
          "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
          1, lockKey, lockToken
        ]);
      } catch (error) {
        console.error('Inline document lock cleanup failed:', error?.name || 'UnknownError');
      }
    }
    activeJobs.delete(key);
  }
}

async function resumePendingDocuments() {
  const pending = await Document.find({ status: 'processing' }).select('_id').limit(100).lean();
  for (const document of pending) {
    // Bound concurrent embeddings so a restart with many pending documents does
    // not launch an uncontrolled number of provider requests.
    await processDocument(document._id);
  }
}

module.exports = { splitPage, splitPages, processDocument, resumePendingDocuments };
