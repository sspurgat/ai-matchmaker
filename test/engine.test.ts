import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, Engine } from "../src/engine.ts";
import type { Brain } from "../src/llm.ts";
import { MemoryStore } from "../src/store.ts";
import type { OutboundText, Transport } from "../src/transport.ts";
import type { ChatMessage, PreferenceProfile } from "../src/types.ts";

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
  calls: { system: string; nudge?: string }[] = [];
  ready = false;
  async reply(system: string, _h: ChatMessage[], nudge?: string) {
    this.calls.push({ system, nudge });
    return [`reply ${this.calls.length}`];
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

function setup() {
  const store = new MemoryStore();
  const brain = new FakeBrain();
  const transport = new FakeTransport();
  const engine = new Engine(store, brain, transport, {
    ...DEFAULT_CONFIG,
    introDelayMs: 0,
    typingMsPerChar: 0,
    minDiscoveryMessages: 2,
  });
  return { store, brain, transport, engine };
}

test("first text gets the AI disclosure and age gate", async () => {
  const { engine, transport, store } = setup();
  await engine.handleInbound("matchmaker", PHONE, "hi");
  assert.equal(transport.sent.length, 2);
  assert.match(transport.sent[0].text, /I'm an AI/);
  assert.match(transport.sent[1].text, /18 or older/);
  assert.equal(store.getUser(PHONE)!.stage, "age_gate");
});

test("under-18 users are turned away", async () => {
  const { engine, store, transport } = setup();
  await engine.handleInbound("matchmaker", PHONE, "hi");
  await engine.handleInbound("matchmaker", PHONE, "no");
  assert.equal(store.getUser(PHONE)!.stage, "opted_out");
  await engine.handleInbound("matchmaker", PHONE, "hello?");
  assert.equal(transport.sent.length, 3, "no replies after opting out");
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
