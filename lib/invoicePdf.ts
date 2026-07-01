import PDFDocument from "pdfkit";
import Invoice from "../models/invoiceModel.ts";
import { uploadPdfBuffer } from "./uploadthing.ts";

type InvoiceDoc = InstanceType<typeof Invoice>;

const BRAND = {
  name: "MDW Wellness",
  tagline: "Home Healthcare & Physiotherapy",
  website: "wellness.mydawaiwala.com",
  email: "contact@mydawaiwala.com",
  phone: "+91 92309 76362",
  legalName: "My Dawai Wala Healthcare Services",
};

const COLORS = {
  primary: "#008000",
  primaryDark: "#006600",
  text: "#1a1a1a",
  muted: "#5c5c5c",
  light: "#f4f7f4",
  border: "#d9e2d9",
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
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount ?? 0);
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
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

function drawBrandMark(doc: PDFKit.PDFDocument, x: number, y: number) {
  doc.save();
  doc.circle(x + 14, y + 14, 14).fill(COLORS.primary);
  doc.fillColor(COLORS.white).font("Helvetica-Bold").fontSize(11);
  doc.text("+", x + 8.5, y + 6.5);
  doc.restore();
}

function drawHeader(doc: PDFKit.PDFDocument, invoice: InvoiceDoc) {
  const w = contentWidth();
  const top = PAGE.margin;
  const generatedAt = new Date();

  doc.save();
  doc.rect(PAGE.margin, top, w, 4).fill(COLORS.primary);
  doc.restore();

  drawBrandMark(doc, PAGE.margin, top + 14);

  doc
    .fillColor(COLORS.text)
    .font("Helvetica-Bold")
    .fontSize(20)
    .text(BRAND.name, PAGE.margin + 36, top + 12, { continued: false });

  doc
    .fillColor(COLORS.muted)
    .font("Helvetica")
    .fontSize(10)
    .text(BRAND.tagline, PAGE.margin + 36, top + 36);

  const metaX = PAGE.margin + w - 190;
  doc
    .fillColor(COLORS.muted)
    .font("Helvetica")
    .fontSize(9)
    .text("Invoice", metaX, top + 12, { width: 190, align: "right" });

  doc
    .fillColor(COLORS.primaryDark)
    .font("Helvetica-Bold")
    .fontSize(13)
    .text(invoice.invoice_id, metaX, top + 24, { width: 190, align: "right" });

  doc
    .fillColor(COLORS.muted)
    .font("Helvetica")
    .fontSize(9)
    .text(`Generated: ${formatDateTime(generatedAt)}`, metaX, top + 42, {
      width: 190,
      align: "right",
    });

  const lineY = top + 72;
  doc
    .moveTo(PAGE.margin, lineY)
    .lineTo(PAGE.margin + w, lineY)
    .strokeColor(COLORS.border)
    .lineWidth(1)
    .stroke();

  return lineY + 16;
}

function drawSectionBar(
  doc: PDFKit.PDFDocument,
  title: string,
  y: number,
): number {
  const w = contentWidth();
  doc.save();
  doc.rect(PAGE.margin, y, w, 24).fill(COLORS.primary);
  doc
    .fillColor(COLORS.white)
    .font("Helvetica-Bold")
    .fontSize(10)
    .text(title, PAGE.margin + 12, y + 7);
  doc.restore();
  return y + 24;
}

function drawInfoRow(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  label: string,
  value: string,
  width: number,
): number {
  doc.fillColor(COLORS.muted).font("Helvetica").fontSize(8).text(label, x, y, {
    width,
  });
  doc
    .fillColor(COLORS.text)
    .font("Helvetica")
    .fontSize(10)
    .text(value || "—", x, y + 11, { width });
  return y + 34;
}

function drawTwoColumnSection(
  doc: PDFKit.PDFDocument,
  y: number,
  leftTitle: string,
  leftRows: [string, string][],
  rightTitle: string,
  rightRows: [string, string][],
): number {
  const w = contentWidth();
  const colW = (w - 16) / 2;
  const leftX = PAGE.margin;
  const rightX = PAGE.margin + colW + 16;
  const boxTop = y;

  y = drawSectionBar(doc, leftTitle, y);
  let leftY = y + 10;
  for (const [label, value] of leftRows) {
    leftY = drawInfoRow(doc, leftX + 12, leftY, label, value, colW - 24);
  }

  const rightBarY = boxTop;
  doc.save();
  doc.rect(rightX, rightBarY, colW, 24).fill(COLORS.primary);
  doc
    .fillColor(COLORS.white)
    .font("Helvetica-Bold")
    .fontSize(10)
    .text(rightTitle, rightX + 12, rightBarY + 7);
  doc.restore();

  let rightY = rightBarY + 34;
  for (const [label, value] of rightRows) {
    rightY = drawInfoRow(doc, rightX + 12, rightY, label, value, colW - 24);
  }

  const sectionBottom = Math.max(leftY, rightY) + 8;
  doc
    .rect(PAGE.margin, boxTop, w, sectionBottom - boxTop)
    .strokeColor(COLORS.border)
    .lineWidth(1)
    .stroke();

  return sectionBottom + 14;
}

function drawLineItemsTable(
  doc: PDFKit.PDFDocument,
  y: number,
  items: { description: string; price: number }[],
): number {
  const w = contentWidth();
  y = drawSectionBar(doc, "Services & Charges", y);

  const tableTop = y;
  const colSno = 36;
  const colDesc = w - colSno - 110;
  const colAmt = 110;
  const headerH = 26;
  const rowH = 28;

  doc.save();
  doc.rect(PAGE.margin, tableTop, w, headerH).fill(COLORS.light);
  doc
    .fillColor(COLORS.muted)
    .font("Helvetica-Bold")
    .fontSize(9)
    .text("S.No", PAGE.margin + 10, tableTop + 9, { width: colSno - 10 })
    .text("Description", PAGE.margin + colSno + 8, tableTop + 9, {
      width: colDesc - 16,
    })
    .text("Amount", PAGE.margin + colSno + colDesc, tableTop + 9, {
      width: colAmt - 12,
      align: "right",
    });
  doc.restore();

  let rowY = tableTop + headerH;
  items.forEach((item, idx) => {
    const fill = idx % 2 === 0 ? COLORS.white : "#fafcfa";
    doc.rect(PAGE.margin, rowY, w, rowH).fill(fill);

    doc
      .fillColor(COLORS.text)
      .font("Helvetica")
      .fontSize(10)
      .text(String(idx + 1), PAGE.margin + 10, rowY + 9, { width: colSno - 10 })
      .text(item.description, PAGE.margin + colSno + 8, rowY + 9, {
        width: colDesc - 16,
      })
      .font("Helvetica-Bold")
      .text(formatINR(item.price), PAGE.margin + colSno + colDesc, rowY + 9, {
        width: colAmt - 12,
        align: "right",
      });

    rowY += rowH;
  });

  doc
    .rect(PAGE.margin, tableTop, w, rowY - tableTop)
    .strokeColor(COLORS.border)
    .lineWidth(1)
    .stroke();

  return rowY + 14;
}

function drawTotalsPanel(
  doc: PDFKit.PDFDocument,
  panelTop: number,
  invoice: InvoiceDoc,
): number {
  const w = contentWidth();
  const panelW = 250;
  const panelX = PAGE.margin + w - panelW;

  const rows: [string, string, boolean][] = [
    ["Subtotal", formatINR(invoice.items_subtotal), false],
    ["Advance paid", formatINR(invoice.advance_paid), false],
    ["Balance due", formatINR(invoice.balance_due), false],
    ["Payable amount", formatINR(invoice.total), true],
  ];

  let rowY = panelTop + 12;
  doc.save();
  doc.rect(panelX, panelTop, panelW, 12 + rows.length * 24 + 12).fill(COLORS.light);
  doc
    .rect(panelX, panelTop, panelW, 12 + rows.length * 24 + 12)
    .strokeColor(COLORS.border)
    .lineWidth(1)
    .stroke();

  for (const [label, value, highlight] of rows) {
    doc
      .fillColor(highlight ? COLORS.primaryDark : COLORS.muted)
      .font(highlight ? "Helvetica-Bold" : "Helvetica")
      .fontSize(highlight ? 11 : 10)
      .text(label, panelX + 14, rowY, { width: 120 });

    doc
      .fillColor(highlight ? COLORS.primaryDark : COLORS.text)
      .font(highlight ? "Helvetica-Bold" : "Helvetica")
      .fontSize(highlight ? 12 : 10)
      .text(value, panelX + 120, rowY, { width: panelW - 134, align: "right" });

    rowY += 24;
  }
  doc.restore();

  return panelTop + 12 + rows.length * 24 + 12 + 10;
}

function drawNotesAndPayment(
  doc: PDFKit.PDFDocument,
  y: number,
  invoice: InvoiceDoc,
): { bottom: number; panelTop: number } {
  const w = contentWidth();
  const panelW = 250;
  const leftW = w - panelW - 16;
  y = drawSectionBar(doc, "Payment Information", y);

  const boxTop = y;
  const paymentLabel =
    PAYMENT_LABELS[invoice.payment_status] ?? invoice.payment_status;

  doc
    .fillColor(COLORS.text)
    .font("Helvetica-Bold")
    .fontSize(11)
    .text(paymentLabel, PAGE.margin + 12, y + 12);

  doc
    .fillColor(COLORS.muted)
    .font("Helvetica")
    .fontSize(9)
    .text("Notes:", PAGE.margin + 12, y + 34);

  const notes = [
    "Please keep this invoice for your records and insurance claims.",
    "For billing queries, contact our customer support within 7 days.",
    "Session packages are non-refundable once activated unless stated otherwise.",
  ];

  let noteY = y + 48;
  for (const note of notes) {
    doc
      .fillColor(COLORS.muted)
      .font("Helvetica")
      .fontSize(9)
      .text(`• ${note}`, PAGE.margin + 18, noteY, { width: leftW - 24 });
    noteY += 16;
  }

  const boxBottom = Math.max(noteY + 12, y + 108);
  doc
    .rect(PAGE.margin, boxTop, leftW, boxBottom - boxTop)
    .strokeColor(COLORS.border)
    .lineWidth(1)
    .stroke();

  return { bottom: boxBottom + 14, panelTop: boxTop };
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
    .fillColor(COLORS.primaryDark)
    .font("Helvetica-Bold")
    .fontSize(11)
    .text("Thank you for choosing MDW Wellness!", PAGE.margin, footerY + 12, {
      width: w,
      align: "center",
    });

  const footerLine = `${BRAND.legalName} | ${BRAND.website} | ${BRAND.email} | ${BRAND.phone}`;
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
    ["Invoice date", formatDate(invoiceDate)],
    ["Service type", invoiceTypeLabel(invoice.invoice_type)],
    ["Billed by", invoice.created_by || "MDW Admin"],
  ];
  if (invoice.enquiry_id) {
    leftRows.push(["Enquiry ID", invoice.enquiry_id]);
  }

  const rightRows: [string, string][] = [
    ["Customer name", invoice.customer_name],
    ["Phone", String(invoice.customer_phone)],
    ["Customer ID", invoice.customer_id],
  ];
  if (invoice.therapist_name) {
    rightRows.push(["Therapist", invoice.therapist_name]);
  }
  if (invoice.package_name) {
    rightRows.push(["Package", invoice.package_name]);
  }
  if (invoice.session_number) {
    rightRows.push(["Session", invoice.session_number]);
  }

  y = drawTwoColumnSection(
    doc,
    y,
    "Invoice Information",
    leftRows,
    "Customer Information",
    rightRows,
  );

  y = drawSectionBar(doc, "Billing Information", y);
  const billingY = y + 10;
  drawInfoRow(
    doc,
    PAGE.margin + 12,
    billingY,
    "Billed to",
    invoice.customer_name,
    contentWidth() / 2 - 24,
  );
  drawInfoRow(
    doc,
    PAGE.margin + contentWidth() / 2 + 4,
    billingY,
    "GST / Tax",
    "Inclusive as applicable",
    contentWidth() / 2 - 24,
  );
  y = billingY + 44;
  doc
    .rect(PAGE.margin, billingY - 10, contentWidth(), y - billingY + 10)
    .strokeColor(COLORS.border)
    .lineWidth(1)
    .stroke();
  y += 14;

  const items =
    invoice.line_items?.length > 0
      ? invoice.line_items
      : [{ description: invoiceTypeLabel(invoice.invoice_type), price: invoice.total }];

  y = drawLineItemsTable(doc, y, items);

  const payment = drawNotesAndPayment(doc, y, invoice);
  drawTotalsPanel(doc, payment.panelTop, invoice);

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
