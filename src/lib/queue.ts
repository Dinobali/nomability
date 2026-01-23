import { Queue } from 'bullmq';
import { env } from '../config/env.js';

const buildConnection = () => {
  const url = new URL(env.REDIS_URL);
  const db = url.pathname ? Number(url.pathname.replace('/', '')) : undefined;
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    username: url.username || undefined,
    password: url.password || undefined,
    db: Number.isNaN(db) ? undefined : db,
    tls: url.protocol === 'rediss:' ? {} : undefined
  };
};

export const queueConnection = buildConnection();

export const jobQueue = new Queue('ai-jobs', {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 500,
    removeOnFail: 500
  }
});
