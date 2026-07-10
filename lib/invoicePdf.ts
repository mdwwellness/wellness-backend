import PDFDocument from "pdfkit";
import Invoice from "../models/invoiceModel.ts";
import { uploadPdfBuffer } from "./uploadthing.ts";
import { drawMdwLogo } from "./mdwLogo.ts";

type InvoiceDoc = InstanceType<typeof Invoice>;

const BRAND = {
  name: "MDW Wellness",
  tagline: "Home Healthcare & Physiotherapy",
  website: "wellness.mydawaiwala.com",
  email: "contact@mydawaiwala.com",
  phone: "+91 92309 76362",
  legalName: "My Dawai Wala Healthcare Services",
};

// Wellness palette — sourced from the client site's --mdw-blue brand token.
const COLORS = {
  primary: "#018bc4",
  primaryDark: "#016a97",
  text: "#0f3057",
  muted: "#5a6b7c",
  light: "#e6f4fb",
  panel: "#f4f9fc",
  rowAlt: "#f7fbfd",
  border: "#e2e8f0",
  white: "#ffffff",
};

const INVOICE_TYPE_LABELS: Record<string, string> = {
  online_consultation: "Online Consultation",
  therapy_session: "Therapy Session",
  package_purchase: "Package Purchase",
  therapy_addon_standalone: "Therapy Add-on",
  vitals_subscription: "Vitals Subscription",
};

const PAYMENT_LABELS: Record<string, string> = {
  paid: "Paid in full",
  pending: "Payment pending",
};

const PAGE = { margin: 42, width: 595.28, height: 841.89 };

function contentWidth(): number {
  return PAGE.width - PAGE.margin * 2;
}

function bufferFromPdfDocument(doc: PDFKit.PDFDocument): Promise<Buffer> {
  const chunks: Buffer[] = [];
  doc.on("data", (d: Buffer) => chunks.push(d));

  return new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

function formatINR(amount: number): string {
  // pdfkit's built-in Helvetica has no rupee glyph (U+20B9) — it would render
  // as a blank box — so use a plain "Rs." prefix that renders reliably.
  const n = new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount ?? 0);
  return `Rs. ${n}`;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

function formatDateTime(d: Date): string {
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

function invoiceTypeLabel(type: string): string {
  return INVOICE_TYPE_LABELS[type] ?? type.replace(/_/g, " ");
}

function readInvoiceDate(invoice: InvoiceDoc): Date {
  const raw = (invoice as any).createdAt;
  if (raw) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

/** Section title in brand blue with a short underline beneath the text. */
function drawSectionHeading(
  doc: PDFKit.PDFDocument,
  title: string,
  x: number,
  y: number,
  width: number,
): number {
  doc.save();
  doc
    .fillColor(COLORS.primary)
    .font("Helvetica-Bold")
    .fontSize(10.5)
    .text(title, x, y, { width, lineBreak: false });
  const tw = Math.min(doc.widthOfString(title), width);
  const underlineY = y + 14;
  doc
    .moveTo(x, underlineY)
    .lineTo(x + tw, underlineY)
    .strokeColor(COLORS.primary)
    .lineWidth(1.4)
    .stroke();
  doc.restore();
  return underlineY + 9;
}

/** Inline "Label: value" row. Returns the next y. */
function drawKeyValue(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  label: string,
  value: string,
  width: number,
): number {
  const labelText = `${label}: `;
  doc.font("Helvetica").fontSize(10);
  const lw = doc.widthOfString(labelText);
  doc.fillColor(COLORS.muted).text(labelText, x, y, { lineBreak: false });
  doc
    .fillColor(COLORS.text)
    .font("Helvetica-Bold")
    .fontSize(10)
    .text(value || "—", x + lw, y, { width: Math.max(20, width - lw), lineBreak: false });
  return y + 16;
}

function drawHeader(doc: PDFKit.PDFDocument, invoice: InvoiceDoc): number {
  const w = contentWidth();
  const top = PAGE.margin;
  const generatedAt = new Date();

  doc.save();
  doc.rect(PAGE.margin, top, w, 4).fill(COLORS.primary);
  doc.restore();

  const headerY = top + 18;

  drawMdwLogo(doc, PAGE.margin, headerY + 1, 82);

  doc
    .fillColor(COLORS.text)
    .font("Helvetica-Bold")
    .fontSize(19)
    .text(BRAND.name, PAGE.margin, headerY, { width: w, align: "center" });
  doc
    .fillColor(COLORS.muted)
    .font("Helvetica")
    .fontSize(9.5)
    .text(BRAND.tagline, PAGE.margin, headerY + 24, { width: w, align: "center" });

  const metaX = PAGE.margin + w - 190;
  doc
    .fillColor(COLORS.muted)
    .font("Helvetica")
    .fontSize(9)
    .text("Invoice", metaX, headerY, { width: 190, align: "right" });
  doc
    .fillColor(COLORS.primaryDark)
    .font("Helvetica-Bold")
    .fontSize(13)
    .text(invoice.invoice_id, metaX, headerY + 12, { width: 190, align: "right" });
  doc
    .fillColor(COLORS.muted)
    .font("Helvetica")
    .fontSize(8.5)
    .text(`Generated: ${formatDateTime(generatedAt)}`, metaX, headerY + 30, {
      width: 190,
      align: "right",
    });

  const lineY = headerY + 54;
  doc
    .moveTo(PAGE.margin, lineY)
    .lineTo(PAGE.margin + w, lineY)
    .strokeColor(COLORS.border)
    .lineWidth(1)
    .stroke();

  return lineY + 18;
}

function drawTwoColumnInfo(
  doc: PDFKit.PDFDocument,
  y: number,
  leftTitle: string,
  leftRows: [string, string][],
  rightTitle: string,
  rightRows: [string, string][],
): number {
  const w = contentWidth();
  const gap = 24;
  const colW = (w - gap) / 2;
  const leftX = PAGE.margin;
  const rightX = PAGE.margin + colW + gap;

  let ly = drawSectionHeading(doc, leftTitle, leftX, y, colW);
  for (const [k, v] of leftRows) ly = drawKeyValue(doc, leftX, ly, k, v, colW);

  let ry = drawSectionHeading(doc, rightTitle, rightX, y, colW);
  for (const [k, v] of rightRows) ry = drawKeyValue(doc, rightX, ry, k, v, colW);

  return Math.max(ly, ry) + 12;
}

/** Service Details (left) + Service Location paragraph (right, when present). */
function drawServiceSection(
  doc: PDFKit.PDFDocument,
  y: number,
  serviceRows: [string, string][],
  address: string,
): number {
  const w = contentWidth();
  const gap = 24;
  const colW = (w - gap) / 2;
  const leftX = PAGE.margin;
  const rightX = PAGE.margin + colW + gap;

  let ly = drawSectionHeading(doc, "Service Details", leftX, y, colW);
  for (const [k, v] of serviceRows) ly = drawKeyValue(doc, leftX, ly, k, v, colW);

  let ry = y;
  if (address) {
    ry = drawSectionHeading(doc, "Service Location", rightX, y, colW);
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor(COLORS.text)
      .text(address, rightX, ry, { width: colW });
    ry += doc.heightOfString(address, { width: colW });
  }

  return Math.max(ly, ry) + 12;
}

function drawServicesTable(
  doc: PDFKit.PDFDocument,
  y: number,
  items: { description: string; price: number }[],
): number {
  const w = contentWidth();
  y = drawSectionHeading(doc, "Services & Charges", PAGE.margin, y, w);
  y += 2;

  const colSno = 40;
  const colAmt = 120;
  const colDesc = w - colSno - colAmt;
  const headerH = 24;
  const rowH = 26;

  doc.save();
  doc.rect(PAGE.margin, y, w, headerH).fill(COLORS.light);
  doc
    .fillColor(COLORS.text)
    .font("Helvetica-Bold")
    .fontSize(9.5)
    .text("S.No", PAGE.margin + 10, y + 8, { width: colSno - 10 })
    .text("Service", PAGE.margin + colSno + 6, y + 8, { width: colDesc - 12 })
    .text("Amount", PAGE.margin + colSno + colDesc, y + 8, {
      width: colAmt - 10,
      align: "right",
    });
  doc.restore();

  let rowY = y + headerH;
  items.forEach((item, idx) => {
    if (idx % 2 === 1) {
      doc.save();
      doc.rect(PAGE.margin, rowY, w, rowH).fill(COLORS.rowAlt);
      doc.restore();
    }
    doc
      .fillColor(COLORS.primary)
      .font("Helvetica-Bold")
      .fontSize(10)
      .text(String(idx + 1), PAGE.margin + 10, rowY + 8, { width: colSno - 10 });
    doc
      .fillColor(COLORS.text)
      .font("Helvetica")
      .fontSize(10)
      .text(item.description, PAGE.margin + colSno + 6, rowY + 8, {
        width: colDesc - 12,
        lineBreak: false,
        ellipsis: true,
      });
    doc
      .fillColor(COLORS.text)
      .font("Helvetica-Bold")
      .fontSize(10)
      .text(formatINR(item.price), PAGE.margin + colSno + colDesc, rowY + 8, {
        width: colAmt - 10,
        align: "right",
      });
    rowY += rowH;
  });

  doc
    .rect(PAGE.margin, y, w, rowY - y)
    .strokeColor(COLORS.border)
    .lineWidth(1)
    .stroke();

  return rowY + 16;
}

function drawPaymentAndTotals(
  doc: PDFKit.PDFDocument,
  y: number,
  invoice: InvoiceDoc,
): number {
  const w = contentWidth();
  const panelW = 250;
  const gap = 16;
  const leftW = w - panelW - gap;
  const leftX = PAGE.margin;
  const panelX = PAGE.margin + w - panelW;

  // Left: payment status + notes.
  const afterHead = drawSectionHeading(doc, "Payment Information", leftX, y, leftW);
  const paymentLabel =
    PAYMENT_LABELS[invoice.payment_status] ?? invoice.payment_status;
  doc
    .fillColor(invoice.payment_status === "paid" ? COLORS.primaryDark : COLORS.text)
    .font("Helvetica-Bold")
    .fontSize(11)
    .text(paymentLabel, leftX, afterHead + 2);

  doc
    .fillColor(COLORS.muted)
    .font("Helvetica")
    .fontSize(9)
    .text("Notes:", leftX, afterHead + 22);

  const notes = [
    "Please keep this invoice for your records and insurance claims.",
    "For billing queries, contact our customer support within 7 days.",
    "Session packages are non-refundable once activated unless stated otherwise.",
  ];
  let noteY = afterHead + 36;
  for (const note of notes) {
    doc
      .fillColor(COLORS.muted)
      .font("Helvetica")
      .fontSize(9)
      .text(`• ${note}`, leftX + 6, noteY, { width: leftW - 12 });
    noteY = doc.y + 3;
  }

  // Right: totals panel.
  const rows: [string, string, boolean][] = [
    ["Subtotal", formatINR(invoice.items_subtotal), false],
    ["Amount paid", formatINR(invoice.advance_paid), false],
    ["Balance due", formatINR(invoice.balance_due), false],
    ["Payable amount", formatINR(invoice.total), true],
  ];
  const panelH = 14 + rows.length * 22 + 10;
  doc.save();
  doc.rect(panelX, y, panelW, panelH).fill(COLORS.panel);
  doc
    .rect(panelX, y, panelW, panelH)
    .strokeColor(COLORS.border)
    .lineWidth(1)
    .stroke();
  let ry = y + 14;
  for (const [label, value, highlight] of rows) {
    if (highlight) {
      doc
        .moveTo(panelX + 12, ry - 5)
        .lineTo(panelX + panelW - 12, ry - 5)
        .strokeColor(COLORS.border)
        .lineWidth(1)
        .stroke();
    }
    doc
      .fillColor(highlight ? COLORS.primary : COLORS.muted)
      .font(highlight ? "Helvetica-Bold" : "Helvetica")
      .fontSize(highlight ? 11 : 10)
      .text(label, panelX + 14, ry, { width: 120 });
    doc
      .fillColor(highlight ? COLORS.primary : COLORS.text)
      .font(highlight ? "Helvetica-Bold" : "Helvetica")
      .fontSize(highlight ? 12 : 10)
      .text(value, panelX + 120, ry, { width: panelW - 134, align: "right" });
    ry += 22;
  }
  doc.restore();

  return Math.max(noteY, y + panelH) + 14;
}

function drawFooter(doc: PDFKit.PDFDocument) {
  const w = contentWidth();
  const footerY = PAGE.height - PAGE.margin - 52;

  doc
    .moveTo(PAGE.margin, footerY)
    .lineTo(PAGE.margin + w, footerY)
    .strokeColor(COLORS.border)
    .lineWidth(1)
    .stroke();

  doc
    .fillColor(COLORS.primary)
    .font("Helvetica-Bold")
    .fontSize(11)
    .text("Thank you for choosing MDW Wellness!", PAGE.margin, footerY + 12, {
      width: w,
      align: "center",
    });

  const footerLine = `${BRAND.legalName}  |  ${BRAND.website}  |  ${BRAND.email}  |  ${BRAND.phone}`;
  doc
    .fillColor(COLORS.muted)
    .font("Helvetica")
    .fontSize(8)
    .text(footerLine, PAGE.margin, footerY + 30, { width: w, align: "center" });

  doc
    .fillColor(COLORS.muted)
    .font("Helvetica")
    .fontSize(7.5)
    .text(
      "This is a computer-generated invoice and does not require a physical signature.",
      PAGE.margin,
      footerY + 42,
      { width: w, align: "center" },
    );
}

function buildInvoicePdf(invoice: InvoiceDoc): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: "A4", margin: PAGE.margin });
  const invoiceDate = readInvoiceDate(invoice);

  let y = drawHeader(doc, invoice);

  const leftRows: [string, string][] = [
    ["Invoice ID", invoice.invoice_id],
    ["Booking ID", (invoice as any).enquiry_id ?? ""],
    ["Date", formatDate(invoiceDate)],
    ["Time", formatTime(invoiceDate)],
    ["Billed by", invoice.created_by || "MDW Admin"],
  ];
  const rightRows: [string, string][] = [
    ["Name", invoice.customer_name],
    ["Phone", String(invoice.customer_phone)],
    ["Customer ID", invoice.customer_id],
  ];
  y = drawTwoColumnInfo(
    doc,
    y,
    "Invoice Information",
    leftRows,
    "Customer Information",
    rightRows,
  );

  const serviceRows: [string, string][] = [];
  if (invoice.therapist_name)
    serviceRows.push(["Therapist", invoice.therapist_name]);
  if ((invoice as any).therapist_id)
    serviceRows.push(["Therapist ID", (invoice as any).therapist_id]);
  if (invoice.package_name) serviceRows.push(["Package", invoice.package_name]);
  if (invoice.session_number)
    serviceRows.push(["Session", String(invoice.session_number)]);
  serviceRows.push(["Service type", invoiceTypeLabel(invoice.invoice_type)]);

  const address = ((invoice as any).address ?? "").toString().trim();
  y = drawServiceSection(doc, y, serviceRows, address);

  const items =
    invoice.line_items?.length > 0
      ? invoice.line_items
      : [
          {
            description: invoiceTypeLabel(invoice.invoice_type),
            price: invoice.total,
          },
        ];
  y = drawServicesTable(doc, y, items);

  drawPaymentAndTotals(doc, y, invoice);

  drawFooter(doc);

  return doc;
}

export async function ensureInvoicePdfGeneratedAndUploaded(
  invoice: InvoiceDoc,
): Promise<string> {
  const filename = `${invoice.invoice_id}-${Date.now()}.pdf`;
  const doc = buildInvoicePdf(invoice);
  const pdfPromise = bufferFromPdfDocument(doc);
  doc.end();
  const pdfBuffer = await pdfPromise;

  return uploadPdfBuffer({
    buffer: pdfBuffer,
    filename,
  });
}
