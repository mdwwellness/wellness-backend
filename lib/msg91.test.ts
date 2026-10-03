import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isOtpConfigured, sendOtp, verifyOtp, OtpNotConfiguredError, OtpProviderError } from "./msg91.ts";

const PHONE = "9876543210";
const DEMO_PHONE = "9000000001";
const AUTH_KEY = "test-auth-key-123";

const mockFetch = vi.fn();
const reply = (body: unknown, status = 200) =>
  mockFetch.mockResolvedValueOnce(new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));

let logs: string[] = [];

function env(vars: Partial<Record<"MSG91_AUTH_TOKEN" | "MSG91_TEMPLATE_ID" | "MSG91_DEMO_PHONE" | "MSG91_DEMO_OTP", string>>) {
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
}
const real = () => env({ MSG91_AUTH_TOKEN: AUTH_KEY, MSG91_TEMPLATE_ID: "tmpl-1" });
const demo = (otp = "246813") => env({ MSG91_DEMO_PHONE: DEMO_PHONE, MSG91_DEMO_OTP: otp });

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
  env({ MSG91_AUTH_TOKEN: "", MSG91_TEMPLATE_ID: "", MSG91_DEMO_PHONE: "", MSG91_DEMO_OTP: "" });
  logs = [];
  for (const level of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.join(" ")));
  }
});

afterEach(() => {
  // Whatever happened in the test, the OTP, the auth key and the full phone never reach the logs.
  for (const line of logs) {
    for (const secret of [AUTH_KEY, PHONE, "123456", "246813"]) expect(line).not.toContain(secret);
  }
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isOtpConfigured", () => {
  it("needs both the auth token and the template id, or a full demo config", () => {
    expect(isOtpConfigured()).toBe(false);
    env({ MSG91_AUTH_TOKEN: AUTH_KEY });
    expect(isOtpConfigured()).toBe(false);
    env({ MSG91_TEMPLATE_ID: "tmpl-1" });
    expect(isOtpConfigured()).toBe(true);
  });

  it("counts demo mode only when the phone is 10 digits and the OTP has 6+ digits", () => {
    demo();
    expect(isOtpConfigured()).toBe(true);
    demo("12345");
    expect(isOtpConfigured()).toBe(false);
    env({ MSG91_DEMO_PHONE: "90000", MSG91_DEMO_OTP: "246813" });
    expect(isOtpConfigured()).toBe(false);
  });
});

describe("sendOtp", () => {
  beforeEach(real);

  it("posts the template id, 91-prefixed mobile, a 6-digit 10-minute OTP, the auth key and a timeout", async () => {
    reply({ type: "success", request_id: "abc" });
    await expect(sendOtp(PHONE)).resolves.toBeUndefined();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.msg91.com/api/v5/otp");
    expect(init.method).toBe("POST");
    expect(init.headers.authkey).toBe(AUTH_KEY);
    expect(JSON.parse(init.body)).toEqual({
      template_id: "tmpl-1",
      mobile: `91${PHONE}`,
      otp_length: 6,
      otp_expiry: 10,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["HTTP 200 with type error", { type: "error", message: `Invalid mobile 91${PHONE}` }, 200],
    ["a missing type", { request_id: "abc" }, 200],
    ["HTTP 500", { type: "success" }, 500],
    ["HTTP 401", { type: "error", message: "AuthenticationFailure" }, 401],
    ["an unparseable body", "<html>bad gateway</html>", 200],
  ])("throws OtpProviderError on %s", async (_label, body, status) => {
    reply(body, status);
    await expect(sendOtp(PHONE)).rejects.toBeInstanceOf(OtpProviderError);
  });

  it("throws OtpProviderError on a network failure or timeout", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(sendOtp(PHONE)).rejects.toBeInstanceOf(OtpProviderError);
    mockFetch.mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    await expect(sendOtp(PHONE)).rejects.toBeInstanceOf(OtpProviderError);
  });

  it("throws OtpNotConfiguredError without calling MSG91 when the template id is missing", async () => {
    env({ MSG91_TEMPLATE_ID: "" });
    await expect(sendOtp(PHONE)).rejects.toBeInstanceOf(OtpNotConfiguredError);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("verifyOtp", () => {
  beforeEach(real);

  it("is true only on type success, posting mobile and otp", async () => {
    reply({ type: "success", message: "OTP verified success" });
    await expect(verifyOtp(PHONE, "123456")).resolves.toBe(true);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.msg91.com/api/v5/otp/verify");
    expect(init.headers.authkey).toBe(AUTH_KEY);
    expect(JSON.parse(init.body)).toEqual({ mobile: `91${PHONE}`, otp: "123456" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("is false when MSG91 answers HTTP 200 with type error (wrong or expired OTP)", async () => {
    reply({ type: "error", message: "OTP not match" });
    await expect(verifyOtp(PHONE, "123456")).resolves.toBe(false);
  });

  it.each([
    ["a missing type", { message: "ok" }, 200],
    ["HTTP 500", { type: "success" }, 500],
    ["HTTP 400 with type error", { type: "error" }, 400],
    ["an unparseable body", "not json", 200],
  ])("throws OtpProviderError on %s", async (_label, body, status) => {
    reply(body, status);
    await expect(verifyOtp(PHONE, "123456")).rejects.toBeInstanceOf(OtpProviderError);
  });

  it("throws OtpProviderError on a network failure or timeout", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(verifyOtp(PHONE, "123456")).rejects.toBeInstanceOf(OtpProviderError);
    mockFetch.mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    await expect(verifyOtp(PHONE, "123456")).rejects.toBeInstanceOf(OtpProviderError);
  });

  it("throws OtpNotConfiguredError when the auth token is missing", async () => {
    env({ MSG91_AUTH_TOKEN: "" });
    await expect(verifyOtp(PHONE, "123456")).rejects.toBeInstanceOf(OtpNotConfiguredError);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("demo mode", () => {
  beforeEach(() => demo());

  it("accepts the demo OTP for the demo phone without calling MSG91", async () => {
    await expect(sendOtp(DEMO_PHONE)).resolves.toBeUndefined();
    await expect(verifyOtp(DEMO_PHONE, "246813")).resolves.toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects a wrong or different-length OTP for the demo phone", async () => {
    for (const otp of ["246814", "24681", "2468130", ""]) {
      await expect(verifyOtp(DEMO_PHONE, otp)).resolves.toBe(false);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("applies only to the demo phone", async () => {
    await expect(sendOtp(PHONE)).rejects.toBeInstanceOf(OtpNotConfiguredError);
    await expect(verifyOtp(PHONE, "246813")).rejects.toBeInstanceOf(OtpNotConfiguredError);

    real();
    reply({ type: "error", message: "OTP not match" });
    await expect(verifyOtp(PHONE, "246813")).resolves.toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("is off when the demo OTP is shorter than 6 digits", async () => {
    demo("12345");
    await expect(sendOtp(DEMO_PHONE)).rejects.toBeInstanceOf(OtpNotConfiguredError);
    await expect(verifyOtp(DEMO_PHONE, "12345")).rejects.toBeInstanceOf(OtpNotConfiguredError);
  });

  it("is off when only one of the two demo vars is set", async () => {
    env({ MSG91_DEMO_OTP: "" });
    await expect(verifyOtp(DEMO_PHONE, "246813")).rejects.toBeInstanceOf(OtpNotConfiguredError);
  });
});
