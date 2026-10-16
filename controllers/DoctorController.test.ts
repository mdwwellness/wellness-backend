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

  // A therapist whose own record is THR-0001.
  const asTherapist = (body: any, id = "THR-0001") =>
    ({ params: { id }, body, user: { role: "THERAPIST", _id: "u1", userEmail: "t@x.com" } }) as unknown as Request;
  const ownRecord = () => mockDoctorFindOne.mockReturnValue({ lean: () => Promise.resolve({ doctorId: "THR-0001" }) });

  it("drops a split sent by a therapist, so they can't raise their own cut", async () => {
    ownRecord();
    await updateDoctorDetails(asTherapist({ name: "T", splitPercent: 100 }), mockRes());
    expect(savedUpdate()).not.toHaveProperty("splitPercent");
    expect(savedUpdate().name).toBe("T");
  });

  it("a therapist can't edit another therapist's profile (#19)", async () => {
    ownRecord();
    const res = mockRes();
    await updateDoctorDetails(asTherapist({ name: "Hacked" }, "THR-0002"), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("a therapist can't switch themselves off or change their ID", async () => {
    ownRecord();
    await updateDoctorDetails(asTherapist({ name: "T", isActive: false, doctorId: "THR-9999" }), mockRes());
    expect(savedUpdate()).toMatchObject({ name: "T", isActive: undefined, doctorId: undefined });
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

  const select = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // A fresh copy each test: the therapist case blanks colleagues' codes.
    select.mockReturnValue({ sort: () => ({ exec: () => Promise.resolve(list.map((d) => ({ ...d }))) }) });
    mockDoctorFind.mockReturnValue({ select });
    mockBookingFind.mockReturnValue({ select: () => ({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve([{ enquiryId: "ENQ-1" }]) }) }) }) });
  });

  const sent = (res: any) => res.send.mock.calls[0][0].data.map((d: any) => [d.doctorId, d.referralCode]);

  it("the office (Admin, Staff) gets no referral codes", async () => {
    for (const role of ["ADMIN", "STAFF"]) {
      await getDoctors(as(role, "u1"), mockRes());
      expect(select).toHaveBeenLastCalledWith("");
    }
  });

  it("the Super Admin sees every code", async () => {
    const res = mockRes();
    await getDoctors(as("SUPER_ADMIN", "x"), res);
    expect(sent(res)).toEqual([["THR-1", "AAAAA"], ["THR-2", "BBBBB"]]);
  });

  it("a therapist sees only their own code", async () => {
    mockDoctorFindOne.mockReturnValue({ lean: () => Promise.resolve({ doctorId: "THR-1" }) });
    const res = mockRes();
    await getDoctors(as("THERAPIST", "u1"), res);
    expect(sent(res)).toEqual([["THR-1", "AAAAA"], ["THR-2", undefined]]);
  });

  it("referrals list the bookings that came in through the therapist's code", async () => {
    mockDoctorFindOne.mockReturnValue({ lean: () => Promise.resolve({ userId: "u1" }) });
    const res = mockRes();
    await getReferrals(as("SUPER_ADMIN", "x", { id: "THR-1" }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockBookingFind).toHaveBeenCalledWith({ referredByDoctorId: "THR-1" });
  });
});
