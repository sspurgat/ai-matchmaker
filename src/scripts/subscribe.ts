// One-time setup: point Linq's inbound webhooks at this server.
// Usage: LINQ_API_KEY=... PUBLIC_URL=https://your-host npm run linq:subscribe
const apiKey = process.env.LINQ_API_KEY;
const publicUrl = process.env.PUBLIC_URL;
if (!apiKey || !publicUrl) {
  console.error("Set LINQ_API_KEY and PUBLIC_URL");
  process.exit(1);
}

const res = await fetch("https://api.linqapp.com/api/partner/v3/webhook-subscriptions", {
  method: "POST",
  headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    target_url: `${publicUrl.replace(/\/$/, "")}/webhooks/linq?version=2026-02-03`,
    subscribed_events: ["message.received"],
  }),
});
const body = await res.json();
if (!res.ok) {
  console.error(res.status, body);
  process.exit(1);
}
console.log(body);
console.log("\nSave signing_secret as LINQ_WEBHOOK_SECRET now; Linq won't show it again.");
