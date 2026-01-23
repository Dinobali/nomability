# Nomability

Production-ready scaffold for Nomability with Node.js, PostgreSQL, Redis, Cloudflare R2, and a background worker.

## Local / Server Setup

1. Copy `.env.example` to `.env` and fill in values.
2. Start services:

```bash
docker compose up -d postgres redis
```

3. Build + run app + worker:

```bash
docker compose up -d api worker
```

4. Run Prisma migrations (first time):

```bash
docker compose exec api npx prisma migrate dev --name init
```

## Key Endpoints

- `POST /api/ai/jobs` – upload audio/video for transcription
- `GET /api/ai/jobs/:id` – poll job status
- `POST /api/auth/register` – create account
- `POST /api/auth/login` – login (password)
- `POST /api/auth/magic-link` – email a magic link
- `POST /api/billing/checkout` – Stripe checkout (monthly or payg)
- `POST /api/billing/portal` – Stripe customer portal
- `GET /api/billing/invoices` – recent invoices

## Notes

- AI worker + Ollama are configured via `AI_WORKER_BASE_URL` and `OLLAMA_BASE_URL`.
- Storage can be local (`R2_ENABLED=false`, `LOCAL_STORAGE_PATH=/app/storage`) or Cloudflare R2.
- Stripe checkout + webhook routes are scaffolded under `/api/billing/*`.
