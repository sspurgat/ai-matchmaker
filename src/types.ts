// "matchmaker" or a character id. Each identity texts from its own line.
export type IdentityId = string;

export const MATCHMAKER: IdentityId = "matchmaker";

export type UserStage = "age_gate" | "discovery" | "matched" | "opted_out";

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
  history: ChatMessage[];
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
  photoUrl?: string;
}
