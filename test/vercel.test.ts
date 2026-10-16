import assert from "node:assert/strict";
import type http from "node:http";
import { test } from "node:test";
import { authorized } from "../src/vercel.ts";

const req = (user: string, pw: string) => ({ headers: { authorization: "Basic " + Buffer.from(`${user}:${pw}`).toString("base64") } }) as http.IncomingMessage;

test("demo password tolerates stray spaces, quotes and capitals", () => {
  assert.ok(authorized(req("steve", "harbor-cobalt-83"), "harbor-cobalt-83"));
  assert.ok(authorized(req("", " Harbor-cobalt-83 "), '"harbor-cobalt-83"\n'));
  assert.ok(!authorized(req("steve", "wrong"), "harbor-cobalt-83"));
  assert.ok(!authorized({ headers: {} } as http.IncomingMessage, "harbor-cobalt-83"));
});
