import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const { mockFindOneAndUpdate, mockDoctorFindOne, mockUserUpdate, mockDoctorFind, mockBookingFind } = vi.hoisted(() => ({
  mockDoctorFind: vi.fn(),
  mockBookingFind: vi.fn(),
  mockFindOneAndUpdate: vi.fn(),
  mockDoctorFindOne: vi.fn(),
  mockUserUpdate: vi.fn(),
}));
vi.mock("../models/doctorsModel.ts", () => ({
  Doctor: { findOne: mockDoctorFindOne, findOneAndUpdate: mockFindOneAndUpdate, find: mockDoctorFind },
}));
vi.mock("../models/userModel.ts", () => ({
  default: { findOne: vi.fn(), findByIdAndUpdate: mockUserUpdate },
}));
vi.mock("../models/appointmentsBookingModel.ts", () => ({ default: { find: mockBookingFind } }));
vi.mock("../models/therapistLeaveModel.ts", () => ({ TherapistLeave: {} }));
vi.mock("../lib/logger.ts", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/counters.ts", () => ({ nextSequence: vi.fn() }));

import { addDoctor, getDoctors, getReferrals, updateDoctorDetails, updateTherapistSuperAdmin } from "./DoctorController.ts";

function mockReq(body: any = {}) {
  return { body } as unknown as Request;
}

function mockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as unknown as Response;
}

describe("addDoctor - input validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a request missing name/email/phone with a clean 400, not a crash", async () => {
    const req = mockReq({ password: "password123" }); // no name, email, or phonenumber
    const res = mockRes();

    await addDoctor(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: "Name, email and phone number are required.",
      })
    );
  });

  it("rejects a password shorter than 6 characters", async () => {
    const req = mockReq({
      name: "Dr. Reddy",
      email: "reddy@example.com",
      phonenumber: "9999999999",
      password: "abc",
    });
    const res = mockRes();

    await addDoctor(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: expect.stringContaining("password"),
      })
    );
  });

  it("requires an earnings split when an admin adds a therapist", async () => {
    const req = {
      ...mockReq({
        name: "Dr. Reddy",
        email: "reddy@example.com",
        phonenumber: "9999999999",
        password: "password123",
      }),
      user: { role: "ADMIN" },
    } as unknown as Request;
    const res = mockRes();

    await addDoctor(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("split") })
    );
  });
});

describe("updateDoctorDetails - earnings split", () => {
  const updateReq = (role: string, body: any) =>
    ({ params: { id: "THR-0001" }, body, user: { role } }) as unknown as Request;
  /** The update object passed to Doctor.findOneAndUpdate. */
  const savedUpdate = () => mockFindOneAndUpdate.mock.calls[0][1];

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindOneAndUpdate.mockResolvedValue({ doctorId: "THR-0001" });
  });

  it("lets an admin set a therapist's split", async () => {
    await updateDoctorDetails(updateReq("ADMIN", { splitPercent: 70 }), mockRes());
    expect(savedUpdate().splitPercent).toBe(70);
  });

  it("drops a split sent by a therapist, so they can't raise their own cut", async () => {
    await updateDoctorDetails(updateReq("THERAPIST", { name: "T", splitPercent: 100 }), mockRes());
    expect(savedUpdate()).not.toHaveProperty("splitPercent");
    expect(savedUpdate().name).toBe("T");
  });

  it("rejects an out-of-range split from an admin", async () => {
    const res = mockRes();
    await updateDoctorDetails(updateReq("SUPER_ADMIN", { splitPercent: 150 }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe("updateTherapistSuperAdmin - login names", () => {
  const chain = (value: unknown) => ({ exec: () => Promise.resolve(value), select: () => ({ exec: () => Promise.resolve(value) }) });

  beforeEach(() => {
    vi.clearAllMocks();
    mockDoctorFindOne.mockReturnValue(chain({ doctorId: "THR-0012", userId: "u1", email: "t@x.com", phonenumber: "9876500001" }));
    mockFindOneAndUpdate.mockReturnValue(chain({ doctorId: "THR-0012" }));
    mockUserUpdate.mockReturnValue(chain({ _id: "u1" }));
  });

  it("doesn't copy empty first/last names onto the login (they're required there)", async () => {
    const req = { params: { id: "THR-0012" }, body: { firstName: "", lastName: " ", isActive: true, splitPercent: 60 }, user: { role: "SUPER_ADMIN" } } as unknown as Request;
    const res = mockRes();
    await updateTherapistSuperAdmin(req, res);
    const userSet = mockUserUpdate.mock.calls[0]?.[1]?.$set ?? {};
    expect(userSet).not.toHaveProperty("userfName");
    expect(userSet).not.toHaveProperty("userlName");
    expect(res.status).not.toHaveBeenCalledWith(500);
  });

  it("still copies real names", async () => {
    const req = { params: { id: "THR-0012" }, body: { firstName: " Riya ", lastName: "Sen" }, user: { role: "SUPER_ADMIN" } } as unknown as Request;
    await updateTherapistSuperAdmin(req, mockRes());
    expect(mockUserUpdate.mock.calls[0][1].$set).toMatchObject({ userfName: "Riya", userlName: "Sen" });
  });
});

describe("referral codes", () => {
  const as = (role: string, id: string, params: object = {}) =>
    ({ params, body: {}, user: { role, _id: id } }) as unknown as Request;
  const list = [
    { doctorId: "THR-1", userId: "u1", referralCode: "AAAAA" },
    { doctorId: "THR-2", userId: "u2", referralCode: "BBBBB" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockDoctorFind.mockReturnValue({ sort: () => ({ lean: () => ({ exec: () => Promise.resolve(list) }) }) });
    mockBookingFind.mockReturnValue({ select: () => ({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve([{ enquiryId: "ENQ-1" }]) }) }) }) });
  });

  it("a therapist sees only their own code in the therapist list; admins see all", async () => {
    const res = mockRes();
    await getDoctors(as("THERAPIST", "u1"), res);
    const sent = (res.send as any).mock.calls[0][0].data;
    expect(sent.map((d: any) => d.referralCode)).toEqual(["AAAAA", undefined]);

    const adminRes = mockRes();
    await getDoctors(as("ADMIN", "x"), adminRes);
    expect((adminRes.send as any).mock.calls[0][0].data.map((d: any) => d.referralCode)).toEqual(["AAAAA", "BBBBB"]);
  });

  it("referrals: own therapist and back office allowed, another therapist refused", async () => {
    mockDoctorFindOne.mockReturnValue({ lean: () => Promise.resolve({ userId: "u1" }) });
    const own = mockRes();
    await getReferrals(as("THERAPIST", "u1", { id: "THR-1" }), own);
    expect(own.status).toHaveBeenCalledWith(200);
    expect(mockBookingFind).toHaveBeenCalledWith({ referredByDoctorId: "THR-1" });

    const other = mockRes();
    await getReferrals(as("THERAPIST", "u2", { id: "THR-1" }), other);
    expect(other.status).toHaveBeenCalledWith(403);

    const staff = mockRes();
    await getReferrals(as("CUSTOMER_CARE", "s1", { id: "THR-1" }), staff);
    expect(staff.status).toHaveBeenCalledWith(200);
  });
});
