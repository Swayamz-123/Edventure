require('dotenv').config();
const mongoose = require('mongoose');
const { startDocumentQueueWorker, stopDocumentQueueWorker } = require('../infrastructure/jobQueue');

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI must be configured.');
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10_000 });
  startDocumentQueueWorker();

  const shutdown = async signal => {
    console.log(`Document worker received ${signal}; shutting down.`);
    await stopDocumentQueueWorker();
    await mongoose.disconnect();
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(error => {
  console.error('Document worker failed to start:', error.message);
  process.exitCode = 1;
});
