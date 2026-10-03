/**
 * End-to-end test for the Customers' App API (/api/customer-app) against a
 * throwaway Docker MongoDB. It never connects to the database in .env.
 *
 *   cd C:\workspace\WellnessBackend && node scripts/e2e-customer-app.ts
 *
 * Starts mongo:7 as "wellness-e2e-mongo" on 127.0.0.1:27099, runs the real
 * backend (node server.ts) on port 10099 with test secrets and the demo OTP,
 * checks every flow over HTTP, then removes the container. Exits 1 on any
 * failure. If .env has UPLOADTHING_TOKEN, three 1x1 PNGs are uploaded through
 * the backend (one alone, two as a photo replacement) and all are deleted
 * again before the run ends. The backend is restarted twice: without
 * CUSTOMER_JWT_SECRET, and with TRUST_PROXY=1.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import { MongoClient, ObjectId } from "mongodb";

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER = "wellness-e2e-mongo";
const MONGO = "mongodb://127.0.0.1:27099";
const PORT = 10099;
const BASE = `http://127.0.0.1:${PORT}`;
const APP = "/api/customer-app";

const DEMO = "9000000001";
const DEMO_E164 = "+919000000001";
const DEMO_OTP = "246813";
const APP_ORIGIN = "https://app.example.test";
const JWT_SECRET = "e2e-staff-access-secret-not-for-prod";
const JWT_REFRESH_SECRET = "e2e-staff-refresh-secret-not-for-prod";
const CUSTOMER_SECRET = "e2e-customer-secret-0123456789abcdefghijklmnopqr";

// What GET /bookings may return per row (lib/customerBookings.ts CustomerBooking).
const BOOKING_KEYS = [
  "enquiryId", "patientName", "service", "typeOfappointment", "bookingKind", "status", "slot",
  "therapistName", "sessionsCompleted", "totalSessions", "preferredReachOutTime", "amountDue",
  "paymentReceived", "payToken", "createdAt",
];
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_SIG = PNG_1X1.subarray(0, 8);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

// ── Safety ───────────────────────────────────────────────────────────────────
class SafetyAbort extends Error {}
const LOCAL_MONGO = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/\w*)?$/;
// The URL itself is never printed: if it is the wrong one it may hold credentials.
function assertLocal(url: string | undefined, what: string) {
  if (!url || !LOCAL_MONGO.test(url)) {
    throw new SafetyAbort(`${what} is not a localhost MongoDB URL; refusing to continue.`);
  }
}

// ── Plumbing ─────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Res = { status: number; body: any; headers: http.IncomingHttpHeaders };
type ReqOpts = {
  json?: unknown;
  raw?: Buffer;
  type?: string;
  token?: string;
  headers?: Record<string, string>;
};

function request(method: string, p: string, o: ReqOpts = {}): Promise<Res> {
  const headers: Record<string, string | number> = { ...o.headers };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  let payload: Buffer | undefined;
  if (o.json !== undefined) {
    payload = Buffer.from(JSON.stringify(o.json));
    headers["content-type"] = "application/json";
  }
  if (o.raw) {
    payload = o.raw;
    headers["content-type"] = o.type ?? "application/octet-stream";
  }
  if (payload) headers["content-length"] = payload.length;
  return new Promise((resolve, reject) => {
    const req = http.request(BASE + p, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: any = text;
        try {
          body = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
      });
    });
    // A server that answers early (413) may reset the socket mid-upload; once
    // the response is in, that error is noise (reject after resolve is a no-op).
    req.on("error", reject);
    req.end(payload);
  });
}

const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)}`.slice(0, 700);

function expect(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const results: { name: string; passed: boolean; detail: string }[] = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const detail = (await fn()) || "ok";
    results.push({ name, passed: true, detail });
    console.log(`PASS  ${name}${detail === "ok" ? "" : `  (${detail})`}`);
  } catch (err) {
    if (err instanceof SafetyAbort) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, detail });
    console.log(`FAIL  ${name}\n      ${detail}`);
  }
}
const pass = (name: string, detail: string) => {
  results.push({ name, passed: true, detail });
  console.log(`PASS  ${name}`);
};

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

// ── Backend child process ────────────────────────────────────────────────────
const envFile = dotenv.parse(readFileSync(path.join(BACKEND, ".env")));
// Only this one key is copied from .env, never DATABASE_URL.
const UT_TOKEN = envFile.UPLOADTHING_TOKEN || "";

function backendEnv(overrides: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PORT: String(PORT),
    DATABASE_URL: MONGO,
    IDENTITY_DB: "mdw",
    JWT_SECRET,
    JWT_REFRESH_SECRET,
    CUSTOMER_JWT_SECRET: CUSTOMER_SECRET,
    MSG91_DEMO_PHONE: DEMO,
    MSG91_DEMO_OTP: DEMO_OTP,
    // "" rather than absent: dotenv never overwrites a key that exists, so an
    // empty value keeps .env (or a future line in it) from switching real SMS on.
    MSG91_AUTH_TOKEN: "",
    MSG91_TEMPLATE_ID: "",
    CUSTOMER_APP_URL: APP_ORIGIN,
    UPLOADTHING_TOKEN: UT_TOKEN,
    LOG_DB: "",
    ...overrides,
  };
  assertLocal(env.DATABASE_URL, "Backend DATABASE_URL");
  return env;
}

type Backend = { child: ChildProcess; log: string[] };
const running = new Set<ChildProcess>();

async function startBackend(env: Record<string, string | undefined>): Promise<Backend> {
  if (await portOpen(PORT)) {
    throw new SafetyAbort(`Port ${PORT} is already in use; refusing to test an unknown server.`);
  }
  const child = spawn(process.execPath, ["server.ts"], {
    cwd: BACKEND,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.add(child);
  child.on("exit", () => running.delete(child));
  const log: string[] = [];
  const collect = (d: Buffer) => log.push(...d.toString().split(/\r?\n/).filter(Boolean));
  child.stdout!.on("data", collect);
  child.stderr!.on("data", collect);

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Backend exited early:\n${log.slice(-20).join("\n")}`);
    const all = log.join("\n");
    const host = all.match(/MongoDB connected: (\S+)/)?.[1];
    if (host && all.includes(`Backend listening on port ${PORT}`)) {
      // Checked before any request that could write.
      if (host !== "127.0.0.1" && host !== "localhost") {
        throw new SafetyAbort(`Backend reports "MongoDB connected: ${host}", not localhost. Aborting.`);
      }
      const root = await request("GET", "/").catch(() => null);
      if (root?.status === 200) return { child, log };
    }
    await sleep(250);
  }
  throw new Error(`Backend did not come up in 60s:\n${log.slice(-20).join("\n")}`);
}

async function stopBackend(b: Backend | null) {
  if (!b) return;
  if (b.child.exitCode === null) {
    b.child.kill();
    await Promise.race([once(b.child, "exit"), sleep(5000)]);
  }
  for (let i = 0; i < 20 && (await portOpen(PORT)); i++) await sleep(250);
}

// ── Docker MongoDB ───────────────────────────────────────────────────────────
function removeContainer() {
  try {
    execFileSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  } catch {}
}

async function startMongo(mongo: MongoClient) {
  removeContainer();
  execFileSync("docker", ["run", "-d", "--rm", "--name", CONTAINER, "-p", "27099:27017", "mongo:7"], {
    stdio: "ignore",
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await mongo.connect();
      await mongo.db("admin").command({ ping: 1 });
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error("MongoDB container did not accept connections within 60s.");
}

// ── UploadThing cleanup ──────────────────────────────────────────────────────
const utKeys = new Set<string>();
async function deleteUploadThingFile(key: string) {
  const { UTApi } = await import("uploadthing/server");
  const result = await new UTApi({ token: UT_TOKEN }).deleteFiles(key);
  if (result.success && result.deletedCount === 1) utKeys.delete(key);
  return result;
}

// ── Helpers on the test data ─────────────────────────────────────────────────
const mint = (sub: string) =>
  jwt.sign({ sub, typ: "customer" }, CUSTOMER_SECRET, { algorithm: "HS256", expiresIn: 600 });

function expectedAge(dob: string): number {
  // India is UTC+05:30 with no DST.
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const years = Number(today.slice(0, 4)) - Number(dob.slice(0, 4));
  return today.slice(5) < dob.slice(5) ? years - 1 : years;
}

const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

// ── The run ──────────────────────────────────────────────────────────────────
async function main(mongo: MongoClient) {
  const users = mongo.db("mdw").collection("users");
  const customers = mongo.db("test").collection("customers");
  const bookings = mongo.db("test").collection("appointmentbookings");
  const VERIFY = `${APP}/auth/verify`;
  const OTP = `${APP}/auth/otp`;

  // 1. Safety before anything starts.
  assertLocal(MONGO, "Harness MONGO");
  expect(CUSTOMER_SECRET.length === 48, "test CUSTOMER_JWT_SECRET must be 48 chars");
  const serverSrc = readFileSync(path.join(BACKEND, "server.ts"), "utf8");
  const backfillSrc = readFileSync(path.join(BACKEND, "scripts", "backfill-account-products.ts"), "utf8");
  for (const [file, src] of [["server.ts", serverSrc], ["scripts/backfill-account-products.ts", backfillSrc]]) {
    if (/override/i.test(src)) throw new SafetyAbort(`${file} mentions "override"; dotenv could replace DATABASE_URL.`);
    if (!/dotenv\.config\(\{\s*path:/.test(src)) throw new SafetyAbort(`${file}: unexpected dotenv call shape.`);
  }
  // Same dotenv call the backend and the backfill make, pointed at a scratch
  // object holding the local URL: the production URL in .env must not win.
  const probe: Record<string, string> = { DATABASE_URL: MONGO };
  dotenv.config({ path: path.join(BACKEND, ".env"), processEnv: probe, quiet: true });
  if (probe.DATABASE_URL !== MONGO) throw new SafetyAbort("dotenv replaced a preset DATABASE_URL; aborting.");
  pass(
    "Safety: .env cannot replace a preset DATABASE_URL (server.ts + backfill)",
    "no `override` in server.ts or the backfill script; dotenv.config with the real .env kept the preset local URL",
  );

  await startMongo(mongo);
  pass("Safety: throwaway MongoDB container up", `${CONTAINER} on 127.0.0.1:27099`);

  let backend: Backend | null = await startBackend(backendEnv());
  pass("Safety: backend log shows MongoDB connected: 127.0.0.1", "checked before any write request");

  // ── Concurrency ────────────────────────────────────────────────────────────
  await check("Concurrency: 5 parallel /auth/verify for a new phone -> one account, products [wellness]", async () => {
    expect((await users.countDocuments({ phoneE164: DEMO_E164 })) === 0, "demo account exists before the test");
    const otp = await request("POST", OTP, { json: { phone: DEMO } });
    expect(otp.status === 200, `/auth/otp: ${show(otp)}`);
    const rs = await Promise.all(
      Array.from({ length: 5 }, () =>
        request("POST", VERIFY, { json: { phone: DEMO, otp: DEMO_OTP, name: "Race Tester" } }),
      ),
    );
    const unclean = rs.filter(
      (r) =>
        !(r.status === 200 && typeof r.body?.data?.token === "string") &&
        !(r.status >= 400 && r.status < 500 && r.body?.success === false),
    );
    expect(!unclean.length, `responses that neither succeeded nor failed cleanly: ${unclean.map(show).join(" | ")}`);
    const docs = await users.find({ phoneE164: DEMO_E164 }).toArray();
    expect(docs.length === 1, `expected 1 mdw.users document, found ${docs.length}`);
    expect(JSON.stringify(docs[0].products) === '["wellness"]', `products = ${JSON.stringify(docs[0].products)}`);
    const ok = rs.filter((r) => r.status === 200);
    const subs = new Set(ok.map((r) => (jwt.decode(r.body.data.token) as any)?.sub));
    expect(subs.size === 1 && subs.has(String(docs[0]._id)), `tokens name ${[...subs]}, account is ${docs[0]._id}`);
    const created = ok.filter((r) => r.body.data.isNewAccount === true).length;
    expect(ok.length < 5 ? created <= 1 : created === 1, `isNewAccount true on ${created} of ${ok.length}`);
    return `statuses ${rs.map((r) => r.status).join(",")}; isNewAccount true on ${created}`;
  });

  await check("Concurrency: the same parallel logins (with a name) leave exactly one Customer for phone + name", async () => {
    const list = await customers
      .find({ phone: Number(DEMO) }, { projection: { _id: 0, customer_id: 1, name: 1, accountId: 1 } })
      .toArray();
    const named = list.filter((c) => c.name === "Race Tester");
    expect(named.length === 1, `found ${named.length} "Race Tester" Customer records: ${JSON.stringify(list)}`);
    expect(list.length === 1, `found ${list.length} Customer records for the phone: ${JSON.stringify(list)}`);
    const account = await users.findOne({ phoneE164: DEMO_E164 });
    expect(named[0].accountId === String(account?._id), `accountId ${named[0].accountId} != account ${account?._id}`);
    return JSON.stringify(named[0]);
  });

  // Fresh start for the happy path, so the login really is a new account.
  await users.deleteMany({ phoneE164: DEMO_E164 });
  await customers.deleteMany({ phone: Number(DEMO) });

  // ── Happy path ─────────────────────────────────────────────────────────────
  await check("Input: /auth/verify with name \"A\" -> 400, no token, no account", async () => {
    const r = await request("POST", VERIFY, { json: { phone: DEMO, otp: DEMO_OTP, name: "A" } });
    expect(r.status === 400 && r.body?.message === "Enter your name (2-80 characters)." && !r.body?.data?.token, show(r));
    const n = await users.countDocuments({ phoneE164: DEMO_E164 });
    expect(n === 0, `accounts for phone after the 400: ${n}`);
  });

  let ashaToken = "";
  let ashaId = "";
  await check("Happy path: /auth/otp 200, /auth/verify with name -> 200, token, isNewAccount, profile", async () => {
    const otp = await request("POST", OTP, { json: { phone: DEMO } });
    expect(otp.status === 200, `/auth/otp: ${show(otp)}`);
    const v = await request("POST", VERIFY, { json: { phone: DEMO, otp: DEMO_OTP, name: "Asha Verma" } });
    expect(v.status === 200, `/auth/verify: ${show(v)}`);
    const d = v.body.data;
    expect(typeof d?.token === "string", `no token: ${show(v)}`);
    expect(d.isNewAccount === true, `isNewAccount = ${d.isNewAccount}`);
    expect(d.expiresIn === 7 * 24 * 3600, `expiresIn = ${d.expiresIn}`);
    expect(d.profile?.name === "Asha Verma" && d.profile?.phone === DEMO, `profile: ${JSON.stringify(d.profile)}`);
    expect(/^CUST-\d{4}$/.test(d.profile.customerId ?? ""), `profile.customerId = ${d.profile.customerId}`);
    const docs = await users.find({ phoneE164: DEMO_E164 }).toArray();
    expect(docs.length === 1, `accounts for phone: ${docs.length}`);
    const a = docs[0];
    expect(
      JSON.stringify(a.products) === '["wellness"]' && a.name === "Asha Verma" && a.status === "active" &&
        JSON.stringify(a.roles) === '["customer"]',
      `account doc: ${JSON.stringify(a)}`,
    );
    ashaToken = d.token;
    ashaId = String(a._id);
    return `account ${ashaId}, ${d.profile.customerId}`;
  });

  await check("Happy path: GET /me 200 with name", async () => {
    const r = await request("GET", `${APP}/me`, { token: ashaToken });
    expect(r.status === 200 && r.body.data?.name === "Asha Verma", show(r));
    expect(r.body.data.accountId === ashaId, `accountId = ${r.body.data.accountId}`);
  });

  const PROFILE = {
    gender: "female",
    dob: "1990-04-12",
    address: "12 Lake Road, Flat 3B",
    city: "Kolkata",
    pincode: "700091",
    emergencyContact: { name: "Ravi Verma", phone: "9876543210", relation: "Brother" },
    email: "Asha@Example.test",
  };
  await check("Happy path: PATCH /me persists gender/dob/address/city/pincode/emergencyContact/email", async () => {
    const r = await request("PATCH", `${APP}/me`, { token: ashaToken, json: PROFILE });
    expect(r.status === 200, show(r));
    const list = await customers.find({ phone: Number(DEMO) }).toArray();
    expect(list.length === 1, `Customer records for phone: ${list.length}`);
    const c = list[0];
    const got = {
      accountId: c.accountId,
      customer_id: c.customer_id,
      gender: c.gender,
      dob: c.dob instanceof Date ? c.dob.toISOString().slice(0, 10) : c.dob,
      address: c.address,
      city: c.city,
      pincode: c.pincode,
      emergencyContact: c.emergencyContact,
      email: c.email,
    };
    const want = {
      accountId: ashaId,
      customer_id: got.customer_id,
      gender: "female",
      dob: "1990-04-12",
      address: PROFILE.address,
      city: "Kolkata",
      pincode: "700091",
      emergencyContact: { name: "Ravi Verma", phone: 9876543210, relation: "Brother" },
      email: "asha@example.test",
    };
    expect(/^CUST-\d{4}$/.test(c.customer_id ?? ""), `customer_id = ${c.customer_id}`);
    expect(JSON.stringify(got) === JSON.stringify(want), `customers doc ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
    const a = await users.findOne({ _id: new ObjectId(ashaId) });
    expect(a?.email === "asha@example.test", `account email = ${a?.email}`);
    expect(r.body.data?.city === "Kolkata" && r.body.data?.gender === "female", `response profile: ${show(r)}`);
    return `${c.customer_id} linked to ${ashaId}`;
  });

  await check("Happy path: age computed from dob", async () => {
    const r = await request("GET", `${APP}/me`, { token: ashaToken });
    const want = expectedAge("1990-04-12");
    expect(r.status === 200 && r.body.data?.dob === "1990-04-12" && r.body.data?.age === want, `want age ${want}: ${show(r)}`);
    return `age ${r.body.data.age}`;
  });

  await check("Happy path: PATCH name changes the account name, Customer.name unchanged", async () => {
    const r = await request("PATCH", `${APP}/me`, { token: ashaToken, json: { name: "Asha V Sharma" } });
    expect(r.status === 200 && r.body.data?.name === "Asha V Sharma", show(r));
    const a = await users.findOne({ _id: new ObjectId(ashaId) });
    const c = await customers.findOne({ accountId: ashaId });
    expect(a?.name === "Asha V Sharma", `account name = ${a?.name}`);
    expect(c?.name === "Asha Verma", `Customer.name = ${c?.name}`);
  });

  // ── Same person, two systems ───────────────────────────────────────────────
  await users.deleteMany({ phoneE164: DEMO_E164 });
  await customers.deleteMany({ phone: Number(DEMO) });
  const seeded = new Date("2026-01-01T00:00:00Z");
  const meeraId = (
    await users.insertOne({
      phoneE164: DEMO_E164,
      roles: ["customer"],
      status: "active",
      name: "Meera Iyer",
      createdAt: seeded,
      updatedAt: seeded,
    })
  ).insertedId;
  await customers.insertOne({
    customer_id: "CUST-0900",
    name: "Meera Iyer",
    phone: Number(DEMO),
    email: "",
    address: "",
    notes: [],
    createdAt: seeded,
    updatedAt: seeded,
  });
  let meeraToken = "";
  await check("Two systems: patient-site account + dashboard Customer -> one account, tagged, linked, name kept", async () => {
    const otp = await request("POST", OTP, { json: { phone: DEMO } });
    expect(otp.status === 200, `/auth/otp: ${show(otp)}`);
    const v = await request("POST", VERIFY, { json: { phone: DEMO, otp: DEMO_OTP, name: "Someone Else" } });
    expect(v.status === 200, `/auth/verify: ${show(v)}`);
    expect(v.body.data.isNewAccount === false, `isNewAccount = ${v.body.data.isNewAccount}`);
    expect(v.body.data.profile?.customerId === "CUST-0900", `profile: ${JSON.stringify(v.body.data.profile)}`);
    const docs = await users.find({ phoneE164: DEMO_E164 }).toArray();
    expect(docs.length === 1, `accounts for phone: ${docs.length}`);
    expect(String(docs[0]._id) === String(meeraId), `account id changed: ${docs[0]._id}`);
    expect(JSON.stringify(docs[0].products) === '["wellness"]', `products = ${JSON.stringify(docs[0].products)}`);
    expect(docs[0].name === "Meera Iyer", `name overwritten: ${docs[0].name}`);
    const cs = await customers.find({ phone: Number(DEMO) }).toArray();
    expect(cs.length === 1, `Customer records for phone: ${cs.length} (${cs.map((c) => c.customer_id)})`);
    expect(cs[0].customer_id === "CUST-0900" && cs[0].accountId === String(meeraId), `customer: ${JSON.stringify(cs[0])}`);
    meeraToken = v.body.data.token;
    return "1 account, CUST-0900 linked, no new CUST";
  });

  // ── Bookings ───────────────────────────────────────────────────────────────
  let enquiryId = "";
  const BOOK = { service: "Home Therapy", note: "Lower back pain", preferredReachOutTime: { from: "10:00", to: "12:00" } };
  await check("Bookings: POST /bookings -> 201 with enquiryId, stored from the account", async () => {
    const r = await request("POST", `${APP}/bookings`, { token: meeraToken, json: BOOK });
    expect(r.status === 201 && /^ENQ-\d{4}$/.test(r.body.data?.enquiryId ?? "") && r.body.data.folded === false, show(r));
    enquiryId = r.body.data.enquiryId;
    const doc = await bookings.findOne({ enquiryId });
    const got = doc && {
      phonenumber: doc.phonenumber,
      name: doc.name,
      service: doc.service,
      status: doc.status,
      source: doc.source,
      typeOfappointment: doc.typeOfappointment,
      note: doc.note,
      preferredReachOutTime: { from: doc.preferredReachOutTime?.from, to: doc.preferredReachOutTime?.to },
      customer_id: doc.customer_id,
    };
    const want = {
      phonenumber: Number(DEMO),
      name: "Meera Iyer",
      service: "Home Therapy",
      status: "enquiry",
      source: "online",
      typeOfappointment: "appointment",
      note: "Lower back pain",
      preferredReachOutTime: { from: "10:00", to: "12:00" },
      customer_id: "CUST-0900",
    };
    expect(JSON.stringify(got) === JSON.stringify(want), `stored ${JSON.stringify(got)}`);
    return enquiryId;
  });

  await check("Bookings: repeat POST -> 200 folded true, no second row", async () => {
    const r = await request("POST", `${APP}/bookings`, { token: meeraToken, json: BOOK });
    expect(r.status === 200 && r.body.data?.folded === true && r.body.data?.enquiryId === enquiryId, show(r));
    const n = await bookings.countDocuments({ phonenumber: Number(DEMO) });
    expect(n === 1, `bookings on the phone: ${n}`);
  });

  await check("Bookings: then a different service (Vitals Check) -> 201 new enquiry, not folded", async () => {
    const r = await request("POST", `${APP}/bookings`, { token: meeraToken, json: { service: "Vitals Check" } });
    const id = r.body?.data?.enquiryId;
    expect(r.status === 201 && r.body.data.folded === false && id && id !== enquiryId, show(r));
    const doc = await bookings.findOne({ enquiryId: id });
    expect(doc?.service === "Vitals Check" && doc?.status === "enquiry", `stored ${JSON.stringify(doc)}`);
    const first = await bookings.findOne({ enquiryId });
    expect(first?.repeatCount === 2, `Home Therapy repeatCount = ${first?.repeatCount}`);
    return `${id}; ${enquiryId} keeps repeatCount 2`;
  });

  await check("Bookings: GET /bookings returns it with allow-listed keys only", async () => {
    const r = await request("GET", `${APP}/bookings`, { token: meeraToken });
    expect(r.status === 200 && Array.isArray(r.body.data), show(r));
    const row = r.body.data.find((b: any) => b.enquiryId === enquiryId);
    expect(row, `booking ${enquiryId} missing: ${show(r)}`);
    const extra = r.body.data.flatMap((b: any) => Object.keys(b).filter((k) => !BOOKING_KEYS.includes(k)));
    expect(!extra.length, `non allow-listed keys: ${[...new Set(extra)]}`);
    const text = JSON.stringify(r.body.data);
    for (const leak of ["Lower back pain", '"location"', '"note"', '"email"', '"phonenumber"', '"activityLog"', '"_id"', '"customer_id"']) {
      expect(!text.includes(leak), `response leaks ${leak}`);
    }
    return `keys: ${Object.keys(row).join(",")}`;
  });

  const now = new Date();
  await bookings.insertMany([
    {
      enquiryId: "ENQ-9901",
      name: "Other Person",
      phonenumber: 9123456780,
      status: "enquiry",
      note: "someone else's note",
      createdAt: now,
    },
    {
      enquiryId: "ENQ-9902",
      name: "Meera Iyer",
      phonenumber: Number(DEMO),
      status: "scheduled",
      bookingKind: "course",
      totalSessions: 4,
      packageOriginId: String(new ObjectId()),
      quotedPrice: 500,
      paymentReceived: false,
      createdAt: now,
    },
    {
      enquiryId: "ENQ-9903",
      name: "Meera Iyer",
      phonenumber: Number(DEMO),
      status: "completed",
      quotedPrice: 800,
      paymentReceived: false,
      createdAt: now,
    },
    // Staff scheduled the visit (physioSlot) on a booking that never had a slot.
    {
      enquiryId: "ENQ-9904",
      name: "Meera Iyer",
      phonenumber: Number(DEMO),
      status: "ongoing",
      bookingKind: "course",
      service: "Online Consultation",
      typeOfappointment: "consultation",
      doctor: "Dr. Reddy",
      doctorId: "DOC-E2E",
      physioSlot: { date: "2026-11-05", time: "11:30" },
      totalSessions: 3,
      quotedPrice: 1500,
      paymentReceived: true,
      createdAt: now,
    },
    {
      enquiryId: "ENQ-9905",
      name: "Meera Iyer",
      phonenumber: Number(DEMO),
      status: "cancelled",
      quotedPrice: 900,
      paymentReceived: false,
      payToken: "e2e0cancelled0pay0token000000000",
      createdAt: now,
    },
    {
      enquiryId: "ENQ-9906",
      name: "Meera Iyer",
      phonenumber: Number(DEMO),
      status: "scheduled",
      bookingKind: "course",
      totalSessions: 4,
      packageOriginId: String(new ObjectId()),
      quotedPrice: 500,
      paymentReceived: false,
      recommendedServices: [
        { serviceId: "svc-e2e-1", serviceName: "Hot pack", quotedPrice: 350, status: "confirmed", recommendedAt: now.toISOString(), paymentCollected: false },
        { serviceId: "svc-e2e-2", serviceName: "Taping", quotedPrice: 200, status: "pending", recommendedAt: now.toISOString() },
        { serviceId: "svc-e2e-3", serviceName: "Ultrasound", quotedPrice: 150, status: "confirmed", recommendedAt: now.toISOString(), paymentCollected: true },
      ],
      createdAt: now,
    },
  ]);
  const myBookings = async () => {
    const r = await request("GET", `${APP}/bookings`, { token: meeraToken });
    expect(r.status === 200 && Array.isArray(r.body.data), show(r));
    return r.body.data as any[];
  };

  await check("Bookings: another phone's booking is not returned", async () => {
    const r = await request("GET", `${APP}/bookings`, { token: meeraToken });
    expect(r.status === 200, show(r));
    const ids = r.body.data.map((b: any) => b.enquiryId);
    expect(!ids.includes("ENQ-9901") && !JSON.stringify(r.body.data).includes("Other Person"), `returned ${ids}`);
    return `returned ${ids.join(",")}`;
  });

  // docs/api.md: follow-up rows count only their own confirmed add-ons, so
  // none at all is 0 (not null; null is for cancelled rows).
  await check("Bookings: course follow-up row without add-ons -> amountDue null (nothing payable; its per-session share is not due)", async () => {
    const data = await myBookings();
    const follow = data.find((b) => b.enquiryId === "ENQ-9902");
    const priced = data.find((b) => b.enquiryId === "ENQ-9903");
    expect(follow && follow.amountDue === null, `follow-up row: ${JSON.stringify(follow)}`);
    expect(priced && priced.amountDue === 800 && priced.paymentReceived === false, `control priced row: ${JSON.stringify(priced)}`);
    return "follow-up null, unpaid control row 800";
  });

  await check("Bookings: course follow-up row with a confirmed unpaid add-on -> amountDue = that add-on's price", async () => {
    const row = (await myBookings()).find((b) => b.enquiryId === "ENQ-9906");
    // 350 confirmed + unpaid; 200 pending and 150 paid must not count, nor the 500 session share.
    expect(row && row.amountDue === 350 && row.paymentReceived === false, `row: ${JSON.stringify(row)}`);
    return "amountDue 350";
  });

  await check("Bookings: physioSlot-only ongoing booking shows slot date/time and therapistName", async () => {
    const row = (await myBookings()).find((b) => b.enquiryId === "ENQ-9904");
    const want = { status: "ongoing", slot: { date: "2026-11-05", time: "11:30" }, therapistName: "Dr. Reddy" };
    const got = row && { status: row.status, slot: row.slot, therapistName: row.therapistName };
    expect(JSON.stringify(got) === JSON.stringify(want), `row: ${JSON.stringify(row)}`);
    expect(!JSON.stringify(row).includes("DOC-E2E"), "doctorId leaked");
    return JSON.stringify(got);
  });

  await check("Bookings: cancelled unpaid booking -> amountDue null, payToken null", async () => {
    const row = (await myBookings()).find((b) => b.enquiryId === "ENQ-9905");
    expect(row && row.status === "cancelled" && row.amountDue === null && row.payToken === null, `row: ${JSON.stringify(row)}`);
    return `paymentReceived ${row.paymentReceived}`;
  });

  await check("Bookings: an ongoing course row (same name + service) does not swallow a new request -> 201", async () => {
    const r = await request("POST", `${APP}/bookings`, { token: meeraToken, json: { service: "Online Consultation" } });
    const id = r.body?.data?.enquiryId;
    expect(r.status === 201 && r.body.data.folded === false && id && id !== "ENQ-9904", show(r));
    const course = await bookings.findOne({ enquiryId: "ENQ-9904" });
    expect(!course?.repeatCount && !course?.activityLog?.length, `ENQ-9904 was touched: ${JSON.stringify(course)}`);
    const doc = await bookings.findOne({ enquiryId: id });
    expect(doc?.typeOfappointment === "consultation" && doc?.status === "enquiry", `stored ${JSON.stringify(doc)}`);
    return `new ${id}`;
  });

  // ── Mass assignment ────────────────────────────────────────────────────────
  await check("Mass assignment: PATCH /me with phone/roles/status/products/accountId/customer_id -> 400, nothing changed", async () => {
    const snapshot = async () =>
      JSON.stringify([await users.findOne({ _id: meeraId }), await customers.findOne({ customer_id: "CUST-0900" })]);
    const before = await snapshot();
    const attempts: object[] = [
      { phone: "9123456789" },
      { roles: ["admin"] },
      { status: "blocked" },
      { products: ["pharmacy"] },
      { accountId: String(new ObjectId()) },
      { customer_id: "CUST-9999" },
    ];
    const bad: string[] = [];
    // Bare, and alongside a valid field: a rejected request must not half-apply.
    for (const a of [...attempts, ...attempts.map((a) => ({ city: "Hacked City", ...a }))]) {
      const r = await request("PATCH", `${APP}/me`, { token: meeraToken, json: a });
      if (r.status !== 400) bad.push(`${JSON.stringify(a)} -> ${show(r)}`);
    }
    expect(!bad.length, bad.join(" | "));
    expect((await snapshot()) === before, "account or customer changed after rejected PATCHes");
    return "12 attempts, all 400";
  });

  await check("Mass assignment: POST /bookings with quotedPrice/paymentReceived/doctorId/status/discountAmount -> 400, no booking", async () => {
    const before = await bookings.countDocuments({});
    const bad: string[] = [];
    for (const extra of [
      { quotedPrice: 1 },
      { paymentReceived: true },
      { doctorId: String(new ObjectId()) },
      { status: "completed" },
      { discountAmount: 100 },
    ]) {
      const r = await request("POST", `${APP}/bookings`, { token: meeraToken, json: { service: "Vitals Check", ...extra } });
      if (r.status !== 400) bad.push(`${JSON.stringify(extra)} -> ${show(r)}`);
    }
    expect(!bad.length, bad.join(" | "));
    const after = await bookings.countDocuments({});
    expect(after === before, `bookings ${before} -> ${after}`);
  });

  // ── Auth rejections ────────────────────────────────────────────────────────
  await check("Auth: no token -> 401", async () => {
    const r = await request("GET", `${APP}/me`);
    expect(r.status === 401, show(r));
  });

  await check("Auth: tampered tokens (swapped payload, alg none, edited signature) -> 401", async () => {
    const [h, , s] = meeraToken.split(".");
    const otherSub = String(new ObjectId());
    const exp = Math.floor(Date.now() / 1000) + 600;
    const variants = {
      swappedPayload: `${h}.${b64url({ sub: otherSub, typ: "customer", exp })}.${s}`,
      algNone: `${b64url({ alg: "none", typ: "JWT" })}.${b64url({ sub: String(meeraId), typ: "customer", exp })}.`,
      editedSignature: `${meeraToken.slice(0, -4)}${meeraToken.slice(-4) === "AAAA" ? "BBBB" : "AAAA"}`,
    };
    const bad: string[] = [];
    for (const [name, token] of Object.entries(variants)) {
      const r = await request("GET", `${APP}/me`, { token });
      if (r.status !== 401 || r.body?.code === "TOKEN_EXPIRED") bad.push(`${name}: ${show(r)}`);
    }
    expect(!bad.length, bad.join(" | "));
  });

  await check("Auth: expired token -> 401 code TOKEN_EXPIRED", async () => {
    const t = Math.floor(Date.now() / 1000);
    const token = jwt.sign({ sub: String(meeraId), typ: "customer", iat: t - 7200, exp: t - 60 }, CUSTOMER_SECRET, {
      algorithm: "HS256",
    });
    const r = await request("GET", `${APP}/me`, { token });
    expect(r.status === 401 && r.body?.code === "TOKEN_EXPIRED", show(r));
  });

  await check("Auth: staff-style token (JWT_SECRET, {id}) on /me -> 401", async () => {
    const token = jwt.sign({ id: String(meeraId) }, JWT_SECRET, { expiresIn: 600 });
    const r = await request("GET", `${APP}/me`, { token });
    expect(r.status === 401, show(r));
  });

  await check("Auth: customer token on staff GET /api/customers -> 401", async () => {
    const r = await request("GET", "/api/customers", { token: meeraToken });
    expect(r.status === 401, show(r));
  });

  await check("Auth: account with products [pharmacy] only -> 403", async () => {
    const id = (
      await users.insertOne({
        phoneE164: "+919111111111",
        roles: ["customer"],
        status: "active",
        products: ["pharmacy"],
        name: "Pharma Only",
        createdAt: seeded,
        updatedAt: seeded,
      })
    ).insertedId;
    const r = await request("GET", `${APP}/me`, { token: mint(String(id)) });
    expect(r.status === 403, show(r));
  });

  await check("Auth: blocked account -> /me 403 and /auth/verify 403 with no write", async () => {
    await users.updateOne({ _id: meeraId }, { $set: { status: "blocked" } });
    try {
      const before = JSON.stringify([await users.findOne({ _id: meeraId }), await customers.find({ phone: Number(DEMO) }).toArray()]);
      const me = await request("GET", `${APP}/me`, { token: meeraToken });
      expect(me.status === 403, `/me: ${show(me)}`);
      const v = await request("POST", VERIFY, { json: { phone: DEMO, otp: DEMO_OTP, name: "Blocked Person" } });
      expect(v.status === 403 && !v.body?.data?.token, `/auth/verify: ${show(v)}`);
      const after = JSON.stringify([await users.findOne({ _id: meeraId }), await customers.find({ phone: Number(DEMO) }).toArray()]);
      expect(after === before, "account or customer changed (updatedAt or other fields)");
    } finally {
      await users.updateOne({ _id: meeraId }, { $set: { status: "active" } });
    }
  });

  // ── Input and limits ───────────────────────────────────────────────────────
  await check("Input: /auth/otp with a bad phone -> 400", async () => {
    const bad: string[] = [];
    for (const phone of ["12345", "5123456789", "919000000001234", "", null]) {
      const r = await request("POST", OTP, { json: { phone } });
      if (r.status !== 400) bad.push(`${JSON.stringify(phone)} -> ${show(r)}`);
    }
    expect(!bad.length, bad.join(" | "));
  });

  await check("Input: /auth/verify with a wrong OTP -> 400", async () => {
    const r = await request("POST", VERIFY, { json: { phone: DEMO, otp: "111111" } });
    expect(r.status === 400 && !r.body?.data?.token, show(r));
  });

  await check("Limits: OTP sends for a non-demo phone -> 503 (MSG91 not configured) x5, then 429", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await request("POST", OTP, { json: { phone: "9876500001" } })).status);
    expect(JSON.stringify(statuses) === "[503,503,503,503,503,429]", `statuses ${statuses}`);
    return `statuses ${statuses}`;
  });

  await check("Limits: email already used by another account -> 409", async () => {
    const mine = await request("PATCH", `${APP}/me`, { token: meeraToken, json: { email: "meera@example.test" } });
    expect(mine.status === 200, `first account sets email: ${show(mine)}`);
    const otherId = (
      await users.insertOne({
        phoneE164: "+919222222222",
        roles: ["customer"],
        status: "active",
        products: ["wellness"],
        name: "Second User",
        createdAt: seeded,
        updatedAt: seeded,
      })
    ).insertedId;
    const r = await request("PATCH", `${APP}/me`, { token: mint(String(otherId)), json: { email: "Meera@Example.test" } });
    expect(r.status === 409, show(r));
    const other = await users.findOne({ _id: otherId });
    expect(other && !("email" in other), `second account email = ${other?.email}`);
  });

  // Own account and token so the 20/hour budget used up here can't 429 any other check.
  const seedWellnessAccount = async (phoneE164: string, name: string) =>
    String(
      (
        await users.insertOne({
          phoneE164,
          roles: ["customer"],
          status: "active",
          products: ["wellness"],
          name,
          createdAt: seeded,
          updatedAt: seeded,
        })
      ).insertedId,
    );
  await check("Limits: PATCH /me 20 per account per hour, the 21st -> 429 and writes nothing", async () => {
    const id = await seedWellnessAccount("+919555555553", "Rate Tester");
    const token = mint(id);
    const statuses: number[] = [];
    for (let i = 1; i <= 20; i++) {
      statuses.push((await request("PATCH", `${APP}/me`, { token, json: { city: `City ${i}` } })).status);
    }
    expect(statuses.every((s) => s === 200), `first 20: ${statuses}`);
    const last = await request("PATCH", `${APP}/me`, { token, json: { city: "Too Many" } });
    expect(last.status === 429, `21st: ${show(last)}`);
    const c = await customers.findOne({ accountId: id });
    expect(c?.city === "City 20", `Customer.city = ${c?.city}`);
    const me = await request("GET", `${APP}/me`, { token });
    expect(me.status === 200, `GET /me after the limit: ${show(me)}`);
    return "20x 200, 21st 429, city stays City 20, GET /me still 200";
  });

  // ── Photo ──────────────────────────────────────────────────────────────────
  const PHOTO = `${APP}/me/photo`;
  await check("Photo: text/plain -> 415", async () => {
    const r = await request("PUT", PHOTO, { token: meeraToken, raw: Buffer.from("hello"), type: "text/plain" });
    expect(r.status === 415, show(r));
  });

  await check("Photo: empty image/png body -> 400", async () => {
    const r = await request("PUT", PHOTO, { token: meeraToken, raw: Buffer.alloc(0), type: "image/png" });
    expect(r.status === 400, show(r));
  });

  await check("Photo: JPEG bytes sent as image/png -> 400", async () => {
    const r = await request("PUT", PHOTO, { token: meeraToken, raw: JPEG_BYTES, type: "image/png" });
    expect(r.status === 400, show(r));
  });

  await check("Photo: body over 4 MB -> 413", async () => {
    const big = Buffer.alloc(4 * 1024 * 1024 + 1024);
    PNG_SIG.copy(big);
    const r = await request("PUT", PHOTO, { token: meeraToken, raw: big, type: "image/png" });
    expect(r.status === 413, show(r));
  });

  await check(
    UT_TOKEN ? "Photo: valid 1x1 PNG -> 200, stored, then deleted from UploadThing" : "Photo: valid 1x1 PNG without UPLOADTHING_TOKEN -> 503",
    async () => {
      const r = await request("PUT", PHOTO, { token: meeraToken, raw: PNG_1X1, type: "image/png" });
      if (!UT_TOKEN) {
        expect(r.status === 503, show(r));
        return "no token in .env";
      }
      const url = r.body?.data?.profilePhotoUrl;
      if (typeof url === "string") utKeys.add(new URL(url).pathname.split("/").pop()!);
      expect(r.status === 200 && typeof url === "string", show(r));
      const c = await customers.findOne({ customer_id: "CUST-0900" });
      expect(c?.profilePhotoUrl === url, `Customer.profilePhotoUrl = ${c?.profilePhotoUrl}`);
      const key = new URL(url).pathname.split("/").pop()!;
      const del = await deleteUploadThingFile(key);
      expect(del.success && del.deletedCount === 1, `deleteFiles(${key}) -> ${JSON.stringify(del)}`);
      const again = await deleteUploadThingFile(key).catch((e) => ({ error: String(e) }));
      return `uploaded and deleted ${key} (deletedCount 1; second delete -> ${JSON.stringify(again)})`;
    },
  );

  // The five requests above (415, 400, 400, 413, upload) used this account's
  // 5/hour budget; the limiter runs before express.raw reads the body.
  await check("Photo: 6th upload within the hour (a valid PNG) -> 429", async () => {
    const r = await request("PUT", PHOTO, { token: meeraToken, raw: PNG_1X1, type: "image/png" });
    const url = r.body?.data?.profilePhotoUrl;
    if (r.status === 200 && typeof url === "string") utKeys.add(new URL(url).pathname.split("/").pop()!);
    expect(r.status === 429 && r.body?.message === "Too many photo uploads. Please try again later.", show(r));
  });

  await check("Photo: a second upload replaces the first and deletes the first UploadThing file", async () => {
    if (!UT_TOKEN) return "skipped: no UPLOADTHING_TOKEN in .env";
    const token = mint(await seedWellnessAccount("+919555555552", "Photo Tester"));
    const keyOf = (u: string) => new URL(u).pathname.split("/").pop()!;
    const upload = async () => {
      const r = await request("PUT", PHOTO, { token, raw: PNG_1X1, type: "image/png" });
      const url = r.body?.data?.profilePhotoUrl;
      if (typeof url === "string") utKeys.add(keyOf(url));
      expect(r.status === 200 && typeof url === "string", show(r));
      return url as string;
    };
    const first = await upload();
    const second = await upload();
    expect(second !== first, "second upload returned the same URL");
    const c = await customers.findOne({ phone: 9555555552 });
    expect(c?.profilePhotoUrl === second, `Customer.profilePhotoUrl = ${c?.profilePhotoUrl}`);

    const status = (u: string) => fetch(u, { method: "GET", redirect: "follow" }).then((r) => r.status, () => 0);
    const live = await status(second);
    expect(live === 200, `control: GET of the current photo -> ${live}`);
    let gone = 200;
    for (let i = 0; i < 10 && gone === 200; i++) {
      gone = await status(first);
      if (gone === 200) await sleep(1500);
    }
    expect(gone !== 200, `GET of the replaced photo still 200 after 15s: ${first}`);
    // If this deletes a file, the backend had not: that is the failure.
    const again: any = await deleteUploadThingFile(keyOf(first)).catch((e) => ({ error: String(e) }));
    expect(again?.deletedCount !== 1, `the replaced file was still there for us to delete: ${JSON.stringify(again)}`);
    utKeys.delete(keyOf(first));

    const del = await deleteUploadThingFile(keyOf(second));
    expect(del.success && del.deletedCount === 1, `deleteFiles(current) -> ${JSON.stringify(del)}`);
    return `first ${keyOf(first)} GET -> ${gone} (our delete afterwards -> ${JSON.stringify(again)}); current GET 200, then deleted`;
  });

  // ── CORS ───────────────────────────────────────────────────────────────────
  await check("CORS: preflight from CUSTOMER_APP_URL -> 204 with access-control-allow-origin", async () => {
    const r = await request("OPTIONS", `${APP}/me`, {
      headers: {
        origin: APP_ORIGIN,
        "access-control-request-method": "PATCH",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(r.status === 204 && r.headers["access-control-allow-origin"] === APP_ORIGIN, `${r.status} ${JSON.stringify(r.headers)}`);
  });

  await check("CORS: preflight from https://evil.example -> 403 JSON Origin not allowed", async () => {
    const r = await request("OPTIONS", `${APP}/me`, {
      headers: { origin: "https://evil.example", "access-control-request-method": "GET" },
    });
    expect(
      r.status === 403 && r.body?.message === "Origin not allowed" && !r.headers["access-control-allow-origin"],
      `${show(r)} acao=${r.headers["access-control-allow-origin"]}`,
    );
  });

  // ── Public endpoints after the rate-limiter move ───────────────────────────
  // 4 posts here, under the public form's 5 per minute per IP.
  const PUBLIC_PHONE = 9333333333;
  const publicEnquiry = (service: string) =>
    request("POST", "/api/appointments/public", {
      json: {
        name: "Public Tester",
        phonenumber: PUBLIC_PHONE,
        service,
        typeOfappointment: service === "Online Consultation" ? "consultation" : "appointment",
        location: "Salt Lake, Kolkata",
      },
    });
  let publicId = "";
  await check("Public: POST /api/appointments/public valid body -> 201", async () => {
    const r = await publicEnquiry("Home Therapy");
    expect(r.status === 201 && r.body.data?.enquiryId, show(r));
    publicId = r.body.data.enquiryId;
    return publicId;
  });

  await check("Public: same name + service again -> 200 folded (repeatCount 2), no second row", async () => {
    const r = await publicEnquiry("Home Therapy");
    expect(r.status === 200 && r.body.data?.enquiryId === publicId && r.body.data?.repeatCount === 2, show(r));
    const n = await bookings.countDocuments({ phonenumber: PUBLIC_PHONE });
    expect(n === 1, `bookings on the phone: ${n}`);
  });

  await check("Public: then Vitals Check -> 201 new enquiry, not folded", async () => {
    const r = await publicEnquiry("Vitals Check");
    expect(r.status === 201 && r.body.data?.enquiryId && r.body.data.enquiryId !== publicId, show(r));
    const n = await bookings.countDocuments({ phonenumber: PUBLIC_PHONE });
    expect(n === 2, `bookings on the phone: ${n}`);
    return r.body.data.enquiryId;
  });

  await check("Public: an ongoing course row (same name + service) does not swallow a new request -> 201", async () => {
    await bookings.insertOne({
      enquiryId: "ENQ-9907",
      name: "Public Tester",
      phonenumber: PUBLIC_PHONE,
      status: "ongoing",
      bookingKind: "course",
      service: "Online Consultation",
      typeOfappointment: "consultation",
      doctor: "Dr. Reddy",
      totalSessions: 3,
      createdAt: new Date(),
    });
    const r = await publicEnquiry("Online Consultation");
    expect(r.status === 201 && r.body.data?.enquiryId && r.body.data.enquiryId !== "ENQ-9907", show(r));
    const course = await bookings.findOne({ enquiryId: "ENQ-9907" });
    expect(!course?.repeatCount && !course?.activityLog?.length, `ENQ-9907 was touched: ${JSON.stringify(course)}`);
    return `new ${r.body.data.enquiryId}`;
  });

  await check("Public: GET /api/appointments/pay/abc -> 404", async () => {
    const r = await request("GET", "/api/appointments/pay/abc");
    expect(r.status === 404, show(r));
  });

  // ── 503 gate without CUSTOMER_JWT_SECRET ───────────────────────────────────
  await stopBackend(backend);
  backend = null;
  // "" (not absent) so a CUSTOMER_JWT_SECRET line in .env could not fill it in.
  backend = await startBackend(backendEnv({ CUSTOMER_JWT_SECRET: "" }));
  await check("503 gate: no CUSTOMER_JWT_SECRET -> /me 503, /auth/otp 503, GET / 200", async () => {
    const me = await request("GET", `${APP}/me`, { token: meeraToken });
    const otp = await request("POST", OTP, { json: { phone: DEMO } });
    const root = await request("GET", "/");
    expect(me.status === 503 && otp.status === 503 && root.status === 200, `me ${show(me)} | otp ${show(otp)} | / ${show(root)}`);
  });
  await stopBackend(backend);
  backend = null;

  // ── TRUST_PROXY=1 ──────────────────────────────────────────────────────────
  // With one trusted hop, req.ip is the entry that hop appended (the last one),
  // so the harness plays the proxy: a client-chosen first entry, then the same
  // "real" address every time. A fresh process, so every limit starts at zero.
  backend = await startBackend(backendEnv({ TRUST_PROXY: "1" }));
  await check("Trust proxy: TRUST_PROXY=1 backend answers (GET / 200, GET /me 200)", async () => {
    const root = await request("GET", "/");
    const me = await request("GET", `${APP}/me`, { token: meeraToken });
    expect(root.status === 200 && me.status === 200 && me.body.data?.name === "Meera Iyer", `/ ${show(root)} | /me ${show(me)}`);
  });

  await check("Trust proxy: 21 OTP sends, 21 phones, a different spoofed first X-Forwarded-For each -> one per-IP bucket, 21st 429", async () => {
    const REAL = "198.51.100.7";
    const statuses: number[] = [];
    for (let i = 1; i <= 21; i++) {
      const phone = `98100000${String(i).padStart(2, "0")}`;
      const r = await request("POST", OTP, { json: { phone }, headers: { "x-forwarded-for": `10.0.0.${i}, ${REAL}` } });
      statuses.push(r.status);
    }
    // 503: MSG91 isn't configured for non-demo phones, but the send was still counted.
    expect(statuses.slice(0, 20).every((s) => s === 503) && statuses[20] === 429, `statuses ${statuses}`);
    // Control: another client behind the same proxy has its own bucket (so the 429 was per IP, not global).
    const other = await request("POST", OTP, {
      json: { phone: "9810000099" },
      headers: { "x-forwarded-for": `10.0.0.1, 198.51.100.8` },
    });
    expect(other.status === 503, `other client: ${show(other)}`);
    return `20x 503, then 429; other proxied client -> ${other.status}`;
  });
  await stopBackend(backend);
  backend = null;

  // ── Backfill script ────────────────────────────────────────────────────────
  const untagged = { roles: "customer", products: { $exists: false } };
  const backfillPhones = ["+919444444441", "+919444444442"];
  await users.insertMany(
    backfillPhones.map((phoneE164, i) => ({
      phoneE164,
      roles: ["customer"],
      status: "active",
      name: `Backfill ${i + 1}`,
      createdAt: seeded,
      updatedAt: seeded,
    })),
  );
  const runBackfill = (args: string[]) => {
    const env = { ...process.env, DATABASE_URL: MONGO, IDENTITY_DB: "mdw" };
    assertLocal(env.DATABASE_URL, "Backfill DATABASE_URL");
    const r = spawnSync(process.execPath, ["scripts/backfill-account-products.ts", ...args], {
      cwd: BACKEND,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };

  await check("Backfill: dry run reports 2 and writes nothing", async () => {
    expect((await users.countDocuments(untagged)) === 2, `untagged before: ${await users.countDocuments(untagged)}`);
    const r = runBackfill([]);
    expect(r.code === 0 && r.out.includes("DRY RUN"), `exit ${r.code}: ${r.out}`);
    expect(/without products -> \["wellness"\]: 2\b/.test(r.out), `output: ${r.out}`);
    expect((await users.countDocuments(untagged)) === 2, "dry run wrote products");
  });

  await check("Backfill: --apply tags both accounts [wellness]", async () => {
    const r = runBackfill(["--apply"]);
    expect(r.code === 0 && r.out.includes("APPLYING") && /Tagged: 2\b/.test(r.out), `exit ${r.code}: ${r.out}`);
    const docs = await users.find({ phoneE164: { $in: backfillPhones } }).toArray();
    expect(
      docs.length === 2 && docs.every((d) => JSON.stringify(d.products) === '["wellness"]'),
      `docs: ${JSON.stringify(docs.map((d) => d.products))}`,
    );
    expect((await users.countDocuments(untagged)) === 0, "untagged accounts remain");
  });
}

// ── Entry ────────────────────────────────────────────────────────────────────
const mongo = new MongoClient(MONGO, { serverSelectionTimeoutMS: 2000 });
let aborted = "";
process.once("SIGINT", () => {
  for (const c of running) c.kill();
  removeContainer();
  process.exit(130);
});

try {
  await main(mongo);
} catch (err) {
  aborted = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
  console.error(`\nABORTED: ${aborted}`);
} finally {
  for (const c of running) c.kill();
  for (const key of [...utKeys]) {
    await deleteUploadThingFile(key).catch((e) => console.error(`UploadThing cleanup failed for ${key}: ${e}`));
  }
  await mongo.close().catch(() => {});
  removeContainer();
  let left = "";
  try {
    left = execFileSync("docker", ["ps", "-a", "-q", "--filter", `name=${CONTAINER}`], { encoding: "utf8" }).trim();
  } catch {}
  console.log(`\nCleanup: backend stopped, container ${left ? "STILL PRESENT" : "removed"}, UploadThing test files left: ${utKeys.size}`);
}

const width = Math.max(...results.map((r) => r.name.length), 10);
console.log(`\n${"CHECK".padEnd(width)}  RESULT`);
for (const r of results) console.log(`${r.name.padEnd(width)}  ${r.passed ? "PASS" : "FAIL"}`);
const failed = results.filter((r) => !r.passed).length;
console.log(`\n${results.length - failed} passed, ${failed} failed${aborted ? ", run ABORTED" : ""}`);
process.exit(failed || aborted ? 1 : 0);
