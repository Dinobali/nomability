import { FastifyInstance } from 'fastify';
import { prisma } from '../lib/db.js';
import { env } from '../config/env.js';
import { generateToken, hashPassword, hashToken, verifyPassword } from '../lib/auth.js';
import { sendMail } from '../lib/email.js';

const issueJwt = (app: FastifyInstance, userId: string, orgId?: string | null) => {
  return app.jwt.sign({ sub: userId, orgId });
};

export const authRoutes = async (app: FastifyInstance) => {
  app.post('/api/auth/register', async (req, reply) => {
    const body = req.body as { email?: string; password?: string; name?: string; orgName?: string };
    if (!body.email || !body.password) {
      return reply.status(400).send({ error: 'Email and password are required.' });
    }

    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) {
      return reply.status(409).send({ error: 'Email already registered.' });
    }

    const passwordHash = await hashPassword(body.password);
    const user = await prisma.user.create({
      data: {
        email: body.email,
        name: body.name,
        passwordHash
      }
    });

    const orgName = body.orgName || body.email.split('@')[0];
    const org = await prisma.org.create({
      data: {
        name: orgName,
        memberships: {
          create: {
            userId: user.id,
            role: 'owner'
          }
        }
      }
    });

    const token = issueJwt(app, user.id, org.id);
    return reply.send({ token });
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = req.body as { email?: string; password?: string };
    if (!body.email || !body.password) {
      return reply.status(400).send({ error: 'Email and password are required.' });
    }

    const user = await prisma.user.findUnique({
      where: { email: body.email },
      include: { memberships: true }
    });

    if (!user || !user.passwordHash) {
      return reply.status(401).send({ error: 'Invalid credentials.' });
    }

    const valid = await verifyPassword(body.password, user.passwordHash);
    if (!valid) {
      return reply.status(401).send({ error: 'Invalid credentials.' });
    }

    let orgId = user.memberships[0]?.orgId || null;
    if (!orgId) {
      const fallbackName = user.email.split('@')[0];
      const org = await prisma.org.create({
        data: {
          name: fallbackName,
          memberships: {
            create: {
              userId: user.id,
              role: 'owner'
            }
          }
        }
      });
      orgId = org.id;
    }
    const token = issueJwt(app, user.id, orgId);
    return reply.send({ token });
  });

  app.post('/api/auth/magic-link', async (req, reply) => {
    const body = req.body as { email?: string };
    if (!body.email) {
      return reply.status(400).send({ error: 'Email is required.' });
    }

    const user = await prisma.user.upsert({
      where: { email: body.email },
      update: {},
      create: { email: body.email }
    });

    const token = generateToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await prisma.magicLinkToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt
      }
    });

    const linkBase = env.MAGIC_LINK_URL || `${env.CLIENT_URL}/magic-link.html`;
    const link = `${linkBase}?token=${token}`;

    await sendMail(body.email, 'Your Nomability login link', `<p>Click to sign in:</p><p><a href="${link}">${link}</a></p>`);

    return reply.send({ ok: true });
  });

  app.post('/api/auth/password-reset/request', async (req, reply) => {
    const body = req.body as { email?: string };
    if (!body.email) {
      return reply.status(400).send({ error: 'Email is required.' });
    }

    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user) {
      return reply.send({ ok: true });
    }

    const token = generateToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt
      }
    });

    const linkBase = env.PASSWORD_RESET_URL || `${env.CLIENT_URL}/reset-password.html`;
    const link = `${linkBase}?token=${token}`;
    await sendMail(body.email, 'Reset your Nomability password', `<p>Reset your password:</p><p><a href=\"${link}\">${link}</a></p>`);

    return reply.send({ ok: true });
  });

  app.post('/api/auth/password-reset/confirm', async (req, reply) => {
    const body = req.body as { token?: string; password?: string };
    if (!body.token || !body.password) {
      return reply.status(400).send({ error: 'Token and password are required.' });
    }

    const tokenHash = hashToken(body.token);
    const record = await prisma.passwordResetToken.findFirst({
      where: {
        tokenHash,
        usedAt: null,
        expiresAt: { gt: new Date() }
      }
    });

    if (!record) {
      return reply.status(400).send({ error: 'Invalid or expired token.' });
    }

    const passwordHash = await hashPassword(body.password);
    await prisma.user.update({
      where: { id: record.userId },
      data: { passwordHash }
    });
    await prisma.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() }
    });

    return reply.send({ ok: true });
  });

  app.get('/api/auth/magic-link/verify', async (req, reply) => {
    const token = (req.query as { token?: string }).token;
    if (!token) {
      return reply.status(400).send({ error: 'Missing token.' });
    }

    const tokenHash = hashToken(token);
    const record = await prisma.magicLinkToken.findFirst({
      where: {
        tokenHash,
        usedAt: null,
        expiresAt: { gt: new Date() }
      },
      include: { user: { include: { memberships: true } } }
    });

    if (!record) {
      return reply.status(400).send({ error: 'Invalid or expired token.' });
    }

    await prisma.magicLinkToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() }
    });

    let orgId = record.user.memberships[0]?.orgId || null;
    if (!orgId) {
      const fallbackName = record.user.email.split('@')[0];
      const org = await prisma.org.create({
        data: {
          name: fallbackName,
          memberships: {
            create: {
              userId: record.userId,
              role: 'owner'
            }
          }
        }
      });
      orgId = org.id;
    }
    const jwt = issueJwt(app, record.userId, orgId);
    return reply.send({ token: jwt });
  });

  app.get('/api/auth/me', { preHandler: app.authenticate }, async (req, reply) => {
    const userId = (req.user as { sub: string }).sub;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true }
    });

    return reply.send({ user });
  });
};
