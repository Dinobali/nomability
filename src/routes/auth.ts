import { FastifyInstance } from 'fastify';
import { randomInt } from 'node:crypto';
import { prisma } from '../lib/db.js';
import { env } from '../config/env.js';
import { generateToken, hashPassword, hashToken, verifyPassword, isStrongPassword, PASSWORD_POLICY_MESSAGE } from '../lib/auth.js';
import { sendMail } from '../lib/email.js';

const issueJwt = (app: FastifyInstance, userId: string, orgId?: string | null) => {
  return app.jwt.sign({ sub: userId, orgId });
};

const VERIFICATION_CODE_TTL_MS = env.EMAIL_VERIFICATION_CODE_TTL_MINUTES * 60 * 1000;

const ensureOrgId = async (user: { id: string; email: string; memberships?: Array<{ orgId: string }> }) => {
  const existingOrgId = user.memberships?.[0]?.orgId || null;
  if (existingOrgId) return existingOrgId;
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
  return org.id;
};

const sendEmailVerification = async (user: { id: string; email: string }) => {
  const code = String(randomInt(100000, 1000000));
  const tokenHash = hashToken(code);
  const expiresAt = new Date(Date.now() + VERIFICATION_CODE_TTL_MS);

  await prisma.emailVerificationToken.create({
    data: {
      userId: user.id,
      tokenHash,
      expiresAt
    }
  });

  const linkBase = env.EMAIL_VERIFY_URL || `${env.CLIENT_URL}/verify-email.html`;
  const link = `${linkBase}?email=${encodeURIComponent(user.email)}&code=${encodeURIComponent(code)}`;
  await sendMail(
    user.email,
    'Verify your Nomability email',
    `<p>Use this code to verify your email:</p><p><strong>${code}</strong></p><p>Or click:</p><p><a href="${link}">${link}</a></p>`
  );
};

export const authRoutes = async (app: FastifyInstance) => {
  app.post('/api/auth/register', async (req, reply) => {
    const body = req.body as { email?: string; password?: string; name?: string; orgName?: string };
    if (!body.email || !body.password) {
      return reply.status(400).send({ error: 'Email and password are required.' });
    }
    if (!isStrongPassword(body.password)) {
      return reply.status(400).send({ error: PASSWORD_POLICY_MESSAGE });
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
        passwordHash,
        emailVerifiedAt: env.EMAIL_VERIFICATION_REQUIRED ? null : new Date()
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

    if (env.EMAIL_VERIFICATION_REQUIRED) {
      await sendEmailVerification(user);
      return reply.send({ ok: true, verificationRequired: true });
    }

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

    if (env.EMAIL_VERIFICATION_REQUIRED && !user.emailVerifiedAt) {
      return reply
        .status(403)
        .send({ error: 'Email not verified. Check your inbox for the code.', code: 'EMAIL_NOT_VERIFIED', verificationRequired: true });
    }

    const orgId = await ensureOrgId(user);
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

  app.post('/api/auth/email-verification/request', async (req, reply) => {
    const body = req.body as { email?: string; force?: boolean };
    if (!body.email) {
      return reply.status(400).send({ error: 'Email is required.' });
    }

    const force = body.force === true;
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user) {
      return reply.send({ ok: true });
    }

    if (!user.emailVerifiedAt || force) {
      await sendEmailVerification(user);
    }

    return reply.send({ ok: true });
  });

  app.post('/api/auth/email-verification/confirm', async (req, reply) => {
    const body = req.body as { email?: string; code?: string };
    if (!body.email || !body.code) {
      return reply.status(400).send({ error: 'Email and code are required.' });
    }

    const user = await prisma.user.findUnique({
      where: { email: body.email },
      include: { memberships: true }
    });

    if (!user) {
      return reply.status(400).send({ error: 'Invalid or expired code.' });
    }

    const tokenHash = hashToken(body.code.trim());
    const record = await prisma.emailVerificationToken.findFirst({
      where: {
        userId: user.id,
        tokenHash,
        usedAt: null,
        expiresAt: { gt: new Date() }
      }
    });

    if (!record) {
      return reply.status(400).send({ error: 'Invalid or expired code.' });
    }

    await prisma.emailVerificationToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() }
    });

    if (!user.emailVerifiedAt) {
      await prisma.user.update({
        where: { id: user.id },
        data: { emailVerifiedAt: new Date() }
      });
    }

    const orgId = await ensureOrgId(user);
    const token = issueJwt(app, user.id, orgId);
    return reply.send({ ok: true, token });
  });

  app.post('/api/auth/password-reset/confirm', async (req, reply) => {
    const body = req.body as { token?: string; password?: string };
    if (!body.token || !body.password) {
      return reply.status(400).send({ error: 'Token and password are required.' });
    }
    if (!isStrongPassword(body.password)) {
      return reply.status(400).send({ error: PASSWORD_POLICY_MESSAGE });
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

    if (!record.user.emailVerifiedAt) {
      await prisma.user.update({
        where: { id: record.userId },
        data: { emailVerifiedAt: new Date() }
      });
    }

    const orgId = await ensureOrgId(record.user);
    const jwt = issueJwt(app, record.userId, orgId);
    return reply.send({ token: jwt });
  });

  app.get('/api/auth/me', { preHandler: app.authenticate }, async (req, reply) => {
    const { sub: userId, orgId } = req.user as { sub: string; orgId?: string };
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, createdAt: true, emailVerifiedAt: true }
    });

    const org = orgId
      ? await prisma.org.findUnique({
          where: { id: orgId },
          select: { id: true, name: true, createdAt: true }
        })
      : null;

    const membership = orgId
      ? await prisma.membership.findUnique({
          where: { userId_orgId: { userId, orgId } },
          select: { role: true }
        })
      : null;

    return reply.send({ user, org, membership });
  });

  app.patch('/api/auth/me', { preHandler: app.authenticate }, async (req, reply) => {
    const { sub: userId, orgId } = req.user as { sub: string; orgId?: string };
    const body = req.body as { name?: string; email?: string; orgName?: string; currentPassword?: string };

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, passwordHash: true, emailVerifiedAt: true }
    });

    if (!user) {
      return reply.status(404).send({ error: 'User not found.' });
    }

    const updates: { name?: string | null; email?: string; emailVerifiedAt?: Date | null } = {};
    let resendVerification = false;

    if (typeof body.name === 'string') {
      const trimmed = body.name.trim();
      updates.name = trimmed.length ? trimmed : null;
    }

    if (typeof body.email === 'string') {
      const nextEmail = body.email.trim().toLowerCase();
      if (nextEmail && nextEmail !== user.email) {
        if (!user.passwordHash) {
          return reply.status(400).send({ error: 'Password not set. Use password reset to set one.' });
        }
        if (!body.currentPassword) {
          return reply.status(400).send({ error: 'Current password required to change email.' });
        }
        const valid = await verifyPassword(body.currentPassword, user.passwordHash);
        if (!valid) {
          return reply.status(401).send({ error: 'Invalid password.' });
        }
        const existing = await prisma.user.findUnique({ where: { email: nextEmail } });
        if (existing && existing.id !== userId) {
          return reply.status(409).send({ error: 'Email already in use.' });
        }
        updates.email = nextEmail;
        if (env.EMAIL_VERIFICATION_REQUIRED) {
          updates.emailVerifiedAt = null;
          resendVerification = true;
        }
      }
    }

    if (Object.keys(updates).length) {
      await prisma.user.update({
        where: { id: userId },
        data: updates
      });
    }

    if (orgId && typeof body.orgName === 'string') {
      const trimmedOrg = body.orgName.trim();
      if (trimmedOrg) {
        const membership = await prisma.membership.findUnique({
          where: { userId_orgId: { userId, orgId } },
          select: { role: true }
        });
        if (membership?.role !== 'owner') {
          return reply.status(403).send({ error: 'Only owners can update the organization.' });
        }
        await prisma.org.update({
          where: { id: orgId },
          data: { name: trimmedOrg }
        });
      }
    }

    const updatedUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, createdAt: true, emailVerifiedAt: true }
    });
    const updatedOrg = orgId
      ? await prisma.org.findUnique({
          where: { id: orgId },
          select: { id: true, name: true, createdAt: true }
        })
      : null;

    if (resendVerification && updatedUser?.email) {
      await sendEmailVerification({ id: userId, email: updatedUser.email });
    }

    return reply.send({ user: updatedUser, org: updatedOrg });
  });

  app.post('/api/auth/password-change', { preHandler: app.authenticate }, async (req, reply) => {
    const { sub: userId } = req.user as { sub: string };
    const body = req.body as { currentPassword?: string; newPassword?: string };

    if (!body.currentPassword || !body.newPassword) {
      return reply.status(400).send({ error: 'Current password and new password are required.' });
    }

    if (!isStrongPassword(body.newPassword)) {
      return reply.status(400).send({ error: PASSWORD_POLICY_MESSAGE });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true }
    });

    if (!user?.passwordHash) {
      return reply.status(400).send({ error: 'Password not set. Use password reset to set one.' });
    }

    const valid = await verifyPassword(body.currentPassword, user.passwordHash);
    if (!valid) {
      return reply.status(401).send({ error: 'Invalid password.' });
    }

    const passwordHash = await hashPassword(body.newPassword);
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash }
    });

    return reply.send({ ok: true });
  });
};
