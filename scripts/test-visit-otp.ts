// Run: npx tsx scripts/test-visit-otp.ts
// Asserts the hash/verify primitive the visit-OTP endpoints rely on.
import assert from "node:assert";
import bcrypt from "bcryptjs";

const code = "1234";
const hash = await bcrypt.hash(code, 10);
assert.ok(await bcrypt.compare("1234", hash), "correct code verifies");
assert.ok(!(await bcrypt.compare("9999", hash)), "wrong code rejected");
console.log("PASS: visit OTP hash/verify");
