import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { renderInvoicePdf, type InvoiceView } from "./invoicePdf.ts";

const fontkit = createRequire(import.meta.url)("fontkit");
const font = (w: string) => fontkit.openSync(fileURLToPath(new URL(`../assets/fonts/Inter-${w}.ttf`, import.meta.url)));

const view: InvoiceView = {
  invoiceId: "INV-2026-0099",
  bookingId: "ENQ-0177",
  date: "12 Nov 2026",
  time: "11:30",
  billedBy: "Staff",
  customer: { name: "Asha Verma", id: "CUST-0001", phone: "9876500001" },
  gst: "",
  meeting: { date: "12 Nov 2026", time: "11:30", link: "https://meet.google.com/abc-defg-hij" },
  rows: [{ service: "Online Consultation", when: "12 Nov 2026, 11:30", pay: "due", unit: 600, qty: 1 }],
  totals: { mrp: 600, discount: 0, payable: 600, paid: 0, due: 600 },
};

describe("invoice PDF", () => {
  it("the slimmed fonts keep the rupee sign and tabular figures", () => {
    for (const w of ["Regular", "SemiBold"]) {
      const f = font(w);
      expect(f.hasGlyphForCodePoint(0x20b9)).toBe(true);
      expect(f.availableFeatures).toContain("tnum");
    }
  });

  // The full Inter font took ~1.4 s per invoice; the slimmed copies ~50 ms.
  it("draws an invoice quickly", async () => {
    await renderInvoicePdf(view); // first run loads the modules
    const t = performance.now();
    const pdf = await renderInvoicePdf(view);
    expect(performance.now() - t).toBeLessThan(500);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  });
});
