// The invoice PDF: one layout for online consultations, home visits and
// packages. Only the meeting/address box and the rows differ. It draws a ready
// InvoiceView, so there are no lookups or money rules in here, just layout.
import PDFDocument from "pdfkit";
import path from "path";
import { fileURLToPath } from "url";
import { drawMdwLogo } from "./mdwLogo.ts";
import { paidAtLabel } from "./sessionDates.ts";

export type InvoiceRow = {
  service: string;
  /** When it's done, shown under the service. */
  when?: string;
  pay: "paid" | "part" | "due";
  /** How it was paid: "UPI", "UPI + Cash". */
  method?: string;
  therapistId?: string;
  therapistName?: string;
  /** Not done yet: no therapist is named until someone has actually done it. */
  upcoming?: boolean;
  unit: number;
  /** Unit price before the discount, when there was one. */
  unitMrp?: number;
  qty: number;
};

export type InvoiceView = {
  invoiceId: string;
  bookingId: string;
  date: string;
  time: string;
  billedBy: string;
  /** "Dr. Sattwik (THR-0004)" */
  therapist?: string;
  customer: { name: string; id: string; phone: string; age?: string };
  gst: string;
  /** "Physiotherapy, 4 sessions" on a package. */
  packageLabel?: string;
  /** Home visit and package. */
  address?: string;
  /** Online consultation. */
  meeting?: { date?: string; time?: string; link?: string };
  rows: InvoiceRow[];
  totals: { mrp: number; discount: number; payable: number; paid: number; due: number };
};

const BRAND = {
  name: "MDW Wellness",
  tagline: "Home Healthcare & Physiotherapy",
  website: "wellness.mydawaiwala.com",
  email: "contact@mydawaiwala.com",
  phone: "+91 92309 76362",
  legalName: "My Dawai Wala Healthcare Services",
};

const C = {
  primary: "#018bc4",
  primaryDark: "#016a97",
  text: "#0f3057",
  muted: "#5a6b7c",
  faint: "#8a99a8",
  head: "#e6f4fb",
  panel: "#f4f9fc",
  border: "#dfe7ee",
  paid: "#047857",
  due: "#fff4cc",
  dueText: "#92400e",
};

const FONTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "fonts");
const R = "Inter";
const S = "Inter-SemiBold";

const PAGE = { w: 595.28, h: 841.89, m: 40 };
const W = PAGE.w - PAGE.m * 2;
const FOOTER_TOP = PAGE.h - PAGE.m - 58;
// Content stops here so it never runs into the footer.
const BOTTOM = FOOTER_TOP - 14;

type Doc = PDFKit.PDFDocument;
type TextOpts = {
  font?: string;
  size?: number;
  color?: string;
  width?: number;
  align?: "left" | "center" | "right";
  strike?: boolean;
  link?: string;
  spacing?: number;
  /** Figures of equal width, so amounts line up in a column. */
  tnum?: boolean;
};

function text(doc: Doc, s: string, x: number, y: number, o: TextOpts = {}) {
  doc
    .font(o.font ?? R)
    .fontSize(o.size ?? 9)
    .fillColor(o.color ?? C.text)
    .text(s, x, y, {
      width: o.width,
      align: o.align,
      strike: o.strike,
      link: o.link,
      characterSpacing: o.spacing,
      features: o.tnum ? ["tnum"] : undefined,
      lineBreak: o.width != null,
    });
}

function height(doc: Doc, s: string, width: number, font = R, size = 9): number {
  return doc.font(font).fontSize(size).heightOfString(s, { width });
}

const money = (n: number) =>
  `₹${(n ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function rule(doc: Doc, y: number, color = C.border, x = PAGE.m, w = W) {
  doc.moveTo(x, y).lineTo(x + w, y).lineWidth(0.75).strokeColor(color).stroke();
}

function header(doc: Doc, v: InvoiceView): number {
  doc.rect(PAGE.m, PAGE.m, W, 3).fill(C.primary);
  const y = PAGE.m + 18;
  drawMdwLogo(doc, PAGE.m, y + 1, 76);
  text(doc, BRAND.name, PAGE.m, y - 1, { font: S, size: 17, width: W, align: "center" });
  text(doc, BRAND.tagline, PAGE.m, y + 22, { size: 8.5, color: C.muted, width: W, align: "center" });
  const mw = 170;
  const mx = PAGE.m + W - mw;
  text(doc, "INVOICE", mx, y, { font: S, size: 7, color: C.faint, width: mw, align: "right", spacing: 1.2 });
  text(doc, v.invoiceId, mx, y + 10, { font: S, size: 12, color: C.primaryDark, width: mw, align: "right" });
  text(doc, `Generated ${paidAtLabel(new Date())}`, mx, y + 28, { size: 7.5, color: C.muted, width: mw, align: "right" });
  const line = y + 48;
  rule(doc, line);
  return line + 18;
}

/** Continuation pages: which invoice this is, then straight into content. */
function continuedHeader(doc: Doc, v: InvoiceView): number {
  doc.rect(PAGE.m, PAGE.m, W, 3).fill(C.primary);
  text(doc, `${v.invoiceId} (continued)`, PAGE.m, PAGE.m + 12, { size: 8, color: C.muted, width: W });
  return PAGE.m + 34;
}

function heading(doc: Doc, title: string, x: number, y: number): number {
  text(doc, title, x, y, { font: S, size: 9.5, color: C.primary });
  const w = doc.widthOfString(title);
  doc.moveTo(x, y + 15).lineTo(x + w, y + 15).lineWidth(1).strokeColor(C.primary).stroke();
  return y + 23;
}

const LABEL_W = 78;
type Pair = [label: string, value: string | undefined, opts?: { link?: string; color?: string }];

/** Label / value rows with the values lined up in one column. */
function pairs(doc: Doc, rows: Pair[], x: number, y: number, width: number): number {
  const vw = width - LABEL_W;
  for (const [label, value, o] of rows) {
    if (!value) continue;
    text(doc, label, x, y, { color: C.muted, width: LABEL_W - 6 });
    text(doc, value, x + LABEL_W, y, { color: o?.color ?? (o?.link ? C.primary : C.text), width: vw, link: o?.link });
    y += Math.max(height(doc, value, vw), height(doc, label, LABEL_W - 6)) + 4.5;
  }
  return y;
}

const GAP = 32;
const COL_W = (W - GAP) / 2;
const LEFT = PAGE.m;
const RIGHT = PAGE.m + COL_W + GAP;

function infoBlocks(doc: Doc, v: InvoiceView, y: number): number {
  const l1 = pairs(
    doc,
    [
      ["Booking ID", v.bookingId],
      ["Date", v.date],
      ["Time", v.time],
      ["Billed by", v.billedBy],
      ["Assigned to", v.therapist],
    ],
    LEFT,
    heading(doc, "Booking Information", LEFT, y),
    COL_W,
  );
  const r1 = pairs(
    doc,
    [
      ["Name", v.customer.name],
      ["Customer ID", v.customer.id],
      ["Phone", v.customer.phone],
      ["Age", v.customer.age],
    ],
    RIGHT,
    heading(doc, "Customer Information", RIGHT, y),
    COL_W,
  );
  y = Math.max(l1, r1) + 14;

  const l2 = pairs(
    doc,
    [
      ["GST Number", v.gst],
      ["Package", v.packageLabel],
    ],
    LEFT,
    heading(doc, "Billing Information", LEFT, y),
    COL_W,
  );
  let r2: number;
  if (v.meeting) {
    const m = v.meeting;
    r2 = pairs(
      doc,
      [
        ["Date", m.date],
        ["Time", m.time],
        m.link ? ["Meet link", m.link, { link: m.link }] : ["Meet link", "Shared before the meeting", { color: C.muted }],
      ],
      RIGHT,
      heading(doc, "Online Meeting", RIGHT, y),
      COL_W,
    );
  } else {
    r2 = heading(doc, "Visit Address", RIGHT, y);
    const address = v.address || "Not given";
    text(doc, address, RIGHT, r2, { color: v.address ? C.text : C.muted, width: COL_W });
    r2 += height(doc, address, COL_W) + 4.5;
  }
  return Math.max(l2, r2) + 16;
}

type Cell = {
  main: string;
  sub?: string;
  color?: string;
  /** The sub line is the price before the discount, struck through. */
  mrp?: boolean;
  tnum?: boolean;
  muted?: boolean;
};
// Unit price is wide enough for "₹1,20,000.00" at full size on one line.
const COLS: { title: string; w: number; align?: "left" | "right" | "center" }[] = [
  { title: "#", w: 22 },
  { title: "Service", w: 0 },
  { title: "Payment", w: 60 },
  { title: "Therapist ID", w: 60 },
  { title: "Therapist", w: 74 },
  { title: "Unit price", w: 82, align: "right" },
  { title: "Qty", w: 28, align: "center" },
  { title: "Amount", w: 70, align: "right" },
];
COLS[1].w = W - COLS.reduce((t, c) => t + c.w, 0);
const PAD_X = 6;
const PAD_Y = 7;
const MAIN = 8.5;
const SUB = 7.5;

const PAY_LABEL = { paid: "Paid", part: "Part paid", due: "Due" } as const;

function cells(row: InvoiceRow, i: number): Cell[] {
  return [
    { main: String(i + 1), muted: true },
    // A time never splits from its AM/PM when the line wraps.
    { main: row.service, sub: row.when?.replace(/ (AM|PM)\b/g, "\u00a0$1") },
    { main: PAY_LABEL[row.pay], sub: row.method, color: row.pay === "paid" ? C.paid : C.dueText },
    { main: (!row.upcoming && row.therapistId) || "-", muted: row.upcoming || !row.therapistId },
    {
      main: row.upcoming ? "Upcoming" : row.therapistName || "-",
      muted: row.upcoming || !row.therapistName,
    },
    {
      main: money(row.unit),
      sub: row.unitMrp != null && row.unitMrp > row.unit ? money(row.unitMrp) : undefined,
      mrp: true,
      tnum: true,
    },
    { main: String(row.qty), tnum: true },
    { main: money(row.unit * row.qty), tnum: true },
  ];
}

function cellHeight(doc: Doc, c: Cell, w: number): number {
  const main = height(doc, c.main, w, R, MAIN);
  return c.sub ? main + 2 + height(doc, c.sub, w, R, c.mrp ? MAIN : SUB) : main;
}

/** "~~₹1,600.00~~", right-aligned, same size as the price so it reads on paper. */
function mrpLine(doc: Doc, amount: string, right: number, y: number) {
  doc.font(R).fontSize(MAIN);
  const amountW = doc.widthOfString(amount, { features: ["tnum"] });
  // pdfkit needs a box width to draw the strike; a little slack keeps it on one line.
  text(doc, amount, right - amountW, y, { size: MAIN, color: C.muted, strike: true, tnum: true, width: amountW + 2 });
}

function tableHead(doc: Doc, y: number): number {
  const h = 22;
  doc.rect(PAGE.m, y, W, h).fill(C.head);
  let x = PAGE.m;
  for (const col of COLS) {
    text(doc, col.title, x + PAD_X, y + 7, { font: S, size: 7.5, width: col.w - PAD_X * 2, align: col.align });
    x += col.w;
  }
  return y + h;
}

function servicesTable(doc: Doc, v: InvoiceView, y: number): number {
  y = heading(doc, "Services", PAGE.m, y) + 1;
  let top = y;
  y = tableHead(doc, y);
  const frame = (bottom: number) => doc.rect(PAGE.m, top, W, bottom - top).lineWidth(0.75).strokeColor(C.border).stroke();

  v.rows.forEach((row, i) => {
    const cs = cells(row, i);
    const h = Math.max(...cs.map((c, k) => cellHeight(doc, c, COLS[k].w - PAD_X * 2))) + PAD_Y * 2;
    if (y + h > BOTTOM) {
      frame(y);
      doc.addPage();
      top = continuedHeader(doc, v);
      y = tableHead(doc, top);
    }
    if (row.pay !== "paid") doc.rect(PAGE.m, y, W, h).fill(C.due);
    let x = PAGE.m;
    cs.forEach((c, k) => {
      const w = COLS[k].w - PAD_X * 2;
      const align = COLS[k].align;
      text(doc, c.main, x + PAD_X, y + PAD_Y, {
        size: MAIN,
        color: c.color ?? (c.muted ? C.muted : C.text),
        width: w,
        align,
        tnum: c.tnum,
      });
      if (c.sub) {
        const sy = y + PAD_Y + height(doc, c.main, w, R, MAIN) + 2;
        if (c.mrp) mrpLine(doc, c.sub, x + PAD_X + w, sy);
        else text(doc, c.sub, x + PAD_X, sy, { size: SUB, color: C.faint, width: w, align, tnum: c.tnum });
      }
      x += COLS[k].w;
    });
    y += h;
    if (i < v.rows.length - 1) rule(doc, y);
  });
  frame(y);
  return y + 18;
}

const TOTALS_W = 236;

function totalsAndNotes(doc: Doc, v: InvoiceView, y: number): number {
  const t = v.totals;
  // MRP and discount only when there was a discount; otherwise MRP would just
  // repeat the total.
  const rows: { label: string; value: string; strong?: boolean; due?: boolean; lineAbove?: boolean }[] = [
    ...(t.discount > 0
      ? [
          { label: "Total", value: money(t.mrp) },
          { label: "Discount", value: `- ${money(t.discount)}` },
        ]
      : []),
    { label: "Total payable", value: money(t.payable), strong: true, lineAbove: t.discount > 0 },
    { label: "Paid", value: money(t.paid) },
    { label: "Amount due", value: money(t.due), strong: t.due > 0, due: t.due > 0 },
  ];
  const ROW_H = 20;
  const PAD = 6;
  const panelH = rows.length * ROW_H + PAD * 2;
  if (y + panelH > BOTTOM) {
    doc.addPage();
    y = continuedHeader(doc, v);
  }

  const px = PAGE.m + W - TOTALS_W;
  doc.rect(px, y, TOTALS_W, panelH).fill(C.panel);
  let ry = y + PAD;
  rows.forEach((r, i) => {
    // The last row runs to the box's edge, so its yellow band leaves no gap.
    const h = ROW_H + (i === rows.length - 1 ? PAD : 0);
    if (r.lineAbove) rule(doc, ry, C.border, px + 12, TOTALS_W - 24);
    if (r.due) doc.rect(px, ry, TOTALS_W, h).fill(C.due);
    const color = r.due ? C.dueText : r.strong ? C.text : C.muted;
    const font = r.strong ? S : R;
    const size = r.strong ? 10 : 9;
    const ty = ry + (h - size * 1.2) / 2;
    text(doc, r.label, px + 14, ty, { font, size, color, width: 110 });
    text(doc, r.value, px + 120, ty, { font, size, color: r.strong || r.due ? color : C.text, width: TOTALS_W - 134, align: "right", tnum: true });
    ry += h;
  });
  doc.rect(px, y, TOTALS_W, panelH).lineWidth(0.75).strokeColor(C.border).stroke();

  const nw = W - TOTALS_W - 28;
  text(doc, "Notes", PAGE.m, y + 2, { font: S, size: 8.5, width: nw });
  let ny = y + 18;
  for (const note of [
    "Please keep this receipt for future reference.",
    "For inquiries, contact customer support within 2 days.",
  ]) {
    text(doc, `•  ${note}`, PAGE.m, ny, { size: 8, color: C.muted, width: nw });
    ny += height(doc, `•  ${note}`, nw, R, 8) + 3;
  }
  return Math.max(ny, y + panelH);
}

function footer(doc: Doc, page: number, pages: number) {
  // Drawing below the bottom margin would make pdfkit start a new page.
  doc.page.margins.bottom = 0;
  rule(doc, FOOTER_TOP);
  text(doc, "Thank you for choosing MDW Wellness!", PAGE.m, FOOTER_TOP + 9, { font: S, size: 9.5, color: C.primary, width: W, align: "center" });
  text(doc, `${BRAND.legalName}  |  ${BRAND.website}  |  ${BRAND.email}  |  ${BRAND.phone}`, PAGE.m, FOOTER_TOP + 25, {
    size: 7.5,
    color: C.muted,
    width: W,
    align: "center",
  });
  text(
    doc,
    "For further queries, please check our Return, Refund and Cancellation Policy. This is a computer-generated invoice and needs no signature.",
    PAGE.m,
    FOOTER_TOP + 37,
    { size: 6.75, color: C.faint, width: W, align: "center" },
  );
  if (pages > 1) text(doc, `Page ${page} of ${pages}`, PAGE.m, FOOTER_TOP + 49, { size: 6.75, color: C.faint, width: W, align: "right" });
}

export function renderInvoicePdf(v: InvoiceView): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: PAGE.m, bufferPages: true, info: { Title: `Invoice ${v.invoiceId}` } });
  doc.registerFont(R, path.join(FONTS, "Inter-Regular.woff"));
  doc.registerFont(S, path.join(FONTS, "Inter-SemiBold.woff"));
  const chunks: Buffer[] = [];
  doc.on("data", (d: Buffer) => chunks.push(d));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  let y = header(doc, v);
  y = infoBlocks(doc, v, y);
  y = servicesTable(doc, v, y);
  totalsAndNotes(doc, v, y);

  const { start, count } = doc.bufferedPageRange();
  for (let i = start; i < start + count; i++) {
    doc.switchToPage(i);
    footer(doc, i - start + 1, count);
  }
  doc.end();
  return done;
}
