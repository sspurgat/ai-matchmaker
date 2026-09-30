import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { parseLinqWebhook, verifyLinqSignature } from "../src/transport.ts";

const secretBytes = crypto.randomBytes(24);
const secret = `whsec_${secretBytes.toString("base64")}`;

function sign(id: string, ts: string, body: string) {
  return `v1,${crypto.createHmac("sha256", secretBytes).update(`${id}.${ts}.${body}`).digest("base64")}`;
}

test("accepts a valid Standard Webhooks signature", () => {
  const body = '{"a":1}';
  const ts = "1700000000";
  const headers = { "webhook-id": "msg_1", "webhook-timestamp": ts, "webhook-signature": sign("msg_1", ts, body) };
  assert.ok(verifyLinqSignature(secret, body, headers, 1700000010));
});

test("rejects tampered bodies and stale timestamps", () => {
  const ts = "1700000000";
  const headers = { "webhook-id": "msg_1", "webhook-timestamp": ts, "webhook-signature": sign("msg_1", ts, '{"a":1}') };
  assert.equal(verifyLinqSignature(secret, '{"a":2}', headers, 1700000010), false);
  assert.equal(verifyLinqSignature(secret, '{"a":1}', headers, 1700000000 + 600), false);
});

test("parses message.received into routing fields", () => {
  const parsed = parseLinqWebhook({
    event_type: "message.received",
    data: {
      chat: { id: "chat-1", owner_handle: { handle: "+12025551234", is_me: true } },
      sender_handle: { handle: "+12025559876", is_me: false },
      parts: [{ type: "text", value: "Hello!" }],
    },
  });
  assert.deepEqual(parsed, { chatId: "chat-1", line: "+12025551234", from: "+12025559876", text: "Hello!" });
  assert.equal(parseLinqWebhook({ event_type: "message.delivered" }), undefined);
});
