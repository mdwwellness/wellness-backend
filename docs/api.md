# API reference

Base URL (production): `https://wellnessbackend-8fxe.onrender.com`
Base URL (local dev): `http://localhost:10000`

## Conventions

**Auth**: Most endpoints require the [`userAuth`](../middlewares/userAuth.ts)
middleware. That means a valid JWT must be present either as:
- Cookie: `accessToken=<jwt>` (preferred — that's how the frontend sends it)
- Header: `Authorization: Bearer <jwt>`

Public endpoints (no auth required) are marked **🔓** in the tables below.

**Response shape**: Most endpoints return
```jsonc
{
  "success": true,
  "message": "Human readable status",  // optional
  "data": { ... }                      // optional, varies per endpoint
}
```
…and on error:
```jsonc
{
  "success": false,
  "message": "Why it failed"
}
```
Some endpoints (`login`, `refresh-token`, a few others) deviate from this
shape — flagged inline below.

**ObjectId vs business IDs**: Some collections have both Mongoose `_id`
(a 24-hex string) and a separate human-meaningful business ID:
- User → only `_id`
- Doctor → has its own `doctorId` (separate from `_id`); most write
  operations key off `doctorId`, not `_id`
- AppointmentBooking → only `_id`

---

## 🧑 Users — `/api/users`

Implemented in [`controllers/userController.ts`](../controllers/userController.ts),
routed in [`routes/userRoute.ts`](../routes/userRoute.ts).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/login` | 🔓 | Exchange credentials for cookies |
| POST | `/logout` | required | Clears server-side refresh token |
| POST | `/refresh-token` | 🔓 (uses cookie) | Issue new access token |
| GET  | `/getallusers` | required | List staff (search supported) |
| PUT  | `/complete-profile` | required | Update logged-in user's own profile |
| POST | `/admin/register-user` | required | Create a new staff/therapist account |
| DELETE | `/admin/delete-user` | required | Delete any user by ID |

> ⚠️ `admin/register-user` and `admin/delete-user` have no role gating —
> any authenticated user can call them. See
> [known-issues](known-issues.md#unguarded-admin-endpoints).

### POST `/api/users/login` 🔓

Request:
```json
{
  "userEmailOrPhone": "manjeet@example.com",
  "userPassword": "plaintextpassword"
}
```

Success response:
```jsonc
{
  "success": true,
  "message": "Login successful",
  "user": {
    "id": "65a1b2c3d4e5f67890123456",
    "userfName": "Manjeet",
    "userlName": "Sharma",
    "userEmail": "manjeet@example.com",
    "userPhone": "9999999999",
    "gender": "Male",
    "dob": "1995-01-01T00:00:00.000Z",
    "role": "SUPER_ADMIN",
    "permissions": ["dashboard.view", "appointment.view", "..."],
    "isActive": true,
    "isProfileComplete": true,
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

Side effects: sets `accessToken` (15 min) and `refreshToken` (7 days) as
httpOnly cookies. Persists the new refresh token to `user.refreshToken`
in Mongo (single-session enforcement).

Errors:
- `404 { message: "User not found" }`
- `401 { message: "Invalid credentials" }`
- `500 { message: "Server error", error }`

### POST `/api/users/refresh-token` 🔓 (uses cookie)

Request: no body. Reads `refreshToken` cookie.

Success response:
```json
{
  "success": true,
  "accessToken": "<new jwt>",
  "refreshToken": "<same refresh>"
}
```

Errors:
- `401 { message: "Refresh token required" }` — no cookie
- `403 { message: "Invalid refresh token" }` — DB record doesn't match
- `403 { message: "Expired or invalid refresh token" }` — JWT verification failed

### POST `/api/users/logout`

Request: no body. Reads `req.user.id` from JWT.

Side effects: unsets `refreshToken` in the user's DB record.
The frontend is expected to clear the browser cookies itself.

Success response:
```json
{ "success": true, "message": "Logged out successfully" }
```

### GET `/api/users/getallusers`

Query params:
- `search` (optional, string) — case-insensitive partial match against
  `userfName`, `userlName`, `userEmail`, `userPhone`

Success response:
```jsonc
{
  "success": true,
  "message": "Users retrieved successfully",
  "data": {
    "users": [
      {
        "_id": "...",
        "userfName": "Manjeet",
        "userlName": "Sharma",
        "userEmail": "manjeet@example.com",
        "userPhone": "9999999999",
        "role": "SUPER_ADMIN",
        "isActive": true,
        // ... excludes userPassword and refreshToken
      }
    ]
  }
}
```

### PUT `/api/users/complete-profile`

The logged-in user updates their OWN profile. Caller's user ID comes
from `req.user._id` — no need to pass it.

Request:
```jsonc
{
  "userfName": "Manjeet",
  "userlName": "Sharma",
  "userEmail": "new@example.com",  // optional — if changed, checked for uniqueness
  "userPhone": "9999999999",       // optional — if changed, checked for uniqueness
  "gender": "Male",                // "Male" | "Female" | "Other" | ""
  "dob": "1995-01-01"              // ISO date string
}
```

Success response:
```jsonc
{
  "success": true,
  "message": "Profile updated successfully",
  "user": { /* updated user, password excluded */ },
  "profileComplete": true   // true iff all of: fName, lName, email, phone, gender, dob are set
}
```

Errors:
- `400 { success: false, message: "Email already taken by another user" }`
- `400 { success: false, message: "Phone number already taken by another user" }`
- `400 { success: false, message: "Validation error", errors: [...] }`
- `404 { success: false, message: "User not found" }`

### POST `/api/users/admin/register-user`

Create a new user (any role).

Request:
```json
{
  "userfName": "Jane",
  "userlName": "Doe",
  "userEmail": "jane@example.com",
  "userPhone": "9000000001",
  "userPassword": "plaintextpw",
  "role": "THERAPIST"
}
```

`role` is required and case-insensitively validated against
`["SUPER_ADMIN", "ADMIN", "THERAPIST", "STAFF", "CUSTOMER_CARE"]`. Invalid
roles silently fall back to `"CUSTOMER"` (which then fails the User schema
enum — see [known-issues](known-issues.md#invalid-role-fallback-bug)).

Success response:
```jsonc
{
  "success": true,
  "message": "User registered successfully",
  "user": {
    "id": "...",
    "userfName": "Jane",
    "userlName": "Doe",
    "userEmail": "jane@example.com",
    "userPhone": "9000000001",
    "role": "THERAPIST"
  }
}
```

Errors:
- `400 { message: "Role is required for admin user creation" }`
- `400 { message: "User already exists with this email or phone number" }`
- `500 { message: "Server error", error }`

### DELETE `/api/users/admin/delete-user`

Request:
```json
{ "userId": "65a1b2c3d4e5f67890123456" }
```

> 🟥 **No role gate.** Any authenticated user can delete any user.
> See [known-issues](known-issues.md#unguarded-admin-endpoints).

Success response:
```json
{ "success": true, "message": "User deleted successfully" }
```

---

## 🩺 Therapists (Doctors) — `/api/therapist`

Implemented in [`controllers/DoctorController.ts`](../controllers/DoctorController.ts),
routed in [`routes/DoctorsRoute.ts`](../routes/DoctorsRoute.ts).

**⚠️ Naming gotcha**: URL namespace is `/api/therapist` (singular), but the
backing collection and model are `Doctor`. Treat them as synonyms — "doctor"
in code = "therapist" in product language.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/` | required | Create a new therapist |
| GET  | `/` | required | List all therapists |
| GET  | `/:id` | required | **Get appointments for a therapist** (NOT a therapist profile) |
| PUT  | `/:id` | required | Update therapist by their `doctorId` |
| DELETE | `/:id` | required | Delete therapist by their `doctorId` |

> ⚠️ `GET /api/therapist/:id` does NOT return a therapist record. It
> returns the appointments assigned to that therapist. There is currently
> no endpoint that returns a single therapist by ID. Use the list endpoint
> and client-side filter.

### POST `/api/therapist`

Request:
```json
{
  "doctorId": "DOC-001",
  "name": "Dr. Reddy",
  "email": "reddy@example.com",
  "phonenumber": 9000000010,
  "specialization": ["Sports Therapy", "Posture Correction"],
  "gender": "male",
  "isActive": true,
  "bio": "10 years experience…"
}
```

Required: `doctorId, name, email, phonenumber, specialization`.
Optional: `gender, isActive (default true), bio`.

Success response:
```json
{ "success": true, "message": "Doctor added successfully" }
```

Errors:
- `400 { success: false, message: "A doctor already exist with this email" }`
- `400 { success: false, message: "Missing fields …" }` — note: the missing-fields
  error message has a [known bug](known-issues.md#adddoctor-error-message-crash) that
  can crash the handler

### GET `/api/therapist`

No query params. Returns every doctor sorted by `createdAt` descending.

Success response:
```jsonc
{
  "success": true,
  "data": [
    { "_id": "...", "doctorId": "DOC-001", "name": "Dr. Reddy", ... },
    ...
  ]
}
```

### GET `/api/therapist/:id` — actually returns appointments

`:id` here is the `doctorId` (e.g. `DOC-001`), NOT a Mongo ObjectId.

Success response:
```jsonc
{
  "success": true,
  "message": "Data retrived",
  "data": [
    { /* AppointmentBooking record */ },
    ...
  ]
}
```

### PUT `/api/therapist/:id`

`:id` here is the `doctorId`.

Request:
```jsonc
{
  "name": "Dr. R Reddy",
  "doctorId": "DOC-001",       // can be re-assigned
  "phonenumber": 9000000010,
  "email": "reddy@example.com",
  "specialization": ["Sports Therapy"],
  "bio": "...",
  "isActive": true
}
```

Success response (note: deviates from the usual `success` shape):
```json
{
  "message": "Doctor updated successfully",
  "updatedDoctor": { /* doc after update */ }
}
```

### DELETE `/api/therapist/:id`

`:id` is the `doctorId`.

Success response:
```json
{ "message": "Doctor deleted successfully" }
```

---

## 📅 Appointments / Enquiries — `/api/appointments`

Implemented in [`controllers/appointmentController.ts`](../controllers/appointmentController.ts),
routed in [`routes/appointmentBookingRoutes.ts`](../routes/appointmentBookingRoutes.ts).

**Single collection, two life-cycles.** This collection backs both:
- **Direct bookings** (`status: "scheduled" | "ongoing" | "completed"`)
- **Enquiries** (`status: "enquiry"`) — the back-office leads funnel

The frontend's `/dashboard/enquiries` page shows the enquiry-stage records;
`/dashboard/appointments` filters them OUT.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/` | required | Create a new appointment OR enquiry |
| GET  | `/` | required + role-scoped | List records, scoped by `req.user.role` |
| PUT  | `/:id` | required | Update any subset of fields on a record |
| DELETE | `/:id` | required | Permanently delete a record |

### POST `/api/appointments`

For a NEW ENQUIRY (lead intake from dashboard), the minimum payload is:
```json
{
  "name": "Anita Sharma",
  "phonenumber": 9812345678,
  "preferredReachOutTime": { "from": "09:00", "to": "11:00" },
  "note": "wants info about physio",
  "status": "enquiry"
}
```

For a FULL APPOINTMENT BOOKING (legacy flow), include the slot details too:
```json
{
  "name": "Anita Sharma",
  "phonenumber": 9812345678,
  "email": "anita@example.com",
  "age": 32,
  "location": "Mumbai",
  "category": "Sports Therapy",
  "typeOfappointment": "appointment",
  "slot": { "date": "2026-06-01", "time": "11:30" },
  "doctorId": "DOC-001",
  "doctor": "Dr. Reddy",
  "status": "scheduled"
}
```

Only `name` and `phonenumber` are wire-required. Everything else is
optional. See [models.md → AppointmentBooking](models.md#appointmentbooking)
for the full field list and which fields fill in at each funnel stage.

**Duplicate-phone behavior**: rejects with `409 Conflict` if an *open* record
already exists for this phone (status in `enquiry | scheduled | ongoing`).
Cancelled / completed records do NOT block re-engagement.

Success response:
```json
{
  "success": true,
  "message": "Appointment booked",
  "data": { /* the created record */ }
}
```

Errors:
- `400 { success: false, message: "Name and phone number are required." }`
- `409 { success: false, message: "An open enquiry/appointment already exists for this phone number." }`

### GET `/api/appointments`

Role-scoped behavior (driven by `req.user.role`):
- `SUPER_ADMIN`, `ADMIN`, `STAFF`, `CUSTOMER_CARE` → returns **all records**
- `THERAPIST` → returns only records where `doctorId` matches the doctor
  who has the same email as the logged-in user
- Anything else → `403 Forbidden`

The frontend also passes `?role=&id=&email=` as query params for backwards
compatibility, but **the backend ignores them and uses `req.user` instead**
(this was a deliberate fix; the query params were spoofable).

Success response:
```jsonc
{
  "success": true,
  "data": [
    { /* AppointmentBooking record */ },
    ...
  ]
}
```

### PUT `/api/appointments/:id`

Update any subset of fields on a record. Used by the dashboard for:
- Advancing the funnel (tick `executiveReachedOut`, set `consultationSlot`, etc.)
- Manual status overrides (e.g. cancel a lead)
- Editing lead details

Request: any subset of the [AppointmentBooking](models.md#appointmentbooking)
fields. Example funnel-stage advance:

```jsonc
{
  "executiveReachedOut": true,
  "executiveReachedOutAt": "2026-05-26T14:30:00.000Z"
}
```

Success response:
```jsonc
{
  "success": true,
  "message": "Appointment updated successfully",
  "data": { /* the record BEFORE update — Mongoose default. See known-issues. */ }
}
```

Errors:
- `404 { success: false, message: "Appointment not found" }`

### DELETE `/api/appointments/:id`

Permanently deletes the record. No soft-delete.

Success response:
```json
{ "success": true, "message": "Appointment deleted successfully" }
```

Errors:
- `404 { success: false, message: "Appointment not found" }`

---

## 📊 Analytics — `/api/metrics`

Implemented in [`controllers/getAnalytics.ts`](../controllers/getAnalytics.ts),
routed in [`routes/analyticsRoute.ts`](../routes/analyticsRoute.ts).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | required | Get KPI counts for the dashboard cards |

### GET `/api/metrics`

No query params, no body. Aggregates everything.

Success response:
```jsonc
{
  "success": true,
  "data": {
    "totalDoctors": 12,
    "activeDoctors": 10,
    "totalActiveDoctors": 10,   // duplicate of activeDoctors — see known-issues
    "totalPatients": 47,         // unique emails across all appointments
    "totalAppointments": 153,
    "patientsInCurrentMonth": 8,
    "appointmentsInCurrentMonth": 22,
    "completedAppointments": 95  // all-time count, not current-month
  }
}
```

> ⚠️ `totalActiveDoctors` is a duplicate of `activeDoctors` — both query
> `Doctor.countDocuments({ isActive: true })`. The frontend uses both,
> probably for historical reasons. Don't delete without checking callers.

> ⚠️ `patientsInCurrentMonth` and `appointmentsInCurrentMonth` filter on
> `slot.date`, so they only count records that actually have a slot set
> (i.e. NOT pure enquiries).

---

## Misc — `/`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | 🔓 | Health-check / welcome message |

```json
{ "message": "Welcome to the MDW Wellness Backend", "status": "success" }
```

Useful for uptime monitoring (Render pings this).
