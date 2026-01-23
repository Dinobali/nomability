import { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { prisma } from '../lib/db.js';
import { env } from '../config/env.js';
import { getDisplayIncludedMinutes, getPlanByKey, getPlanLabel, getPriceIdForPlan } from '../lib/plans.js';

const stripe = env.STRIPE_SECRET_KEY
  ? new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' })
  : null;

export const billingRoutes = async (app: FastifyInstance) => {
  app.post('/api/billing/checkout', { preHandler: app.authenticate }, async (req, reply) => {
    if (!stripe) {
      return reply.status(400).send({ error: 'Stripe is not configured.' });
    }
    const body = req.body as { plan?: string; hours?: number };
    const plan = body.plan || 'starter';
    const isPayg = plan === 'payg';
    const priceId = isPayg ? env.STRIPE_PRICE_PAYG : getPriceIdForPlan(plan);

    if (!priceId) {
      return reply.status(400).send({ error: 'Stripe price ID missing.' });
    }

    const user = req.user as { sub: string; orgId?: string };
    if (!user.orgId) {
      return reply.status(400).send({ error: 'Organization not found.' });
    }

    let customer = await prisma.stripeCustomer.findUnique({ where: { orgId: user.orgId } });
    if (!customer) {
      const org = await prisma.org.findUnique({ where: { id: user.orgId } });
      const created = await stripe.customers.create({
        name: org?.name,
        email: undefined
      });
      customer = await prisma.stripeCustomer.create({
        data: { orgId: user.orgId, stripeCustomerId: created.id }
      });
    }

    const quantity = isPayg ? Math.max(1, Math.floor(body.hours || 1)) : 1;

    const session = await stripe.checkout.sessions.create({
      mode: isPayg ? 'payment' : 'subscription',
      customer: customer.stripeCustomerId,
      line_items: [{ price: priceId, quantity }],
      metadata: {
        orgId: user.orgId,
        plan
      },
      success_url: `${env.CLIENT_URL}/billing-success.html`,
      cancel_url: `${env.CLIENT_URL}/billing-cancel.html`
    });

    return reply.send({ url: session.url });
  });

  app.post('/api/billing/portal', { preHandler: app.authenticate }, async (req, reply) => {
    if (!stripe) {
      return reply.status(400).send({ error: 'Stripe is not configured.' });
    }
    const user = req.user as { sub: string; orgId?: string };
    if (!user.orgId) {
      return reply.status(400).send({ error: 'Organization not found.' });
    }
    const customer = await prisma.stripeCustomer.findUnique({ where: { orgId: user.orgId } });
    if (!customer) {
      return reply.status(404).send({ error: 'Stripe customer not found.' });
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: customer.stripeCustomerId,
      return_url: env.CLIENT_URL
    });
    return reply.send({ url: session.url });
  });

  app.get('/api/billing/invoices', { preHandler: app.authenticate }, async (req, reply) => {
    if (!stripe) {
      return reply.status(400).send({ error: 'Stripe is not configured.' });
    }
    const user = req.user as { sub: string; orgId?: string };
    if (!user.orgId) {
      return reply.status(400).send({ error: 'Organization not found.' });
    }
    const customer = await prisma.stripeCustomer.findUnique({ where: { orgId: user.orgId } });
    if (!customer) {
      return reply.status(404).send({ error: 'Stripe customer not found.' });
    }
    const invoices = await stripe.invoices.list({
      customer: customer.stripeCustomerId,
      limit: 10
    });
    return reply.send({ invoices: invoices.data });
  });

  app.get('/api/billing/status', { preHandler: app.authenticate }, async (req, reply) => {
    const user = req.user as { sub: string; orgId?: string };
    if (!user.orgId) {
      return reply.status(400).send({ error: 'Organization not found.' });
    }
    const subscription = await prisma.subscription.findUnique({ where: { orgId: user.orgId } });
    const credits = await prisma.creditBalance.findUnique({ where: { orgId: user.orgId } });
    const usage = await prisma.usageRecord.aggregate({
      where: {
        orgId: user.orgId,
        createdAt: { gte: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)) }
      },
      _sum: { minutes: true }
    });
    const includedMinutes = subscription
      ? getDisplayIncludedMinutes(subscription.priceId)
      : 0;
    return reply.send({
      subscription,
      credits: credits?.minutesRemaining || 0,
      usageThisMonth: usage._sum.minutes || 0,
      includedMinutes,
      unlimited: includedMinutes === null,
      planLabel: subscription ? getPlanLabel(subscription.priceId) : null
    });
  });

  app.get('/api/billing/bank-details', async (_req, reply) => {
    const bank = {
      accountHolder: env.BANK_ACCOUNT_HOLDER,
      iban: env.BANK_IBAN,
      bic: env.BANK_BIC,
      bankName: env.BANK_NAME
    };

    if (!bank.iban) {
      return reply.status(404).send({ error: 'Bank details not configured.' });
    }

    return reply.send({ bank });
  });

  app.post('/api/billing/invoice', { preHandler: app.authenticate }, async (req, reply) => {
    const body = req.body as { plan?: string; name?: string; address?: string; phone?: string };
    const plan = getPlanByKey(body.plan || 'starter');

    if (!plan || plan.amountCents == null) {
      return reply.status(400).send({ error: 'Invalid plan.' });
    }

    if (!body.name || !body.address || !body.phone) {
      return reply.status(400).send({ error: 'Name, address, and phone are required.' });
    }

    const user = req.user as { sub: string; orgId?: string };
    if (!user.orgId) {
      return reply.status(400).send({ error: 'Organization not found.' });
    }

    const invoiceNumber = await generateInvoiceNumber();
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 14);

    const invoice = await prisma.invoiceRequest.create({
      data: {
        orgId: user.orgId,
        userId: user.sub,
        planKey: plan.key,
        amountCents: plan.amountCents,
        invoiceNumber,
        billingName: body.name,
        billingAddress: body.address,
        billingPhone: body.phone,
        dueDate
      }
    });

    return reply.send({
      invoice,
      bank: {
        accountHolder: env.BANK_ACCOUNT_HOLDER,
        iban: env.BANK_IBAN,
        bic: env.BANK_BIC,
        bankName: env.BANK_NAME
      }
    });
  });

  app.get('/api/billing/invoice', { preHandler: app.authenticate }, async (req, reply) => {
    const user = req.user as { sub: string; orgId?: string };
    if (!user.orgId) {
      return reply.status(400).send({ error: 'Organization not found.' });
    }

    const invoices = await prisma.invoiceRequest.findMany({
      where: { orgId: user.orgId },
      orderBy: { createdAt: 'desc' }
    });

    return reply.send({ invoices });
  });

  app.post('/api/billing/webhook', { config: { rawBody: true } }, async (req, reply) => {
    if (!stripe || !env.STRIPE_WEBHOOK_SECRET) {
      return reply.status(400).send({ error: 'Stripe webhook not configured.' });
    }

    const signature = req.headers['stripe-signature'] as string | undefined;
    if (!signature) {
      return reply.status(400).send({ error: 'Missing signature.' });
    }

    const rawBody = (req as any).rawBody as Buffer | undefined;
    if (!rawBody) {
      return reply.status(400).send({ error: 'Missing raw body.' });
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
    } catch (error) {
      return reply.status(400).send({ error: 'Invalid signature.' });
    }

    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.created') {
      const subscription = event.data.object as Stripe.Subscription;
      await prisma.subscription.upsert({
        where: { stripeSubscriptionId: subscription.id },
        create: {
          orgId: await resolveOrgId(subscription.customer as string),
          stripeSubscriptionId: subscription.id,
          priceId: subscription.items.data[0]?.price.id,
          status: subscription.status,
          currentPeriodEnd: subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null
        },
        update: {
          priceId: subscription.items.data[0]?.price.id,
          status: subscription.status,
          currentPeriodEnd: subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null
        }
      });
    }

    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object as Stripe.Subscription;
      await prisma.subscription.updateMany({
        where: { stripeSubscriptionId: subscription.id },
        data: {
          status: subscription.status,
          currentPeriodEnd: subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null
        }
      });
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode === 'payment' && session.metadata?.plan === 'payg') {
        const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 10 });
        const paygPriceId = env.STRIPE_PRICE_PAYG;
        const totalHours = lineItems.data.reduce((acc, item) => {
          if (item.price?.id === paygPriceId) {
            return acc + (item.quantity || 0);
          }
          return acc;
        }, 0);
        const orgId = session.metadata?.orgId || (session.customer ? await resolveOrgId(session.customer as string) : null);
        if (orgId && totalHours > 0) {
          const minutesToAdd = totalHours * 60;
          const existing = await prisma.creditBalance.findUnique({ where: { orgId } });
          const current = existing?.minutesRemaining || 0;
          await prisma.creditBalance.upsert({
            where: { orgId },
            create: { orgId, minutesRemaining: current + minutesToAdd },
            update: { minutesRemaining: current + minutesToAdd }
          });
          await prisma.org.update({ where: { id: orgId }, data: { overLimit: false } });
        }
      }
    }

    return reply.send({ received: true });
  });
};

const generateInvoiceNumber = async () => {
  const now = new Date();
  const prefix = `INV-${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const suffix = String(Math.floor(1000 + Math.random() * 9000));
    const invoiceNumber = `${prefix}-${suffix}`;
    const existing = await prisma.invoiceRequest.findUnique({ where: { invoiceNumber } });
    if (!existing) return invoiceNumber;
  }

  throw new Error('Unable to generate invoice number.');
};

const resolveOrgId = async (stripeCustomerId: string) => {
  const record = await prisma.stripeCustomer.findUnique({ where: { stripeCustomerId } });
  if (!record) {
    throw new Error('Stripe customer not found.');
  }
  return record.orgId;
};
