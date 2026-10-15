import { CHARACTERS } from "./characters.ts";
import { DEFAULT_CONFIG, Engine } from "./engine.ts";
import type { Brain } from "./llm.ts";
import { PlaceholderImageGenerator } from "./media.ts";
import { MATCHMAKER_NAME } from "./prompts.ts";
import { MemoryStore } from "./store.ts";
import type { OutboundText, Transport } from "./transport.ts";
import { MATCHMAKER, type User } from "./types.ts";

// Hosted simulator (Vercel). There's no server-side database: the browser
// keeps its own user state and sends it with every turn. Each turn runs a
// fresh engine, streams out whatever the matchmaker and companions send,
// waits for background work (intros, summaries), then returns the new state.
// Fine for a demo; anyone can edit their own state, so never use this for real users.

export type DemoAction =
  | { action: "send"; identity: string; text: string; channel?: "imessage" | "web" }
  | { action: "invite"; identity: string }
  | { action: "advance"; hours: number };

export interface DemoTurn {
  phone: string;
  user?: User | null;
}

export type DemoEvent = { type: "message"; message: OutboundText & { at: string } } | { type: "state"; user: User | null } | { type: "error"; error: string };

class StreamTransport implements Transport {
  constructor(private emit: (e: DemoEvent) => void) {}
  async send(msg: OutboundText) {
    this.emit({ type: "message", message: { ...msg, at: new Date().toISOString() } });
    return msg.chatId ?? `sim-${msg.from}-${msg.to}`;
  }
}

export function demoContacts() {
  return [{ id: MATCHMAKER, name: `${MATCHMAKER_NAME} (matchmaker)` }, ...CHARACTERS.map((c) => ({ id: c.id, name: c.name }))];
}

const PHONE = /^\+1555\d{7}$/;

export async function runDemoTurn(brain: Brain, turn: DemoTurn & DemoAction, emit: (e: DemoEvent) => void) {
  // Only fake 555 numbers, so the hosted demo can never touch a real phone.
  if (!PHONE.test(turn.phone)) throw new Error("bad phone");
  const store = new MemoryStore();
  if (turn.user && turn.user.phone === turn.phone) store.saveUser(turn.user);
  const config = { ...DEFAULT_CONFIG, introDelayMs: 0, typingMsPerChar: 0, showErrors: true };
  const engine = new Engine(store, brain, new StreamTransport(emit), config, { images: new PlaceholderImageGenerator() });

  if (turn.action === "send") {
    const text = String(turn.text ?? "").slice(0, 2000);
    await engine.handleInbound(turn.identity, turn.phone, text, undefined, turn.channel === "web" ? "web" : "imessage");
  } else if (turn.action === "invite") {
    await engine.unlockWeb(turn.phone, turn.identity);
  } else if (turn.action === "advance") {
    const hours = Math.min(Math.max(Number(turn.hours) || 0, 0), 24 * 30);
    await engine.tick(Date.now() + hours * 3600_000);
  }
  await engine.idle();
  emit({ type: "state", user: store.getUser(turn.phone) ?? null });
}
