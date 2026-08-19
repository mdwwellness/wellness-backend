import type { Request, Response } from "express";
import Customer from "../models/customerModel.ts";
import { nextSequence } from "../lib/counters.ts";

function pad4(n: number): string {
  return String(n).padStart(4, "0");
}

function formatCustomerId(seq: number): string {
  return `CUST-${pad4(seq)}`;
}

function parseSearchToPhone(q: string): number | null {
  const digits = q.replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  return n;
}

export async function getCustomers(req: Request, res: Response) {
  try {
    const q = String(req.query.q ?? "").trim();
    if (!q) {
      const customers = await Customer.find()
        .sort({ createdAt: -1 })
        .limit(500)
        .select("customer_id name phone email address notes createdAt updatedAt")
        .exec();
      return res.status(200).send({ success: true, data: customers });
    }

    const phone = parseSearchToPhone(q);
    const query: any = phone
      ? { phone }
      : {
          $or: [
            { name: { $regex: q, $options: "i" } },
            { customer_id: { $regex: q, $options: "i" } },
          ],
        };

    const customers = await Customer.find(query)
      .limit(50)
      .select("customer_id name phone email address notes createdAt updatedAt")
      .exec();
    return res.status(200).send({ success: true, data: customers });
  } catch (err: any) {
    return res.status(500).send({ success: false, message: err.message });
  }
}

export async function createCustomer(req: Request, res: Response) {
  try {
    const { name, phone, email, address } = req.body ?? {};

    if (!name || typeof name !== "string" || name.trim().length < 2) {
      return res.status(400).send({
        success: false,
        message: "Customer name is required (min 2 chars).",
      });
    }
    if (!phone || typeof phone !== "number") {
      return res.status(400).send({
        success: false,
        message: "Customer phone is required and must be a number.",
      });
    }

    // Identity is phone + person: a different name on the same (household) number
    // is a different customer, so only an exact phone+name match is a duplicate.
    const target = name.trim().toLowerCase();
    const onThisPhone = await Customer.find({ phone }).exec();
    const existing = onThisPhone.find(
      (c) => (c.name ?? "").toString().trim().toLowerCase() === target,
    );
    if (existing) {
      // Same number AND same name already exists. Don't silently overwrite their
      // stored name/email/address on a "create" (a typo'd re-entry would clobber
      // good data). Return the existing record flagged as a duplicate; edits go
      // through updateCustomer explicitly.
      return res.status(200).send({
        success: true,
        duplicate: true,
        message: `A customer named ${existing.name} with this phone already exists (${existing.customer_id}).`,
        data: existing,
      });
    }

    const seq = await nextSequence("customer");
    const customer_id = formatCustomerId(seq);

    const created = await Customer.create({
      customer_id,
      name: name.trim(),
      phone,
      email: email ?? "",
      address: address ?? "",
    });

    return res.status(201).send({
      success: true,
      message: "Customer created.",
      data: created,
    });
  } catch (err: any) {
    return res.status(500).send({ success: false, message: err.message });
  }
}

export async function getCustomerById(req: Request, res: Response) {
  try {
    const { customerId } = req.params;
    const customer = await Customer.findOne({ customer_id: customerId }).exec();
    if (!customer) {
      return res.status(404).send({ success: false, message: "Customer not found" });
    }
    return res.status(200).send({ success: true, data: customer });
  } catch (err: any) {
    return res.status(500).send({ success: false, message: err.message });
  }
}

export async function updateCustomer(req: Request, res: Response) {
  try {
    const { customerId } = req.params;
    const patch = req.body ?? {};

    const customer = await Customer.findOne({ customer_id: customerId }).exec();
    if (!customer) {
      return res.status(404).send({ success: false, message: "Customer not found" });
    }

    if (patch.name && typeof patch.name === "string" && patch.name.trim().length >= 2) {
      customer.name = patch.name.trim();
    }
    if (patch.email && typeof patch.email === "string") customer.email = patch.email;
    if (patch.address && typeof patch.address === "string") customer.address = patch.address;

    // Handle notes operations
    if (patch.notes) {
      if (!Array.isArray(customer.notes)) customer.notes = [];

      // Add a new note
      if (patch.notes.add && typeof patch.notes.add === "object") {
        const { at, by, userId, note } = patch.notes.add;
        if (at && by && note) {
          customer.notes.push({ at, by, userId: userId ?? "", note });
        }
      }

      // Edit an existing note (match by at timestamp + by field)
      if (patch.notes.edit && typeof patch.notes.edit === "object") {
        const { at, by, note } = patch.notes.edit;
        if (at && by && note) {
          const idx = customer.notes.findIndex(
            (n) => n.at === at && n.by === by
          );
          if (idx !== -1) {
            customer.notes[idx].note = note;
          }
        }
      }
    }

    await customer.save();
    return res.status(200).send({ success: true, message: "Customer updated", data: customer });
  } catch (err: any) {
    return res.status(500).send({ success: false, message: err.message });
  }
}

