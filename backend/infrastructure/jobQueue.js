const redis = require('./redis');
const Document = require('../models/Document');
const { processDocument } = require('../services/documentIngestion');

const QUEUE_NAME = 'edventure:queue:document-ingestion';
const JOB_TTL_SECONDS = 7 * 24 * 60 * 60;
const LOCK_TTL_SECONDS = 300;
const UNLOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

let workerPromise = null;
let stopRequested = false;

async function enqueueDocument(documentId, { attempt = 0, suffix = null } = {}) {
  const id = String(documentId);
  const jobId = suffix || `document:${id}:ingest:${attempt}`;
  const payload = {
    jobId,
    type: 'document-ingestion',
    documentId: id,
    attempt,
    enqueuedAt: new Date().toISOString()
  };
  const queued = await redis.enqueueOnce(
    QUEUE_NAME,
    `edventure:queue:dedupe:${jobId}`,
    payload,
    JOB_TTL_SECONDS
  );
  if (queued) {
    await redis.command([
      'SET',
      `edventure:job:${jobId}`,
      JSON.stringify({ ...payload, status: 'queued', updatedAt: new Date().toISOString() }),
      'EX',
      JOB_TTL_SECONDS
    ]);
  }
  return { queued, jobId };
}

async function setJobStatus(job, status, extra = {}) {
  await redis.command([
    'SET',
    `edventure:job:${job.jobId}`,
    JSON.stringify({
      ...job,
      status,
      ...extra,
      updatedAt: new Date().toISOString()
    }),
    'EX',
    JOB_TTL_SECONDS
  ]);
}

async function processJob(job) {
  const lockKey = `edventure:lock:document:${job.documentId}`;
  const lockToken = `${job.jobId}:${process.pid}:${Date.now()}`;
  const acquired = await redis.command(['SET', lockKey, lockToken, 'NX', 'EX', LOCK_TTL_SECONDS]);
  if (acquired !== 'OK') {
    await setJobStatus(job, 'skipped_duplicate', { reason: 'Another worker holds the document lease.' });
    return;
  }

  try {
    await setJobStatus(job, 'processing', { startedAt: new Date().toISOString() });
    await processDocument(job.documentId, { lockAlreadyHeld: true });
    const document = await Document.findById(job.documentId).select('status statusMessage chunkCount').lean();

    if (document?.status === 'ready') {
      await setJobStatus(job, 'completed', { completedAt: new Date().toISOString(), chunkCount: document.chunkCount });
      return;
    }

    if (document?.status === 'failed' && job.attempt < 2) {
      await Document.updateOne(
        { _id: job.documentId, status: 'failed' },
        { $set: { status: 'processing', statusMessage: 'A retry has been scheduled.', updatedAt: new Date() } }
      );
      const retry = await enqueueDocument(job.documentId, { attempt: job.attempt + 1 });
      await setJobStatus(job, 'retry_scheduled', { nextJobId: retry.jobId });
      return;
    }

    await setJobStatus(job, 'failed', {
      completedAt: new Date().toISOString(),
      error: document?.statusMessage || 'Document ingestion failed.'
    });
  } catch (error) {
    console.error('Document queue job failed:', error?.name || 'UnknownError');
    await setJobStatus(job, 'failed', { error: 'Worker execution failed.' });
  } finally {
    try {
      await redis.command(['EVAL', UNLOCK_SCRIPT, 1, lockKey, lockToken]);
    } catch (error) {
      console.error('Document worker lease cleanup failed:', error?.name || 'UnknownError');
    }
  }
}

async function recoverPendingDocuments() {
  const pending = await Document.find({ status: 'processing' }).select('_id').limit(500).lean();
  for (const document of pending) {
    // Recovery jobs are unique per scan, allowing a restarted worker to recover
    // jobs that were removed from the queue immediately before a process crash.
    const recoverySlot = Math.floor(Date.now() / 60_000);
    await enqueueDocument(document._id, {
      attempt: 0,
      suffix: `document:${document._id}:recovery:${recoverySlot}`
    });
  }
}

async function workerLoop({ pollMs = 2000, recoveryMs = 60_000 } = {}) {
  let lastRecovery = 0;
  while (!stopRequested) {
    try {
      const now = Date.now();
      if (now - lastRecovery >= recoveryMs) {
        await recoverPendingDocuments();
        lastRecovery = now;
      }

      const raw = await redis.command(['RPOP', QUEUE_NAME]);
      if (!raw) {
        await new Promise(resolve => setTimeout(resolve, pollMs));
        continue;
      }

      let job;
      try {
        job = JSON.parse(raw);
      } catch (_error) {
        console.error('Discarding malformed document queue message.');
        continue;
      }
      if (job?.type !== 'document-ingestion' || !job.documentId || !job.jobId) {
        console.error('Discarding invalid document queue message.');
        continue;
      }
      await processJob(job);
    } catch (error) {
      console.error('Redis document queue loop failed:', error?.name || 'UnknownError');
      await new Promise(resolve => setTimeout(resolve, Math.max(2000, pollMs)));
    }
  }
}

function startDocumentQueueWorker(options = {}) {
  if (!redis.isConfigured()) throw new Error('Configure REDIS_URL or Upstash REST credentials before starting the queue worker.');
  if (workerPromise) return () => stopDocumentQueueWorker();
  stopRequested = false;
  workerPromise = workerLoop(options).finally(() => {
    workerPromise = null;
  });
  return () => stopDocumentQueueWorker();
}

async function stopDocumentQueueWorker() {
  stopRequested = true;
  if (workerPromise) await workerPromise;
}

module.exports = {
  QUEUE_NAME,
  enqueueDocument,
  startDocumentQueueWorker,
  stopDocumentQueueWorker,
  recoverPendingDocuments
};
