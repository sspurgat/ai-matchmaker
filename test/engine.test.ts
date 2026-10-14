import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryAnalytics } from "../src/analytics.ts";
import { DevPaymentProvider } from "../src/billing.ts";
import { DEFAULT_CONFIG, Engine, type EngineConfig, type EngineDeps } from "../src/engine.ts";
import type { Brain, SummarizeInput } from "../src/llm.ts";
import { PlaceholderImageGenerator } from "../src/media.ts";
import { MemoryStore } from "../src/store.ts";
import type { OutboundText, Transport } from "../src/transport.ts";
import type { ChatMessage, PreferenceProfile, RelationshipMemory } from "../src/types.ts";

const PHONE = "+15555550100";

class FakeTransport implements Transport {
  sent: OutboundText[] = [];
  async send(msg: OutboundText) {
    this.sent.push(msg);
    return `chat-${msg.from}`;
  }
  from(id: string) {
    return this.sent.filter((m) => m.from === id);
  }
}

class FakeBrain implements Brain {
  calls: { system: string; nudge?: string; history: ChatMessage[] }[] = [];
  summaries: SummarizeInput[] = [];
  ready = false;
  replyWith?: string[];
  async reply(system: string, history: ChatMessage[], nudge?: string) {
    this.calls.push({ system, nudge, history: [...history] });
    return this.replyWith ?? [`reply ${this.calls.length}`];
  }
  async summarize(input: SummarizeInput): Promise<RelationshipMemory> {
    this.summaries.push(input);
    return {
      userFacts: ["has a dog named Pixel"],
      sharedMemories: [`talked through ${input.messages.length} messages`],
      milestones: [],
      preferences: [],
      recentContext: "talking about weekend plans",
    };
  }
  async extractProfile(): Promise<PreferenceProfile> {
    return {
      summary: "Likes nerdy, witty people.",
      personality: ["witty"],
      interests: ["space", "board games"],
      vibe: ["nerdy"],
      dealbreakers: [],
      readyToIntroduce: this.ready,
    };
  }
}

function setup(config: Partial<EngineConfig> = {}, deps: EngineDeps = {}) {
  const store = new MemoryStore();
  const brain = new FakeBrain();
  const transport = new FakeTransport();
  const analytics = new MemoryAnalytics();
  const engine = new Engine(
    store,
    brain,
    transport,
    { ...DEFAULT_CONFIG, introDelayMs: 0, typingMsPerChar: 0, minDiscoveryMessages: 2, ...config },
    { analytics, ...deps },
  );
  return { store, brain, transport, engine, analytics };
}

// Age-confirmed, profiled, and introduced to two companions (priya first).
async function matched(s: ReturnType<typeof setup>) {
  s.brain.ready = true;
  for (const t of ["hi", "yes", "a", "b"]) await s.engine.handleInbound("matchmaker", PHONE, t);
  await s.engine.idle();
}

test("first text gets the AI disclosure and age gate", async () => {
  const { engine, transport, store } = setup();
  await engine.handleInbound("matchmaker", PHONE, "hi");
  assert.equal(transport.sent.length, 2);
  assert.match(transport.sent[0].text, /I'm an AI/);
  assert.match(transport.sent[1].text, /18 or older/);
  assert.equal(store.getUser(PHONE)!.stage, "age_gate");
});

test("under-18 users are turned away for good", async () => {
  const { engine, store, transport } = setup();
  await engine.handleInbound("matchmaker", PHONE, "hi");
  await engine.handleInbound("matchmaker", PHONE, "no");
  assert.equal(store.getUser(PHONE)!.stage, "blocked");
  await engine.handleInbound("matchmaker", PHONE, "hello?");
  await engine.handleInbound("matchmaker", PHONE, "START");
  assert.equal(store.getUser(PHONE)!.stage, "blocked", "START can't reopen an underage block");
  assert.equal(transport.sent.length, 3, "no replies after being blocked");
});

test("'yes, I'm 16' at the age gate is a minor, not a yes", async () => {
  const { engine, store } = setup();
  await engine.handleInbound("matchmaker", PHONE, "hi");
  await engine.handleInbound("matchmaker", PHONE, "yes i'm 16");
  assert.equal(store.getUser(PHONE)!.stage, "blocked");
  assert.equal(store.getUser(PHONE)!.account?.credits ?? 0, 0, "no starting credits for minors");
});

test("saying you're a minor mid-conversation pauses the account for review", async () => {
  const s = setup();
  await matched(s);
  await s.engine.handleInbound("priya", PHONE, "lol im 15 btw");
  const user = s.store.getUser(PHONE)!;
  assert.equal(user.stage, "blocked");
  assert.equal(user.safety!.events.at(-1)!.kind, "underage");
  const sent = s.transport.sent.length;
  await s.engine.handleInbound("priya", PHONE, "hello??");
  assert.equal(s.transport.sent.length, sent, "silent while blocked");

  await s.engine.adminUnblock(PHONE);
  await s.engine.handleInbound("matchmaker", PHONE, "START");
  assert.equal(s.store.getUser(PHONE)!.stage, "matched");
});

test("self-harm mentions always get crisis resources", async () => {
  const s = setup();
  await matched(s);
  s.brain.replyWith = ["oh no, I'm here"];
  await s.engine.handleInbound("priya", PHONE, "honestly i want to die");
  const last = s.transport.from("priya").at(-1)!;
  assert.match(last.text, /988/);
  assert.equal(s.store.getUser(PHONE)!.safety!.events.at(-1)!.kind, "self_harm");
});

test("HELP answers on any line without touching the conversation", async () => {
  const s = setup();
  await s.engine.handleInbound("matchmaker", PHONE, "hi");
  await s.engine.handleInbound("matchmaker", PHONE, "HELP");
  assert.match(s.transport.sent.at(-1)!.text, /STOP/);
  assert.equal(s.store.getUser(PHONE)!.matchmakerHistory.length, 3, "HELP isn't part of the chat");
});

test("floods are rate limited", async () => {
  const s = setup({ maxInboundPerMinute: 3 });
  await matched(s); // uses 4 texts, so already over
  const before = s.transport.sent.length;
  await s.engine.handleInbound("priya", PHONE, "hey");
  assert.equal(s.transport.sent.length, before);
  assert.equal(s.store.getUser(PHONE)!.safety!.events.at(-1)!.kind, "rate_limited");
});

test("long companion chats fold old messages into memory", async () => {
  const s = setup({ summarizeAfter: 10, keepRecent: 4 });
  await matched(s);
  for (let i = 0; i < 6; i++) await s.engine.handleInbound("priya", PHONE, `message ${i}`);
  await s.engine.idle();
  const rel = s.store.getUser(PHONE)!.relationships.priya;
  assert.equal(s.brain.summaries.length, 1);
  assert.equal(rel.summarizedThrough, 7, "summarized up to the last 4 messages at the time it ran");
  assert.deepEqual(rel.memory!.userFacts, ["has a dog named Pixel"]);

  await s.engine.handleInbound("priya", PHONE, "what's up");
  const call = s.brain.calls.at(-1)!;
  assert.match(call.system, /has a dog named Pixel/);
  assert.ok(call.history.length < rel.history.length, "only recent messages go to the model");
  assert.equal(rel.history.length, 15, "full transcript is kept for the admin view");
});

test("photo with no library and no generator: companion deflects, no credits used", async () => {
  const s = setup();
  await matched(s);
  await s.engine.handleInbound("priya", PHONE, "can you send a pic?");
  assert.match(s.brain.calls.at(-1)!.nudge!, /can't send one/);
  assert.equal(s.store.getUser(PHONE)!.account!.credits, DEFAULT_CONFIG.startingCredits);
});

test("generated photos tell you the cost first and spend credits only on yes", async () => {
  const s = setup({}, { images: new PlaceholderImageGenerator() });
  await matched(s);
  const start = s.store.getUser(PHONE)!.account!.credits;
  await s.engine.handleInbound("priya", PHONE, "send me a selfie");
  assert.match(s.transport.from("priya").at(-1)!.text, /uses 5 credits.*Reply YES/);
  assert.equal(s.store.getUser(PHONE)!.account!.credits, start);

  await s.engine.handleInbound("priya", PHONE, "yes");
  const sent = s.transport.from("priya").at(-1)!;
  assert.ok(sent.mediaUrl?.startsWith("data:image/svg+xml"));
  const user = s.store.getUser(PHONE)!;
  assert.equal(user.account!.credits, start - 5);
  assert.equal(user.relationships.priya.sentMediaIds!.length, 1);
});

test("photo requests that read as a minor are refused", async () => {
  const s = setup({}, { images: new PlaceholderImageGenerator() });
  await matched(s);
  await s.engine.handleInbound("priya", PHONE, "send a pic dressed like a schoolgirl");
  assert.match(s.brain.calls.at(-1)!.nudge!, /won't send/);
  assert.equal(s.store.getUser(PHONE)!.safety!.events.at(-1)!.kind, "image_prompt_blocked");
});

test("payments add credits once per payment id", async () => {
  const payments = new DevPaymentProvider("http://localhost:3000", "secret");
  const s = setup({}, { payments });
  await matched(s);
  await s.engine.handleInbound("matchmaker", PHONE, "CREDITS");
  assert.match(s.transport.sent.at(-1)!.text, /dev\/checkout\?phone=/);

  const body = JSON.stringify({ type: "payment.succeeded", id: "pay_1", phone: PHONE, product: "credits_50" });
  const event = payments.parseWebhook(body, { "x-dev-signature": payments.sign(body) })!;
  assert.equal(await s.engine.applyPayment(event), true);
  assert.equal(await s.engine.applyPayment(event), false, "duplicate delivery is ignored");
  assert.equal(s.store.getUser(PHONE)!.account!.credits, DEFAULT_CONFIG.startingCredits + 50);
  assert.throws(() => payments.parseWebhook(body, { "x-dev-signature": "nope" }));
});

test("analytics never store the phone number", async () => {
  const s = setup();
  await matched(s);
  assert.ok(s.analytics.named("introduced").length === 2);
  assert.ok(!JSON.stringify(s.analytics.events).includes(PHONE));
});

test("discovery leads to introductions from separate identities", async () => {
  const { engine, brain, transport, store } = setup();
  await engine.handleInbound("matchmaker", PHONE, "hi");
  await engine.handleInbound("matchmaker", PHONE, "yes");
  assert.equal(store.getUser(PHONE)!.stage, "discovery");

  await engine.handleInbound("matchmaker", PHONE, "I like smart funny people");
  brain.ready = true;
  await engine.handleInbound("matchmaker", PHONE, "space, board games");
  await engine.idle();

  const user = store.getUser(PHONE)!;
  assert.equal(user.stage, "matched");
  const introduced = Object.keys(user.relationships);
  assert.equal(introduced.length, 2);
  assert.ok(introduced.includes("priya"), "the nerdy character should rank first");
  for (const id of introduced) assert.equal(transport.from(id).length, 1);
  // Companions get the matchmaker's summary, not the raw transcript.
  const intro = brain.calls.find((c) => c.system.includes("You are Priya"))!;
  assert.match(intro.system, /Likes nerdy, witty people/);
});

test("companion replies track relationship state", async () => {
  const { engine, brain, store } = setup();
  brain.ready = true;
  for (const t of ["hi", "yes", "a", "b"]) await engine.handleInbound("matchmaker", PHONE, t);
  await engine.idle();
  await engine.handleInbound("priya", PHONE, "hey Priya!", "chat-priya");
  const rel = store.getUser(PHONE)!.relationships.priya;
  assert.equal(rel.stage, "early");
  assert.equal(rel.userMessageCount, 1);
  assert.deepEqual(rel.history.map((m) => m.from), ["them", "user", "them"]);
});

test("quiet relationships go dormant and the matchmaker checks in once", async () => {
  const { engine, brain, store, transport } = setup();
  brain.ready = true;
  for (const t of ["hi", "yes", "a", "b"]) await engine.handleInbound("matchmaker", PHONE, t);
  await engine.idle();
  const before = transport.from("matchmaker").length;

  const later = Date.now() + 4 * 24 * 3600_000;
  await engine.tick(later);
  const rels = Object.values(store.getUser(PHONE)!.relationships);
  assert.ok(rels.every((r) => r.stage === "dormant"));
  assert.equal(transport.from("matchmaker").length, before + 1);
  assert.match(brain.calls.at(-1)!.nudge!, /How|how things are going/);

  await engine.tick(later + 3600_000);
  await engine.tick(later + 7200_000);
  assert.equal(transport.from("matchmaker").length, before + 2, "one check-in per dormant relationship");
});

test("STOP opts the user out from any line", async () => {
  const { engine, store } = setup();
  await engine.handleInbound("matchmaker", PHONE, "hi");
  await engine.handleInbound("matchmaker", PHONE, "STOP");
  assert.equal(store.getUser(PHONE)!.stage, "opted_out");
});

test("a failed model call still gets a reply instead of silence", async () => {
  const s = setup({ showErrors: true });
  s.brain.reply = async () => {
    throw new Error("boom");
  };
  await s.engine.handleInbound("matchmaker", PHONE, "hi");
  await s.engine.handleInbound("matchmaker", PHONE, "I am");
  const last = s.transport.sent.at(-1)!;
  assert.match(last.text, /Reply failed: boom/);
  assert.equal(s.store.getUser(PHONE)!.stage, "discovery", "the age confirmation still sticks");
});
