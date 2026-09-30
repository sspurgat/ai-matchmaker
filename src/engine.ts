import { CHARACTERS, getCharacter } from "./characters.ts";
import type { Brain } from "./llm.ts";
import {
  AGE_RETRY_TEXT,
  READY_NUDGE,
  STOPPED_TEXT,
  UNDERAGE_TEXT,
  WELCOME_TEXTS,
  checkInNudge,
  companionSystem,
  introNudge,
  matchmakerSystem,
} from "./prompts.ts";
import { rankCharacters } from "./ranking.ts";
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
}

export const DEFAULT_CONFIG: EngineConfig = {
  introsPerRound: 2,
  minDiscoveryMessages: 4,
  introDelayMs: 20_000,
  typingMsPerChar: 25,
  coolingAfterMs: 24 * 3600_000,
  dormantAfterMs: 3 * 24 * 3600_000,
};

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const now = () => new Date().toISOString();

const YES = /^\s*(y|ya|yes|yeah|yep|yup|sure|ok|okay|i am|i'm|im|correct|of course|definitely|absolutely|\d{2,3})\b/i;
const NO = /^\s*(n|no|nope|nah|not yet|i'm not|im not)\b/i;
const STOP = /^\s*(stop|unsubscribe|cancel|end|quit)\s*$/i;
const START = /^\s*(start|unstop)\s*$/i;
const WANTS_MORE = /\b(someone (else|new)|another (person|match|one)|more people|new match|introduce me)\b/i;

export class Engine {
  private locks = new Map<string, Promise<unknown>>();
  private background = new Set<Promise<unknown>>();

  constructor(
    private store: Store,
    private brain: Brain,
    private transport: Transport,
    private config: EngineConfig = DEFAULT_CONFIG,
  ) {}

  // Resolves once scheduled work (intros) has finished. Used by tests.
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
      const user = this.store.getUser(phone) ?? newUser(phone);
      if (chatId) user.chatIds[identity] = chatId;

      if (STOP.test(text)) {
        user.stage = "opted_out";
        this.store.saveUser(user);
        await this.send(user, identity, [STOPPED_TEXT], { record: false });
        return;
      }
      if (user.stage === "opted_out") {
        if (!START.test(text)) return;
        user.stage = user.profile ? "matched" : "discovery";
      }

      if (identity === MATCHMAKER) await this.onMatchmakerText(user, text);
      else await this.onCompanionText(user, identity, text);
      this.store.saveUser(user);
    });
  }

  private async onMatchmakerText(user: User, text: string) {
    const firstContact = user.matchmakerHistory.length === 0;
    user.matchmakerHistory.push({ from: "user", text, at: now() });

    if (user.stage === "age_gate") {
      if (firstContact) return this.send(user, MATCHMAKER, WELCOME_TEXTS);
      if (YES.test(text)) {
        user.stage = "discovery";
        return this.matchmakerSays(user, "They just confirmed they're 18+. Say thanks, then start getting to know them with your first question.");
      }
      if (NO.test(text)) {
        user.stage = "opted_out";
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
          await this.matchmakerSays(user, READY_NUDGE);
          this.spawn(this.introduce(user.phone, this.config.introsPerRound));
          return;
        }
      }
      return this.matchmakerSays(user);
    }

    // Matched: keep chatting; learn more; introduce someone new when asked.
    if (WANTS_MORE.test(text) && this.remaining(user) > 0) {
      user.profile = await this.brain.extractProfile(user.matchmakerHistory);
      await this.matchmakerSays(user, "They want to meet someone new. Tell them you've got someone in mind and you'll have her text. Don't describe her.");
      this.spawn(this.introduce(user.phone, 1));
      return;
    }
    return this.matchmakerSays(user);
  }

  private remaining(user: User) {
    return CHARACTERS.filter((c) => !user.relationships[c.id]).length;
  }

  private async onCompanionText(user: User, characterId: string, text: string) {
    const rel = user.relationships[characterId];
    if (!rel) {
      // Someone texted a companion line without an introduction. Ignore for now.
      console.warn(`${user.phone} texted ${characterId} without an intro`);
      return;
    }
    rel.history.push({ from: "user", text, at: now() });
    rel.userMessageCount++;
    rel.lastUserMessageAt = now();
    if (rel.stage === "introduced" || rel.stage === "cooling" || rel.stage === "dormant") rel.stage = "early";
    if (rel.stage === "early" && rel.userMessageCount >= 10) rel.stage = "active";

    const c = getCharacter(characterId);
    const texts = await this.brain.reply(companionSystem(c, user, rel), rel.history);
    await this.send(user, characterId, texts);
  }

  private async matchmakerSays(user: User, nudge?: string) {
    const texts = await this.brain.reply(matchmakerSystem(user), user.matchmakerHistory, nudge);
    await this.send(user, MATCHMAKER, texts);
  }

  private async introduce(phone: string, count: number) {
    for (let i = 0; i < count; i++) {
      await sleep(this.config.introDelayMs);
      const done = await this.withUser(phone, async () => {
        const user = this.store.getUser(phone);
        if (!user?.profile || user.stage === "opted_out") return true;
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
          if (quiet >= this.config.dormantAfterMs) {
            rel.stage = "dormant";
            if (!rel.lastCheckInAt || Date.parse(rel.lastCheckInAt) < last) checkIn ??= rel;
          } else if (quiet >= this.config.coolingAfterMs && rel.stage !== "dormant") {
            rel.stage = "cooling";
          }
        }
        if (checkIn) {
          checkIn.lastCheckInAt = new Date(at).toISOString();
          await this.matchmakerSays(user, checkInNudge(getCharacter(checkIn.characterId)));
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
