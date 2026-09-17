import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import checkPermission from "./checkPermissions.ts";
import { PERMISSIONS } from "../lib/index.ts";

function mockReq(role?: string, customPermissions: string[] = []) {
  return { user: role ? { role, customPermissions } : undefined } as unknown as Request;
}

function mockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as unknown as Response;
}

function run(permission: string, role?: string, custom: string[] = []) {
  const req = mockReq(role, custom);
  const res = mockRes();
  const next = vi.fn();
  checkPermission(permission)(req, res, next);
  return { res, next };
}

const BACK_OFFICE = ["SUPER_ADMIN", "ADMIN", "STAFF", "CUSTOMER_CARE"];

describe("checkPermission - back-office roles keep full access", () => {
  // The whole point of the current grant table: nothing changes for staff.
  for (const role of BACK_OFFICE) {
    it(`${role} can manage services, settings, therapists and delete appointments`, () => {
      for (const perm of [
        PERMISSIONS.SERVICE_MANAGE,
        PERMISSIONS.SETTINGS_MANAGE,
        PERMISSIONS.THERAPIST_CREATE,
        PERMISSIONS.THERAPIST_DELETE,
        PERMISSIONS.APPOINTMENT_DELETE,
      ]) {
        const { res, next } = run(perm, role);
        expect(next, `${role} should pass ${perm}`).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
      }
    });
  }
});

describe("checkPermission - therapist boundary", () => {
  it("lets a therapist do their own job", () => {
    for (const perm of [
      PERMISSIONS.DASHBOARD_VIEW,
      PERMISSIONS.APPOINTMENT_VIEW,
      PERMISSIONS.APPOINTMENT_CREATE,
      PERMISSIONS.APPOINTMENT_EDIT,
      PERMISSIONS.THERAPIST_VIEW,
      PERMISSIONS.THERAPIST_EDIT,
    ]) {
      const { next } = run(perm, "THERAPIST");
      expect(next, `therapist should pass ${perm}`).toHaveBeenCalled();
    }
  });

  it("blocks a therapist from pricing, clinic settings and roster changes", () => {
    for (const perm of [
      PERMISSIONS.SERVICE_MANAGE,
      PERMISSIONS.SETTINGS_MANAGE,
      PERMISSIONS.THERAPIST_CREATE,
      PERMISSIONS.THERAPIST_DELETE,
      PERMISSIONS.APPOINTMENT_DELETE,
      PERMISSIONS.ADMIN_CREATE,
    ]) {
      const { res, next } = run(perm, "THERAPIST");
      expect(next, `therapist should be blocked from ${perm}`).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    }
  });

  it("still honours an explicit per-user grant", () => {
    const { next } = run(PERMISSIONS.SERVICE_MANAGE, "THERAPIST", [
      PERMISSIONS.SERVICE_MANAGE,
    ]);
    expect(next).toHaveBeenCalled();
  });
});

describe("checkPermission - rejects bad callers", () => {
  it("401s with no authenticated user", () => {
    const { res, next } = run(PERMISSIONS.SERVICE_MANAGE, undefined);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("403s an unrecognised role", () => {
    const { res, next } = run(PERMISSIONS.SERVICE_MANAGE, "NOT_A_ROLE");
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
