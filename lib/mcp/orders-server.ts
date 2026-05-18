import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import fs from "fs";
import path from "path";
import { findOrder, ORDERS } from "@/lib/orders";

const policyPath = path.join(process.cwd(), "data", "policy.md");
const POLICY_TEXT = fs.readFileSync(policyPath, "utf-8");

const today = new Date().toISOString().split("T")[0];

function daysSinceDelivery(deliveredAt: string): number {
  const delivered = new Date(deliveredAt);
  const now = new Date(today);
  return Math.floor((now.getTime() - delivered.getTime()) / (1000 * 60 * 60 * 24));
}

export function buildOrdersMcpServer() {
  return createSdkMcpServer({
    name: "linen-lark-orders",
    version: "1.0.0",
    alwaysLoad: true,
    tools: [
      tool(
        "lookup_order",
        "Look up a customer order by order ID and/or email address. Returns order details including status, items, delivery date, and return eligibility.",
        {
          order_id: z.string().optional().describe("Order ID, e.g. LNL-10041"),
          email: z.string().optional().describe("Customer email address used at checkout"),
        },
        async ({ order_id, email }) => {
          const order = findOrder({ orderId: order_id, email });

          if (!order) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    found: false,
                    message: "No order found matching the provided details.",
                  }),
                },
              ],
            };
          }

          const daysSince = order.deliveredAt ? daysSinceDelivery(order.deliveredAt) : null;
          const hasSaleItem = order.items.some((i) => i.saleItem);
          const returnEligible =
            order.status === "delivered" &&
            !order.refundedAt &&
            daysSince !== null &&
            daysSince <= 30 &&
            !hasSaleItem;

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
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
                    eligible: returnEligible,
                    daysSinceDelivery: daysSince,
                    reasons: [
                      !returnEligible && order.status === "refunded"
                        ? "Order has already been refunded."
                        : null,
                      !returnEligible && daysSince !== null && daysSince > 30
                        ? `Outside 30-day return window (${daysSince} days since delivery).`
                        : null,
                      !returnEligible && hasSaleItem
                        ? "Order contains final-sale items which cannot be returned."
                        : null,
                      !returnEligible && order.status === "in_transit"
                        ? "Order is still in transit and cannot be returned yet."
                        : null,
                    ].filter(Boolean),
                    freeShipping:
                      returnEligible &&
                      order.shippingCountry === "US" &&
                      order.total > 75,
                  },
                }),
              },
            ],
          };
        }
      ),

      tool(
        "get_return_policy",
        "Retrieve the full Linen & Lark returns and refunds policy document.",
        {},
        async () => ({
          content: [{ type: "text" as const, text: POLICY_TEXT }],
        })
      ),

      tool(
        "initiate_return",
        "Initiate a return for an eligible order. Validates eligibility, then creates a return record and (for qualifying US orders) generates a prepaid return label.",
        {
          order_id: z.string().describe("Order ID to return, e.g. LNL-10041"),
          email: z.string().describe("Customer email address on the order"),
          reason: z
            .enum([
              "wrong_size",
              "changed_mind",
              "defective",
              "wrong_item_received",
              "quality_issue",
              "other",
            ])
            .describe("Reason for the return"),
          items_to_return: z
            .array(z.string())
            .describe("Array of SKUs to return. Pass all SKUs to return the full order."),
          notes: z.string().optional().describe("Additional context from the customer"),
        },
        async ({ order_id, email, reason, items_to_return, notes }) => {
          const order = findOrder({ orderId: order_id, email });

          if (!order) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    success: false,
                    error: "Order not found. Please verify the order ID and email address.",
                  }),
                },
              ],
            };
          }

          const daysSince = order.deliveredAt ? daysSinceDelivery(order.deliveredAt) : null;
          const hasSaleItem = order.items.some((i) => i.saleItem);

          if (order.status === "refunded") {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    success: false,
                    error: "This order has already been refunded.",
                  }),
                },
              ],
            };
          }

          if (order.status === "in_transit") {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    success: false,
                    error:
                      "Order is still in transit. Please wait until it is delivered before initiating a return.",
                  }),
                },
              ],
            };
          }

          if (daysSince !== null && daysSince > 30) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    success: false,
                    error: `Outside the 30-day return window (${daysSince} days since delivery).`,
                  }),
                },
              ],
            };
          }

          if (hasSaleItem) {
            const saleSkus = order.items.filter((i) => i.saleItem).map((i) => i.sku);
            const attemptingToReturnSaleItem = items_to_return.some((sku) =>
              saleSkus.includes(sku)
            );
            if (attemptingToReturnSaleItem) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      success: false,
                      error:
                        "One or more items in your return request are final sale and cannot be returned.",
                      saleItems: saleSkus,
                    }),
                  },
                ],
              };
            }
          }

          const returnId = `RET-${Date.now().toString(36).toUpperCase()}`;
          const freePrepaidLabel = order.shippingCountry === "US" && order.total > 75;
          const refundEstimate = order.items
            .filter((i) => items_to_return.includes(i.sku))
            .reduce((sum, i) => sum + i.unitPrice * i.qty, 0);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  returnId,
                  orderId: order.id,
                  itemsAccepted: items_to_return,
                  reason,
                  notes: notes ?? null,
                  estimatedRefund: refundEstimate,
                  currency: order.currency,
                  refundMethod: "original_payment_method",
                  refundTimeline: "5–7 business days after return receipt",
                  shipping: freePrepaidLabel
                    ? {
                        type: "prepaid_label",
                        message:
                          "A prepaid return label has been sent to your email. Drop off at any USPS location within 7 days.",
                      }
                    : {
                        type: "customer_responsibility",
                        message:
                          "Please ship the item to: Linen & Lark Returns, 340 Spring St, Suite 200, New York, NY 10013. Use a trackable method — we recommend UPS or USPS Priority.",
                      },
                }),
              },
            ],
          };
        }
      ),

      tool(
        "escalate_to_human",
        "Escalate the customer's issue to a human support agent. Use this for complex cases, VIP customers, high-value orders, situations outside policy, or when the customer explicitly requests a human.",
        {
          order_id: z
            .string()
            .optional()
            .describe("Related order ID if applicable"),
          customer_email: z.string().describe("Customer's email address"),
          reason: z.string().describe("Brief description of why escalation is needed"),
          priority: z
            .enum(["normal", "high", "urgent"])
            .describe(
              "normal: standard SLA (1 business day); high: VIP or high-value; urgent: defective/damaged goods or active shipment issue"
            ),
          context: z
            .string()
            .optional()
            .describe("Summary of the conversation so far to pass to the human agent"),
        },
        async ({ order_id, customer_email, reason, priority, context }) => {
          const ticketId = `ESC-${Date.now().toString(36).toUpperCase()}`;
          const slaMap = { normal: "1 business day", high: "4 hours", urgent: "1 hour" };

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  ticketId,
                  orderId: order_id ?? null,
                  customerEmail: customer_email,
                  reason,
                  priority,
                  context: context ?? null,
                  expectedResponseTime: slaMap[priority],
                  message: `Your case has been escalated (ticket ${ticketId}). A member of our team will reach out to ${customer_email} within ${slaMap[priority]}.`,
                }),
              },
            ],
          };
        }
      ),
    ],
  });
}

export const ordersMcpServerConfig = buildOrdersMcpServer();
