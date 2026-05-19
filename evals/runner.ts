import fs from "fs";
import path from "path";

// ── Types ─────────────────────────────────────────────────────────────────────

interface EvalCase {
  id: string;
  category: string;
  description: string;
  user_messages: string[];
  expected_tools: string[];
  expected_behavior: string;
  must_not_do: string[];
}

interface ToolCall {
  name: string;
  input: unknown;
}

interface Turn {
  role: "user" | "assistant";
  content: string;
}

interface CaseResult {
  id: string;
  category: string;
  description: string;
  expected_tools: string[];
  expected_behavior: string;
  must_not_do: string[];
  transcript: Turn[];
  tool_calls: ToolCall[];
  final_reply: string;
  latency_ms: number;
  error: string | null;
}

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL = "http://localhost:3000";
const CASES_PATH = path.join(__dirname, "cases.json");
const RESULTS_PATH = path.join(__dirname, "results.json");

// ── Helpers ───────────────────────────────────────────────────────────────────

function pad(n: number, width: number) {
  return String(n).padStart(width, " ");
}

function elapsed(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

async function runCase(evalCase: EvalCase, index: number, total: number): Promise<CaseResult> {
  const label = `${pad(index, 2)}/${total}: ${evalCase.id} — ${evalCase.description.slice(0, 60)}`;
  process.stdout.write(`  Running case ${label}...`);

  const start = Date.now();
  const transcript: Turn[] = [];
  const allToolCalls: ToolCall[] = [];
  let finalReply = "";
  let error: string | null = null;

  try {
    // Build conversation history across multiple turns
    const history: { role: "user" | "assistant"; content: string }[] = [];

    for (const userMessage of evalCase.user_messages) {
      history.push({ role: "user", content: userMessage });
      transcript.push({ role: "user", content: userMessage });

      const res = await fetch(`${BASE_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}: ${errText}`);
      }

      const body = (await res.json()) as {
        reply: string;
        tool_calls?: ToolCall[];
        error?: string;
      };

      if (body.error) throw new Error(body.error);

      finalReply = body.reply;
      if (body.tool_calls) allToolCalls.push(...body.tool_calls);

      history.push({ role: "assistant", content: finalReply });
      transcript.push({ role: "assistant", content: finalReply });
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    finalReply = "";
  }

  const latency = Date.now() - start;
  const status = error ? "✗ ERROR" : "✓";
  process.stdout.write(` ${status} ${elapsed(latency)}\n`);

  return {
    id: evalCase.id,
    category: evalCase.category,
    description: evalCase.description,
    expected_tools: evalCase.expected_tools,
    expected_behavior: evalCase.expected_behavior,
    must_not_do: evalCase.must_not_do,
    transcript,
    tool_calls: allToolCalls,
    final_reply: finalReply,
    latency_ms: latency,
    error,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const cases: EvalCase[] = JSON.parse(fs.readFileSync(CASES_PATH, "utf-8"));
  const total = cases.length;

  console.log(`\nRestock eval runner — ${total} cases`);
  console.log(`Target: ${BASE_URL}`);
  console.log(`─`.repeat(72));

  // Verify server is reachable
  try {
    const probe = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "ping" }] }),
    });
    if (!probe.ok && probe.status !== 500) {
      throw new Error(`Server returned ${probe.status}`);
    }
    console.log(`✓ Server reachable\n`);
  } catch {
    console.error(`✗ Cannot reach ${BASE_URL}. Is the dev server running?\n`);
    process.exit(1);
  }

  const wallStart = Date.now();
  const results: CaseResult[] = [];

  // Run categories in order for readable output
  const order = [
    "happy-path",
    "ambiguous-intent",
    "out-of-scope",
    "adversarial",
    "edge-case",
    "escalation-trigger",
  ];
  const sorted = [
    ...order.flatMap((cat) => cases.filter((c) => c.category === cat)),
    ...cases.filter((c) => !order.includes(c.category)),
  ];

  for (let i = 0; i < sorted.length; i++) {
    const result = await runCase(sorted[i], i + 1, total);
    results.push(result);
    // Brief pause to avoid hammering the API
    if (i < sorted.length - 1) await new Promise((r) => setTimeout(r, 300));
  }

  const wallMs = Date.now() - wallStart;
  const errors = results.filter((r) => r.error).length;

  console.log(`\n${"─".repeat(72)}`);
  console.log(`Completed ${total} cases in ${elapsed(wallMs)}`);
  console.log(`Errors: ${errors} / ${total}`);

  // Summary by category
  const cats = [...new Set(results.map((r) => r.category))];
  console.log(`\nCategory summary:`);
  for (const cat of cats) {
    const group = results.filter((r) => r.category === cat);
    const errs = group.filter((r) => r.error).length;
    const avgMs = Math.round(group.reduce((s, r) => s + r.latency_ms, 0) / group.length);
    console.log(`  ${cat.padEnd(22)} ${group.length} cases  ${errs > 0 ? `${errs} errors  ` : "          "}avg ${elapsed(avgMs)}`);
  }

  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
  console.log(`\n✓ Results saved to evals/results.json\n`);
}

main().catch((err) => {
  console.error("Runner failed:", err);
  process.exit(1);
});
