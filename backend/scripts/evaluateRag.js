require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const mongoose = require('mongoose');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Document = require('../models/Document');
const DocumentChunk = require('../models/DocumentChunk');
const { cosineSimilarity, lexicalScore, tokens } = require('../routes/tutor');

const TOP_K = 5;
const ABSTENTION_SEMANTIC_THRESHOLD = 0.2;
const ABSTENTION_LEXICAL_THRESHOLD = 0.15;

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1);
  return Number(sorted[index].toFixed(2));
}

function reciprocalRank(rankedIds, relevantIds) {
  const relevant = new Set(relevantIds);
  const index = rankedIds.findIndex(id => relevant.has(id));
  return index < 0 ? 0 : 1 / (index + 1);
}

function recallAtK(rankedIds, relevantIds, k = TOP_K) {
  const relevant = new Set(relevantIds);
  if (!relevant.size) return null;
  return rankedIds.slice(0, k).filter(id => relevant.has(id)).length / relevant.size;
}

function ndcgAtK(rankedIds, relevantIds, k = TOP_K) {
  const relevant = new Set(relevantIds);
  if (!relevant.size) return null;
  let dcg = 0;
  rankedIds.slice(0, k).forEach((id, index) => {
    if (relevant.has(id)) dcg += 1 / Math.log2(index + 2);
  });
  const idealLength = Math.min(relevant.size, k);
  let idealDcg = 0;
  for (let index = 0; index < idealLength; index += 1) idealDcg += 1 / Math.log2(index + 2);
  return idealDcg ? dcg / idealDcg : 0;
}

function shouldAbstain(best) {
  return !best || (
    best.semantic < ABSTENTION_SEMANTIC_THRESHOLD &&
    best.lexical < ABSTENTION_LEXICAL_THRESHOLD
  );
}

async function embedQuery(question) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY must be set to run live retrieval evaluation.');
  const ai = new GoogleGenerativeAI(apiKey);
  const model = ai.getGenerativeModel({
    model: process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001'
  });
  const response = await model.embedContent(question);
  const vector = response?.embedding?.values;
  if (!Array.isArray(vector) || vector.length < 128 || vector.some(value => !Number.isFinite(value))) {
    throw new Error('The embedding provider returned an invalid query vector.');
  }
  return vector;
}

async function runEvaluation() {
  const userId = process.env.RAG_EVAL_USER_ID;
  if (!userId || !mongoose.isValidObjectId(userId)) {
    throw new Error('Set RAG_EVAL_USER_ID to the MongoDB ObjectId of a dedicated evaluation account.');
  }

  const datasetPath = path.resolve(process.env.RAG_EVAL_DATASET || 'evaluation/rag-cases.example.json');
  const dataset = JSON.parse(await fs.readFile(datasetPath, 'utf8'));
  if (!Array.isArray(dataset.cases) || !dataset.cases.length) {
    throw new Error('Evaluation dataset must contain a non-empty cases array.');
  }

  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) throw new Error('MONGO_URI must be configured.');
  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10_000 });

  try {
    const embeddingModel = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';
    const ownedDocuments = await Document.find({ userId, status: 'ready' }).select('_id title').lean();
    const ownedDocumentIds = new Set(ownedDocuments.map(document => String(document._id)));

    const results = [];
    for (const testCase of dataset.cases) {
      const caseId = String(testCase.id || results.length + 1);
      const question = typeof testCase.question === 'string' ? testCase.question.trim() : '';
      if (question.length < 4 || question.length > 3000) {
        throw new Error(`Case ${caseId} must have a question between 4 and 3000 characters.`);
      }
      const requestedDocumentIds = Array.isArray(testCase.documentIds)
        ? testCase.documentIds.map(String)
        : [];
      if (requestedDocumentIds.some(id => !mongoose.isValidObjectId(id) || !ownedDocumentIds.has(id))) {
        throw new Error(`Case ${caseId} includes a document that is not owned by the evaluation account.`);
      }

      const filter = {
        userId,
        documentId: requestedDocumentIds.length
          ? { $in: requestedDocumentIds }
          : { $in: [...ownedDocumentIds] },
        embeddingModel
      };
      const start = performance.now();
      const [vector, chunks] = await Promise.all([
        embedQuery(question),
        DocumentChunk.find(filter).select('+embedding').limit(500).lean()
      ]);
      const questionTokens = tokens(question);
      const ranked = chunks.map(chunk => {
        const semantic = cosineSimilarity(vector, chunk.embedding);
        const lexical = lexicalScore(questionTokens, chunk.text);
        return {
          id: String(chunk._id),
          documentId: String(chunk.documentId),
          pageNumber: chunk.pageNumber,
          semantic,
          lexical,
          score: 0.75 * ((semantic + 1) / 2) + 0.25 * lexical
        };
      }).sort((a, b) => b.score - a.score).slice(0, TOP_K);
      const latencyMs = performance.now() - start;
      const relevantIds = Array.isArray(testCase.relevantChunkIds)
        ? testCase.relevantChunkIds.map(String)
        : [];
      const rankedIds = ranked.map(chunk => chunk.id);
      const abstained = shouldAbstain(ranked[0] ? ranked[0] : null);
      const answerable = testCase.answerable === true;
      const acceptableCitationIds = Array.isArray(testCase.acceptableCitationChunkIds)
        ? new Set(testCase.acceptableCitationChunkIds.map(String))
        : null;
      const citedIds = Array.isArray(testCase.citedChunkIds) ? testCase.citedChunkIds.map(String) : null;

      results.push({
        id: caseId,
        answerable,
        abstained,
        abstentionCorrect: abstained === !answerable,
        latencyMs: Number(latencyMs.toFixed(2)),
        recallAt5: answerable && relevantIds.length ? recallAtK(rankedIds, relevantIds, TOP_K) : null,
        reciprocalRank: answerable && relevantIds.length ? reciprocalRank(rankedIds, relevantIds) : null,
        ndcgAt5: answerable && relevantIds.length ? ndcgAtK(rankedIds, relevantIds, TOP_K) : null,
        citationPrecision: citedIds && acceptableCitationIds
          ? (citedIds.length ? citedIds.filter(id => acceptableCitationIds.has(id)).length / citedIds.length : null)
          : null,
        topResults: ranked.map(chunk => ({
          chunkId: chunk.id,
          documentId: chunk.documentId,
          pageNumber: chunk.pageNumber,
          combinedScore: Number(chunk.score.toFixed(4)),
          semanticScore: Number(chunk.semantic.toFixed(4)),
          lexicalScore: Number(chunk.lexical.toFixed(4))
        }))
      });
    }

    const mean = key => {
      const values = results.map(result => result[key]).filter(value => Number.isFinite(value));
      return values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4)) : null;
    };
    const summary = {
      totalCases: results.length,
      answerableCases: results.filter(result => result.answerable).length,
      unanswerableCases: results.filter(result => !result.answerable).length,
      recallAt5: mean('recallAt5'),
      mrr: mean('reciprocalRank'),
      ndcgAt5: mean('ndcgAt5'),
      abstentionAccuracy: mean('abstentionCorrect'),
      citationPrecisionOnAnnotatedCases: mean('citationPrecision'),
      retrievalLatencyP50Ms: percentile(results.map(result => result.latencyMs), 0.5),
      retrievalLatencyP95Ms: percentile(results.map(result => result.latencyMs), 0.95),
      notes: [
        'Recall/MRR/nDCG require relevantChunkIds annotations for each answerable case.',
        'Abstention accuracy compares the configured retrieval threshold with answerable labels; it does not grade generated answers.',
        'Citation precision is calculated only when citedChunkIds and acceptableCitationChunkIds have human annotations.',
        'Faithfulness and citation support require manual or separately validated claim-level grading; this script does not invent those scores.'
      ],
      results
    };

    const outputPath = path.resolve(process.env.RAG_EVAL_OUTPUT || 'evaluation/rag-results.json');
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify(summary, null, 2));
    console.log(`\nWrote evaluation report to ${outputPath}`);
    return summary;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  runEvaluation().catch(error => {
    console.error('RAG evaluation failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  percentile,
  reciprocalRank,
  recallAtK,
  ndcgAtK,
  shouldAbstain,
  runEvaluation
};
