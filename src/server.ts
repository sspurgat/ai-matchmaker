import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JsonlAnalytics } from "./analytics.ts";
import { DevPaymentProvider, getProduct, type PaymentProvider } from "./billing.ts";
import { CHARACTERS } from "./characters.ts";
import { DEFAULT_CONFIG, Engine } from "./engine.ts";
import { ClaudeBrain } from "./llm.ts";
import { NoImageGenerator, PlaceholderImageGenerator } from "./media.ts";
import { MATCHMAKER_NAME } from "./prompts.ts";
import { JsonFileStore } from "./store.ts";
import { LinqTransport, SimTransport, parseLinqWebhook, verifyLinqSignature } from "./transport.ts";
import { MATCHMAKER } from "./types.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT ?? 3000);
const MODE = process.env.LINQ_API_KEY ? "linq" : "sim";

const store = new JsonFileStore(process.env.DATA_FILE ?? path.join(root, "data", `${MODE}-store.json`));
const brain = new ClaudeBrain();
const sim = new SimTransport();

// LINQ_LINES maps identity -> phone line, e.g. {"matchmaker":"+1...","maya":"+1..."}
const lines: Record<string, string> = JSON.parse(process.env.LINQ_LINES ?? "{}");
const identityByLine = Object.fromEntries(Object.entries(lines).map(([id, line]) => [line, id]));
const transport = MODE === "linq" ? new LinqTransport(process.env.LINQ_API_KEY!, lines) : sim;

const config =
  MODE === "sim"
    ? { ...DEFAULT_CONFIG, introDelayMs: 4000, typingMsPerChar: 15, showErrors: true }
    : DEFAULT_CONFIG;

const analytics = new JsonlAnalytics(process.env.ANALYTICS_FILE ?? path.join(root, "data", `${MODE}-events.jsonl`));

// Payments: the dev provider only runs in the simulator. A real processor
// plugs in here once one is chosen (see billing.ts).
const devPayments = MODE === "sim" ? new DevPaymentProvider(`http://localhost:${PORT}`, crypto.randomBytes(16).toString("hex")) : undefined;
const payments: PaymentProvider | undefined = devPayments;

// Images: placeholder cards in the simulator; none over Linq until a generator is chosen.
const images = MODE === "sim" ? new PlaceholderImageGenerator() : new NoImageGenerator();

const engine = new Engine(store, brain, transport, config, { analytics, payments, images });

// Admin view. Over Linq it needs ADMIN_TOKEN; in the simulator it's open
// unless ADMIN_TOKEN is set.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
function adminAllowed(req: http.IncomingMessage): boolean {
  if (!ADMIN_TOKEN) return MODE === "sim";
  const got = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(ADMIN_TOKEN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function userSummary(u: ReturnType<typeof store.allUsers>[number]) {
  const rels = Object.values(u.relationships);
  const last = [u.matchmakerHistory.at(-1)?.at, ...rels.map((r) => r.history.at(-1)?.at)].filter(Boolean).sort().at(-1);
  return {
    phone: u.phone,
    stage: u.stage,
    createdAt: u.createdAt,
    lastActivityAt: last,
    credits: u.account?.credits ?? 0,
    plan: u.account?.plan ?? "free",
    relationships: rels.map((r) => ({ characterId: r.characterId, stage: r.stage, userMessages: r.userMessageCount })),
    safetyEvents: u.safety?.events.length ?? 0,
  };
}

// Relationship upkeep (cooling, dormancy, matchmaker check-ins).
setInterval(() => engine.tick().catch(console.error), 15 * 60_000).unref();

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  try {
    // Linq inbound webhook. Answer fast; do the work after.
    if (req.method === "POST" && url.pathname === "/webhooks/linq") {
      const raw = await readBody(req);
      const secret = process.env.LINQ_WEBHOOK_SECRET;
      if (secret && !verifyLinqSignature(secret, raw, req.headers)) return json(res, 401, { error: "bad signature" });
      const inbound = parseLinqWebhook(JSON.parse(raw));
      json(res, 200, { ok: true });
      if (!inbound || !inbound.text) return;
      const identity = identityByLine[inbound.line];
      if (!identity) return console.warn(`Inbound on unknown line ${inbound.line}`);
      engine.handleInbound(identity, inbound.from, inbound.text, inbound.chatId).catch(console.error);
      return;
    }

    if (url.pathname === "/health") return json(res, 200, { ok: true, mode: MODE });

    // Payment processor webhook. Idempotent on the processor's payment id.
    if (req.method === "POST" && url.pathname === "/webhooks/payments") {
      if (!payments) return json(res, 404, { error: "payments not configured" });
      const raw = await readBody(req);
      let event;
      try {
        event = payments.parseWebhook(raw, req.headers);
      } catch {
        return json(res, 401, { error: "bad signature" });
      }
      if (event) await engine.applyPayment(event);
      return json(res, 200, { ok: true });
    }

    // ---- Admin ("all chats" view from the spec) ----
    if (url.pathname === "/admin" && req.method === "GET") {
      if (!ADMIN_TOKEN && MODE !== "sim") return json(res, 404, { error: "not found" });
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(fs.readFileSync(path.join(root, "public", "admin.html")));
    }
    if (url.pathname.startsWith("/api/admin/")) {
      if (!adminAllowed(req)) return json(res, 401, { error: "unauthorized" });
      const route = url.pathname.slice("/api/admin/".length);
      // Audit trail: every operator read or action is logged.
      console.log(`[admin] ${req.method} ${route} ${url.searchParams.get("phone") ?? ""}`);
      if (req.method === "GET" && route === "users") {
        const users = store.allUsers().map(userSummary).sort((a, b) => (b.lastActivityAt ?? b.createdAt).localeCompare(a.lastActivityAt ?? a.createdAt));
        return json(res, 200, { users, events: analytics.counts() });
      }
      if (req.method === "GET" && route === "user") {
        const user = store.getUser(url.searchParams.get("phone") ?? "");
        return user ? json(res, 200, user) : json(res, 404, { error: "no such user" });
      }
      if (req.method === "POST" && route === "grant") {
        const { phone, credits } = JSON.parse(await readBody(req));
        if (!Number.isInteger(credits)) return json(res, 400, { error: "credits must be an integer" });
        return json(res, 200, { credits: await engine.adminGrant(phone, credits) });
      }
      if (req.method === "POST" && route === "unblock") {
        const { phone } = JSON.parse(await readBody(req));
        await engine.adminUnblock(phone);
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: "not found" });
    }

    if (MODE !== "sim") return json(res, 404, { error: "not found" });

    // ---- Simulator (local testing without phones) ----
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(fs.readFileSync(path.join(root, "public", "simulator.html")));
    }
    // Dev checkout: "pays" instantly by posting a signed webhook to ourselves.
    if (req.method === "GET" && url.pathname === "/dev/checkout" && devPayments) {
      const product = getProduct(url.searchParams.get("product") ?? "");
      const phone = url.searchParams.get("phone") ?? "";
      if (!product) return json(res, 400, { error: "unknown product" });
      const body = JSON.stringify({ type: "payment.succeeded", id: `dev_${crypto.randomUUID()}`, phone, product: product.id });
      const r = await fetch(`http://localhost:${PORT}/webhooks/payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-dev-signature": devPayments.sign(body) },
        body,
      });
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(`<!doctype html><meta name="viewport" content="width=device-width"><body style="font:16px system-ui;padding:24px">${r.ok ? `Test purchase complete: ${product.label}. No money moved. You can close this tab.` : "Test purchase failed."}</body>`);
    }

    if (req.method === "GET" && url.pathname === "/api/sim/contacts") {
      return json(res, 200, [
        { id: MATCHMAKER, name: `${MATCHMAKER_NAME} (matchmaker)` },
        ...CHARACTERS.map((c) => ({ id: c.id, name: c.name })),
      ]);
    }
    if (req.method === "GET" && url.pathname === "/api/sim/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const onMsg = (m: unknown) => res.write(`data: ${JSON.stringify(m)}\n\n`);
      sim.on("message", onMsg);
      req.on("close", () => sim.off("message", onMsg));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/sim/send") {
      const { identity, phone, text, channel } = JSON.parse(await readBody(req));
      json(res, 202, { ok: true });
      engine.handleInbound(identity, phone, text, undefined, channel === "web" ? "web" : "imessage").catch(console.error);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/sim/invite") {
      // "Move to web" button: have a companion send the private-chat link now.
      const { phone, identity } = JSON.parse(await readBody(req));
      json(res, 202, { ok: true });
      engine.unlockWeb(phone, identity).catch(console.error);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/sim/state") {
      return json(res, 200, store.getUser(url.searchParams.get("phone") ?? "") ?? null);
    }
    if (req.method === "POST" && url.pathname === "/api/sim/reset") {
      const { phone } = JSON.parse(await readBody(req));
      store.deleteUser(phone);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/sim/advance") {
      // Pretend time passed so you can see cooling and check-ins.
      const { hours } = JSON.parse(await readBody(req));
      json(res, 202, { ok: true });
      engine.tick(Date.now() + Number(hours) * 3600_000).catch(console.error);
      return;
    }
    json(res, 404, { error: "not found" });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: String(err) });
  }
});

server.listen(PORT, async () => {
  console.log(`AI Matchmaker (${MODE} mode) on http://localhost:${PORT}`);
  const problem = await brain.check();
  console.log(problem ? `\n⚠️  Claude API problem: ${problem}\n` : "Claude API key works.");
});
