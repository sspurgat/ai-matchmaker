import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod/v4";
import type { ChatMessage, PreferenceProfile, RelationshipMemory } from "./types.ts";

export interface SummarizeInput {
  characterName: string;
  previous?: RelationshipMemory;
  messages: ChatMessage[]; // the older messages being folded into memory
}

// Everything the engine needs from a model. Tests swap in a scripted fake.
export interface Brain {
  // Returns one or more texts to send, in order.
  reply(system: string, history: ChatMessage[], nudge?: string): Promise<string[]>;
  extractProfile(transcript: ChatMessage[]): Promise<PreferenceProfile>;
  // Folds older messages into the companion's long-term memory notes.
  summarize(input: SummarizeInput): Promise<RelationshipMemory>;
}

const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";

// Turns an API failure into something a person can act on.
export function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "The Claude API key was rejected. Check ANTHROPIC_API_KEY in .env (no spaces or quotes), then restart.";
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return `This API key can't use ${MODEL}. ${err.message}`;
  }
  if (err instanceof Anthropic.RateLimitError) return "Claude API rate limit hit. Wait a minute and try again.";
  if (err instanceof Anthropic.BadRequestError && /credit balance/i.test(err.message)) {
    return "Your Anthropic account is out of credits. Add some at console.anthropic.com under Billing, then try again.";
  }
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the Claude API. Check your internet connection.";
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

const ProfileSchema = z.object({
  summary: z.string(),
  personality: z.array(z.string()),
  interests: z.array(z.string()),
  vibe: z.array(z.string()),
  dealbreakers: z.array(z.string()),
  readyToIntroduce: z.boolean(),
});

const MemorySchema = z.object({
  userFacts: z.array(z.string()),
  sharedMemories: z.array(z.string()),
  milestones: z.array(z.string()),
  preferences: z.array(z.string()),
  recentContext: z.string(),
});

// Our history is "user" vs "them"; the API wants alternating user/assistant
// turns starting with a user turn. A nudge is an out-of-band instruction for a
// proactive text (an intro, a check-in), sent as a bracketed user turn.
export function toApiMessages(
  history: ChatMessage[],
  nudge?: string,
): Anthropic.Beta.BetaMessageParam[] {
  const out: Anthropic.Beta.BetaMessageParam[] = [];
  const push = (role: "user" | "assistant", text: string) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n${text}`;
    else out.push({ role, content: text });
  };
  if (history[0]?.from === "them") push("user", "[conversation start]");
  for (const m of history) push(m.from === "user" ? "user" : "assistant", m.text);
  if (nudge) push("user", `[Note from the app, not from the user: ${nudge}]`);
  return out;
}

// Characters text in bursts; the prompt asks for blank lines between texts.
export function splitTexts(raw: string): string[] {
  return raw
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);
}

export class ClaudeBrain implements Brain {
  private client = new Anthropic();

  // Cheap startup check that the key works and can see the model.
  // Returns undefined when fine, or a readable problem.
  async check(): Promise<string | undefined> {
    try {
      await this.client.models.retrieve(MODEL);
      return undefined;
    } catch (err) {
      return describeError(err);
    }
  }

  async reply(system: string, history: ChatMessage[], nudge?: string) {
    const response = await this.client.beta.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system,
      messages: toApiMessages(history.slice(-60), nudge),
      output_config: { effort: "low" },
      // Re-run on a fallback model if the primary declines, instead of going silent.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (response.stop_reason === "refusal") {
      return ["hmm, let's talk about something else"];
    }
    const text = response.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    return splitTexts(text);
  }

  async extractProfile(transcript: ChatMessage[]) {
    const lines = transcript
      .map((m) => `${m.from === "user" ? "USER" : "MATCHMAKER"}: ${m.text}`)
      .join("\n");
    const response = await this.client.messages.parse({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: "low", format: zodOutputFormat(ProfileSchema) },
      messages: [
        {
          role: "user",
          content: `Below is a text conversation between a user and an AI matchmaker. Build the user's preference profile from it.

- summary: 1-2 sentences in the matchmaker's voice describing the user and what they're looking for, suitable to pass on to a potential match. Only include what they'd be fine with a match knowing.
- personality / interests / vibe: short lowercase tags describing the kind of person they want to meet (vibe examples: playful, direct, nerdy, bold, outdoorsy, artsy, romantic, caring, witty).
- dealbreakers: things they said they don't want.
- readyToIntroduce: true once there's enough to make a reasonable first introduction (roughly: some sense of personality and at least a couple of interests or vibes). Don't wait for perfection.

<conversation>
${lines}
</conversation>`,
        },
      ],
    });
    if (!response.parsed_output) throw new Error("Profile extraction failed");
    return response.parsed_output;
  }

  async summarize({ characterName, previous, messages }: SummarizeInput) {
    const lines = messages.map((m) => `${m.from === "user" ? "USER" : characterName.toUpperCase()}: ${m.text}`).join("\n");
    const response = await this.client.messages.parse({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: "low", format: zodOutputFormat(MemorySchema) },
      messages: [
        {
          role: "user",
          content: `You maintain ${characterName}'s long-term memory of a texting relationship with a user. ${characterName} is a fictional character; older messages are about to be dropped from her context, so anything worth remembering must be in these notes.

Merge the existing notes with the new messages and return the updated notes:
- userFacts: stable facts about the user (name, job, pets, family, where they live, plans).
- sharedMemories: specific things they talked about or "did" together, inside jokes.
- milestones: relationship firsts and turning points (first flirt, first photo, a fight, making up).
- preferences: what the user likes or dislikes in how ${characterName} talks to them.
- recentContext: one sentence on where the conversation left off.

Short phrases, no more than 20 items per list. Keep older items unless the new messages contradict them; drop trivia. Leave out passwords, payment details, and other sensitive identifiers.

<existing_notes>
${JSON.stringify(previous ?? {})}
</existing_notes>

<new_messages>
${lines}
</new_messages>`,
        },
      ],
    });
    if (!response.parsed_output) throw new Error("Memory summarization failed");
    return response.parsed_output;
  }
}
