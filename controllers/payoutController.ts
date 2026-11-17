import type { Request, Response } from "express";
import { Doctor } from "../models/doctorsModel.ts";
import { TherapistSettlement } from "../models/therapistSettlementModel.ts";
import { payoutBalances } from "../lib/payouts.ts";
import { ownDoctorId } from "../lib/payments.ts";
import { canManageSplit } from "../lib/therapistSplit.ts";

/**
 * GET /api/payouts: each therapist's balance with the clinic (earned, cash in
 * hand, paid, remaining). Admin / Super Admin see everyone; a therapist only
 * themself; other roles nothing.
 */
export async function getPayoutBalances(req: Request, res: Response) {
  try {
    const role = req.user?.role;
    if (canManageSplit(role)) return res.status(200).send({ success: true, data: await payoutBalances() });
    if (role === "THERAPIST") {
      const own = await ownDoctorId(req.user as any);
      return res.status(200).send({ success: true, data: own ? await payoutBalances(own) : [] });
    }
    return res.status(403).send({ success: false, message: "Only admins and therapists can see payouts." });
  } catch (error: any) {
    console.error("[getPayoutBalances]", error);
    return res.status(500).send({ success: false, message: "Server error" });
  }
}

/**
 * POST /api/payouts/settlements { doctorId, amount, direction, note }: money
 * that changed hands with a therapist. "paid": the clinic paid them; "received":
 * they handed cash back. Admin / Super Admin only (the route checks the role).
 */
export async function addSettlement(req: Request, res: Response) {
  try {
    const { doctorId, amount, direction, note } = req.body ?? {};
    const value = Math.round(Number(amount));
    if (!Number.isFinite(value) || value < 1) {
      return res.status(400).send({ success: false, message: "Enter an amount of at least ₹1." });
    }
    if (direction !== "paid" && direction !== "received") {
      return res.status(400).send({ success: false, message: "Say whether the clinic paid the therapist or received cash back." });
    }
    if (typeof doctorId !== "string" || !(await Doctor.exists({ doctorId }))) {
      return res.status(404).send({ success: false, message: "Therapist not found." });
    }
    const u: any = req.user;
    const by = u?.userfName ? `${u.userfName ?? ""} ${u.userlName ?? ""}`.trim() : (u?.userEmail ?? "");
    const saved = await TherapistSettlement.create({
      doctorId,
      amount: value,
      direction,
      note: typeof note === "string" ? note.trim().slice(0, 200) : "",
      by,
    });
    return res.status(201).send({ success: true, message: "Settlement recorded", data: saved });
  } catch (error: any) {
    console.error("[addSettlement]", error);
    return res.status(500).send({ success: false, message: "Server error" });
  }
}
