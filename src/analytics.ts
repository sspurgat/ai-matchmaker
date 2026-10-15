import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Product events for the spec's metrics (retention, intros, relationship
// survival, credit use). Users are keyed by a hash, never the phone number.

export interface Analytics {
  track(event: string, phone: string, props?: Record<string, unknown>): void;
  counts(): Record<string, number>;
}

export function userKey(phone: string): string {
  return crypto.createHash("sha256").update(phone).digest("hex").slice(0, 16);
}

export class MemoryAnalytics implements Analytics {
  events: { at: string; event: string; user: string; props?: Record<string, unknown> }[] = [];
  track(event: string, phone: string, props?: Record<string, unknown>) {
    this.events.push({ at: new Date().toISOString(), event, user: userKey(phone), props });
  }
  counts() {
    const out: Record<string, number> = {};
    for (const e of this.events) out[e.event] = (out[e.event] ?? 0) + 1;
    return out;
  }
  named(event: string) {
    return this.events.filter((e) => e.event === event);
  }
}

// Appends JSON lines to a file; easy to load into a warehouse later.
export class JsonlAnalytics implements Analytics {
  private tally: Record<string, number> = {};
  constructor(private file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const { event } = JSON.parse(line);
          this.tally[event] = (this.tally[event] ?? 0) + 1;
        } catch {}
      }
    }
  }
  track(event: string, phone: string, props?: Record<string, unknown>) {
    this.tally[event] = (this.tally[event] ?? 0) + 1;
    const line = JSON.stringify({ at: new Date().toISOString(), event, user: userKey(phone), ...(props && { props }) });
    fs.appendFile(this.file, line + "\n", (err) => err && console.error("analytics write failed", err));
  }
  counts() {
    return { ...this.tally };
  }
}
