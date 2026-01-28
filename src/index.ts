import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { env } from './config/env.js';
import { authRoutes } from './routes/auth.js';
import { jobRoutes } from './routes/jobs.js';
import { billingRoutes } from './routes/billing.js';
import { adminRoutes } from './routes/admin.js';

const app = Fastify({ logger: true, trustProxy: true });

app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
  (req as any).rawBody = body;
  try {
    const text = body.length ? body.toString('utf8') : '';
    done(null, text ? JSON.parse(text) : {});
  } catch (err) {
    done(err as Error);
  }
});

const allowedOrigins = new Set(
  [
    env.CLIENT_URL,
    ...(env.CORS_ALLOWED_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
  ].filter(Boolean)
);

const isProd = env.NODE_ENV === 'production';
const localhostPattern = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

app.register(cors, {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.has(origin)) return callback(null, true);
    if (!isProd && localhostPattern.test(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'), false);
  },
  credentials: true
});

const cspDirectives: Record<string, string[]> = {
  "default-src": ["'self'"],
  "base-uri": ["'self'"],
  "object-src": ["'none'"],
  "frame-ancestors": ["'self'"],
  "script-src": ["'self'", 'https://analytics.nomability.net'],
  "script-src-attr": ["'none'"],
  "style-src": ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  "font-src": ["'self'", 'https://fonts.gstatic.com', 'data:'],
  "img-src": ["'self'", 'data:', 'blob:', 'https://assets.nomability.net'],
  "media-src": ["'self'", 'blob:', 'https://assets.nomability.net', 'https://api.nomability.net'],
  "connect-src": [
    "'self'",
    'https://api.nomability.net',
    'wss://api.nomability.net',
    'https://ai.nomability.net',
    'wss://ai.nomability.net',
    'https://analytics.nomability.net'
  ],
  "form-action": ["'self'"],
  "upgrade-insecure-requests": []
};

if (!isProd) {
  cspDirectives["connect-src"].push(
    'http://localhost:3003',
    'http://127.0.0.1:3003',
    'http://localhost:8008',
    'http://127.0.0.1:8008'
  );
  cspDirectives["img-src"].push('http://localhost:3003', 'http://127.0.0.1:3003');
  cspDirectives["media-src"].push('http://localhost:3003', 'http://127.0.0.1:3003');
}

app.register(helmet, {
  contentSecurityPolicy: {
    directives: cspDirectives
  }
});
app.register(rateLimit, {
  max: 200,
  timeWindow: '1 minute',
  keyGenerator: (req) => {
    const cfConnectingIp = req.headers['cf-connecting-ip'];
    if (Array.isArray(cfConnectingIp)) return cfConnectingIp[0];
    if (typeof cfConnectingIp === 'string' && cfConnectingIp.trim()) return cfConnectingIp.trim();
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
    return req.ip;
  }
});
app.register(cookie);
app.register(jwt, { secret: env.JWT_SECRET, sign: { expiresIn: env.JWT_EXPIRE } });

app.decorate('authenticate', async (req: any, reply: any) => {
  if (!env.AUTH_REQUIRED) return;
  try {
    await req.jwtVerify();
  } catch (err) {
    reply.code(401).send({ error: 'Unauthorized' });
  }
});

app.decorate('authenticateOptional', async (req: any, reply: any) => {
  if (!env.AUTH_REQUIRED) return;
  const authHeader = req.headers.authorization;
  if (!authHeader) return;
  try {
    await req.jwtVerify();
  } catch (err) {
    return;
  }
});

app.register(multipart, {
  limits: {
    fileSize: env.AI_MAX_UPLOAD_MB * 1024 * 1024,
    files: env.AI_MAX_FILES
  }
});

app.register(fastifyStatic, {
  root: path.join(process.cwd(), 'public'),
  index: ['index.html']
});

app.get('/health', async () => ({ status: 'ok' }));

app.register(authRoutes);
app.register(jobRoutes);
app.register(billingRoutes);
app.register(adminRoutes);

app.get('/', async (_req, reply) => {
  return reply.sendFile('index.html');
});

const start = async () => {
  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
