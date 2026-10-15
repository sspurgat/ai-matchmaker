import type { Character, MediaItem, Relationship } from "./types.ts";

// Photo pipeline seams. Characters have no real images yet; the library is
// empty and generation is a placeholder until an image stack is chosen
// (spec 20.2: identity consistency, latency, reuse, likeness safety).

export const PHOTO_REQUEST =
  /\b(send|see|show|share|got|have|get|want|pic of|photo of)\b[^.?!]{0,30}\b(pic|pics|picture|photo|photos|selfie|selfies)\b|\bwhat do you look like\b/i;

// Never generate anything that reads as a minor or a real person.
const MINOR_TERMS = /\b(teen|teenage|young[- ]looking|child|kid|minor|schoolgirl|school girl|underage|loli)\b/i;
// "look like Taylor Swift": a capitalized full name after a likeness phrase.
const LIKENESS = /\b(?:look(?:s|ing)? like|as if you were|dressed as)\s+[A-Z][a-z]+\s+[A-Z][a-z]+/;

export function checkImageRequest(text: string): { ok: true } | { ok: false; reason: string } {
  if (MINOR_TERMS.test(text)) return { ok: false, reason: "minor-presenting" };
  if (LIKENESS.test(text)) return { ok: false, reason: "real-person likeness" };
  return { ok: true };
}

// Next reusable photo this user hasn't been sent yet.
export function nextLibraryPhoto(c: Character, rel: Relationship): MediaItem | undefined {
  const sent = new Set(rel.sentMediaIds ?? []);
  return (c.media ?? []).find((m) => (m.tier === "canonical" || m.tier === "situational") && !sent.has(m.id));
}

export interface ImageRequest {
  character: Character;
  prompt: string; // what the user asked for
  tier: "personalized" | "exclusive";
}

export interface ImageGenerator {
  // Returns undefined when generation isn't available.
  generate(req: ImageRequest): Promise<MediaItem | undefined>;
}

// No generator configured: callers fall back to library photos only.
export class NoImageGenerator implements ImageGenerator {
  async generate() {
    return undefined;
  }
}

// Simulator-only: an SVG card standing in for a generated photo, so the
// credits flow can be clicked through end to end. Not deliverable over Linq.
export class PlaceholderImageGenerator implements ImageGenerator {
  async generate({ character, prompt, tier }: ImageRequest): Promise<MediaItem> {
    const esc = (s: string) => s.replace(/[<>&"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#c7b8ea"/><text x="150" y="130" font-size="64" text-anchor="middle" font-family="sans-serif" fill="#fff">${esc(character.name[0])}</text><text x="150" y="190" font-size="14" text-anchor="middle" font-family="sans-serif" fill="#fff">placeholder ${tier} photo</text><text x="150" y="215" font-size="12" text-anchor="middle" font-family="sans-serif" fill="#fff">${esc(prompt.slice(0, 40))}</text></svg>`;
    return {
      id: `gen-${character.id}-${Date.now()}`,
      url: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
      tier,
    };
  }
}
