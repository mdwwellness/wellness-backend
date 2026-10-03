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

**Duplicate-phone behavior**: Staff creates never fold or block: a second record for the same phone is
allowed. Repeat folding exists only on the public form
(`POST /api/appointments/public`) and the customer app
(`POST /api/customer-app/bookings`): a submission merges into an open lead
with status `enquiry`, the same phone, the same name (case and spaces ignored)
and the same service, and the merge is logged on that lead. Anything else
creates a new record.

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

## 📱 Customers' App - `/api/customer-app`

Implemented in [`controllers/customerAppController.ts`](../controllers/customerAppController.ts),
routed in [`routes/customerAppRoutes.ts`](../routes/customerAppRoutes.ts).

For the customer-facing app (patients, not staff). Accounts are shared with
the patient site: one phone is one account in `mdw.users`, linked to the
clinic's `CUST-####` record (see
[models.md: Customer account](models.md#customer-account-mdwusers)).

**Auth**: sign in with a phone OTP, then send the returned token as
`Authorization: Bearer <token>` on every other call. Cookies are never read
here, staff tokens don't work on these routes and customer tokens don't work
on staff routes. Tokens last 7 days with no refresh: on a 401, sign in again.
Logout is client-side (drop the token).

Every call marked "customer" re-reads the account, so blocking it takes effect
at once:
- `401 "Sign in required."`: no `Authorization: Bearer` header.
- `401 "Invalid or expired session."`: bad token; an expired one also carries `"code": "TOKEN_EXPIRED"`.
- `403 "This account is blocked."` / `403 "This account isn't registered for MDW Wellness."`

**Who you are comes from the token**: phone, name, email, account id and
customer id are never read from a request body. Bodies are allow-listed and
unknown fields are rejected by name (`400 "Unknown field(s): quotedPrice."`).

**Not configured**: without a valid `CUSTOMER_JWT_SECRET` every route answers
`503 "Customer accounts aren't available right now."`; without MSG91 the two
`/auth` routes answer `503 "Phone sign-in isn't available right now."`.
Browser origins must be listed in `CUSTOMER_APP_URL` (CORS), otherwise
`403 "Origin not allowed"`.

**Per-IP limits** use the client address Express derives when `TRUST_PROXY`
is set to the number of proxy hops in front of the app (on Render, confirm the
hop count from a real request's `X-Forwarded-For` before setting it). Without
it they use the first `X-Forwarded-For` entry, which a client can spoof.
Per-phone and per-account limits don't depend on it.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/otp` | 🔓 | Send a login OTP by SMS |
| POST | `/auth/verify` | 🔓 | Check the OTP and sign in (creates the account on first login) |
| GET | `/me` | customer | Own profile |
| PATCH | `/me` | customer | Edit own profile |
| PUT | `/me/photo` | customer | Upload the profile photo (raw image body) |
| GET | `/bookings` | customer | Own bookings, newest first |
| POST | `/bookings` | customer | Ask for a booking (creates an enquiry) |

### POST `/api/customer-app/auth/otp` 🔓

Request (`+91 98765 43210` and `09876543210` work too):
```json
{ "phone": "9876543210" }
```

Success response:
```json
{ "success": true, "message": "OTP sent." }
```

Limits per hour: 5 per phone, 20 per IP, 300 in total.

Errors:
- `400 "Enter a valid 10-digit Indian mobile number."`
- `429 "Too many OTP requests. Please try again later."`
- `502 "Couldn't send the OTP right now. Please try again."` (MSG91 failed)
- `503 "Phone sign-in isn't available right now."`

### POST `/api/customer-app/auth/verify` 🔓

Request (`name` is optional, and `null` counts as not sent. When sent it must
be 2-80 characters after trimming, and it only fills in an account that has
no name yet):
```json
{ "phone": "9876543210", "otp": "123456", "name": "Asha Verma" }
```

Success response:
```jsonc
{
  "success": true,
  "message": "Signed in.",
  "data": {
    "token": "<jwt>",
    "expiresIn": 604800,   // seconds (7 days)
    "isNewAccount": true,
    "profile": { /* same shape as GET /me */ }
  }
}
```

Signing in tags the account `products: ["wellness"]` and, when it has a name,
links it to the clinic's customer record (creating one if needed). A failed
link doesn't fail the sign-in; it is retried on the next profile save, photo or
booking.

Errors:
- `400 "Enter a valid 10-digit Indian mobile number."`
- `400 "Enter the OTP you received."` (not exactly 6 digits)
- `400 "Enter your name (2-80 characters)."` (checked before the OTP, so it isn't used up)
- `400 "Invalid or expired OTP."`
- `403 "This account is blocked."`
- `429 "Too many attempts. Please try again later."` (30 an hour per IP; per phone: 10 an hour and 30 a day)
- `502 "Couldn't verify the OTP right now. Please try again."`
- `503 "Phone sign-in isn't available right now."`

### GET `/api/customer-app/me`

Success response (missing values are `null`):
```jsonc
{
  "success": true,
  "data": {
    "accountId": "64b7f0c2a1b2c3d4e5f60718",
    "customerId": "CUST-0074",     // null until the profile has a name (or while its record belongs to another login)
    "phone": "9876543210",
    "name": "Asha Verma",
    "email": "asha@example.com",
    "gender": "female",            // "male" | "female" | "other"
    "dob": "1990-04-12",
    "age": 36,                     // from dob, never stored
    "address": "12 Lake Road, Flat 3B",
    "city": "Kolkata",
    "pincode": "700091",
    "emergencyContact": { "name": "Ravi Verma", "phone": "9876500000", "relation": "Brother" },
    "profilePhotoUrl": "https://<app>.ufs.sh/f/<key>",
    "profileComplete": true        // the account has a name
  }
}
```

### PATCH `/api/customer-app/me`

Send only the fields to change. `null` clears any field except `name`. A
blank string (spaces only counts) also clears `email`, `address` and `city`,
and `""` clears `pincode`. `name` can't be cleared, and `""` for `gender` or
`dob` is a 400. In `emergencyContact`, a `null` or blank `relation` is left
out.

```json
{ "name": "Asha Verma", "gender": "female", "dob": "1990-04-12", "city": "Kolkata" }
```

| Field | Rule |
|---|---|
| `name` | 2-80 characters |
| `email` | valid address, max 254, stored lowercase. Not verified. |
| `gender` | `"male"`, `"female"` or `"other"` |
| `dob` | `"YYYY-MM-DD"`, a real date, not in the future, at most 120 years ago |
| `address` | max 200 characters |
| `city` | max 80 characters |
| `pincode` | 6 digits, not starting with 0 |
| `emergencyContact` | `{ "name": 2-80 chars, "phone": Indian mobile, "relation"?: max 40 }` |

`name` changes the account name only. The clinic's customer record keeps the
name it was created with (staff can change it in the dashboard), because
bookings are matched to customers by phone + name. The first save with a name
creates or links that record. `email` is copied to the linked record (cleared
there as `""`).

Success response: `200 { "success": true, "message": "Profile updated.", "data": <profile> }`

Errors:
- `400` with the validation message, e.g. `"Phone can't be changed here."`, `"Nothing to update."`
- `400 "Add your name before the other details."` (the other details live on the clinic record, which needs a name; sending `name` in the same request is enough)
- `409 "That email is already used by another account."`
- `409 "Your clinic record is linked to another login. Please contact us."` (other details sent while the record for this phone + name belongs to another login; a `name` or `email` in the same request is still saved)
- `429 "Too many profile updates. Please try again later."` (20 per account per hour)

### PUT `/api/customer-app/me/photo`

The body is the raw image, max 4 MB, sent as `image/jpeg`, `image/png` or
`image/webp`. The file's own signature must match the Content-Type. The
profile needs a name first; the upload creates or links the clinic record if
needed. The replaced photo is deleted from UploadThing once the new one is
saved (best effort). Limit: 5 uploads per account per hour, checked before
the body is read.

```bash
curl -X PUT "$BASE/api/customer-app/me/photo" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: image/jpeg" \
  --data-binary @photo.jpg
```

Success response: `200 { "success": true, "message": "Photo updated.", "data": <profile> }`

Errors:
- `400 "The photo is empty."`
- `400 "That file isn't a valid image."`
- `400 "Add your name before uploading a photo."`
- `409 "Your clinic record is linked to another login. Please contact us."`
- `413 "request entity too large"` over 4 MB
- `415 "Send the photo as image/jpeg, image/png or image/webp."`
- `429 "Too many photo uploads. Please try again later."`
- `502 "Couldn't save the photo right now. Please try again."` (UploadThing failed; the old photo is kept)
- `503 "Photo upload isn't available right now."` (checked before anything is written)

### GET `/api/customer-app/bookings`

Every booking on the signed-in phone, newest first, at most 100. A shared
household number shows everyone's bookings; `patientName` says whose.

Success response:
```jsonc
{
  "success": true,
  "data": [
    {
      "enquiryId": "ENQ-0042",
      "patientName": "Asha Verma",
      "service": "Home Therapy",
      "typeOfappointment": "appointment",          // or "consultation"
      "bookingKind": "course",                     // "intake" | "course" | null
      "status": "scheduled",                       // enquiry | scheduled | ongoing | completed | cancelled
      "slot": { "date": "2026-10-05", "time": "11:30" },   // see below; null when no date or time
      "therapistName": "Dr. Reddy",
      "sessionsCompleted": 0,
      "totalSessions": 5,
      "preferredReachOutTime": { "from": "09:00", "to": "11:00" },
      "amountDue": 1500,                           // null when nothing is payable on this row (see below)
      "paymentReceived": false,
      "payToken": "3f9c...",                       // payment page: /pay/<payToken>; null on cancelled rows
      "createdAt": "2026-10-01T09:12:44.000Z"
    }
  ]
}
```

- `slot`: the visit staff scheduled (`physioSlot`) when set, else the slot
  that was asked for, field by field (date and time each fall back on their own).
- `amountDue`: the booking fee and confirmed add-ons not yet paid on this row,
  computed by the same rule as the public pay page (`payableLedger`). A course
  is billed on its first row, so follow-up rows count only their own confirmed
  add-ons. `null` means nothing is payable on this row: it is cancelled, it has
  no price yet, or it is a course follow-up with no add-ons.
- `paymentReceived`: `true` once `amountDue` is 0. When `amountDue` is `null`
  it is the stored flag, which is `false` for a new enquiry and for course
  follow-up rows (their payment is recorded on the first row).

Use `amountDue > 0` to decide whether a row is payable, and `amountDue === 0`
to show "Paid".

### POST `/api/customer-app/bookings`

Request:
```json
{
  "service": "Home Therapy",
  "preferredReachOutTime": { "from": "09:00", "to": "11:00" },
  "note": "Knee pain after a fall",
  "location": "12 Lake Road, Kolkata"
}
```

| Field | Rule |
|---|---|
| `service` | required: `"Online Consultation"`, `"Home Therapy"` or `"Vitals Check"` |
| `preferredReachOutTime` | optional `{ from, to }`, 24-hour `"HH:MM"`, `from` before `to` |
| `note` | optional, max 1000 characters |
| `vitals` | optional, `"Vitals Check"` only: up to 10 items, each max 100 characters |
| `location` | optional, max 300 characters; defaults to the profile's address, city and pincode |

The booking is stored as `status: "enquiry"`, `source: "online"`, under the
clinic record's name (else the account name), with the account's phone and
email. The clinic record is created or linked first if needed.

A request is folded into an existing booking instead of creating a new one
only when the same phone already has a booking still in `status: "enquiry"`
with the same patient name (case and spacing ignored) and the same `service`.
The new details are added to that enquiry's activity log. A different name, a
different service, or a booking staff have already scheduled always creates a
new enquiry.

Success responses:
```jsonc
// 201, new enquiry
{ "success": true, "message": "Booking received - our team will reach out shortly.", "data": { "enquiryId": "ENQ-0042", "folded": false } }
// 200, folded into the open one
{ "success": true, "message": "We already have your enquiry - we've noted your latest details.", "data": { "enquiryId": "ENQ-0041", "folded": true } }
```

Errors:
- `400` with the validation message
- `400 "Add your name to your profile first."`
- `429 "Too many bookings. Please try again later."` (10 per account per hour)

---

## Misc — `/`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | 🔓 | Health-check / welcome message |

```json
{ "message": "Welcome to the MDW Wellness Backend", "status": "success" }
```

Useful for uptime monitoring (Render pings this).
