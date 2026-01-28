import { env } from '../config/env.js';

type PlanDefinition = {
  key: string;
  label: string;
  priceId?: string;
  includedMinutes: number | null;
  amountCents?: number;
};

export const PLAN_DEFINITIONS: PlanDefinition[] = [
  {
    key: 'starter',
    label: '10 hours',
    priceId: env.STRIPE_PRICE_STARTER_10H,
    includedMinutes: 600,
    amountCents: 999
  },
  {
    key: 'pro',
    label: '20 hours',
    priceId: env.STRIPE_PRICE_PRO_20H,
    includedMinutes: 1200,
    amountCents: 1999
  },
  {
    key: 'unlimited',
    label: 'Unlimited',
    priceId: env.STRIPE_PRICE_UNLIMITED,
    includedMinutes: null,
    amountCents: 3499
  },
  {
    key: 'monthly',
    label: 'Monthly',
    priceId: env.STRIPE_PRICE_MONTHLY,
    includedMinutes: env.PLAN_INCLUDED_MINUTES
  }
];

export const getPlanByKey = (key?: string | null) => {
  if (!key) return undefined;
  return PLAN_DEFINITIONS.find((plan) => plan.key === key);
};

const normalizePriceId = (priceId?: string | null) => {
  if (!priceId) return null;
  return priceId.startsWith('manual:') ? priceId.slice('manual:'.length) : priceId;
};

export const getPlanByPriceId = (priceId?: string | null) => {
  if (!priceId) return undefined;
  const normalized = normalizePriceId(priceId);
  return PLAN_DEFINITIONS.find((plan) => plan.priceId === priceId)
    || (normalized ? PLAN_DEFINITIONS.find((plan) => plan.key === normalized) : undefined)
    || (normalized ? PLAN_DEFINITIONS.find((plan) => plan.priceId === normalized) : undefined);
};

export const getPriceIdForPlan = (planKey?: string | null) => {
  const plan = getPlanByKey(planKey || undefined);
  return plan?.priceId;
};

export const getIncludedMinutesForPriceId = (priceId?: string | null) => {
  const plan = getPlanByPriceId(priceId);
  if (!plan) return env.PLAN_INCLUDED_MINUTES;
  if (plan.includedMinutes === null) return Number.POSITIVE_INFINITY;
  return plan.includedMinutes;
};

export const getDisplayIncludedMinutes = (priceId?: string | null) => {
  const plan = getPlanByPriceId(priceId);
  if (plan?.includedMinutes === null) return null;
  return plan?.includedMinutes ?? env.PLAN_INCLUDED_MINUTES;
};

export const getPlanLabel = (priceId?: string | null) => {
  const plan = getPlanByPriceId(priceId);
  return plan?.label || null;
};
