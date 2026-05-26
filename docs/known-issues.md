# Known issues, bugs, and landmines

Read this file before making non-trivial changes. Most of these are real
problems we know about but haven't fixed yet — flagged here so you don't
assume they're intentional design.

## Severity legend

- 🟥 **High** — security or data-integrity issue. Fix before scaling.
- 🟧 **Medium** — wrong behavior in edge cases; users may hit it.
- 🟨 **Low / smell** — confusing or buggy in subtle ways; not blocking.
- 💀 **Dead code** — exists but is never wired up; either delete or use.

---

## 🟥 Unguarded admin endpoints

**Where:** [`routes/userRoute.ts`](../routes/userRoute.ts), lines 19–20.

```ts
userRouter.delete("/admin/delete-user", userAuth, deleteUser);
userRouter.post("/admin/register-user", userAuth, adminRegisterUser);
```

Both endpoints require only `userAuth` — any authenticated user can call
them regardless of role. That means a logged-in `THERAPIST` could delete a
`SUPER_ADMIN` or create a new `SUPER_ADMIN` account for themselves.

**Recommended fix:** wire `checkPermissions(PERMISSIONS.ADMIN_CREATE)` and
`checkPermissions(PERMISSIONS.USER_FORCE_LOGOUT)` (or similar) on these
routes. See the [`checkPermissions` middleware](#-checkpermissions-middleware-is-never-wired)
section below — it's already written, just never used.

---

## 🟥 `getAllAppointments` was the only role-gated endpoint in the codebase

**Where:** [`controllers/appointmentController.ts:54`](../controllers/appointmentController.ts).

After the recent fix, `GET /api/appointments` correctly trusts
`req.user.role` and only allows back-office roles. **Every other endpoint
across all controllers** (POST/PUT/DELETE on appointments and doctors,
analytics, user management) accepts any authenticated request regardless
of role. Defense in depth is missing.

**Recommended fix:** apply `checkPermissions(<permission>)` middleware on
every route that should be role-restricted. Pair with fixing the
[ROLES grant-everything bug](#-roles-grants-every-role-every-permission).

---

## 🟥 JWT secret fallbacks

**Where:** [`controllers/userController.ts`](../controllers/userController.ts)
lines 9 and 17.

```ts
jwt.sign({ id: userId }, process.env.JWT_SECRET || "vivo123", ...)
jwt.sign({ id: userId }, process.env.JWT_REFRESH_SECRET || "vivo123refresh", ...)
```

If `JWT_SECRET` / `JWT_REFRESH_SECRET` are missing in production, the code
silently signs tokens with the strings `"vivo123"` / `"vivo123refresh"`.
Anyone who knows these defaults can forge valid JWTs for any user ID.

**Recommended fix:** crash on startup if these env vars are unset. Remove
the fallback strings.

---

## 🟧 ROLES grants every role every permission

**Where:** [`lib/index.ts:23-29`](../lib/index.ts).

```ts
export const ROLES = {
  SUPER_ADMIN: Object.values(PERMISSIONS),
  ADMIN: Object.values(PERMISSIONS),
  THERAPIST: Object.values(PERMISSIONS),
  STAFF: Object.values(PERMISSIONS),
  CUSTOMER_CARE: Object.values(PERMISSIONS),
};
```

Every role gets every permission. This means even if you wire up
`checkPermissions`, it won't actually differentiate between roles — every
role passes every check. The PERMISSIONS constant is fine; the ROLES map
needs to be replaced with realistic per-role permission sets.

**Recommended fix:** define real per-role grants. For example:
```ts
export const ROLES = {
  SUPER_ADMIN: Object.values(PERMISSIONS),
  ADMIN: [
    PERMISSIONS.DASHBOARD_VIEW,
    PERMISSIONS.APPOINTMENT_VIEW, PERMISSIONS.APPOINTMENT_CREATE,
    PERMISSIONS.APPOINTMENT_EDIT, PERMISSIONS.APPOINTMENT_DELETE,
    PERMISSIONS.THERAPIST_VIEW, PERMISSIONS.THERAPIST_CREATE,
    // …
  ],
  THERAPIST: [
    PERMISSIONS.DASHBOARD_VIEW,
    PERMISSIONS.APPOINTMENT_VIEW,
  ],
  // …
};
```

---

## 💀 `checkPermissions` middleware is never wired

**Where:** [`middlewares/checkPermissions.ts`](../middlewares/checkPermissions.ts).

The middleware is fully implemented — reads `req.user.role`, looks up the
role's permissions, merges with `user.customPermissions`, allows or
rejects. But **no route uses it.** Every router file mounts only
`userAuth`.

Either start using it (preferred) or delete it. Currently it's a misleading
signal — onboarding engineers may assume permissions are enforced when
they aren't.

---

## 🟧 `getAllAppointments` still trusts `req.query.email` for the THERAPIST branch

**Where:** [`controllers/appointmentController.ts:64`](../controllers/appointmentController.ts).

After the recent fix, the role is read from `req.user.role` (good). But
when the role is `THERAPIST`, the controller looks up the doctor record
by:

```ts
const isExistingDoctor = await Doctor.findOne({ email: userEmail }).exec();
```

…where `userEmail = req.user?.userEmail`. That's now correct.

However, the older versions of the codebase read `email` from
`req.query.email`. If you find any other endpoints doing this for
authorization, **fix them** — query params can be spoofed by the client.
Always use `req.user.*` for authz decisions.

---

## 🟧 Invalid-role fallback bug in `adminRegisterUser`

**Where:** [`controllers/userController.ts:164-167`](../controllers/userController.ts).

```ts
const userRole =
  role && validRoles.includes(role.toUpperCase())
    ? role.toUpperCase()
    : "CUSTOMER";
```

If the caller passes an invalid role, the code falls back to `"CUSTOMER"`.
But the User schema's role enum is `["SUPER_ADMIN", "ADMIN", "THERAPIST",
"STAFF", "CUSTOMER_CARE"]` — `"CUSTOMER"` isn't valid. The `save()` will
throw a Mongoose validation error, which gets caught and returned as a
generic 500. The actual error message is hidden from the client.

**Recommended fix:** return a 400 with a clear "invalid role" message
instead of falling back.

---

## 🟧 `addDoctor` error-message string can crash the handler

**Where:** [`controllers/DoctorController.ts:26`](../controllers/DoctorController.ts).

```ts
if (!name || !email || !phonenumber || !specialization || !doctorId) {
  return res.status(400).send({
    success: false,
    message: `Missing fields ${details.filter((item: any) => item === undefined).join(", ")}`
  })
}
```

`details` here is `req.body`, which is an object — not an array. Calling
`.filter()` on it throws `TypeError`, which then trips the catch block and
returns a generic 500. So the user sees "server error" instead of "missing
fields".

**Recommended fix:** rewrite as:
```ts
const missing = ["name", "email", "phonenumber", "specialization", "doctorId"]
  .filter(k => !(details as any)[k]);
if (missing.length) {
  return res.status(400).send({
    success: false,
    message: `Missing fields: ${missing.join(", ")}`,
  });
}
```

---

## 🟨 `updateAppointment` returns the pre-update document

**Where:** [`controllers/appointmentController.ts:101-104`](../controllers/appointmentController.ts).

```ts
const updated = await AppointmentBooking.findByIdAndUpdate(id, updateData);
```

`findByIdAndUpdate` in Mongoose defaults to returning the document **before**
the update. The response then says `"Appointment updated successfully"` and
includes that stale document in `data`. The actual update did happen — just
the response reflects the old state.

The frontend doesn't currently rely on this `data`; it uses local state and
React Query invalidation. But if you ever do consume it, add
`{ new: true }`.

---

## 🟨 `Doctor.gender` field has a typo `requied` instead of `required`

**Where:** [`models/doctorsModel.ts:15`](../models/doctorsModel.ts).

```ts
gender:{
  type:String,
  requied:true,        // ← typo; Mongoose ignores unknown options
  enum:["male","female"],
},
```

`requied` isn't a valid Mongoose schema option, so the field is effectively
optional even though the typo suggests it was meant to be required. The
controller validation doesn't check it either. New doctors can be created
without `gender`.

**Recommended fix:** either correct the typo to `required: true`, or
remove the line and treat `gender` as truly optional in the UI.

---

## 🟨 Welcome route uses `defaul` typo? (NO — was fixed)

The `appointmentsBookingModel.ts` `status` field previously had
`defaul: "scheduled"` instead of `default: "scheduled"`, which meant
new records were created with no default status. **Fixed in commit
`d02ecd2`.** Mentioned here in case you find similar typos elsewhere —
schema definitions silently accept misspelled options.

---

## 🟨 Two analytics fields are duplicates

**Where:** [`controllers/getAnalytics.ts`](../controllers/getAnalytics.ts).

`activeDoctors` and `totalActiveDoctors` are both computed as
`Doctor.countDocuments({ isActive: true })`. The frontend uses both names
(presumably for historical reasons). Removing one will break the frontend
without coordinated changes.

---

## 🟨 `getDoctors` null-check is dead

**Where:** [`controllers/DoctorController.ts:56-61`](../controllers/DoctorController.ts).

```ts
const doctorsDetails = await data.exec();
if (!doctorsDetails) {
  return res.status(404).send({ success: false, message: "something went wrong" })
}
```

`Doctor.find()` returns `[]` (empty array) when there are no matches, never
`null`/`undefined`. The branch is unreachable. Harmless but misleading.

---

## 🟨 Two slot date types

**Where:** [`models/appointmentsBookingModel.ts`](../models/appointmentsBookingModel.ts).

The legacy `slot.date` field is `type: Date` (and Mongoose coerces incoming
strings). The new `consultationSlot.date` and `physioSlot.date` are
`type: String`. This is intentional (the funnel UI works with `"YYYY-MM-DD"`
strings directly), but worth knowing: don't assume all date fields are
the same type when querying.

---

## Suggested cleanup order

If you have a week to harden the backend, do these in order:

1. Fix [JWT secret fallbacks](#-jwt-secret-fallbacks) (security)
2. Wire [`checkPermissions`](#-checkpermissions-middleware-is-never-wired) on admin endpoints (security)
3. Fix [ROLES grant-everything](#-roles-grants-every-role-every-permission) (makes the previous step meaningful)
4. Add `checkPermissions` to remaining mutation endpoints (defense in depth)
5. Fix [`addDoctor`](#-adddoctor-error-message-string-can-crash-the-handler) and [invalid-role fallback](#-invalid-role-fallback-bug-in-adminregisteruser) (correctness)
6. Decide on the [duplicate analytics field](#-two-analytics-fields-are-duplicates) and the [pre-update return](#-updateappointment-returns-the-pre-update-document) (cleanup)

The above is just my opinion based on the audit. Confirm with the team
before doing wholesale changes.
