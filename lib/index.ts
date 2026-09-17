export const PERMISSIONS = Object.freeze({
  DASHBOARD_VIEW: "dashboard.view",

  APPOINTMENT_VIEW: "appointment.view",
  APPOINTMENT_CREATE: "appointment.create",
  APPOINTMENT_EDIT: "appointment.edit",
  APPOINTMENT_DELETE: "appointment.delete",

  THERAPIST_VIEW: "therapist.view",
  THERAPIST_CREATE: "therapist.create",
  THERAPIST_EDIT: "therapist.edit",
  THERAPIST_DELETE: "therapist.delete",

  ADMIN_VIEW:"admin.view",
  ADMIN_CREATE:"admin.create",
  ADMIN_EDIT:"admin.edit",

  // Service catalogue and the pricing tables that go with it (session rates).
  SERVICE_MANAGE: "service.manage",
  // Clinic-wide numbers: booking gap, default therapist revenue split.
  SETTINGS_MANAGE: "settings.manage",

  EXPORT_DATA: "export.data",
  USER_FORCE_LOGOUT: "user.force_logout",
  MODULE_LOCK: "module.lock",
})

const ALL_PERMISSIONS = Object.values(PERMISSIONS);

/**
 * What a therapist may do, derived from what the dashboard actually lets them
 * reach (nav is filtered to Dashboard / Appointments / Earnings / My Profile /
 * Settings-own-profile) rather than from what sounds tidy.
 *
 * Deliberately granted, because their own screens really do call these:
 *  - APPOINTMENT_EDIT: completing a session, visit OTPs, add-on recommendations
 *  - APPOINTMENT_CREATE: booking a recommended follow-up session
 *  - THERAPIST_VIEW: the roster read behind the home KPIs and earnings split
 *  - THERAPIST_EDIT: their own "My Profile" record, which has no role gate in
 *    the UI, so denying this would break a therapist editing their own details
 *
 * Note this is a role scope, not ownership scoping. THERAPIST_EDIT still lets a
 * therapist PUT another therapist's record if they craft the request, because
 * `updateDoctorDetails` doesn't check "is this my record" - that needs fixing in
 * the controller, not here (tracked separately in ISSUES.md).
 */
const THERAPIST_PERMISSIONS = [
  PERMISSIONS.DASHBOARD_VIEW,
  PERMISSIONS.APPOINTMENT_VIEW,
  PERMISSIONS.APPOINTMENT_CREATE,
  PERMISSIONS.APPOINTMENT_EDIT,
  PERMISSIONS.THERAPIST_VIEW,
  PERMISSIONS.THERAPIST_EDIT,
  PERMISSIONS.EXPORT_DATA,
];

/**
 * The four back-office roles are intentionally identical: that's what the
 * product does today, and pretending otherwise here would lock staff out of
 * work they do daily. Differentiating STAFF from CUSTOMER_CARE is a business
 * decision, not a refactor (ISSUES.md #10).
 */
export const ROLES: Record<string, string[]> = {
  SUPER_ADMIN: ALL_PERMISSIONS,
  ADMIN: ALL_PERMISSIONS,
  STAFF: ALL_PERMISSIONS,
  CUSTOMER_CARE: ALL_PERMISSIONS,
  THERAPIST: THERAPIST_PERMISSIONS,
};

export const USER_ROLES = {
  SUPER_ADMIN: "SUPER_ADMIN",
  ADMIN: "ADMIN",
  THERAPIST: "THERAPIST",
  STAFF: "STAFF",
  CUSTOMER_CARE: "CUSTOMER_CARE",
};
