// What MDW Wellness sells through the public site, the Customers' App and the
// dashboard's New enquiry form. A lead's `service` is one of these when it came
// in through any of them. KEEP IN SYNC with the dashboard's OFFERINGS
// (src/components/pages/enquiries/booking.ts).
export const OFFERINGS = ["Online Consultation", "Home Therapy", "Vitals Check"] as const;

/** How an offering is delivered: a video call, or at home. Undefined for anything else. */
export function bookingTypeOf(service: unknown): "consultation" | "appointment" | undefined {
  if (!(OFFERINGS as readonly unknown[]).includes(service)) return undefined;
  return service === "Online Consultation" ? "consultation" : "appointment";
}
