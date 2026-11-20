import AppointmentBooking from "../models/appointmentsBookingModel.ts";

/** Drops empty plain objects (not inside arrays), as Mongoose's toObject() does. */
function minimize(o: any): any {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (Array.isArray(v)) {
      for (const x of v) if (x?.constructor === Object) minimize(x);
    } else if (v?.constructor === Object) {
      minimize(v);
      if (!Object.keys(v).length) delete o[k];
    }
  }
  return o;
}

/**
 * A booking read with .lean(), shaped exactly like doc.toObject(): schema
 * defaults filled in (older records lack newer fields) and empty objects
 * dropped. Building a Mongoose document per row cost about 8x the CPU, and the
 * free backend has very little (ISSUES #66). Parity guard: listRows.test.ts.
 */
export const asListRow = (raw: any) => minimize(AppointmentBooking.applyDefaults(raw));
