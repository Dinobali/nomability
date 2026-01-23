import { prisma } from './db.js';
import { env } from '../config/env.js';

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing']);

const startOfMonth = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
};

export const getUsageThisMonth = async (orgId: string) => {
  const result = await prisma.usageRecord.aggregate({
    where: {
      orgId,
      createdAt: { gte: startOfMonth() }
    },
    _sum: { minutes: true }
  });
  return result._sum.minutes || 0;
};

export const getSubscription = async (orgId: string) => {
  return prisma.subscription.findUnique({ where: { orgId } });
};

export const isSubscriptionActive = (status?: string | null) => {
  if (!status) return false;
  return ACTIVE_SUBSCRIPTION_STATUSES.has(status);
};

export const getCredits = async (orgId: string) => {
  const balance = await prisma.creditBalance.findUnique({ where: { orgId } });
  return balance?.minutesRemaining || 0;
};

export const canStartJob = async (orgId: string) => {
  const org = await prisma.org.findUnique({ where: { id: orgId }, select: { overLimit: true } });
  const subscription = await getSubscription(orgId);
  const subscriptionActive = isSubscriptionActive(subscription?.status);
  const usageThisMonth = await getUsageThisMonth(orgId);
  const credits = await getCredits(orgId);

  if (subscriptionActive && usageThisMonth < env.PLAN_INCLUDED_MINUTES) {
    return { allowed: true, subscriptionActive, usageThisMonth, credits };
  }

  if (credits > 0) {
    return { allowed: true, subscriptionActive, usageThisMonth, credits };
  }

  if (org?.overLimit) {
    return { allowed: false, subscriptionActive, usageThisMonth, credits };
  }

  return { allowed: false, subscriptionActive, usageThisMonth, credits };
};

export const applyUsage = async (orgId: string, jobId: string, minutes: number) => {
  if (minutes <= 0) {
    return { minutes: 0, amountCents: 0 };
  }

  const subscription = await getSubscription(orgId);
  const subscriptionActive = isSubscriptionActive(subscription?.status);
  const usageThisMonth = await getUsageThisMonth(orgId);
  const includedRemaining = subscriptionActive
    ? Math.max(env.PLAN_INCLUDED_MINUTES - usageThisMonth, 0)
    : 0;

  let remaining = minutes;
  let coveredIncluded = 0;
  if (includedRemaining > 0) {
    coveredIncluded = Math.min(includedRemaining, remaining);
    remaining -= coveredIncluded;
  }

  let creditsUsed = 0;
  if (remaining > 0) {
    const balance = await prisma.creditBalance.findUnique({ where: { orgId } });
    const available = balance?.minutesRemaining || 0;
    creditsUsed = Math.min(available, remaining);
    remaining -= creditsUsed;

    if (creditsUsed > 0) {
      await prisma.creditBalance.upsert({
        where: { orgId },
        create: { orgId, minutesRemaining: available - creditsUsed },
        update: { minutesRemaining: available - creditsUsed }
      });
    }
  }

  if (remaining > 0) {
    await prisma.org.update({
      where: { id: orgId },
      data: { overLimit: true }
    });
  }

  const amountCents = remaining > 0
    ? Math.ceil((remaining * env.PAYG_RATE_CENTS_PER_HOUR) / 60)
    : 0;

  await prisma.usageRecord.create({
    data: {
      orgId,
      jobId,
      minutes,
      amountCents
    }
  });

  return { minutes, amountCents, coveredIncluded, creditsUsed, remainingOverLimit: remaining };
};
