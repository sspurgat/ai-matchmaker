import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import { demoContacts, runDemoTurn, type DemoEvent } from "./demo.ts";
import { ClaudeBrain } from "./llm.ts";

// Vercel entry for the hosted simulator. scripts/build-vercel.mjs bundles
// this into one function and routes every path here.
// Needs ANTHROPIC_API_KEY and DEMO_PASSWORD. The password keeps strangers
// from spending the Claude key; the page asks for it with a browser login box.

const brain = new ClaudeBrain();
const page = (name: string) => fs.readFileSync(new URL(`./${name}`, import.meta.url));

// Forgiving on purpose: values pasted into Vercel or typed on a phone often
// pick up stray spaces, quotes or a capital first letter.
export function normalize(pw: string): string {
  return pw.trim().replace(/^(["'])(.*)\1$/, "$2").trim().toLowerCase();
}

export function authorized(req: http.IncomingMessage, password: string): boolean {
  const header = String(req.headers.authorization ?? "");
  const decoded = header.startsWith("Basic ") ? Buffer.from(header.slice(6), "base64").toString() : "";
  const got = crypto.createHash("sha256").update(normalize(decoded.slice(decoded.indexOf(":") + 1))).digest();
  const want = crypto.createHash("sha256").update(normalize(password)).digest();
  return crypto.timingSafeEqual(got, want);
}

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

export default async function handler(req: http.IncomingMessage, res: http.ServerResponse) {
  const password = process.env.DEMO_PASSWORD;
  if (!password) return json(res, 503, { error: "Set DEMO_PASSWORD in the Vercel project to turn the demo on." });
  if (!authorized(req, password)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="AI Matchmaker demo"', "Content-Type": "text/plain" });
    return res.end("Password required. Any username works.");
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(page("simulator.html"));
    }
    if (req.method === "GET" && url.pathname === "/api/sim/config") return json(res, 200, { hosted: true });
    if (req.method === "GET" && url.pathname === "/api/sim/contacts") return json(res, 200, demoContacts());
    if (req.method === "POST" && url.pathname === "/api/demo/turn") {
      const turn = JSON.parse(await readBody(req));
      // One JSON object per line, sent as each text goes out.
      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
      const emit = (e: DemoEvent) => res.write(JSON.stringify(e) + "\n");
      try {
        await runDemoTurn(brain, turn, emit);
      } catch (err) {
        emit({ type: "error", error: err instanceof Error ? err.message : String(err) });
      }
      return res.end();
    }
    json(res, 404, { error: "not found" });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: String(err) });
  }
}
