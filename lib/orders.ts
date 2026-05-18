export type OrderStatus =
  | "delivered"
  | "in_transit"
  | "processing"
  | "refunded"
  | "cancelled";

export interface Order {
  id: string;
  email: string;
  customerName: string;
  items: Array<{ name: string; sku: string; qty: number; unitPrice: number; saleItem: boolean }>;
  total: number;
  currency: "USD" | "CAD" | "GBP";
  status: OrderStatus;
  placedAt: string;       // ISO date
  deliveredAt?: string;   // ISO date, if delivered
  trackingNumber?: string;
  shippingCountry: string;
  isGift: boolean;
  vip: boolean;
  notes?: string;
  refundedAt?: string;    // ISO date, if already refunded
}

export const ORDERS: Order[] = [
  {
    // Edge case: outside 30-day return window
    id: "LNL-10041",
    email: "priya.mehta@example.com",
    customerName: "Priya Mehta",
    items: [{ name: "Relaxed Linen Shirt – Sage", sku: "LS-SAGE-M", qty: 1, unitPrice: 148, saleItem: false }],
    total: 148,
    currency: "USD",
    status: "delivered",
    placedAt: "2026-02-14",
    deliveredAt: "2026-02-18",
    trackingNumber: "1Z9991W30310488298",
    shippingCountry: "US",
    isGift: false,
    vip: false,
  },
  {
    // Edge case: sale item — final sale, no return
    id: "LNL-10078",
    email: "carlos.ruiz@example.com",
    customerName: "Carlos Ruiz",
    items: [
      { name: "Linen Wrap Dress – Terracotta (Sale)", sku: "LD-TERRA-S", qty: 1, unitPrice: 89, saleItem: true },
      { name: "Linen Scrunchie Set", sku: "ACC-SCR-3PK", qty: 1, unitPrice: 18, saleItem: false },
    ],
    total: 107,
    currency: "USD",
    status: "delivered",
    placedAt: "2026-04-01",
    deliveredAt: "2026-04-05",
    trackingNumber: "1Z9991W30310488311",
    shippingCountry: "US",
    isGift: false,
    vip: false,
  },
  {
    // Edge case: international order (UK) — return shipping not free
    id: "LNL-10093",
    email: "amelia.jones@example.co.uk",
    customerName: "Amelia Jones",
    items: [{ name: "Linen Duvet Cover – White (Queen)", sku: "BED-DUV-WH-Q", qty: 1, unitPrice: 220, saleItem: false }],
    total: 220,
    currency: "GBP",
    status: "delivered",
    placedAt: "2026-04-20",
    deliveredAt: "2026-04-28",
    trackingNumber: "JD014600004GB",
    shippingCountry: "GB",
    isGift: false,
    vip: false,
  },
  {
    // Edge case: in transit — no return yet, tracking available
    id: "LNL-10112",
    email: "sara.okonkwo@example.com",
    customerName: "Sara Okonkwo",
    items: [
      { name: "Linen Jogger – Stone", sku: "LJ-STONE-XS", qty: 1, unitPrice: 118, saleItem: false },
      { name: "Linen Tank Top – Oat", sku: "LT-OAT-XS", qty: 2, unitPrice: 68, saleItem: false },
    ],
    total: 254,
    currency: "USD",
    status: "in_transit",
    placedAt: "2026-05-13",
    trackingNumber: "9400111899223450083046",
    shippingCountry: "US",
    isGift: false,
    vip: false,
  },
  {
    // Edge case: VIP high-value order — warrants white-glove escalation
    id: "LNL-10055",
    email: "diana.chen@example.com",
    customerName: "Diana Chen",
    items: [
      { name: "Linen Blazer – Ecru", sku: "LB-ECRU-6", qty: 1, unitPrice: 340, saleItem: false },
      { name: "Linen Wide-Leg Trouser – Ecru", sku: "LWT-ECRU-6", qty: 1, unitPrice: 198, saleItem: false },
      { name: "Linen Camisole – Ivory", sku: "LC-IVY-XS", qty: 2, unitPrice: 78, saleItem: false },
    ],
    total: 694,
    currency: "USD",
    status: "delivered",
    placedAt: "2026-04-28",
    deliveredAt: "2026-05-02",
    trackingNumber: "1Z9991W30310499001",
    shippingCountry: "US",
    isGift: false,
    vip: true,
    notes: "VIP loyalty member – 3rd order this year",
  },
  {
    // Edge case: gift order — recipient different from purchaser
    id: "LNL-10066",
    email: "marcus.bell@example.com",
    customerName: "Marcus Bell",
    items: [{ name: "Linen Robe – Blush", sku: "LR-BLSH-M", qty: 1, unitPrice: 165, saleItem: false }],
    total: 165,
    currency: "USD",
    status: "delivered",
    placedAt: "2026-05-01",
    deliveredAt: "2026-05-06",
    trackingNumber: "1Z9991W30310499088",
    shippingCountry: "US",
    isGift: true,
    vip: false,
    notes: "Gift — recipient is Jamie Bell. Gift receipt included.",
  },
  {
    // Edge case: recently delivered — within easy return window
    id: "LNL-10128",
    email: "nadia.petrov@example.com",
    customerName: "Nadia Petrov",
    items: [{ name: "Linen Midi Skirt – Dusty Blue", sku: "LMS-DBL-S", qty: 1, unitPrice: 138, saleItem: false }],
    total: 138,
    currency: "USD",
    status: "delivered",
    placedAt: "2026-05-10",
    deliveredAt: "2026-05-14",
    trackingNumber: "9400111899223451009021",
    shippingCountry: "US",
    isGift: false,
    vip: false,
  },
  {
    // Edge case: already refunded — should not be refunded again
    id: "LNL-10034",
    email: "tom.nguyen@example.com",
    customerName: "Tom Nguyen",
    items: [{ name: "Linen Pillowcase Set – Natural", sku: "BED-PCS-NAT-K", qty: 1, unitPrice: 92, saleItem: false }],
    total: 92,
    currency: "USD",
    status: "refunded",
    placedAt: "2026-03-15",
    deliveredAt: "2026-03-19",
    refundedAt: "2026-04-01",
    shippingCountry: "US",
    isGift: false,
    vip: false,
    notes: "Refund processed — item defective (stitching). Full refund issued to original payment method.",
  },
];

export function findOrder(params: { orderId?: string; email?: string }): Order | undefined {
  return ORDERS.find((o) => {
    if (params.orderId && params.email) {
      return o.id === params.orderId && o.email.toLowerCase() === params.email.toLowerCase();
    }
    if (params.orderId) return o.id === params.orderId;
    if (params.email) return o.email.toLowerCase() === params.email.toLowerCase();
    return false;
  });
}
