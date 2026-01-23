import { FastifyInstance } from 'fastify';
import { prisma } from '../lib/db.js';
import { generateToken, hashToken } from '../lib/auth.js';
import { sendMail } from '../lib/email.js';
import { env } from '../config/env.js';

const requireAdmin = async (req: any, reply: any) => {
  const user = req.user as { sub?: string; orgId?: string };
  if (!user?.orgId) {
    return reply.status(401).send({ error: 'Organization not found.' });
  }
  const membership = await prisma.membership.findFirst({
    where: { orgId: user.orgId, userId: user.sub }
  });
  if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
    return reply.status(403).send({ error: 'Not authorized.' });
  }
};

export const adminRoutes = async (app: FastifyInstance) => {
  app.get('/api/admin/org/members', { preHandler: [app.authenticate, requireAdmin] }, async (req, reply) => {
    const user = req.user as { orgId?: string };
    const members = await prisma.membership.findMany({
      where: { orgId: user.orgId },
      include: { user: { select: { id: true, email: true, name: true } } }
    });
    return reply.send({ members });
  });

  app.post('/api/admin/org/invite', { preHandler: [app.authenticate, requireAdmin] }, async (req, reply) => {
    const user = req.user as { orgId?: string };
    const body = req.body as { email?: string; role?: string };
    if (!body.email) {
      return reply.status(400).send({ error: 'Email is required.' });
    }

    const inviteToken = generateToken();
    const tokenHash = hashToken(inviteToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const invitedUser = await prisma.user.upsert({
      where: { email: body.email },
      update: {},
      create: { email: body.email }
    });

    await prisma.magicLinkToken.create({
      data: {
        userId: invitedUser.id,
        tokenHash,
        expiresAt
      }
    });

    await prisma.membership.upsert({
      where: { userId_orgId: { userId: invitedUser.id, orgId: user.orgId! } },
      create: {
        userId: invitedUser.id,
        orgId: user.orgId!,
        role: body.role === 'admin' ? 'admin' : 'member'
      },
      update: {
        role: body.role === 'admin' ? 'admin' : 'member'
      }
    });

    const linkBase = env.MAGIC_LINK_URL || `${env.CLIENT_URL}/magic-link.html`;
    const link = `${linkBase}?token=${inviteToken}&redirect=app.html`;
    await sendMail(body.email, 'Nomability team invite', `<p>You have been invited to Nomability.</p><p><a href="${link}">Accept invite</a></p>`);

    return reply.send({ ok: true });
  });

  app.delete('/api/admin/org/members/:id', { preHandler: [app.authenticate, requireAdmin] }, async (req, reply) => {
    const user = req.user as { orgId?: string };
    const memberId = (req.params as { id?: string }).id;
    if (!memberId) {
      return reply.status(400).send({ error: 'Member ID is required.' });
    }

    const membership = await prisma.membership.findUnique({ where: { id: memberId } });
    if (!membership || membership.orgId !== user.orgId) {
      return reply.status(404).send({ error: 'Member not found.' });
    }
    if (membership.role === 'owner') {
      return reply.status(400).send({ error: 'Owner cannot be removed.' });
    }

    await prisma.membership.delete({ where: { id: memberId } });
    return reply.send({ ok: true });
  });
};
