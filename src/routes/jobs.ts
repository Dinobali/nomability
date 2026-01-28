import { FastifyInstance } from 'fastify';
import fetch from 'node-fetch';
import { prisma } from '../lib/db.js';
import { jobQueue } from '../lib/queue.js';
import { saveFile } from '../lib/storage.js';
import { env } from '../config/env.js';
import { canStartJob } from '../lib/usage.js';

const parseBoolean = (value?: string) => value === 'true' || value === '1';

export const jobRoutes = async (app: FastifyInstance) => {
  app.get('/api/ai/worker-health', { preHandler: app.authenticateOptional }, async (_req, reply) => {
    const healthPath = env.AI_WORKER_HEALTH_ENDPOINT || '/health';
    const url = `${env.AI_WORKER_BASE_URL}${healthPath}`;
    try {
      const response = await fetch(url, { method: 'GET' });
      const body = await response.text().catch(() => '');
      if (!response.ok) {
        return reply.status(502).send({
          status: 'error',
          upstreamStatus: response.status,
          detail: body.slice(0, 300)
        });
      }
      return reply.send({ status: 'ok' });
    } catch (err) {
      return reply.status(502).send({ status: 'error', detail: 'AI worker unreachable' });
    }
  });

  app.post('/api/ai/jobs', { preHandler: app.authenticate }, async (req, reply) => {
    const parts = req.parts();
    const fields: Record<string, string> = {};
    const uploads: Array<{ filename: string; mimetype: string; key: string; bucket: string }> = [];

    for await (const part of parts) {
      if (part.type === 'file') {
        if (!part.filename) {
          part.file.resume();
          continue;
        }
        const stored = await saveFile(part.file, part.filename, part.mimetype || 'application/octet-stream');
        uploads.push({
          filename: part.filename,
          mimetype: part.mimetype || 'application/octet-stream',
          key: stored.key,
          bucket: stored.bucket
        });
      } else {
        fields[part.fieldname] = String(part.value ?? '');
      }
    }

    if (uploads.length === 0) {
      return reply.status(400).send({ error: 'No files uploaded.' });
    }

    const tasks = fields.tasks ? JSON.parse(fields.tasks) : {};
    const params = {
      model: fields.model || 'base',
      language: fields.language || '',
      targetLanguage: fields.targetLanguage || '',
      summaryStyle: fields.summaryStyle || 'bullet',
      speakerCount: fields.speakerCount || 'auto',
      outputFormat: fields.outputFormat || 'txt',
      timestamps: parseBoolean(fields.timestamps)
    };

    const user = (req.user as { sub?: string; orgId?: string }) || {};
    const orgId = user.orgId || null;
    const userId = user.sub || null;

    if (env.AUTH_REQUIRED) {
      if (!orgId) {
        return reply.status(401).send({ error: 'Organization not found. Please log in.' });
      }

      const entitlement = await canStartJob(orgId);
      if (!entitlement.allowed) {
        return reply.status(402).send({
          error: 'Plan limit reached. Please top up credits or renew your plan.',
          usageThisMonth: entitlement.usageThisMonth,
          includedMinutes: env.PLAN_INCLUDED_MINUTES,
          creditMinutes: entitlement.credits
        });
      }
    }

    const job = await prisma.job.create({
      data: {
        status: 'queued',
        progress: 0,
        tasks,
        params,
        userId,
        orgId
      }
    });

    for (const upload of uploads) {
      const fileRecord = await prisma.file.create({
        data: {
          jobId: job.id,
          originalName: upload.filename,
          mimeType: upload.mimetype,
          r2Key: upload.key,
          bucket: upload.bucket
        }
      });
    }

    await jobQueue.add('process', { jobId: job.id });

    return reply.send({ jobId: job.id });
  });

  app.get('/api/ai/jobs/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const jobId = (req.params as { id: string }).id;
    const user = req.user as { orgId?: string };
    if (env.AUTH_REQUIRED && !user.orgId) {
      return reply.status(401).send({ error: 'Organization not found.' });
    }
    const job = await prisma.job.findFirst({
      where: env.AUTH_REQUIRED ? { id: jobId, orgId: user.orgId } : { id: jobId }
    });

    if (!job) {
      return reply.status(404).send({ error: 'Job not found.' });
    }

    return reply.send({
      status: job.status,
      progress: job.progress,
      result: job.result,
      error: job.error
    });
  });
};
