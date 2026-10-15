import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import type { Channel, IdentityId } from "./types.ts";

export interface OutboundText {
  from: IdentityId;
  to: string; // user phone
  text: string;
  mediaUrl?: string;
  chatId?: string; // existing Linq chat, if we have one
  channel?: Channel; // default imessage
  link?: { url: string; title: string }; // shown as a link card
}

export interface Transport {
  // Returns the chat id to reuse for this identity/user pair.
  send(msg: OutboundText): Promise<string | undefined>;
  typing?(chatId: string): Promise<void>;
}

// Local stand-in for the phone: the web simulator subscribes to "message".
export class SimTransport extends EventEmitter implements Transport {
  async send(msg: OutboundText) {
    this.emit("message", { ...msg, at: new Date().toISOString() });
    return msg.chatId ?? `sim-${msg.from}-${msg.to}`;
  }
}

const LINQ_BASE = "https://api.linqapp.com/api/partner/v3";

// Linq routes iMessage -> RCS -> SMS automatically. Each identity sends from
// its own line so every character shows up as a separate contact.
export class LinqTransport implements Transport {
  constructor(
    private apiKey: string,
    private lines: Record<IdentityId, string>,
  ) {}

  lineFor(identity: IdentityId): string {
    const line = this.lines[identity];
    if (!line) throw new Error(`No Linq line configured for identity "${identity}"`);
    return line;
  }

  private async call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${LINQ_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Linq ${method} ${path} failed: ${res.status} ${await res.text()}`);
    return res.status === 204 ? undefined : res.json();
  }

  async send(msg: OutboundText) {
    // Web-chat messages belong to the web app, not the phone line. There's no
    // real web chat yet (simulator only), so they're dropped here.
    if (msg.channel === "web") return msg.chatId;
    const text = msg.link ? `${msg.text}\n${msg.link.url}` : msg.text;
    const parts: object[] = [{ type: "text", value: text }];
    if (msg.mediaUrl) parts.push({ type: "media", url: msg.mediaUrl });
    if (msg.chatId) {
      await this.call("POST", `/chats/${msg.chatId}/messages`, { message: { parts } });
      return msg.chatId;
    }
    const created = (await this.call("POST", "/chats", {
      from: this.lineFor(msg.from),
      to: [msg.to],
      message: { parts },
    })) as { id?: string; chat?: { id?: string } } | undefined;
    return created?.chat?.id ?? created?.id;
  }

  async typing(chatId: string) {
    await this.call("POST", `/chats/${chatId}/typing`).catch(() => {});
  }
}

export interface LinqInbound {
  chatId: string;
  line: string; // our number that received it
  from: string; // user's handle
  text: string;
}

// Parses a message.received webhook. Returns undefined for other events.
export function parseLinqWebhook(body: any): LinqInbound | undefined {
  if (body?.event_type !== "message.received") return undefined;
  const d = body.data;
  if (d?.sender_handle?.is_me) return undefined;
  const text = (d?.parts ?? [])
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.value)
    .join("\n");
  return {
    chatId: d.chat.id,
    line: d.chat.owner_handle.handle,
    from: d.sender_handle.handle,
    text,
  };
}

// Standard Webhooks signature: base64(HMAC-SHA256(secret, `${id}.${ts}.${body}`)).
export function verifyLinqSignature(
  secret: string,
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const id = headers["webhook-id"];
  const ts = headers["webhook-timestamp"];
  const sig = headers["webhook-signature"];
  if (typeof id !== "string" || typeof ts !== "string" || typeof sig !== "string") return false;
  if (Math.abs(nowSeconds - Number(ts)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = crypto.createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest();
  return sig.split(" ").some((s) => {
    if (!s.startsWith("v1,")) return false;
    const got = Buffer.from(s.slice(3), "base64");
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
}
