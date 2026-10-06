import crypto from "node:crypto";
import type { Account, User } from "./types.ts";

// Credits ledger and a provider-agnostic payments seam. No real processor is
// wired in: the spec says to validate processors (adult-content rules,
// reserves, chargebacks) first, so this only defines the shape.

export interface Product {
  id: string;
  kind: "credits" | "membership";
  label: string;
  priceCents: number;
  credits: number; // credits granted on purchase (memberships include some)
  days?: number; // membership length
}

// PLACEHOLDER prices and pack sizes. Not decided yet; see the spec's
// monetization tests (subscription + credits vs prepaid vs hybrid).
export const PRODUCTS: Product[] = [
  { id: "credits_50", kind: "credits", label: "50 credits", priceCents: 999, credits: 50 },
  { id: "credits_120", kind: "credits", label: "120 credits", priceCents: 1999, credits: 120 },
  { id: "member_monthly", kind: "membership", label: "Monthly membership + 100 credits", priceCents: 1399, credits: 100, days: 30 },
];

// PLACEHOLDER credit costs. Ordinary texting is never charged.
export const COSTS = {
  personalizedPhoto: 5,
  exclusivePhoto: 15,
};

export function getProduct(id: string): Product | undefined {
  return PRODUCTS.find((p) => p.id === id);
}

export function account(user: User): Account {
  user.account ??= { plan: "free", credits: 0, ledger: [] };
  return user.account;
}

// Adds (or with a negative delta, removes) credits. A ref makes it idempotent,
// so a payment webhook delivered twice only counts once. Returns false if the
// ref was already applied.
export function grant(user: User, delta: number, reason: string, ref?: string, at = new Date()): boolean {
  const acct = account(user);
  if (ref && acct.ledger.some((e) => e.ref === ref)) return false;
  acct.credits += delta;
  acct.ledger.push({ at: at.toISOString(), delta, reason, ref });
  return true;
}

export function spend(user: User, cost: number, reason: string, ref?: string): boolean {
  if (account(user).credits < cost) return false;
  return grant(user, -cost, reason, ref);
}

export function isMember(user: User, at = Date.now()): boolean {
  const acct = account(user);
  return acct.plan === "member" && !!acct.memberUntil && Date.parse(acct.memberUntil) > at;
}

export function applyPurchase(user: User, product: Product, ref: string, at = new Date()): boolean {
  if (!grant(user, product.credits, `purchase:${product.id}`, ref, at)) return false;
  if (product.kind === "membership" && product.days) {
    const acct = account(user);
    const from = Math.max(at.getTime(), acct.memberUntil ? Date.parse(acct.memberUntil) : 0);
    acct.plan = "member";
    acct.memberUntil = new Date(from + product.days * 86_400_000).toISOString();
  }
  return true;
}

export interface PaymentEvent {
  ref: string; // the processor's payment id; used for idempotency
  phone: string;
  productId: string;
}

// What any processor (Stripe, CCBill, Segpay, ...) needs to provide.
export interface PaymentProvider {
  name: string;
  checkoutUrl(phone: string, product: Product): Promise<string>;
  // Returns undefined for events we don't care about; throws on a bad signature.
  parseWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): PaymentEvent | undefined;
}

// Local stand-in. Its checkout page completes the purchase immediately and
// posts a signed webhook to ourselves, so the whole loop runs without a
// processor. Only enabled in simulator mode.
export class DevPaymentProvider implements PaymentProvider {
  name = "dev";
  constructor(private baseUrl: string, private secret: string) {}

  async checkoutUrl(phone: string, product: Product) {
    const q = new URLSearchParams({ phone, product: product.id });
    return `${this.baseUrl}/dev/checkout?${q}`;
  }

  sign(rawBody: string) {
    return crypto.createHmac("sha256", this.secret).update(rawBody).digest("hex");
  }

  parseWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>) {
    const sig = headers["x-dev-signature"];
    const expected = this.sign(rawBody);
    if (typeof sig !== "string" || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      throw new Error("bad payment signature");
    }
    const body = JSON.parse(rawBody);
    if (body.type !== "payment.succeeded") return undefined;
    return { ref: String(body.id), phone: String(body.phone), productId: String(body.product) };
  }
}
