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

## Share the simulator on Vercel

`npm run build:vercel` builds a password-protected copy of the simulator for Vercel (`vercel.json` runs it for you on deploy). Set two environment variables in the Vercel project: `ANTHROPIC_API_KEY` and `DEMO_PASSWORD`. The browser asks for the password (any username works) so strangers can't spend your Claude key.

The hosted copy has no database. Each browser keeps its own pretend user and chat in local storage and gets its own fake 555 number, so testers don't see each other. Payments, the admin view and the 15-minute background check-ins are off there; "Skip 30 hours" still works.

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
| `src/safety.ts` | Deterministic backstops: age-answer parsing, mid-chat minor detection, self-harm resources, rate limiting. |
| `src/billing.ts` | Credits ledger, placeholder products and costs, and the payment-provider seam (dev provider only). |
| `src/media.ts` | Photo requests, the reusable photo library, image-request safety, and the image-generator seam (placeholder only). |
| `src/analytics.ts` | Product events as JSON lines, keyed by a hash of the phone number. |
| `src/server.ts` | HTTP server: Linq webhook, payments webhook, admin view, and the simulator. |

Decisions made for the prototype (all easy to change):

- **Privacy:** Rosie sees only each relationship's status (stage, message counts), never the private conversation. Companions get Rosie's one-line summary of you, not your whole onboarding chat.
- **Content:** flirting is allowed; explicit content is off until the Linq and carrier rules for adult content are confirmed.
- **Disclosure:** the first message says that Rosie and everyone she introduces are AI. Characters stay in character but answer honestly if sincerely asked.
- **Intros:** two at a time once Rosie has enough to go on; ask her for "someone new" to get another.
- **Storage:** a JSON file in `data/`. Swap for a database before real users.

## Safety

The prompts carry the safety rules, and `src/safety.ts` backs them up without relying on the model:

- **Age gate:** "yes I'm 16", "17" or "I'm not" all count as under 18. Anyone under 18 is blocked for good; START can't reopen it.
- **Mid-conversation:** a first-person statement like "im 15" or "I'm in high school" pauses the account for review in the admin view.
- **Crisis:** if a text mentions self-harm, the reply always includes the 988 Lifeline, even if the model left it out.
- **Compliance:** STOP and HELP work on every line. Floods over 20 texts a minute are dropped and logged.
- **Photos:** requests that read as a minor or a real person's likeness are refused.

## Memory

Each companion keeps the full transcript (for the admin view), but once a chat passes 40 messages the older part is summarized into memory notes (facts about the user, shared memories, milestones, preferences) and only the recent messages go to the model.

## Credits and payments

Texting is free. Credits pay for extras like generated photos, and the user is always told the cost and asked to confirm first. Text CREDITS to see your balance and buy links. Prices, pack sizes, costs and the 10 starting credits are placeholders in `src/billing.ts` and `src/engine.ts`.

No real payment processor is connected. In the simulator, the buy link goes to a fake checkout that "pays" instantly so you can click through the whole loop. A real processor plugs in by implementing `PaymentProvider`.

## Photos

Characters have no photos yet. When someone asks for a pic, the companion sends an unused library photo (free) if there is one; otherwise, in the simulator, a placeholder card stands in for a generated photo (costs credits). Over Linq with no generator configured, the companion just deflects in character.

## Admin view

Open http://localhost:3000/admin to see every user, their conversations, memory notes, safety events and credit ledger, and to grant credits or lift a block after review. Over Linq it requires `ADMIN_TOKEN`. Every admin request is logged.

## Tests

```bash
npm test
npm run typecheck
```

CI runs both on every pull request.

## Not built yet

Real character photos and an image generator, a real payment processor, a web account page (billing, privacy, data export and deletion), and a real database.
