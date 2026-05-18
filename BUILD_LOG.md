# Build Log — Restock

A record of how this project was built, what decisions were made, and why.

---

## Overview

**Built with:** Claude Code (Anthropic's agentic coding tool) + Claude claude-sonnet-4-6  
**Build session:** May 2026  
**Purpose:** Portfolio artifact for a PM interview at Decagon (enterprise AI customer-service company)

---

## How It Was Built

This project was scaffolded and wired entirely in a single Claude Code session. The human (Saniya) provided product decisions and reviewed output at each stage; Claude Code executed the implementation.

### Stage 1 — Scaffold
- Initialized Next.js 16 via `create-next-app` (scaffolded to `/tmp` due to npm's uppercase-directory restriction, then moved)
- Installed `@anthropic-ai/sdk`, `shadcn/ui`, `lucide-react`
- Initialized shadcn and added: `button`, `card`, `input`, `scroll-area`, `avatar`, `badge`

### Stage 2 — Data & Policy
- Designed 8 seed orders in `lib/orders.ts`, each representing a distinct support edge case
- Wrote `data/policy.md` — the ground-truth policy document the agent cites rather than relying on memory
- Created `lib/mcp/orders-server.ts` as an MCP server definition (later kept as reference)

### Stage 3 — First API Approach (Agent SDK — abandoned)
- Initially wired `app/api/chat/route.ts` using `@anthropic-ai/claude-agent-sdk` with an in-process MCP server
- **Problem:** The Agent SDK requires its own auth flow (`/login`) and is designed for autonomous file/shell agents, not stateless customer-service chatbots
- **Decision:** Refactored to the standard `@anthropic-ai/sdk` Messages API with a manual tool-use loop

### Stage 4 — Tool-Use Loop (current implementation)
- Rewrote `route.ts` to use `client.messages.create()` directly
- Implemented a `for` loop (max 6 iterations) checking `stop_reason === "tool_use"`
- Converted MCP tool schemas to Anthropic tool format (JSON Schema in `input_schema`)
- Moved tool execution logic into `execTool()` — a pure synchronous function with no external DB calls
- All tool calls and results logged to the server console for observability

### Stage 5 — Environment Variable Issue (Turbopack)
- `process.env.ANTHROPIC_API_KEY` was `undefined` at request time despite `.env.local` being present
- Diagnosed as a known Turbopack bug in Next.js 15/16: non-`NEXT_PUBLIC_` vars are not reliably injected into route handler `process.env` in dev mode
- **Fix:** `getApiKey()` tries `process.env` first (works in production), falls back to parsing `.env.local` directly (works in local dev with Turbopack)

### Stage 6 — System Prompt
- Saniya wrote the system prompt independently; it was added to `lib/system-prompt.ts`
- Covers: persona, scope (in/out), policy facts, tool routing rules, escalation triggers, tone guidelines, hard prohibitions

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| Standard Anthropic SDK over Agent SDK | Customer-service is a request/response loop, not an autonomous agent. Simpler, more debuggable, no auth dependency. |
| Tool-use loop over streaming | Easier to reason about for a portfolio demo; tool calls are fully visible in server logs |
| In-process tool execution | No external DB or service dependencies — the project runs with just an API key |
| `get_return_policy` as a tool | Agent retrieves policy at call time rather than relying on system prompt memory — reduces hallucination risk on edge cases |
| 8 typed edge-case orders | Covers the failure modes most likely to appear in a real CX demo: window expiry, final sale, international, in-transit, VIP, gift, duplicate refund |
| `findOrder()` returns first match | Deliberate simplification — a real implementation would require customer auth |

---

## Known Issues / Limitations at Time of Commit

See [README.md — Limitations](./README.md#limitations) for the full list.

Additional notes:
- `lib/mcp/orders-server.ts` is not called at runtime but is kept as reference for a future MCP-native deployment
- The `hello.txt` file at the project root is a leftover from before the project was initialized — harmless
- Node.js v24 + npm v11 were used; `npm audit` shows 2 moderate vulnerabilities (inherited from Next.js deps, not application code)
