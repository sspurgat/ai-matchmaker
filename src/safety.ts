import type { IdentityId, SafetyKind, User } from "./types.ts";

// Deterministic safety checks that run on every inbound text, before and
// independent of the model. The prompts carry the same rules; these are the
// backstop that doesn't depend on the model following them.

export type AgeAnswer = "adult" | "minor" | "unclear";

const SAYS_UNDER = /\b(under|below|younger than|less than)\s*(18|eighteen)\b/i;
const SAYS_NOT_UNDER = /\bnot\s+(under|below|younger than)\s*(18|eighteen)\b/i;
const NO = /^\s*(n|no|nope|nah|not yet|i'?m not|im not|i am not)\b/i;
const YES = /^\s*(y|ya|yes|yeah|yep|yup|sure|ok|okay|i am|i'?m|im|correct|of course|definitely|absolutely|over 18|18\+)\b/i;

// Reads an answer to "are you 18 or older?". Numbers win over words, so
// "yes I'm 16" is a minor, and "no" wins over "I'm" in "I'm not".
export function parseAgeAnswer(text: string): AgeAnswer {
  if (SAYS_NOT_UNDER.test(text)) return "adult";
  if (SAYS_UNDER.test(text)) return "minor";
  const num = text.match(/\b(\d{1,3})\b/);
  if (num) {
    const n = Number(num[1]);
    if (n < 18) return "minor";
    if (n <= 120) return "adult";
  }
  if (NO.test(text)) return "minor";
  if (YES.test(text)) return "adult";
  return "unclear";
}

// First-person statements of being under 18, said mid-conversation.
// Deliberately narrow ("I'm 16", "im 15 years old", "I'm in high school") so
// "I'm 5 minutes away" or "my nephew is 12" don't trip it.
const AGE_STATEMENT =
  /\b(?:i'?m|i am|im)\s+(?:only\s+|just\s+)?(\d{1,2})(?:\s*(?:yo|y\/o|yrs?\s*old|years?\s*old))?(?=\s*(?:$|[.,!?)]|and\b|but\b|btw\b|tho\b|lol\b|lmao\b|haha\b))/i;
const IN_SCHOOL = /\b(?:i'?m|i am|im)\s+(?:in|a)\s+(?:high school|middle school|junior high|freshman in high school|sophomore in high school|(?:6|7|8|9|10|11|12)th grade)\b/i;

export function mentionsBeingMinor(text: string): boolean {
  if (IN_SCHOOL.test(text)) return true;
  const m = text.match(AGE_STATEMENT);
  return !!m && Number(m[1]) < 18;
}

const SELF_HARM =
  /\b(kill(ing)? myself|suicid\w*|end(ing)? my life|want(ed)? to die|wanna die|self[- ]?harm|cut(ting)? myself|hurt(ing)? myself|(don'?t|do not) want to (live|be alive|be here)|no reason to live|better off dead)\b/i;

export function mentionsSelfHarm(text: string): boolean {
  return SELF_HARM.test(text);
}

export const CRISIS_TEXT =
  "If you're thinking about hurting yourself, please reach out to the 988 Suicide & Crisis Lifeline: call or text 988 (US), any time. You can also text HOME to 741741.";

// Make sure crisis resources go out even if the model forgot them.
export function withCrisisResources(texts: string[]): string[] {
  return texts.some((t) => t.includes("988")) ? texts : [...texts, CRISIS_TEXT];
}

export function recordSafetyEvent(user: User, kind: SafetyKind, identity: IdentityId, text: string) {
  user.safety ??= { events: [] };
  user.safety.events.push({ at: new Date().toISOString(), kind, identity, excerpt: text.slice(0, 200) });
  if (user.safety.events.length > 200) user.safety.events.splice(0, user.safety.events.length - 200);
}

// Simple sliding-window rate limit per user across all lines. In memory only;
// a restart resets it, which is fine for abuse control at this stage.
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs = 60_000) {}
  allow(key: string, at = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => at - t < this.windowMs);
    recent.push(at);
    this.hits.set(key, recent);
    return recent.length <= this.max;
  }
}
