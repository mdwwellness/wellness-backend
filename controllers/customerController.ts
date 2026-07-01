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
        .select("customer_id name phone email address createdAt updatedAt")
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
      .select("customer_id name phone email address createdAt updatedAt")
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

    const existing = await Customer.findOne({ phone }).exec();
    if (existing) {
      // Update name/address if changed; keep customer_id stable.
      if (email || address) {
        existing.name = name.trim();
        existing.email = email ?? existing.email;
        existing.address = address ?? existing.address;
        await existing.save();
      } else if (existing.name !== name.trim()) {
        existing.name = name.trim();
        await existing.save();
      }

      return res.status(200).send({
        success: true,
        message: "Customer already exists — updated.",
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

    await customer.save();
    return res.status(200).send({ success: true, message: "Customer updated", data: customer });
  } catch (err: any) {
    return res.status(500).send({ success: false, message: err.message });
  }
}

