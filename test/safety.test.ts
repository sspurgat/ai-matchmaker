import assert from "node:assert/strict";
import { test } from "node:test";
import { checkImageRequest, PHOTO_REQUEST } from "../src/media.ts";
import { mentionsBeingMinor, mentionsSelfHarm, parseAgeAnswer } from "../src/safety.ts";

test("age answers", () => {
  for (const t of ["yes", "Yep!", "I'm 25", "im 34 lol", "yes 18+", "over 18", "no, I'm 30", "not under 18"]) {
    assert.equal(parseAgeAnswer(t), "adult", t);
  }
  for (const t of ["no", "nope", "I'm not", "i'm not lol", "yes im 16", "17", "under 18", "im under 18"]) {
    assert.equal(parseAgeAnswer(t), "minor", t);
  }
  for (const t of ["why?", "who is this", "maybe"]) assert.equal(parseAgeAnswer(t), "unclear", t);
});

test("first-person minor statements", () => {
  for (const t of ["im 15", "I'm 16 years old", "lol i am only 14", "I'm in high school", "im in 10th grade"]) {
    assert.ok(mentionsBeingMinor(t), t);
  }
  for (const t of ["I'm 5 minutes away", "my nephew is 12", "I'm 29", "im 2 drinks in", "I'm 100% sure"]) {
    assert.ok(!mentionsBeingMinor(t), t);
  }
});

test("self-harm phrases", () => {
  assert.ok(mentionsSelfHarm("sometimes I want to die"));
  assert.ok(mentionsSelfHarm("thinking about suicide"));
  assert.ok(!mentionsSelfHarm("this traffic is killing me"));
});

test("photo requests and image safety", () => {
  for (const t of ["send me a pic", "can I see a photo of you?", "what do you look like", "got any selfies"]) {
    assert.ok(PHOTO_REQUEST.test(t), t);
  }
  assert.ok(!PHOTO_REQUEST.test("I took a photo class once"));
  assert.equal(checkImageRequest("send a selfie at the beach").ok, true);
  assert.equal(checkImageRequest("send one looking like a teen").ok, false);
  assert.equal(checkImageRequest("dressed as Taylor Swift").ok, false);
});
