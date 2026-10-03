// Indian mobile numbers, normalised to the bare 10 digits everything else
// stores (Customer.phone, AppointmentBooking.phonenumber). Exact lengths only:
// a lenient "last 10 digits" would turn a typo'd 13-digit input into someone
// else's number.
export function parseIndianMobile(input: unknown): string | null {
  if (typeof input !== "string" && typeof input !== "number") return null;
  const digits = String(input).replace(/\D/g, "");
  let phone10: string | null = null;
  if (digits.length === 10) phone10 = digits;
  else if (digits.length === 11 && digits.startsWith("0")) phone10 = digits.slice(1);
  else if (digits.length === 12 && digits.startsWith("91")) phone10 = digits.slice(2);
  return phone10 && /^[6-9]\d{9}$/.test(phone10) ? phone10 : null;
}

export const toE164 = (phone10: string): string => "+91" + phone10;

export const fromE164 = (e164: string): string => e164.replace(/^\+91/, "");

/** For logs: the last 4 digits only, enough to tell numbers apart. */
export const maskPhone = (phone: string): string => `******${phone.slice(-4)}`;
