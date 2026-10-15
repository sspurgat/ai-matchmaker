import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHARACTERS } from "./characters.ts";
import { DEFAULT_CONFIG, Engine } from "./engine.ts";
import { ClaudeBrain } from "./llm.ts";
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
    ? { ...DEFAULT_CONFIG, introDelayMs: 4000, typingMsPerChar: 15 }
    : DEFAULT_CONFIG;
const engine = new Engine(store, brain, transport, config);

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

    if (MODE !== "sim") return json(res, 404, { error: "not found" });

    // ---- Simulator (local testing without phones) ----
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(fs.readFileSync(path.join(root, "public", "simulator.html")));
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
      const { identity, phone, text } = JSON.parse(await readBody(req));
      json(res, 202, { ok: true });
      engine.handleInbound(identity, phone, text).catch(console.error);
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

server.listen(PORT, () => {
  console.log(`AI Matchmaker (${MODE} mode) on http://localhost:${PORT}`);
});
