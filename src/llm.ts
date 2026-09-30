import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod/v4";
import type { ChatMessage, PreferenceProfile } from "./types.ts";

// Everything the engine needs from a model. Tests swap in a scripted fake.
export interface Brain {
  // Returns one or more texts to send, in order.
  reply(system: string, history: ChatMessage[], nudge?: string): Promise<string[]>;
  extractProfile(transcript: ChatMessage[]): Promise<PreferenceProfile>;
}

const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";

const ProfileSchema = z.object({
  summary: z.string(),
  personality: z.array(z.string()),
  interests: z.array(z.string()),
  vibe: z.array(z.string()),
  dealbreakers: z.array(z.string()),
  readyToIntroduce: z.boolean(),
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
}
