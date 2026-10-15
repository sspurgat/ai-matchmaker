import assert from "node:assert/strict";
import { test } from "node:test";
import { runDemoTurn, type DemoEvent } from "../src/demo.ts";
import type { Brain } from "../src/llm.ts";
import type { User } from "../src/types.ts";

const brain: Brain = {
  async reply() { return ["hi there"]; },
  async summarize() { return { userFacts: [], sharedMemories: [], milestones: [], preferences: [], recentContext: "" }; },
  async extractProfile() { return { summary: "", personality: [], interests: [], vibe: [], dealbreakers: [], readyToIntroduce: true }; },
};

async function turn(user: User | null, action: object) {
  const events: DemoEvent[] = [];
  await runDemoTurn(brain, { phone: "+15550001111", user, ...action } as never, (e) => events.push(e));
  const state = events.find((e) => e.type === "state");
  return { events, user: state?.type === "state" ? state.user : null };
}

test("hosted demo carries state between turns through the browser", async () => {
  let r = await turn(null, { action: "send", identity: "matchmaker", text: "hi" });
  assert.ok(r.events.some((e) => e.type === "message"));
  assert.equal(r.user?.stage, "age_gate");
  for (const text of ["yes", "a", "b", "c", "d"]) r = await turn(r.user, { action: "send", identity: "matchmaker", text });
  // Intros run in the same turn, so companions have texted by the time it ends.
  assert.ok(Object.keys(r.user!.relationships).length > 0);
  const first = Object.keys(r.user!.relationships)[0];
  r = await turn(r.user, { action: "invite", identity: first });
  assert.ok(r.events.some((e) => e.type === "message" && e.message.link));
  assert.ok(r.user!.relationships[first].webUnlockedAt);
});

test("hosted demo refuses real-looking phone numbers", async () => {
  await assert.rejects(runDemoTurn(brain, { phone: "+14155550100", action: "send", identity: "matchmaker", text: "hi" }, () => {}));
});
