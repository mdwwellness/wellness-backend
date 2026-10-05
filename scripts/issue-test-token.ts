/**
 * Issue a customer token for ONE test account without SMS, so an outside
 * developer can try the signed-in /api/customer-app endpoints before phone
 * sign-in is switched on. Run it yourself: it needs the target server's secret
 * and database, which never belong in the repo or a chat.
 *
 *   DATABASE_URL="<db uri>" CUSTOMER_JWT_SECRET="<that server's secret>" \
 *     npx tsx scripts/issue-test-token.ts <phone> "<name>" [hours]
 *
 * Creates (or reuses) the account for that phone, tags it "wellness", links
 * its clinic customer record, and prints a token valid for [hours] (default
 * 48, max 168). Whoever holds the token sees that account's profile and every
 * booking on that phone, and can book for real, so use a dedicated test number.
 * Revoke early: set the account's status to "blocked"; its tokens stop at once.
 *
 * Deliberately does not read .env: the database and secret must be passed in.
 */
import mongoose from "mongoose";
import { maskPhone, parseIndianMobile } from "../lib/phone.ts";
import { loginWellnessAccount, validPersonName } from "../lib/customerAccount.ts";
import { linkCustomerForAccount } from "../lib/customerProfile.ts";
import { signCustomerToken } from "../lib/customerToken.ts";
import { customerJwtSecret } from "../lib/env.ts";

const USAGE =
  'Usage: DATABASE_URL="..." CUSTOMER_JWT_SECRET="..." npx tsx scripts/issue-test-token.ts <phone> "<name>" [hours 1-168]';

const [phoneArg, nameArg, hoursArg = "48"] = process.argv.slice(2);
const phone = parseIndianMobile(phoneArg);
const name = validPersonName(nameArg);
const hours = Number(hoursArg);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!phone || !name || !Number.isInteger(hours) || hours < 1 || hours > 168) fail(USAGE);
if (!process.env.DATABASE_URL) fail("DATABASE_URL is not set. " + USAGE);
if (!customerJwtSecret()) {
  fail("CUSTOMER_JWT_SECRET is missing, shorter than 32 characters, or equal to JWT_SECRET.");
}

await mongoose.connect(process.env.DATABASE_URL);
console.log(`Database: ${mongoose.connection.host} / accounts in ${process.env.IDENTITY_DB || "mdw"}`);

const { account, created } = await loginWellnessAccount(phone, { name });
const customer = await linkCustomerForAccount(account);
const token = signCustomerToken(String(account._id), hours * 3600);
const expires = new Date(Date.now() + hours * 3_600_000).toISOString().replace("T", " ").slice(0, 16);

console.log(`Account: ${String(account._id)} (${created ? "created" : "existing"}), phone ${maskPhone(phone)}, name "${account.name ?? name}"`);
console.log(`Clinic record: ${customer?.customer_id ?? "not linked"}`);
console.log(`Expires: ${expires} UTC (${hours} h)`);
console.log(`\nToken (send it privately; use it as "Authorization: Bearer <token>"):\n\n${token}\n`);

await mongoose.disconnect();
