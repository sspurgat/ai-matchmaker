import { MemoryAnalytics, type Analytics } from "./analytics.ts";
import { COSTS, PRODUCTS, account, applyPurchase, getProduct, grant, spend, type PaymentEvent, type PaymentProvider } from "./billing.ts";
import { CHARACTERS, getCharacter } from "./characters.ts";
import { describeError, type Brain } from "./llm.ts";
import { NoImageGenerator, PHOTO_REQUEST, checkImageRequest, nextLibraryPhoto, type ImageGenerator } from "./media.ts";
import {
  AGE_RETRY_TEXT,
  BLOCKED_PHOTO_NUDGE,
  BLOCKED_TEXT,
  HELP_TEXT,
  NO_PHOTO_NUDGE,
  READY_NUDGE,
  STOPPED_TEXT,
  UNDERAGE_TEXT,
  WELCOME_TEXTS,
  appNotice,
  checkInNudge,
  companionSystem,
  introNudge,
  matchmakerSystem,
  photoNudge,
} from "./prompts.ts";
import { rankCharacters } from "./ranking.ts";
import {
  CRISIS_TEXT,
  RateLimiter,
  mentionsBeingMinor,
  mentionsSelfHarm,
  parseAgeAnswer,
  recordSafetyEvent,
  withCrisisResources,
} from "./safety.ts";
import { newUser, type Store } from "./store.ts";
import type { Transport } from "./transport.ts";
import { MATCHMAKER, type ChatMessage, type IdentityId, type Relationship, type User } from "./types.ts";

export interface EngineConfig {
  introsPerRound: number; // how many people the matchmaker introduces at once
  minDiscoveryMessages: number; // user texts before we try to build a profile
  introDelayMs: number; // gap between "I have people in mind" and each intro
  typingMsPerChar: number; // fake typing time so replies don't feel instant
  coolingAfterMs: number; // quiet this long -> relationship is cooling
  dormantAfterMs: number; // quiet this long -> dormant, matchmaker checks in
  summarizeAfter: number; // unsummarized companion messages before folding old ones into memory
  keepRecent: number; // messages kept verbatim after a summary
  maxInboundPerMinute: number; // per user, across all lines
  startingCredits: number; // granted once, when age is confirmed
  showErrors: boolean; // simulator: tell the tester why a reply failed instead of a generic apology
}

export const DEFAULT_CONFIG: EngineConfig = {
  introsPerRound: 2,
  minDiscoveryMessages: 4,
  introDelayMs: 20_000,
  typingMsPerChar: 25,
  coolingAfterMs: 24 * 3600_000,
  dormantAfterMs: 3 * 24 * 3600_000,
  summarizeAfter: 40,
  keepRecent: 16,
  maxInboundPerMinute: 20,
  startingCredits: 10, // PLACEHOLDER: the spec leaves this open
  showErrors: false,
};

export interface EngineDeps {
  analytics?: Analytics;
  images?: ImageGenerator;
  payments?: PaymentProvider;
}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const now = () => new Date().toISOString();

const STOP = /^\s*(stop|unsubscribe|cancel|end|quit)\s*$/i;
const START = /^\s*(start|unstop)\s*$/i;
const HELP = /^\s*(help|info)\s*$/i;
const CREDITS = /^\s*(credits|balance)\s*$/i;
const CONFIRM = /^\s*(y|yes|yeah|yep|yup|sure|ok|okay|do it|send it)\b/i;
const WANTS_MORE = /\b(someone (else|new)|another (person|match|one)|more people|new match|introduce me)\b/i;

export class Engine {
  private locks = new Map<string, Promise<unknown>>();
  private background = new Set<Promise<unknown>>();
  private limiter: RateLimiter;
  readonly analytics: Analytics;
  private images: ImageGenerator;
  private payments?: PaymentProvider;

  constructor(
    private store: Store,
    private brain: Brain,
    private transport: Transport,
    private config: EngineConfig = DEFAULT_CONFIG,
    deps: EngineDeps = {},
  ) {
    this.limiter = new RateLimiter(config.maxInboundPerMinute);
    this.analytics = deps.analytics ?? new MemoryAnalytics();
    this.images = deps.images ?? new NoImageGenerator();
    this.payments = deps.payments;
  }

  // Resolves once scheduled work (intros, memory summaries) has finished. Used by tests.
  async idle() {
    while (this.background.size) await Promise.all([...this.background]);
  }

  // One message at a time per user, so state updates never interleave.
  private withUser<T>(phone: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(phone) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(phone, next);
    return next;
  }

  private spawn(p: Promise<unknown>) {
    const tracked = p.catch((err) => console.error("background task failed", err)).finally(() => this.background.delete(tracked));
    this.background.add(tracked);
  }

  handleInbound(identity: IdentityId, phone: string, text: string, chatId?: string) {
    return this.withUser(phone, async () => {
      let user = this.store.getUser(phone);
      if (!user) {
        user = newUser(phone);
        this.analytics.track("user_created", phone);
      }
      if (chatId) user.chatIds[identity] = chatId;

      // Compliance keywords work on every line, whatever state the user is in.
      if (STOP.test(text)) {
        if (user.stage !== "blocked") user.stage = "opted_out";
        this.store.saveUser(user);
        this.analytics.track("opted_out", phone);
        await this.send(user, identity, [STOPPED_TEXT], { record: false });
        return;
      }
      if (user.stage === "blocked") return;

      if (!this.limiter.allow(phone)) {
        const events = user.safety?.events ?? [];
        const last = [...events].reverse().find((e) => e.kind === "rate_limited");
        if (!last || Date.now() - Date.parse(last.at) > 60_000) recordSafetyEvent(user, "rate_limited", identity, text);
        this.store.saveUser(user);
        return;
      }

      if (HELP.test(text)) {
        this.store.saveUser(user);
        return this.send(user, identity, [HELP_TEXT], { record: false });
      }
      if (CREDITS.test(text) && user.ageConfirmedAt) {
        await this.send(user, identity, [await this.creditsText(user)], { record: false });
        this.store.saveUser(user);
        return;
      }

      if (user.stage === "opted_out") {
        if (!START.test(text)) return;
        user.stage = !user.ageConfirmedAt ? "age_gate" : user.profile ? "matched" : "discovery";
        this.analytics.track("opted_in", phone);
      }

      // Backstops that don't depend on the model. The age gate has its own age parsing.
      const crisis = mentionsSelfHarm(text);
      if (crisis) {
        recordSafetyEvent(user, "self_harm", identity, text);
        this.analytics.track("safety_event", phone, { kind: "self_harm" });
        if (user.stage === "age_gate") await this.send(user, identity, [CRISIS_TEXT], { record: false });
      }
      if (user.stage !== "age_gate" && mentionsBeingMinor(text)) {
        user.stage = "blocked";
        recordSafetyEvent(user, "underage", identity, text);
        this.analytics.track("safety_event", phone, { kind: "underage" });
        this.store.saveUser(user);
        await this.send(user, identity, crisis ? [BLOCKED_TEXT, CRISIS_TEXT] : [BLOCKED_TEXT], { record: false });
        return;
      }

      this.analytics.track("user_message", phone, { identity });
      try {
        if (identity === MATCHMAKER) await this.onMatchmakerText(user, text, crisis);
        else await this.onCompanionText(user, identity, text, crisis);
      } catch (err) {
        // Never go silent: a failed model call used to leave the user with no reply at all.
        const why = describeError(err);
        console.error(`Couldn't reply to ${phone} as ${identity}: ${why}`);
        this.analytics.track("reply_failed", phone, { identity });
        const notice = this.config.showErrors ? `Reply failed: ${why}` : "Sorry, something went wrong on our end. Try again in a minute.";
        await this.send(user, identity, [appNotice(notice)], { record: false }).catch(() => {});
      }
      this.store.saveUser(user);
    });
  }

  private async onMatchmakerText(user: User, text: string, crisis: boolean) {
    const firstContact = user.matchmakerHistory.length === 0;
    user.matchmakerHistory.push({ from: "user", text, at: now() });

    if (user.stage === "age_gate") {
      if (firstContact) return this.send(user, MATCHMAKER, WELCOME_TEXTS);
      const answer = parseAgeAnswer(text);
      if (answer === "adult") {
        user.stage = "discovery";
        user.ageConfirmedAt = now();
        grant(user, this.config.startingCredits, "starting_grant", "starting_grant");
        this.analytics.track("age_confirmed", user.phone);
        return this.matchmakerSays(user, "They just confirmed they're 18+. Say thanks, then start getting to know them with your first question.");
      }
      if (answer === "minor") {
        // Permanent: START can't reopen it. An operator can review in the admin view.
        user.stage = "blocked";
        recordSafetyEvent(user, "underage", MATCHMAKER, text);
        this.analytics.track("age_rejected", user.phone);
        return this.send(user, MATCHMAKER, [UNDERAGE_TEXT]);
      }
      return this.send(user, MATCHMAKER, [AGE_RETRY_TEXT]);
    }

    if (user.stage === "discovery") {
      user.discoveryMessageCount++;
      if (user.discoveryMessageCount >= this.config.minDiscoveryMessages) {
        user.profile = await this.brain.extractProfile(user.matchmakerHistory);
        if (user.profile.readyToIntroduce) {
          user.stage = "matched";
          this.analytics.track("profile_ready", user.phone, { discoveryMessages: user.discoveryMessageCount });
          await this.matchmakerSays(user, READY_NUDGE, crisis);
          this.spawn(this.introduce(user.phone, this.config.introsPerRound));
          return;
        }
      }
      return this.matchmakerSays(user, undefined, crisis);
    }

    // Matched: keep chatting; learn more; introduce someone new when asked.
    if (WANTS_MORE.test(text) && this.remaining(user) > 0) {
      user.profile = await this.brain.extractProfile(user.matchmakerHistory);
      this.analytics.track("asked_for_intro", user.phone);
      await this.matchmakerSays(user, "They want to meet someone new. Tell them you've got someone in mind and you'll have her text. Don't describe her.", crisis);
      this.spawn(this.introduce(user.phone, 1));
      return;
    }
    return this.matchmakerSays(user, undefined, crisis);
  }

  private remaining(user: User) {
    return CHARACTERS.filter((c) => !user.relationships[c.id]).length;
  }

  private async onCompanionText(user: User, characterId: string, text: string, crisis: boolean) {
    const rel = user.relationships[characterId];
    if (!rel || !user.ageConfirmedAt) {
      // Someone texted a companion line without an introduction. Ignore for now.
      console.warn(`${user.phone} texted ${characterId} without an intro`);
      return;
    }
    rel.history.push({ from: "user", text, at: now() });
    rel.userMessageCount++;
    rel.lastUserMessageAt = now();
    const before = rel.stage;
    if (rel.stage === "introduced" || rel.stage === "cooling" || rel.stage === "dormant") rel.stage = "early";
    if (rel.stage === "early" && rel.userMessageCount >= 10) rel.stage = "active";
    if (rel.stage !== before) this.analytics.track("relationship_stage", user.phone, { characterId, from: before, to: rel.stage });

    const c = getCharacter(characterId);
    const handled = await this.maybeHandlePhoto(user, rel, text);
    if (!handled) {
      let texts = await this.companionReply(user, rel);
      if (crisis) texts = withCrisisResources(texts);
      await this.send(user, characterId, texts);
    }

    if (rel.history.length - (rel.summarizedThrough ?? 0) > this.config.summarizeAfter) {
      this.spawn(this.summarize(user.phone, c.id));
    }
  }

  private companionReply(user: User, rel: Relationship, nudge?: string) {
    const c = getCharacter(rel.characterId);
    return this.brain.reply(companionSystem(c, user, rel), rel.history.slice(rel.summarizedThrough ?? 0), nudge);
  }

  // Photo requests: free library photos first; generated photos cost credits
  // and the user confirms the cost before anything is spent. Returns true if
  // it sent the reply itself.
  private async maybeHandlePhoto(user: User, rel: Relationship, text: string): Promise<boolean> {
    const c = getCharacter(rel.characterId);

    if (rel.pendingPhoto) {
      const pending = rel.pendingPhoto;
      rel.pendingPhoto = undefined;
      if (CONFIRM.test(text)) {
        const item = await this.images.generate({ character: c, prompt: pending.prompt, tier: "personalized" });
        if (item && spend(user, pending.cost, "photo", item.id)) {
          this.analytics.track("credits_spent", user.phone, { amount: pending.cost, on: "photo" });
          await this.sendPhoto(user, rel, item.id, item.url, item.caption);
          return true;
        }
        await this.send(user, c.id, [appNotice("Sorry, that photo couldn't be made right now. No credits were used.")], { record: false });
        return true;
      }
      // Anything else declines; carry on with a normal reply.
    }

    if (!PHOTO_REQUEST.test(text)) return false;
    this.analytics.track("photo_requested", user.phone, { characterId: c.id });

    const check = checkImageRequest(text);
    if (!check.ok) {
      recordSafetyEvent(user, "image_prompt_blocked", c.id, text);
      await this.send(user, c.id, await this.companionReply(user, rel, BLOCKED_PHOTO_NUDGE));
      return true;
    }

    const lib = nextLibraryPhoto(c, rel);
    if (lib) {
      await this.sendPhoto(user, rel, lib.id, lib.url, lib.caption);
      return true;
    }

    if (this.images instanceof NoImageGenerator) {
      await this.send(user, c.id, await this.companionReply(user, rel, NO_PHOTO_NUDGE));
      return true;
    }

    const cost = COSTS.personalizedPhoto;
    const balance = account(user).credits;
    if (balance >= cost) {
      rel.pendingPhoto = { at: now(), cost, prompt: text };
      await this.send(user, c.id, [appNotice(`A new photo from ${c.name} uses ${cost} credits (you have ${balance}). Reply YES to send it.`)], { record: false });
    } else {
      await this.send(user, c.id, [appNotice(`A new photo from ${c.name} uses ${cost} credits and you have ${balance}. Text CREDITS to top up.`)], { record: false });
    }
    return true;
  }

  private async sendPhoto(user: User, rel: Relationship, mediaId: string, url: string, caption?: string) {
    const texts = await this.companionReply(user, rel, photoNudge(caption));
    rel.sentMediaIds = [...(rel.sentMediaIds ?? []), mediaId];
    await this.send(user, rel.characterId, texts.slice(0, 1), { mediaUrl: url });
    this.analytics.track("photo_sent", user.phone, { characterId: rel.characterId, mediaId });
  }

  private async creditsText(user: User) {
    const acct = account(user);
    const lines = [`You have ${acct.credits} credits. Texting is always free; credits are for extras like photos.`];
    if (this.payments) {
      for (const p of PRODUCTS) lines.push(`${p.label} ($${(p.priceCents / 100).toFixed(2)}): ${await this.payments.checkoutUrl(user.phone, p)}`);
    } else {
      lines.push("Buying more isn't open yet.");
    }
    return appNotice(lines.join("\n"));
  }

  // A completed payment from the provider's webhook. Idempotent on event.ref.
  applyPayment(event: PaymentEvent) {
    return this.withUser(event.phone, async () => {
      const user = this.store.getUser(event.phone);
      const product = getProduct(event.productId);
      if (!user || !product) throw new Error(`Unknown user or product in payment ${event.ref}`);
      if (!applyPurchase(user, product, event.ref)) return false;
      this.store.saveUser(user);
      this.analytics.track("purchase", user.phone, { productId: product.id, priceCents: product.priceCents });
      if (user.stage === "blocked" || user.stage === "opted_out") return true;
      await this.send(user, MATCHMAKER, [appNotice(`Payment received: ${product.label}. You now have ${account(user).credits} credits.`)], { record: false });
      this.store.saveUser(user);
      return true;
    });
  }

  // ---- Operator actions (admin view) ----

  adminGrant(phone: string, credits: number, note = "admin_grant") {
    return this.withUser(phone, async () => {
      const user = this.store.getUser(phone);
      if (!user) throw new Error("no such user");
      grant(user, credits, note);
      this.store.saveUser(user);
      return account(user).credits;
    });
  }

  // Lifts a block after review. The user stays quiet until they text START.
  adminUnblock(phone: string) {
    return this.withUser(phone, async () => {
      const user = this.store.getUser(phone);
      if (!user) throw new Error("no such user");
      if (user.stage === "blocked") user.stage = "opted_out";
      this.store.saveUser(user);
    });
  }

  private async summarize(phone: string, characterId: string) {
    await this.withUser(phone, async () => {
      const user = this.store.getUser(phone);
      const rel = user?.relationships[characterId];
      if (!user || !rel) return;
      const from = rel.summarizedThrough ?? 0;
      const cut = rel.history.length - this.config.keepRecent;
      if (cut - from <= 0) return;
      rel.memory = await this.brain.summarize({
        characterName: getCharacter(characterId).name,
        previous: rel.memory,
        messages: rel.history.slice(from, cut),
      });
      rel.summarizedThrough = cut;
      this.store.saveUser(user);
      this.analytics.track("memory_summarized", phone, { characterId, through: cut });
    });
  }

  private async matchmakerSays(user: User, nudge?: string, crisis = false) {
    let texts = await this.brain.reply(matchmakerSystem(user), user.matchmakerHistory, nudge);
    if (crisis) texts = withCrisisResources(texts);
    await this.send(user, MATCHMAKER, texts);
  }

  private async introduce(phone: string, count: number) {
    for (let i = 0; i < count; i++) {
      await sleep(this.config.introDelayMs);
      const done = await this.withUser(phone, async () => {
        const user = this.store.getUser(phone);
        if (!user?.profile || user.stage !== "matched") return true;
        const [pick] = rankCharacters(user, user.profile, CHARACTERS);
        if (!pick) return true;
        const rel: Relationship = {
          characterId: pick.id,
          stage: "introduced",
          introducedAt: now(),
          userMessageCount: 0,
          history: [],
        };
        user.relationships[pick.id] = rel;
        const texts = await this.brain.reply(companionSystem(pick, user, rel), [], introNudge(pick));
        await this.send(user, pick.id, texts, { mediaUrl: pick.photoUrl });
        this.store.saveUser(user);
        this.analytics.track("introduced", phone, { characterId: pick.id });
        return false;
      });
      if (done) return;
    }
  }

  // Periodic upkeep: relationships cool and go dormant; the matchmaker checks in.
  tick(at = Date.now()) {
    const work = this.store.allUsers().map((u) =>
      this.withUser(u.phone, async () => {
        const user = this.store.getUser(u.phone)!;
        if (user.stage !== "matched") return;
        let checkIn: Relationship | undefined;
        for (const rel of Object.values(user.relationships)) {
          const last = Date.parse(rel.lastUserMessageAt ?? rel.introducedAt);
          const quiet = at - last;
          const before = rel.stage;
          if (quiet >= this.config.dormantAfterMs) {
            rel.stage = "dormant";
            if (!rel.lastCheckInAt || Date.parse(rel.lastCheckInAt) < last) checkIn ??= rel;
          } else if (quiet >= this.config.coolingAfterMs && rel.stage !== "dormant") {
            rel.stage = "cooling";
          }
          if (rel.stage !== before) this.analytics.track("relationship_stage", user.phone, { characterId: rel.characterId, from: before, to: rel.stage });
        }
        if (checkIn) {
          checkIn.lastCheckInAt = new Date(at).toISOString();
          await this.matchmakerSays(user, checkInNudge(getCharacter(checkIn.characterId)));
          this.analytics.track("check_in", user.phone, { characterId: checkIn.characterId });
        }
        this.store.saveUser(user);
      }),
    );
    return Promise.all(work);
  }

  private async send(
    user: User,
    identity: IdentityId,
    texts: string[],
    opts: { record?: boolean; mediaUrl?: string } = {},
  ) {
    const history: ChatMessage[] | undefined =
      identity === MATCHMAKER ? user.matchmakerHistory : user.relationships[identity]?.history;
    for (const [i, text] of texts.entries()) {
      const chatId = user.chatIds[identity];
      if (chatId && this.transport.typing) await this.transport.typing(chatId);
      await sleep(Math.min(8000, text.length * this.config.typingMsPerChar));
      const id = await this.transport.send({
        from: identity,
        to: user.phone,
        text,
        chatId,
        mediaUrl: i === 0 ? opts.mediaUrl : undefined,
      });
      if (id) user.chatIds[identity] = id;
      if (opts.record !== false) history?.push({ from: "them", text, at: now() });
    }
  }
}
