import "server-only";
import Stripe from "stripe";
import { serverEnv } from "@/lib/env";

let stripe: Stripe | null | undefined;

/** Client Stripe (null si non configuré : la facturation reste gérée par le super admin). */
export function getStripe(): Stripe | null {
  if (stripe !== undefined) return stripe;
  const key = serverEnv().stripeSecretKey;
  stripe = key ? new Stripe(key) : null;
  return stripe;
}
