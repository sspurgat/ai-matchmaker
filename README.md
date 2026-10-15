# AI Matchmaker (prototype)

"Meet someone, don't build someone." You text Rosie, an AI matchmaker. She gets to know you, then AI companions text you from their own numbers.

This is the first prototype from the product spec: one matchmaker, a pool of four companions (Maya, Jess, Priya, Sofia), conversational onboarding, preference extraction, introductions, per-relationship memory, relationship states, and matchmaker check-ins.

## Run it locally (no phones needed)

```bash
npm install
cp .env.example .env   # add ANTHROPIC_API_KEY, leave LINQ_API_KEY empty
npm run dev
```

Open http://localhost:3000. The simulator looks like a Messages app: text Rosie, and introductions show up as new contacts. The right-hand panel shows what the system has inferred (profile, relationship states), and the "Skip hours" buttons fast-forward time so you can see relationships cool off and Rosie check in.

## Run it over real texts (Linq)

1. Get a Linq API key and one phone line per identity (matchmaker + each character).
2. Fill `LINQ_API_KEY` and `LINQ_LINES` in `.env`.
3. Deploy somewhere public (or use a tunnel), then run `PUBLIC_URL=https://... npm run linq:subscribe` and save the returned `signing_secret` as `LINQ_WEBHOOK_SECRET`.
4. `npm start`, then text the matchmaker's number.

Linq sends over iMessage when it can and falls back to RCS, then SMS.

## How it works

| File | What it does |
| --- | --- |
| `src/engine.ts` | The flow: age gate → discovery → introductions → companion chats → check-ins. One message at a time per user. |
| `src/prompts.ts` | Matchmaker and companion system prompts, including the safety rules. |
| `src/characters.ts` | The character pool. |
| `src/ranking.ts` | Picks who to introduce: stated preferences plus revealed ones (who you actually keep texting). |
| `src/llm.ts` | Claude calls: chat replies and structured profile extraction. |
| `src/transport.ts` | Linq sending, webhook parsing and signature checks, plus the simulator transport. |
| `src/server.ts` | HTTP server: Linq webhook and the simulator. |

Decisions made for the prototype (all easy to change):

- **Privacy:** Rosie sees only each relationship's status (stage, message counts), never the private conversation. Companions get Rosie's one-line summary of you, not your whole onboarding chat.
- **Content:** flirting is allowed; explicit content is off until the Linq and carrier rules for adult content are confirmed.
- **Disclosure:** the first message says that Rosie and everyone she introduces are AI. Characters stay in character but answer honestly if sincerely asked.
- **Intros:** two at a time once Rosie has enough to go on; ask her for "someone new" to get another.
- **Storage:** a JSON file in `data/`. Swap for a database before real users.

## Tests

```bash
npm test
npm run typecheck
```

## Not built yet

Photos (the `photoUrl` field is wired but characters have none), payments and credits, long-term memory summarization, a web account page, and the admin "all chats" view.
