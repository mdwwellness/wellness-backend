import type { Request, Response } from "express";
import Invoice from "../models/invoiceModel.ts";
import Customer from "../models/customerModel.ts";
import { createInvoiceIfMissingForAppointment, createManualInvoice } from "../lib/invoiceGeneration.ts";
import { ensureInvoicePdfGeneratedAndUploaded } from "../lib/invoicePdf.ts";
import { logger } from "../lib/logger.ts";

const BACK_OFFICE_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "STAFF", "CUSTOMER_CARE"]);

function actorName(req: Request): string {
  const u: any = req.user;
  const f = (u?.userfName ?? "").toString().trim();
  const l = (u?.userlName ?? "").toString().trim();
  return `${f} ${l}`.trim() || u?.userEmail || "system";
}

export async function getInvoices(req: Request, res: Response) {
  try {
    const role = (req.user as any)?.role as string | undefined;
    if (role && !BACK_OFFICE_ROLES.has(role)) {
      return res.status(403).send({ success: false, message: "Forbidden" });
    }

    const q = String(req.query.q ?? "").trim();
    const type = String(req.query.type ?? "").trim();
    const paymentStatus = String(req.query.paymentStatus ?? "").trim();

    const query: any = {};
    if (type) query.invoice_type = type;
    if (paymentStatus) query.payment_status = paymentStatus;

    if (q) {
      const phoneDigits = q.replace(/[^\d]/g, "");
      query.$or = [
        { invoice_id: { $regex: q, $options: "i" } },
        { customer_name: { $regex: q, $options: "i" } },
        ...(phoneDigits ? [{ customer_phone: Number(phoneDigits) }] : []),
      ];
    }

    const invoices = await Invoice.find(query)
      .sort({ createdAt: -1 })
      .limit(100)
      .exec();

    return res.status(200).send({ success: true, data: invoices });
  } catch (err: any) {
    return res.status(500).send({ success: false, message: err.message });
  }
}

export async function getInvoice(req: Request, res: Response) {
  try {
    const role = (req.user as any)?.role as string | undefined;
    if (role && !BACK_OFFICE_ROLES.has(role)) {
      return res.status(403).send({ success: false, message: "Forbidden" });
    }

    const { invoiceId } = req.params;
    const invoice = await Invoice.findOne({ invoice_id: invoiceId }).exec();
    if (!invoice) return res.status(404).send({ success: false, message: "Invoice not found" });
    return res.status(200).send({ success: true, data: invoice });
  } catch (err: any) {
    return res.status(500).send({ success: false, message: err.message });
  }
}

export async function updateInvoice(req: Request, res: Response) {
  try {
    const role = (req.user as any)?.role as string | undefined;
    if (role && !BACK_OFFICE_ROLES.has(role)) {
      return res.status(403).send({ success: false, message: "Forbidden" });
    }

    const { invoiceId } = req.params;
    const patch = req.body ?? {};

    const invoice = await Invoice.findOne({ invoice_id: invoiceId }).exec();
    if (!invoice) return res.status(404).send({ success: false, message: "Invoice not found" });

    // Editable fields for MVP
    if (typeof patch.therapist_name === "string") invoice.therapist_name = patch.therapist_name;
    if (patch.session_number !== undefined) invoice.session_number = patch.session_number;
    if (patch.package_type !== undefined) invoice.package_type = patch.package_type;
    if (patch.package_ref !== undefined) invoice.package_ref = patch.package_ref;
    if (typeof patch.package_name === "string") invoice.package_name = patch.package_name;

    if (patch.payment_status && ["paid", "pending"].includes(patch.payment_status)) {
      invoice.payment_status = patch.payment_status;
    }

    if (Array.isArray(patch.line_items)) {
      invoice.line_items = patch.line_items
        .filter((li: any) => li && typeof li.description === "string" && Number.isFinite(li.price))
        .map((li: any) => ({ description: li.description.trim(), price: Number(li.price) }));
    }

    // Recompute totals from line items; preserve advance_paid.
    const itemsSubtotal = invoice.line_items.reduce((sum: number, li: any) => sum + (li.price ?? 0), 0);
    invoice.items_subtotal = itemsSubtotal;
    invoice.total = itemsSubtotal;
    invoice.balance_due = invoice.total - (invoice.advance_paid ?? 0);

    // Invalidate PDF after edits.
    invoice.pdf_url = null;
    invoice.last_edited_by = actorName(req);
    invoice.last_edited_at = new Date();

    await invoice.save();
    return res.status(200).send({ success: true, message: "Invoice updated", data: invoice });
  } catch (err: any) {
    return res.status(500).send({ success: false, message: err.message });
  }
}

export async function createInvoice(req: Request, res: Response) {
  try {
    const role = (req.user as any)?.role as string | undefined;
    if (role && !BACK_OFFICE_ROLES.has(role)) {
      return res.status(403).send({ success: false, message: "Forbidden" });
    }

    const body = req.body ?? {};
    const invoice = await createManualInvoice({
      invoice_type: body.invoice_type,
      customer_id: body.customer_id,
      customer_name: body.customer_name,
      customer_phone: body.customer_phone,
      appointment_id: body.appointment_id,
      enquiry_id: body.enquiry_id,
      therapist_name: body.therapist_name,
      line_items: body.line_items,
      advance_paid: body.advance_paid,
      payment_status: body.payment_status,
      package_type: body.package_type,
      package_ref: body.package_ref,
      package_name: body.package_name,
      session_number: body.session_number,
      created_by: actorName(req),
    });

    return res.status(201).send({
      success: true,
      message: "Invoice created",
      data: invoice,
    });
  } catch (err: any) {
    return res.status(400).send({ success: false, message: err.message });
  }
}

export async function generateInvoicePdf(req: Request, res: Response) {
  try {
    const role = (req.user as any)?.role as string | undefined;
    if (role && !BACK_OFFICE_ROLES.has(role)) {
      return res.status(403).send({ success: false, message: "Forbidden" });
    }

    const { invoiceId } = req.params;
    const regenerate = req.query.regenerate === "true";
    const invoice = await Invoice.findOne({ invoice_id: invoiceId }).exec();
    if (!invoice) return res.status(404).send({ success: false, message: "Invoice not found" });

    if (invoice.pdf_url && !regenerate) {
      return res.status(200).send({
        success: true,
        message: "Invoice PDF already generated",
        data: { pdf_url: invoice.pdf_url },
      });
    }

    const pdf_url = await ensureInvoicePdfGeneratedAndUploaded(invoice);
    invoice.pdf_url = pdf_url;
    await invoice.save();

    return res.status(200).send({ success: true, message: "Invoice PDF generated", data: { pdf_url } });
  } catch (err: any) {
    logger.error(`generateInvoicePdf failed for ${req.params.invoiceId}`, err);
    return res.status(500).send({ success: false, message: err.message });
  }
}

// Utility endpoint (internal/testing): generate invoice if appointment completed.
export async function ensureInvoiceForAppointment(req: Request, res: Response) {
  try {
    const role = (req.user as any)?.role as string | undefined;
    if (role && !BACK_OFFICE_ROLES.has(role)) {
      return res.status(403).send({ success: false, message: "Forbidden" });
    }

    const { appointmentId } = req.body ?? {};
    if (!appointmentId) return res.status(400).send({ success: false, message: "appointmentId required" });

    const actor = { name: actorName(req), email: (req.user as any)?.userEmail };
    const inv = await createInvoiceIfMissingForAppointment({ appointmentId, actor });
    return res.status(200).send({ success: true, data: inv });
  } catch (err: any) {
    return res.status(500).send({ success: false, message: err.message });
  }
}

