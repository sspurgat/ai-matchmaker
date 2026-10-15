import type { Character, PreferenceProfile, User } from "./types.ts";

const norm = (s: string) => s.toLowerCase().trim();

function tagsOf(c: Character): Set<string> {
  return new Set([...c.personality, ...c.interests, ...c.vibe].map(norm));
}

// Loose match so "hiking" matches "hiking and camping" and "nerdy" matches "nerd".
function overlap(wanted: string[], have: Set<string>): number {
  let score = 0;
  for (const w of wanted.map(norm)) {
    for (const h of have) {
      if (h === w || h.includes(w) || w.includes(h)) {
        score += 1;
        break;
      }
    }
  }
  return score;
}

// Stated preferences from the profile, plus revealed preferences: characters
// the user actually kept texting pull similar characters up.
export function rankCharacters(
  user: User,
  profile: PreferenceProfile,
  pool: Character[],
  rng: () => number = Math.random,
): Character[] {
  const engaged = Object.values(user.relationships)
    .filter((r) => r.userMessageCount > 0)
    .map((r) => ({ tags: tagsOf(pool.find((c) => c.id === r.characterId)!), weight: r.userMessageCount }));

  const scored = pool
    .filter((c) => !user.relationships[c.id])
    .map((c) => {
      const tags = tagsOf(c);
      let score =
        2 * overlap(profile.vibe, tags) +
        overlap(profile.personality, tags) +
        overlap(profile.interests, tags) -
        3 * overlap(profile.dealbreakers, tags);
      for (const e of engaged) {
        const shared = [...tags].filter((t) => e.tags.has(t)).length;
        score += Math.min(3, shared * Math.log2(1 + e.weight) * 0.5);
      }
      // A little noise so introductions feel discovered, not computed.
      score += rng() * 0.75;
      return { c, score };
    });

  return scored.sort((a, b) => b.score - a.score).map((s) => s.c);
}
