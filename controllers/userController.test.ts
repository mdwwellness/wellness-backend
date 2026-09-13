import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

// ── Mocks (hoisted) ────────────────────────────────────────────────────────
// vi.mock is hoisted to the top, so mock variables must use vi.hoisted().

const {
  mockUserSave,
  mockUserFindById,
  mockUserFindByIdAndUpdate,
  mockUserFindOne,
  mockDoctorFindOneAndUpdate,
} = vi.hoisted(() => ({
  mockUserSave: vi.fn(),
  mockUserFindById: vi.fn(),
  mockUserFindByIdAndUpdate: vi.fn(),
  mockUserFindOne: vi.fn(),
  mockDoctorFindOneAndUpdate: vi.fn(),
}));

// Build a chainable mock for .select() on findByIdAndUpdate
function buildChainableMock(resolveValue: any) {
  const chain: any = {};
  chain.select = vi.fn().mockResolvedValue(resolveValue);
  return chain;
}

vi.mock("../models/userModel.ts", () => ({
  default: {
    findById: mockUserFindById,
    findByIdAndUpdate: (...args: any[]) => {
      // Store args so we can assert on them
      mockUserFindByIdAndUpdate(...args);
      // Return a chainable object with .select()
      const result = mockUserFindByIdAndUpdate.mock.results[0]?.value;
      return buildChainableMock(result);
    },
    findOne: mockUserFindOne,
  },
}));

vi.mock("../models/doctorsModel.ts", () => ({
  Doctor: {
    findOneAndUpdate: mockDoctorFindOneAndUpdate,
  },
}));

vi.mock("../lib/index.ts", () => ({
  ROLES: {},
}));

vi.mock("../lib/mailer.ts", () => ({
  sendPasswordResetEmail: vi.fn(),
}));

// ── Import after mocks ─────────────────────────────────────────────────────
import { completeProfile, adminEditUserProfile } from "./userController.ts";

// ── Helpers ────────────────────────────────────────────────────────────────
function mockReq(body: any = {}, userOverride: any = {}) {
  return {
    body,
    user: {
      _id: "user123",
      role: "THERAPIST",
      ...userOverride,
    },
  } as unknown as Request;
}

function mockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as unknown as Response;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe("completeProfile — Doctor sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should sync name, email, phone to Doctor when a THERAPIST updates profile", async () => {
    // Arrange
    const existingUser = {
      _id: "user123",
      userfName: "Old",
      userlName: "Name",
      userEmail: "old@example.com",
      userPhone: "1111111111",
      role: "THERAPIST",
      gender: "Male",
      dob: new Date("1990-01-01"),
    };

    const updatedUser = {
      ...existingUser,
      userfName: "New",
      userlName: "Name",
      userEmail: "new@example.com",
      userPhone: "2222222222",
    };

    mockUserFindById.mockResolvedValue(existingUser);
    mockUserFindByIdAndUpdate.mockResolvedValue(updatedUser);
    mockDoctorFindOneAndUpdate.mockResolvedValue({});

    const req = mockReq({
      userfName: "New",
      userlName: "Name",
      userEmail: "new@example.com",
      userPhone: "2222222222",
    });
    const res = mockRes();

    // Act
    await completeProfile(req, res);

    // Assert
    expect(mockDoctorFindOneAndUpdate).toHaveBeenCalledWith(
      { userId: "user123" },
      {
        $set: {
          firstName: "New",
          lastName: "Name",
          name: "New Name",
          email: "new@example.com",
          phonenumber: 2222222222,
        },
      }
    );
  });

  it("should NOT sync to Doctor when a non-THERAPIST updates profile", async () => {
    // Arrange
    const existingUser = {
      _id: "user123",
      userfName: "Old",
      userlName: "Name",
      userEmail: "old@example.com",
      userPhone: "1111111111",
      role: "ADMIN",
      gender: "Male",
      dob: new Date("1990-01-01"),
    };

    const updatedUser = { ...existingUser, userfName: "New" };

    mockUserFindById.mockResolvedValue(existingUser);
    mockUserFindByIdAndUpdate.mockResolvedValue(updatedUser);

    const req = mockReq({ userfName: "New" }, { role: "ADMIN" });
    const res = mockRes();

    // Act
    await completeProfile(req, res);

    // Assert
    expect(mockDoctorFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("should handle Doctor sync failure gracefully (User still updated)", async () => {
    // Arrange
    const existingUser = {
      _id: "user123",
      userfName: "Old",
      userlName: "Name",
      userEmail: "old@example.com",
      userPhone: "1111111111",
      role: "THERAPIST",
      gender: "Male",
      dob: new Date("1990-01-01"),
    };

    const updatedUser = {
      ...existingUser,
      userfName: "New",
      userlName: "Name",
    };

    mockUserFindById.mockResolvedValue(existingUser);
    mockUserFindByIdAndUpdate.mockResolvedValue(updatedUser);
    mockDoctorFindOneAndUpdate.mockRejectedValue(new Error("DB error"));

    const req = mockReq({ userfName: "New", userlName: "Name" });
    const res = mockRes();

    // Act
    await completeProfile(req, res);

    // Assert — User update succeeded despite Doctor sync failure
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true })
    );
  });

  it("should only sync fields that are provided in the request", async () => {
    // Arrange
    const existingUser = {
      _id: "user123",
      userfName: "Old",
      userlName: "Name",
      userEmail: "old@example.com",
      userPhone: "1111111111",
      role: "THERAPIST",
      gender: "Male",
      dob: new Date("1990-01-01"),
    };

    const updatedUser = {
      ...existingUser,
      userfName: "New",
    };

    mockUserFindById.mockResolvedValue(existingUser);
    mockUserFindByIdAndUpdate.mockResolvedValue(updatedUser);
    mockDoctorFindOneAndUpdate.mockResolvedValue({});

    const req = mockReq({ userfName: "New" }); // Only name change
    const res = mockRes();

    // Act
    await completeProfile(req, res);

    // Assert — Only name should be synced (email/phone not provided)
    expect(mockDoctorFindOneAndUpdate).toHaveBeenCalledWith(
      { userId: "user123" },
      {
        $set: {
          firstName: "New",
          lastName: "Name",
          name: "New Name",
        },
      }
    );
  });
});

describe("adminEditUserProfile — Doctor sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should sync name, email, phone, isActive to Doctor when editing a THERAPIST", async () => {
    // Arrange
    const existingUser = {
      _id: "user456",
      userfName: "Old",
      userlName: "Name",
      userEmail: "old@example.com",
      userPhone: "1111111111",
      role: "THERAPIST",
      refreshToken: "some-token",
      save: mockUserSave.mockResolvedValue(true),
    };

    mockUserFindById.mockResolvedValue(existingUser);
    mockDoctorFindOneAndUpdate.mockResolvedValue({});

    const req = mockReq({
      userId: "user456",
      userfName: "New",
      userlName: "Name",
      userEmail: "new@example.com",
      userPhone: "2222222222",
      isActive: false,
    });
    const res = mockRes();

    // Act
    await adminEditUserProfile(req, res);

    // Assert
    expect(mockDoctorFindOneAndUpdate).toHaveBeenCalledWith(
      { userId: "user456" },
      {
        $set: {
          firstName: "New",
          lastName: "Name",
          name: "New Name",
          email: "new@example.com",
          phonenumber: 2222222222,
          isActive: false,
        },
      }
    );
  });

  it("should NOT sync to Doctor when editing a non-THERAPIST user", async () => {
    // Arrange
    const existingUser = {
      _id: "user456",
      userfName: "Old",
      userlName: "Name",
      userEmail: "old@example.com",
      userPhone: "1111111111",
      role: "STAFF",
      refreshToken: null,
      save: mockUserSave.mockResolvedValue(true),
    };

    mockUserFindById.mockResolvedValue(existingUser);

    const req = mockReq({
      userId: "user456",
      userfName: "New",
    });
    const res = mockRes();

    // Act
    await adminEditUserProfile(req, res);

    // Assert
    expect(mockDoctorFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("should handle Doctor sync failure gracefully (User still updated)", async () => {
    // Arrange
    const existingUser = {
      _id: "user456",
      userfName: "Old",
      userlName: "Name",
      userEmail: "old@example.com",
      userPhone: "1111111111",
      role: "THERAPIST",
      refreshToken: null,
      save: mockUserSave.mockResolvedValue(true),
    };

    mockUserFindById.mockResolvedValue(existingUser);
    mockDoctorFindOneAndUpdate.mockRejectedValue(new Error("DB error"));

    const req = mockReq({
      userId: "user456",
      userfName: "New",
    });
    const res = mockRes();

    // Act
    await adminEditUserProfile(req, res);

    // Assert — User update succeeded despite Doctor sync failure
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true })
    );
  });

  it("should clear refreshToken when role is changed", async () => {
    // Arrange
    const existingUser = {
      _id: "user456",
      userfName: "Old",
      userlName: "Name",
      userEmail: "old@example.com",
      userPhone: "1111111111",
      role: "STAFF",
      refreshToken: "some-token",
      save: mockUserSave.mockResolvedValue(true),
    };

    mockUserFindById.mockResolvedValue(existingUser);
    mockDoctorFindOneAndUpdate.mockResolvedValue({});

    const req = mockReq({
      userId: "user456",
      role: "THERAPIST", // Role change
    });
    const res = mockRes();

    // Act
    await adminEditUserProfile(req, res);

    // Assert — refreshToken should be cleared
    expect(existingUser.refreshToken).toBe("");
    expect(existingUser.save).toHaveBeenCalled();
  });

  it("should return 400 when userId is missing", async () => {
    const req = mockReq({ userfName: "Test" }); // No userId
    const res = mockRes();

    await adminEditUserProfile(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, message: "User ID required" })
    );
  });

  it("should return 404 when user is not found", async () => {
    mockUserFindById.mockResolvedValue(null);

    const req = mockReq({ userId: "nonexistent" });
    const res = mockRes();

    await adminEditUserProfile(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, message: "User not found" })
    );
  });
});
