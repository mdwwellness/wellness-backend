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
  
  EXPORT_DATA: "export.data",
  USER_FORCE_LOGOUT: "user.force_logout",
  MODULE_LOCK: "module.lock",
})

export const ROLES = {
  SUPER_ADMIN: Object.values(PERMISSIONS),
  ADMIN: Object.values(PERMISSIONS),
  THERAPIST: Object.values(PERMISSIONS),
  STAFF: Object.values(PERMISSIONS),
  CUSTOMER_CARE: Object.values(PERMISSIONS),
};

export const USER_ROLES = {
  SUPER_ADMIN: "SUPER_ADMIN",
  ADMIN: "ADMIN",
  THERAPIST: "THERAPIST",
  STAFF: "STAFF",
  CUSTOMER_CARE: "CUSTOMER_CARE",
};
