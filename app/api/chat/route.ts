import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "@/lib/system-prompt";
import { findOrder } from "@/lib/orders";
import fs from "fs";
import path from "path";

export const runtime = "nodejs";
export const maxDuration = 60;

// Turbopack (Next.js 15/16 default) has a known bug where non-NEXT_PUBLIC_ vars
// from .env.local are not injected into process.env for route handlers in dev.
// This fallback reads .env.local directly so local dev works without workarounds.
function getApiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const envFile = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf-8");
    const match = envFile.match(/^ANTHROPIC_API_KEY=(.+)$/m);
    if (match?.[1]) return match[1].trim();
  } catch {}
  throw new Error("ANTHROPIC_API_KEY is not set — add it to .env.local");
}

function getClient() {
  return new Anthropic({ apiKey: getApiKey() });
}

const POLICY_TEXT = fs.readFileSync(path.join(process.cwd(), "data/policy.md"), "utf-8");

function daysSince(isoDate: string) {
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / 86_400_000);
}

// ── Tool schemas ─────────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: "lookup_order",
    description:
      "Look up a customer order by order ID and/or email. Returns order details, status, items, and return eligibility.",
    input_schema: {
      type: "object" as const,
      properties: {
        order_id: { type: "string", description: "Order ID, e.g. LNL-10041" },
        email:    { type: "string", description: "Customer email used at checkout" },
      },
    },
  },
  {
    name: "get_return_policy",
    description: "Retrieve the full Linen & Lark returns and refunds policy document.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "initiate_return",
    description:
      "Initiate a return for an eligible order. Validates eligibility, creates a return record, and issues a prepaid label for qualifying US orders.",
    input_schema: {
      type: "object" as const,
      properties: {
        order_id:        { type: "string" },
        email:           { type: "string" },
        reason:          {
          type: "string",
          enum: ["wrong_size", "changed_mind", "defective", "wrong_item_received", "quality_issue", "other"],
        },
        items_to_return: { type: "array", items: { type: "string" }, description: "Array of SKUs to return" },
        notes:           { type: "string" },
      },
      required: ["order_id", "email", "reason", "items_to_return"],
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Escalate to a human support agent. Use for complex cases, VIP customers, explicit human requests, or out-of-scope issues.",
    input_schema: {
      type: "object" as const,
      properties: {
        order_id:       { type: "string" },
        customer_email: { type: "string" },
        reason:         { type: "string" },
        priority:       { type: "string", enum: ["normal", "high", "urgent"] },
        context:        { type: "string" },
      },
      required: ["customer_email", "reason", "priority"],
    },
  },
];

// ── Tool execution ────────────────────────────────────────────────────────────

function execTool(name: string, input: Record<string, unknown>): string {
  if (name === "get_return_policy") {
    return POLICY_TEXT;
  }

  if (name === "lookup_order") {
    const order = findOrder({
      orderId: input.order_id as string | undefined,
      email:   input.email   as string | undefined,
    });
    if (!order) return JSON.stringify({ found: false, message: "No order found." });

    const daysSinceDelivery = order.deliveredAt ? daysSince(order.deliveredAt) : null;
    const hasSaleItem = order.items.some((i) => i.saleItem);
    const eligible =
      order.status === "delivered" &&
      !order.refundedAt &&
      daysSinceDelivery !== null &&
      daysSinceDelivery <= 30 &&
      !hasSaleItem;

    return JSON.stringify({
      found: true,
      order: {
        id: order.id,
        customerName: order.customerName,
        email: order.email,
        status: order.status,
        placedAt: order.placedAt,
        deliveredAt: order.deliveredAt ?? null,
        trackingNumber: order.trackingNumber ?? null,
        shippingCountry: order.shippingCountry,
        currency: order.currency,
        total: order.total,
        isGift: order.isGift,
        vip: order.vip,
        refundedAt: order.refundedAt ?? null,
        items: order.items,
        notes: order.notes ?? null,
      },
      returnEligibility: {
        eligible,
        daysSinceDelivery,
        freeShipping: eligible && order.shippingCountry === "US" && order.total > 75,
        reasons: [
          order.status === "refunded"                           ? "Already refunded."                                : null,
          daysSinceDelivery !== null && daysSinceDelivery > 30  ? `${daysSinceDelivery} days since delivery (>30).` : null,
          hasSaleItem                                           ? "Contains final-sale items."                       : null,
          order.status === "in_transit"                         ? "Still in transit."                               : null,
        ].filter(Boolean),
      },
    });
  }

  if (name === "initiate_return") {
    const { order_id, email, reason, items_to_return, notes } = input as {
      order_id: string;
      email: string;
      reason: string;
      items_to_return: string[];
      notes?: string;
    };

    const order = findOrder({ orderId: order_id, email });
    if (!order)                        return JSON.stringify({ success: false, error: "Order not found." });
    if (order.status === "refunded")   return JSON.stringify({ success: false, error: "Already refunded." });
    if (order.status === "in_transit") return JSON.stringify({ success: false, error: "Still in transit — wait until delivered." });

    const days = order.deliveredAt ? daysSince(order.deliveredAt) : null;
    if (days !== null && days > 30)
      return JSON.stringify({ success: false, error: `Outside 30-day return window (${days} days since delivery).` });

    const saleSkus = order.items.filter((i) => i.saleItem).map((i) => i.sku);
    if (items_to_return.some((sku) => saleSkus.includes(sku)))
      return JSON.stringify({ success: false, error: "Final-sale items cannot be returned.", saleSkus });

    const returnId = `RET-${Date.now().toString(36).toUpperCase()}`;
    const refundAmount = order.items
      .filter((i) => items_to_return.includes(i.sku))
      .reduce((sum, i) => sum + i.unitPrice * i.qty, 0);
    const freePrepaid = order.shippingCountry === "US" && order.total > 75;

    return JSON.stringify({
      success: true,
      returnId,
      orderId: order.id,
      itemsAccepted: items_to_return,
      reason,
      notes: notes ?? null,
      estimatedRefund: refundAmount,
      currency: order.currency,
      refundTimeline: "5–7 business days after return receipt",
      shipping: freePrepaid
        ? { type: "prepaid_label", message: "Prepaid label sent to your email. Drop off at USPS within 7 days." }
        : { type: "customer_responsibility", message: "Ship to: Linen & Lark Returns, 340 Spring St Suite 200, New York NY 10013." },
    });
  }

  if (name === "escalate_to_human") {
    const { order_id, customer_email, reason, priority, context } = input as {
      order_id?: string;
      customer_email: string;
      reason: string;
      priority: "normal" | "high" | "urgent";
      context?: string;
    };
    const ticketId = `ESC-${Date.now().toString(36).toUpperCase()}`;
    const sla = { normal: "1 business day", high: "4 hours", urgent: "1 hour" }[priority];
    return JSON.stringify({
      success: true,
      ticketId,
      orderId: order_id ?? null,
      customerEmail: customer_email,
      reason,
      priority,
      context: context ?? null,
      expectedResponseTime: sla,
      message: `Escalated (ticket ${ticketId}). Our team will contact ${customer_email} within ${sla}.`,
    });
  }

  return JSON.stringify({ error: `Unknown tool: ${name}` });
}

// ── Route handler ─────────────────────────────────────────────────────────────

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export async function POST(req: NextRequest) {
  try {
    console.log("KEY LOADED:", !!process.env.ANTHROPIC_API_KEY);
    const client = getClient();
    const { messages } = (await req.json()) as { messages: ChatMessage[] };

    const anthropicMessages: Anthropic.MessageParam[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const MAX_ITERATIONS = 6;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: anthropicMessages,
      });

      if (response.stop_reason === "end_turn") {
        const text = response.content.find((b) => b.type === "text");
        return NextResponse.json({ reply: (text as Anthropic.TextBlock)?.text ?? "" });
      }

      if (response.stop_reason === "tool_use") {
        anthropicMessages.push({ role: "assistant", content: response.content });

        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const block of response.content) {
          if (block.type === "tool_use") {
            console.log(`[tool_call] ${block.name}`, JSON.stringify(block.input));
            const result = execTool(block.name, block.input as Record<string, unknown>);
            console.log(`[tool_result] ${block.name}`, result.slice(0, 300));
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
          }
        }
        anthropicMessages.push({ role: "user", content: toolResults });
        continue;
      }

      // stop_reason: max_tokens or unexpected
      break;
    }

    return NextResponse.json({
      reply: "I wasn't able to complete that request. Please try again or ask to speak with a human.",
    });
  } catch (err) {
    console.error("CHAT ERROR:", err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
