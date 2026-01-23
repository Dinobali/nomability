import { Worker } from 'bullmq';
import { env } from './config/env.js';
import { queueConnection } from './lib/queue.js';
import { prisma } from './lib/db.js';
import { processJob } from './jobs/processor.js';

const worker = new Worker(
  'ai-jobs',
  async (job) => {
    const jobId = job.data.jobId as string;
    await processJob(jobId);
  },
  {
    connection: queueConnection,
    concurrency: 2
  }
);

worker.on('failed', async (job, err) => {
  if (!job) return;
  await prisma.job.update({
    where: { id: job.data.jobId },
    data: { status: 'failed', error: err.message }
  });
});

worker.on('completed', async (job) => {
  if (!job) return;
  await prisma.job.update({
    where: { id: job.data.jobId },
    data: { status: 'completed', progress: 100 }
  });
});

const shutdown = async () => {
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`Worker started in ${env.NODE_ENV} mode.`);
