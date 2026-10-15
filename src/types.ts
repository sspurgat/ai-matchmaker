// "matchmaker" or a character id. Each identity texts from its own line.
export type IdentityId = string;

export const MATCHMAKER: IdentityId = "matchmaker";

// "blocked" is permanent (e.g. the user said they're under 18); START can't undo it.
export type UserStage = "age_gate" | "discovery" | "matched" | "opted_out" | "blocked";

export type RelationshipStage =
  | "introduced"
  | "early"
  | "active"
  | "cooling"
  | "dormant";

export interface ChatMessage {
  from: "user" | "them";
  text: string;
  at: string; // ISO timestamp
}

export interface PreferenceProfile {
  summary: string; // one or two sentences the matchmaker can pass on to a match
  personality: string[];
  interests: string[];
  vibe: string[]; // e.g. "playful", "direct", "nerdy"
  dealbreakers: string[];
  readyToIntroduce: boolean;
}

export interface Relationship {
  characterId: string;
  stage: RelationshipStage;
  introducedAt: string;
  lastUserMessageAt?: string;
  userMessageCount: number;
  lastCheckInAt?: string;
  // Full transcript, kept for the admin view. Only the part after
  // summarizedThrough is sent to the model; the rest lives in memory.
  history: ChatMessage[];
  memory?: RelationshipMemory;
  summarizedThrough?: number; // index into history
  sentMediaIds?: string[];
  pendingPhoto?: { at: string; cost: number; prompt: string }; // waiting for the user to confirm spending credits
}

// What a companion remembers once old messages are summarized away.
// Categories follow the spec's memory section.
export interface RelationshipMemory {
  userFacts: string[]; // stable facts about the user
  sharedMemories: string[]; // things you did or talked about together
  milestones: string[]; // firsts, turning points
  preferences: string[]; // what the user likes or dislikes in this relationship
  recentContext: string; // a sentence on where the conversation left off
}

export type SafetyKind = "self_harm" | "underage" | "rate_limited" | "image_prompt_blocked";

export interface SafetyEvent {
  at: string;
  kind: SafetyKind;
  identity: IdentityId;
  excerpt: string; // trimmed; enough for review, not the whole message
}

export interface CreditEntry {
  at: string;
  delta: number;
  reason: string; // "starting_grant", "purchase", "photo", "admin_grant"...
  ref?: string; // payment id or media id; purchases are idempotent on this
}

export interface Account {
  plan: "free" | "member";
  memberUntil?: string;
  credits: number;
  ledger: CreditEntry[];
}

export interface User {
  phone: string;
  stage: UserStage;
  createdAt: string;
  profile?: PreferenceProfile;
  matchmakerHistory: ChatMessage[];
  discoveryMessageCount: number;
  relationships: Record<string, Relationship>;
  // Linq chat id per identity, so replies land in the same thread.
  chatIds: Record<IdentityId, string>;
  ageConfirmedAt?: string;
  account?: Account;
  safety?: { events: SafetyEvent[]; recentInbound?: string[] };
}

export interface Character {
  id: string;
  name: string;
  age: number;
  city: string;
  occupation: string;
  bio: string;
  personality: string[];
  interests: string[];
  vibe: string[];
  textingStyle: string;
  boundaries: string;
  photoUrl?: string; // canonical intro photo
  media?: MediaItem[];
}

// Media tiers from the spec. Canonical and situational items are reusable
// across users; personalized and exclusive ones are generated per relationship.
export type MediaTier = "canonical" | "situational" | "personalized" | "exclusive";

export interface MediaItem {
  id: string;
  url: string;
  tier: MediaTier;
  caption?: string; // what the character might say when sending it
  tags?: string[];
}
