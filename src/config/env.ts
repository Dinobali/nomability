import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const booleanFromEnv = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'n', 'off', ''].includes(normalized)) return false;
    }
    return value;
  }, z.boolean()).default(defaultValue);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3003),
  CLIENT_URL: z.string().default('http://localhost:3003'),
  AUTH_REQUIRED: booleanFromEnv(false),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 chars'),
  JWT_EXPIRE: z.string().default('7d'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().default('redis://localhost:6379/0'),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  FROM_EMAIL: z.string().optional(),
  FROM_NAME: z.string().optional(),
  MAGIC_LINK_URL: z.string().optional(),
  PASSWORD_RESET_URL: z.string().optional(),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_MONTHLY: z.string().optional(),
  STRIPE_PRICE_PAYG: z.string().optional(),
  STRIPE_PRICE_STARTER_10H: z.string().optional(),
  STRIPE_PRICE_PRO_20H: z.string().optional(),
  STRIPE_PRICE_UNLIMITED: z.string().optional(),
  PLAN_INCLUDED_MINUTES: z.coerce.number().default(300),
  PAYG_RATE_CENTS_PER_HOUR: z.coerce.number().default(199),

  R2_ENABLED: booleanFromEnv(false),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_PRIVATE_BUCKET: z.string().optional(),
  R2_PUBLIC_BUCKET: z.string().optional(),
  R2_PUBLIC_URL: z.string().optional(),
  LOCAL_STORAGE_PATH: z.string().default('/app/storage'),

  BANK_ACCOUNT_HOLDER: z.string().optional(),
  BANK_IBAN: z.string().optional(),
  BANK_BIC: z.string().optional(),
  BANK_NAME: z.string().optional(),

  AI_WORKER_BASE_URL: z.string().default('http://localhost:8008'),
  AI_WORKER_TRANSCRIBE_ENDPOINT: z.string().default('/v1/transcriptions'),
  AI_WORKER_HEALTH_ENDPOINT: z.string().default('/health'),
  AI_WORKER_TRANSLATE_ENDPOINT: z.string().optional(),
  AI_WORKER_SUMMARY_ENDPOINT: z.string().optional(),
  AI_MAX_UPLOAD_MB: z.coerce.number().default(500),
  AI_MAX_FILES: z.coerce.number().default(6),

  OLLAMA_BASE_URL: z.string().optional(),
  OLLAMA_MODEL: z.string().default('translategemma:latest'),
  OLLAMA_TIMEOUT_MS: z.coerce.number().default(300000)
});

export const env = envSchema.parse(process.env);
