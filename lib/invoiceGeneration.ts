import { Types } from "mongoose";
import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import Customer from "../models/customerModel.ts";
import Invoice from "../models/invoiceModel.ts";
import Service from "../models/serviceModel.ts";
import { nextSequence, nextYearlySequence } from "./counters.ts";

type Actor = {
  name?: string;
  email?: string;
};

type InvoiceType =
  | "package_purchase"
  | "therapy_session"
  | "therapy_addon_standalone"
  | "online_consultation"
  | "vitals_subscription";

type CustomerDoc = InstanceType<typeof Customer>;
type InvoiceDoc = InstanceType<typeof Invoice>;

function pad4(n: number): string {
  return String(n).padStart(4, "0");
}

function formatCustomerId(seq: number): string {
  return `CUST-${pad4(seq)}`;
}

function formatInvoiceId(year: number, seq: number): string {
  return `INV-${year}-${pad4(seq)}`;
}

function safeNumber(n: unknown): number {
  if (typeof n === "number" && Number.isFinite(n)) return n;
  if (typeof n === "string" && n.trim() !== "") {
    const x = Number(n);
    if (Number.isFinite(x)) return x;
  }
  return 0;
}

export async function ensureCustomerForAppointment(
  appointment: any,
): Promise<CustomerDoc> {
  const phone = safeNumber(appointment.phonenumber);
  const name = (appointment.name ?? "").toString();
  const email = (appointment.email ?? "").toString();
  const address = (appointment.location ?? "").toString(); // location used as address context in MVP

  // Prefer stable identity by phone.
  const existing = await Customer.findOne({ phone }).exec();
  if (existing) return existing;

  const seq = await nextSequence("customer");
  const customer_id = formatCustomerId(seq);

  const created = new Customer({
    customer_id,
    name: name || "Unknown customer",
    phone,
    email,
    address,
  });
  await created.save();
  return created;
}

function hasConsultationSlotBooked(appointment: any): boolean {
  if (appointment.consultationSlot?.date && appointment.consultationSlot?.time) {
    return true;
  }
  if (appointment.typeOfappointment === "consultation") {
    const slotDate = appointment.slot?.date;
    const slotTime = appointment.slot?.time;
    if (slotDate && slotTime) return true;
    if (slotDate) return true;
  }
  return false;
}

/** When to auto-create an invoice for this appointment (idempotent). */
export function shouldAutoGenerateInvoice(appointment: any): boolean {
  if (appointment.status === "completed") return true;

  if (!hasConsultationSlotBooked(appointment)) return false;

  // Standalone "Book Consultation" flow
  if (appointment.typeOfappointment === "consultation") return true;

  // Enquiry funnel: online consult booked before physio is scheduled
  if (!appointment.physioSlot?.date) return true;

  return false;
}

function deriveInvoiceType(
  appointment: any,
  service?: any,
): InvoiceType {
  // Completed visit → therapy billing (not consult fee)
  if (appointment.status === "completed") {
    if (appointment.appointmentKind === "recommended") {
      return "therapy_addon_standalone";
    }
    if (service?.isPackage) return "package_purchase";
    return "therapy_session";
  }

  // Online consultation booked / consultation-only
  if (
    appointment.typeOfappointment === "consultation" ||
    appointment.consultationCompleted ||
    (hasConsultationSlotBooked(appointment) && !appointment.physioSlot?.date)
  ) {
    return "online_consultation";
  }

  if (appointment.appointmentKind === "recommended") {
    return "therapy_addon_standalone";
  }

  if (service?.isPackage) return "package_purchase";
  return "therapy_session";
}

export async function maybeCreateInvoiceForAppointment(args: {
  appointment: any;
  actor?: Actor;
}): Promise<InvoiceDoc | null> {
  const { appointment, actor } = args;
  if (!appointment?._id) return null;
  if (!shouldAutoGenerateInvoice(appointment)) return null;

  const existing = await Invoice.findOne({ appointment_id: appointment._id }).exec();
  if (existing) return existing;

  return createInvoiceFromAppointment({ appointment, actor });
}

async function createInvoiceFromAppointment(args: {
  appointment: any;
  actor?: Actor;
}): Promise<InvoiceDoc | null> {
  const { appointment, actor } = args;

  // Idempotency guard: one invoice per appointment_id.
  const existing = await Invoice.findOne({ appointment_id: appointment._id }).exec();
  if (existing) return existing;

  // Year comes from completion timestamp if available.
  const completedAt = appointment.completedAt ? new Date(appointment.completedAt) : new Date();
  const year = completedAt.getFullYear();

  const seq = await nextYearlySequence("invoice", year);
  const invoice_id = formatInvoiceId(year, seq);

  const customer = await ensureCustomerForAppointment(appointment);

  const service = appointment.packageServiceId
    ? await Service.findOne({ serviceId: appointment.packageServiceId }).exec()
    : appointment.service
      ? await Service.findOne({ name: appointment.service }).exec()
      : null;

  const invoice_type = deriveInvoiceType(appointment, service);

  const therapist_name = appointment.doctor ?? "";

  const unitPrice =
    (appointment.quotedPrice ?? null) != null
      ? safeNumber(appointment.quotedPrice)
      : (appointment.paymentAmount ?? null) != null
        ? safeNumber(appointment.paymentAmount)
        : service?.price != null
          ? safeNumber(service.price)
          : invoice_type === "online_consultation"
            ? 500
            : 0;

  const lineItemDescription =
    (appointment.service ?? "")?.toString() ||
    service?.name ||
    (invoice_type === "online_consultation" ? "Online Consultation" : "Therapy");

  const line_items: { description: string; price: number }[] = [
    { description: lineItemDescription, price: unitPrice },
  ];

  for (const rec of appointment.recommendedServices ?? []) {
    if (!rec?.serviceName) continue;
    if (rec.status && rec.status !== "confirmed") continue;
    line_items.push({
      description: `Add-on: ${rec.serviceName}`,
      price: safeNumber(rec.quotedPrice),
    });
  }

  const items_subtotal = line_items.reduce((sum, li) => sum + safeNumber(li.price), 0);
  const total = items_subtotal;

  const advance_paid = appointment.paymentReceived ? safeNumber(appointment.paymentAmount) : 0;
  const balance_due = total - advance_paid;

  const payment_status: "paid" | "pending" =
    advance_paid > 0 && balance_due <= 0 ? "paid" : "pending";

  const package_type = service?.isPackage ? "standard" : null;
  const package_ref = service?.isPackage ? service.serviceId : null;
  const package_name = service?.isPackage ? service.name : "";

  const enquiry_id = appointment.enquiryId ?? "";

  const createdBy =
    (actor?.name ?? "").trim() ||
    (actor?.email ?? "").trim() ||
    "system";

  try {
    const created = await Invoice.create({
      invoice_id,
      invoice_type,
      appointment_id: appointment._id,
      enquiry_id,
      customer_id: customer.customer_id,
      customer_name: customer.name,
      customer_phone: customer.phone,
      package_type,
      package_ref,
      package_name,
      session_number: null,
      therapist_name,
      line_items,
      items_subtotal,
      advance_paid,
      balance_due,
      total,
      payment_status,
      pdf_url: null,
      created_by: createdBy,
      last_edited_by: null,
      last_edited_at: null,
    });

    return created;
  } catch (err: any) {
    // If the unique constraint on appointment_id races, fall back to fetch.
    if (err?.code === 11000) {
      const dupe = await Invoice.findOne({ appointment_id: appointment._id }).exec();
      return dupe;
    }
    throw err;
  }
}

export async function createInvoiceIfMissingForAppointment(args: {
  appointmentId: string;
  actor?: Actor;
}): Promise<InvoiceDoc | null> {
  const { appointmentId, actor } = args;
  if (!Types.ObjectId.isValid(appointmentId)) return null;

  const appointment = await AppointmentBooking.findById(appointmentId).exec();
  if (!appointment) return null;

  return maybeCreateInvoiceForAppointment({ appointment, actor });
}

export type ManualInvoiceInput = {
  invoice_type: InvoiceType;
  customer_id?: string;
  customer_name?: string;
  customer_phone?: number;
  appointment_id?: string;
  enquiry_id?: string;
  therapist_name?: string;
  line_items: { description: string; price: number }[];
  advance_paid?: number;
  payment_status?: "paid" | "pending";
  package_type?: string | null;
  package_ref?: string | null;
  package_name?: string;
  session_number?: string | null;
  created_by?: string;
};

export async function createManualInvoice(
  input: ManualInvoiceInput,
): Promise<InvoiceDoc> {
  let customer_id = input.customer_id ?? "";
  let customer_name = (input.customer_name ?? "").trim();
  let customer_phone = input.customer_phone ?? 0;

  if (customer_id) {
    const customer = await Customer.findOne({ customer_id }).exec();
    if (!customer) throw new Error("Customer not found");
    customer_name = customer.name;
    customer_phone = customer.phone;
  } else {
    if (!customer_name || customer_name.length < 2) {
      throw new Error("Customer name is required (min 2 chars).");
    }
    if (!customer_phone || typeof customer_phone !== "number") {
      throw new Error("Customer phone is required.");
    }
    const customer = await ensureCustomerForAppointment({
      name: customer_name,
      phonenumber: customer_phone,
      email: "",
      location: "",
    });
    customer_id = customer.customer_id;
    customer_name = customer.name;
    customer_phone = customer.phone;
  }

  if (input.appointment_id) {
    if (!Types.ObjectId.isValid(input.appointment_id)) {
      throw new Error("Invalid appointment_id");
    }
    const dupe = await Invoice.findOne({
      appointment_id: input.appointment_id,
    }).exec();
    if (dupe) throw new Error("An invoice already exists for this appointment.");
  }

  const line_items = (input.line_items ?? [])
    .filter((li) => li && typeof li.description === "string")
    .map((li) => ({
      description: li.description.trim() || "Item",
      price: Number(li.price) || 0,
    }));

  if (line_items.length === 0) {
    throw new Error("At least one line item is required.");
  }

  const items_subtotal = line_items.reduce((s, li) => s + li.price, 0);
  const total = items_subtotal;
  const advance_paid = Number(input.advance_paid) || 0;
  const balance_due = total - advance_paid;
  const payment_status: "paid" | "pending" =
    input.payment_status ??
    (advance_paid > 0 && balance_due <= 0 ? "paid" : "pending");

  const year = new Date().getFullYear();
  const seq = await nextYearlySequence("invoice", year);
  const invoice_id = formatInvoiceId(year, seq);

  const created = await Invoice.create({
    invoice_id,
    invoice_type: input.invoice_type,
    appointment_id: input.appointment_id ?? null,
    enquiry_id: input.enquiry_id ?? "",
    customer_id,
    customer_name,
    customer_phone,
    package_type: input.package_type ?? null,
    package_ref: input.package_ref ?? null,
    package_name: input.package_name ?? "",
    session_number: input.session_number ?? null,
    therapist_name: input.therapist_name ?? "",
    line_items,
    items_subtotal,
    advance_paid,
    balance_due,
    total,
    payment_status,
    pdf_url: null,
    created_by: input.created_by ?? "manual",
    last_edited_by: null,
    last_edited_at: null,
  });

  return created;
}

