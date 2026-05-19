import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Turn {
  role: "user" | "assistant";
  content: string;
}

interface ToolCall {
  name: string;
  input: unknown;
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

interface JudgeVerdict {
  passed: boolean;
  score: number;       // 1–5
  reasoning: string;
  failure_modes: string[];
}

interface ScoredResult extends CaseResult {
  verdict: JudgeVerdict;
  judge_error: string | null;
  judge_latency_ms: number;
  prompt_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
}

// ── Config ────────────────────────────────────────────────────────────────────

const RESULTS_PATH = path.join(__dirname, "results.json");
const SCORED_PATH  = path.join(__dirname, "scored.json");
const REPORT_PATH  = path.join(__dirname, "REPORT.md");

// claude-sonnet-4-6 pricing (per million tokens, as of May 2026)
const COST_PER_M_INPUT  = 3.0;
const COST_PER_M_OUTPUT = 15.0;

// ── API key (same fallback as route.ts) ───────────────────────────────────────

function getApiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const envFile = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf-8");
    const match = envFile.match(/^ANTHROPIC_API_KEY=(.+)$/m);
    if (match?.[1]) return match[1].trim();
  } catch {}
  throw new Error("ANTHROPIC_API_KEY is not set — add it to .env.local");
}

// ── Judge prompt ──────────────────────────────────────────────────────────────

function buildJudgePrompt(result: CaseResult): string {
  const transcriptStr = result.transcript
    .map((t) => `${t.role.toUpperCase()}: ${t.content}`)
    .join("\n\n");

  const toolCallStr =
    result.tool_calls.length > 0
      ? result.tool_calls.map((t) => `  - ${t.name}(${JSON.stringify(t.input)})`).join("\n")
      : "  (none)";

  return `You are an expert evaluator for an AI customer support agent called Restock, built for a DTC linen apparel brand called Linen & Lark.

Your job is to judge whether the agent's response meets the evaluation criteria for a specific test case.

## Test Case
- ID: ${result.id}
- Category: ${result.category}
- What this tests: ${result.description}

## Expected Behavior
${result.expected_behavior}

## Must NOT Do (any of these is an automatic failure)
${result.must_not_do.map((m) => `- ${m}`).join("\n")}

## Expected Tools Called
${result.expected_tools.length > 0 ? result.expected_tools.join(", ") : "(none required)"}

## Actual Tool Calls Made
${toolCallStr}

## Actual Conversation Transcript
${result.error ? `[ERROR — agent returned an error: ${result.error}]` : transcriptStr}

## Scoring Rubric
- 5: Excellent. Fully meets expected behavior, no issues, handles nuance well.
- 4: Good. Meets expected behavior with minor gaps (e.g., slightly verbose, missed a small detail).
- 3: Acceptable. Partially meets expected behavior but has a meaningful gap or omission.
- 2: Poor. Significantly misses expected behavior or exhibits a "must not do" item.
- 1: Fail. Completely wrong, dangerous, or exhibits a critical "must not do" violation.

## Instructions
Evaluate the agent's actual behavior against the expected behavior and must-not-do list.
Consider: Did it call the right tools? Did it give the right answer? Did it violate any constraints?
If there was an error (no response), score it 1.

Respond with ONLY valid JSON in exactly this format — no markdown, no explanation outside the JSON:
{
  "passed": true or false,
  "score": 1 to 5,
  "reasoning": "2-4 sentence explanation of why this score was given",
  "failure_modes": ["list of specific things that went wrong, or empty array if passed"]
}`;
}

// ── Judging ───────────────────────────────────────────────────────────────────

async function judgeOne(
  client: Anthropic,
  result: CaseResult,
  index: number,
  total: number
): Promise<ScoredResult> {
  const label = `${String(index).padStart(2, " ")}/${total}: ${result.id}`;
  process.stdout.write(`  Judging ${label}...`);

  const start = Date.now();
  let verdict: JudgeVerdict = { passed: false, score: 1, reasoning: "", failure_modes: [] };
  let judgeError: string | null = null;
  let promptTokens = 0;
  let outputTokens = 0;

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      system:
        "You are a strict but fair evaluator. Always respond with valid JSON only — no markdown code blocks, no preamble. Your entire response must be parseable by JSON.parse().",
      messages: [{ role: "user", content: buildJudgePrompt(result) }],
    });

    promptTokens  = response.usage.input_tokens;
    outputTokens  = response.usage.output_tokens;

    const raw = response.content.find((b) => b.type === "text");
    if (!raw || raw.type !== "text") throw new Error("No text block in judge response");

    // Strip any accidental markdown fences
    const cleaned = raw.text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
    verdict = JSON.parse(cleaned) as JudgeVerdict;

    // Validate shape
    if (typeof verdict.passed !== "boolean") throw new Error("verdict.passed must be boolean");
    if (typeof verdict.score !== "number" || verdict.score < 1 || verdict.score > 5)
      throw new Error("verdict.score must be 1–5");

  } catch (err) {
    judgeError = err instanceof Error ? err.message : String(err);
    verdict = {
      passed: false,
      score: 1,
      reasoning: `Judge error: ${judgeError}`,
      failure_modes: ["judge_error"],
    };
  }

  const judgeLatency = Date.now() - start;
  const costUsd =
    (promptTokens / 1_000_000) * COST_PER_M_INPUT +
    (outputTokens / 1_000_000) * COST_PER_M_OUTPUT;

  const icon = verdict.passed ? "✓" : "✗";
  process.stdout.write(` ${icon} score=${verdict.score} (${judgeLatency}ms)\n`);

  return {
    ...result,
    verdict,
    judge_error: judgeError,
    judge_latency_ms: judgeLatency,
    prompt_tokens: promptTokens,
    output_tokens: outputTokens,
    estimated_cost_usd: costUsd,
  };
}

// ── Report generation ─────────────────────────────────────────────────────────

function generateReport(scored: ScoredResult[]): string {
  const total = scored.length;
  const passed = scored.filter((s) => s.verdict.passed).length;
  const passRate = ((passed / total) * 100).toFixed(1);
  const avgScore = (scored.reduce((s, r) => s + r.verdict.score, 0) / total).toFixed(2);
  const totalLatencyMs = scored.reduce((s, r) => s + r.latency_ms, 0);
  const totalCost = scored.reduce((s, r) => s + r.estimated_cost_usd, 0);

  // Per-category breakdown
  const categories = [...new Set(scored.map((s) => s.category))];
  const catRows = categories.map((cat) => {
    const group = scored.filter((s) => s.category === cat);
    const catPassed = group.filter((s) => s.verdict.passed).length;
    const catPassRate = ((catPassed / group.length) * 100).toFixed(0);
    const catAvgScore = (group.reduce((s, r) => s + r.verdict.score, 0) / group.length).toFixed(2);
    return { cat, n: group.length, catPassed, catPassRate, catAvgScore };
  });

  // Bottom 5 by score
  const bottom5 = [...scored].sort((a, b) => a.verdict.score - b.verdict.score).slice(0, 5);

  // Top 3 expensive failures (failed + most failure_modes or lowest score)
  const failures = scored.filter((s) => !s.verdict.passed);
  const top3Failures = [...failures]
    .sort((a, b) => b.verdict.failure_modes.length - a.verdict.failure_modes.length || a.verdict.score - b.verdict.score)
    .slice(0, 3);

  const now = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

  let md = `# Restock Eval Report\n\n_Generated: ${now}_\n\n`;

  // Headline
  md += `## Headline Results\n\n`;
  md += `| Metric | Value |\n|---|---|\n`;
  md += `| Overall pass rate | **${passRate}%** (${passed}/${total}) |\n`;
  md += `| Average score | **${avgScore}** / 5 |\n`;
  md += `| Total agent latency | ${(totalLatencyMs / 1000).toFixed(1)}s |\n`;
  md += `| Estimated judge cost | $${totalCost.toFixed(4)} |\n\n`;

  // Per-category table
  md += `## Results by Category\n\n`;
  md += `| Category | N | Passed | Pass Rate | Avg Score |\n|---|---|---|---|---|\n`;
  for (const row of catRows) {
    md += `| ${row.cat} | ${row.n} | ${row.catPassed} | ${row.catPassRate}% | ${row.catAvgScore} |\n`;
  }
  md += `\n`;

  // Bottom 5 lowest-scoring
  md += `## Bottom 5 Lowest-Scoring Cases\n\n`;
  for (const s of bottom5) {
    md += `### ${s.id} — Score ${s.verdict.score}/5 (${s.verdict.passed ? "PASS" : "FAIL"})\n\n`;
    md += `**Category:** ${s.category}  \n`;
    md += `**Description:** ${s.description}  \n`;
    md += `**Expected behavior:** ${s.expected_behavior}\n\n`;
    md += `**Judge reasoning:** ${s.verdict.reasoning}\n\n`;
    if (s.verdict.failure_modes.length > 0) {
      md += `**Failure modes:**\n${s.verdict.failure_modes.map((f) => `- ${f}`).join("\n")}\n\n`;
    }
    md += `**Tools called:** ${s.tool_calls.length > 0 ? s.tool_calls.map((t) => t.name).join(", ") : "(none)"}\n\n`;
    md += `**Transcript:**\n\n`;
    for (const turn of s.transcript) {
      md += `> **${turn.role.toUpperCase()}:** ${turn.content.replace(/\n/g, "  \n> ")}\n\n`;
    }
    if (s.error) md += `> ⚠️ **Error:** ${s.error}\n\n`;
    md += `---\n\n`;
  }

  // Top 3 high-stakes failures
  md += `## Top 3 Highest-Stakes Failures\n\n`;
  if (top3Failures.length === 0) {
    md += `_No failures — all cases passed._\n\n`;
  } else {
    for (const s of top3Failures) {
      md += `### ${s.id} — Score ${s.verdict.score}/5\n\n`;
      md += `**Category:** ${s.category}  \n`;
      md += `**Description:** ${s.description}\n\n`;
      md += `**Why this is high-stakes:** ${s.verdict.failure_modes.join("; ")}\n\n`;
      md += `**Judge reasoning:** ${s.verdict.reasoning}\n\n`;
      md += `**Must not do (violated):**\n${s.must_not_do.map((m) => `- ${m}`).join("\n")}\n\n`;
      md += `**Transcript:**\n\n`;
      for (const turn of s.transcript) {
        md += `> **${turn.role.toUpperCase()}:** ${turn.content.replace(/\n/g, "  \n> ")}\n\n`;
      }
      md += `---\n\n`;
    }
  }

  // All results table
  md += `## All Results\n\n`;
  md += `| ID | Category | Score | Pass | Tools Called |\n|---|---|---|---|---|\n`;
  for (const s of scored) {
    const pass = s.verdict.passed ? "✓" : "✗";
    const tools = s.tool_calls.map((t) => t.name).join(", ") || "—";
    md += `| ${s.id} | ${s.category} | ${s.verdict.score}/5 | ${pass} | ${tools} |\n`;
  }
  md += `\n`;

  return md;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(RESULTS_PATH)) {
    console.error("✗ evals/results.json not found. Run eval:run first.");
    process.exit(1);
  }

  const results: CaseResult[] = JSON.parse(fs.readFileSync(RESULTS_PATH, "utf-8"));
  const total = results.length;

  const client = new Anthropic({ apiKey: getApiKey() });

  console.log(`\nRestock eval judge — ${total} cases`);
  console.log(`Model: claude-sonnet-4-6`);
  console.log(`─`.repeat(72));

  const wallStart = Date.now();
  const scored: ScoredResult[] = [];

  for (let i = 0; i < results.length; i++) {
    const scoredResult = await judgeOne(client, results[i], i + 1, total);
    scored.push(scoredResult);
    // Brief pause between judge calls
    if (i < results.length - 1) await new Promise((r) => setTimeout(r, 200));
  }

  const wallMs = Date.now() - wallStart;
  const passed = scored.filter((s) => s.verdict.passed).length;
  const avgScore = (scored.reduce((s, r) => s + r.verdict.score, 0) / total).toFixed(2);
  const totalCost = scored.reduce((s, r) => s + r.estimated_cost_usd, 0);

  console.log(`\n${"─".repeat(72)}`);
  console.log(`Judged ${total} cases in ${(wallMs / 1000).toFixed(1)}s`);
  console.log(`Pass rate: ${passed}/${total} (${((passed / total) * 100).toFixed(1)}%)`);
  console.log(`Average score: ${avgScore}/5`);
  console.log(`Estimated cost: $${totalCost.toFixed(4)}`);

  fs.writeFileSync(SCORED_PATH, JSON.stringify(scored, null, 2));
  console.log(`\n✓ Scores saved to evals/scored.json`);

  const report = generateReport(scored);
  fs.writeFileSync(REPORT_PATH, report);
  console.log(`✓ Report saved to evals/REPORT.md\n`);
}

main().catch((err) => {
  console.error("Judge failed:", err);
  process.exit(1);
});
