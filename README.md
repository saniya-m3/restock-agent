# Restock — Linen & Lark Customer Support Agent

A production-shaped AI customer support agent for **Linen & Lark**, a fictional DTC linen apparel brand. Built as a portfolio artifact demonstrating how an AI agent can handle real customer-service workflows: order lookup, return eligibility, policy enforcement, and human escalation.

---

## What It Is

Restock is a chat interface powered by **Claude claude-sonnet-4-6** via the Anthropic Messages API. The agent runs a tool-use loop against four purpose-built tools and enforces Linen & Lark's return policy on every request — no hallucinated details, no policy overrides.

### Tools

| Tool | What it does |
|---|---|
| `lookup_order` | Fetches order details and computes return eligibility (window, sale status, refund history) |
| `get_return_policy` | Retrieves the full policy document so the agent cites facts, not memory |
| `initiate_return` | Validates eligibility, creates a return record, issues a prepaid label for qualifying US orders |
| `escalate_to_human` | Creates a support ticket with priority routing (normal / high / urgent) |

### Seed Orders (8 edge cases)

| Order ID | Edge Case |
|---|---|
| `LNL-10128` | Happy path — recently delivered, free return eligible |
| `LNL-10041` | Outside 30-day return window |
| `LNL-10078` | Mixed order: one final-sale item, one returnable item |
| `LNL-10093` | International (UK) — customer pays return shipping |
| `LNL-10112` | In transit — cannot return yet |
| `LNL-10055` | VIP high-value order ($694) — warrants elevated escalation |
| `LNL-10066` | Gift order — recipient differs from purchaser |
| `LNL-10034` | Already refunded — blocks duplicate refund |

---

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router, TypeScript) |
| UI | Tailwind CSS + shadcn/ui (Linear/Vercel aesthetic) |
| AI | Anthropic Messages API (`claude-sonnet-4-6`) |
| Tool loop | Custom tool-use loop in `app/api/chat/route.ts`, max 6 iterations |
| Runtime | Node.js (Vercel-deployable) |

---

## Getting Started

```bash
# 1. Install dependencies
npm install

# 2. Set your Anthropic API key
cp .env.local.example .env.local
# Open .env.local and paste your key after ANTHROPIC_API_KEY=

# 3. Start the dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

**Note:** the dev server uses Next.js 16 with Turbopack. If `process.env.ANTHROPIC_API_KEY` is not picked up (Turbopack known issue), the route falls back to reading `.env.local` directly — no action needed.

---

## Project Structure

```
app/
  page.tsx                # Chat UI — shadcn components, streaming-ready
  api/chat/route.ts       # Tool-use loop (Anthropic SDK), up to 6 iterations
lib/
  system-prompt.ts        # Agent persona, scope, policy rules, escalation triggers
  orders.ts               # 8 typed seed orders + findOrder() lookup helper
  mcp/
    orders-server.ts      # MCP server definition (reference — not used at runtime)
data/
  policy.md               # Linen & Lark returns & refunds policy (ground truth)
components/ui/            # shadcn/ui: Button, Input, ScrollArea, Avatar, Badge
```

---

## Sample Prompts

```
"What's the status of order LNL-10112?"
"I want to return my skirt — order LNL-10128, nadia.petrov@example.com"
"Can I return the dress from order LNL-10078?"
"I need to speak to a human about order LNL-10055."
"What's your return policy for international orders?"
```

---

## Limitations

- **Seed data only** — no real database; orders are hardcoded in `lib/orders.ts`
- **No session persistence** — conversation history lives in React state; refresh resets the thread
- **No auth** — any visitor can look up any order by ID or email
- **Single-user lookup** — `findOrder()` returns the first email match; customers with multiple orders must provide an order ID
- **Exchanges not implemented** — the system prompt mentions same-size exchanges but no tool exists to process them; the agent will describe the policy but cannot execute it
- **English only** — system prompt instructs the agent to match the customer's language but has not been tested beyond English

---

## Deployment

Set `ANTHROPIC_API_KEY` in your Vercel project environment variables, then:

```bash
vercel --prod
```
