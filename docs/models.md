# Data models

Three Mongoose collections, all in one Mongo database (the connection
string is `process.env.DATABASE_URL`).

## Relationships at a glance

```
┌─────────────┐         ┌─────────────┐
│    User     │         │   Doctor    │
│  (staff +   │         │ (therapist  │
│ therapists) │         │  directory) │
└──────┬──────┘         └──────┬──────┘
       │ userEmail              │ doctorId
       │ links to               │ assigned to
       │ Doctor.email           │
       │ when role=THERAPIST    │
       │                        │
       │                        ▼
       │              ┌────────────────────────┐
       │              │  AppointmentBooking    │
       │              │  (appointments +       │
       └─────────────▶│   enquiries — same     │
                      │   collection)          │
                      │                        │
                      │  doctorId: String      │
                      │   → Doctor.doctorId    │
                      └────────────────────────┘
```

Relationships are **soft / by-string**, not Mongoose `ref` populates.
There are no `ObjectId` cross-collection references. You match by:
- `Doctor.email === User.userEmail` (therapist → user account)
- `AppointmentBooking.doctorId === Doctor.doctorId` (appointment → therapist)

That means you can't `populate()` — you'd have to do explicit `find()` calls.

---

## User

File: [`models/userModel.ts`](../models/userModel.ts)
Collection: `users`

The User collection holds every authenticated identity — staff,
therapists, admin, customer-care. Patients/clients are NOT users (their
contact info lives on AppointmentBooking instead).

| Field | Type | Required | Notes |
|---|---|---|---|
| `_id` | ObjectId | auto | Mongo's primary key |
| `userfName` | String | yes | First name |
| `userlName` | String | yes | Last name |
| `userEmail` | String | yes, **unique** | Login identifier |
| `userPhone` | String | yes, **unique** | Alt login identifier (use either email OR phone in `userEmailOrPhone` at login) |
| `userPassword` | String | yes | bcrypt-hashed via the `pre('save')` hook. Never returned by any API. |
| `gender` | String enum | no | `"Male" \| "Female" \| "Other" \| ""` (default empty) |
| `dob` | Date | no | Default `null` |
| `isProfileComplete` | Boolean | no | Default `false`. Flipped client-side via `PUT /complete-profile` when all profile fields are populated. |
| `refreshToken` | String | no | Single-session enforcement — set on login, cleared on logout, rotated on refresh. Default `null`. |
| `role` | String enum | yes | One of `SUPER_ADMIN`, `ADMIN`, `THERAPIST`, `STAFF`, `CUSTOMER_CARE`. Default `CUSTOMER_CARE`. **`uppercase: true`** — Mongoose auto-uppercases on save. |
| `customPermissions` | String[] | no | Per-user permission grants on top of role. Only consulted by the (currently dead) `checkPermissions` middleware. |
| `isActive` | Boolean | no | Default `true`. `userAuth` middleware rejects deactivated users. |
| `passwordResetOTP` | String | no | Used by future password-reset flow (the reset endpoint is not yet implemented in this repo). |
| `passwordResetOTPExpires` | Date | no | Pair with above. |
| `createdAt`, `updatedAt` | Date | auto | Mongoose `{ timestamps: true }` |

**Important quirks:**
- Passwords are bcrypted with a salt round of 10 inside the
  `userSchema.pre("save")` hook. **If you `findOneAndUpdate` a password, it
  WON'T be hashed** — the pre-save hook doesn't run for `findOneAndUpdate`.
  Always `user.save()` after setting `userPassword`.
- The `role` field uses `uppercase: true`, so `"admin"` becomes `"ADMIN"` on
  save. That's why the `adminRegisterUser` controller `.toUpperCase()`s the
  role too — defense in depth.

---

## Doctor

File: [`models/doctorsModel.ts`](../models/doctorsModel.ts)
Collection: `doctors`

The therapist directory. Despite the model name, the product calls these
"therapists" and the routes are mounted at `/api/therapist`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `_id` | ObjectId | auto | Mongo's primary key — **rarely used directly** |
| `doctorId` | String | yes, **unique** | The business ID. All write endpoints find by this, NOT by `_id`. E.g. `"DOC-001"`. |
| `name` | String | yes | Display name (e.g. `"Dr. Reddy"`) |
| `gender` | String enum | technically optional ⚠️ | `"male" \| "female"`. The schema has a typo (`requied` instead of `required`) so the validation never fires. Treat as required at the application level. |
| `email` | String | yes | Used by `getAllAppointments` for the THERAPIST role: looks up the doctor by matching `email` to the logged-in user's `userEmail`. **Must match the corresponding User record's email for therapist-only views to work.** |
| `phonenumber` | Number | yes | 10-digit phone, stored as Number |
| `specialization` | String[] | yes | Array of therapy categories from the frontend's `THERAPY_CATEGORYES` list. |
| `isActive` | Boolean | no | Default `true`. Inactive doctors still appear in `getDoctors` but the analytics endpoint counts them as inactive. |
| `bio` | String | no | Free text |
| `createdAt`, `updatedAt` | Date | auto | Mongoose `{ timestamps: true }` |

**The doctor ↔ user link**: When a THERAPIST-role user logs in, their
`req.user.userEmail` must match a `Doctor.email` for them to see their
appointments. There's no enforced foreign-key here — if they don't match
(typo, separate accounts), the therapist sees an empty list. Worth checking
manually when onboarding a new therapist.

---

## AppointmentBooking

File: [`models/appointmentsBookingModel.ts`](../models/appointmentsBookingModel.ts)
Collection: `appointmentbookings` (Mongoose auto-pluralizes)

**This single collection serves two distinct concepts**: traditional
appointment bookings (with a slot + assigned therapist) AND inbound-lead
enquiries (no slot yet, sits in a back-office funnel). The `status` field
discriminates between them.

### Required for every record

| Field | Type | Notes |
|---|---|---|
| `name` | String, `trim: true` | Client's name |
| `phonenumber` | Number | Client's phone (numeric — no leading zero / country code support yet) |

### Identity / display

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | auto |
| `email` | String | Client's email. Used as a unique-patient key in analytics. |
| `age` | Number | Client's age |
| `location` | String | Free text (city/area) |
| `category` | String | Therapy/diet/massage category from `THERAPY_CATEGORYES` |
| `note` | String | Executive's notes |

### The booking itself

| Field | Type | Notes |
|---|---|---|
| `typeOfappointment` | enum | `"consultation" \| "appointment"` |
| `slot.date` | Date | The booked date. **Type is Date but the frontend sends `"YYYY-MM-DD"` strings — Mongoose coerces.** |
| `slot.time` | String | E.g. `"11:30"`, 24h |
| `therapyStartTime`, `therapyEndTime` | String | Free-text time strings for in-progress sessions |

### Therapist assignment

| Field | Type | Notes |
|---|---|---|
| `doctor` | String | Therapist's display name (denormalized — kept here for read perf) |
| `doctorId` | String, `ref: "Doctor"` | Therapist's `doctorId`. The `ref` is declared but not used by anything; relationships are by-string match, not Mongoose populate. |

### Status (lifecycle)

| Value | Meaning |
|---|---|
| `"enquiry"` | **DEFAULT** for new records. Sits in the back-office funnel. |
| `"scheduled"` | Slot booked, awaiting the session |
| `"ongoing"` | Session in progress |
| `"completed"` | Session done |
| `"cancelled"` | Cancelled by client or staff |

The frontend `/dashboard/appointments` page filters OUT `"enquiry"` records;
`/dashboard/enquiries` shows the whole funnel.

### Funnel checkpoint fields (new with the enquiries dashboard)

These are how the back-office tracks a lead through the funnel.

| Field | Type | Notes |
|---|---|---|
| `preferredReachOutTime.from` | String | Client's preferred contact-window start, 24h `"HH:MM"` |
| `preferredReachOutTime.to` | String | …end |
| `executiveReachedOut` | Boolean, default `false` | Has an exec called/messaged the client? |
| `executiveReachedOutAt` | Date | When |
| `consultationSlot.date` | String | `"YYYY-MM-DD"` — when the consult is booked for |
| `consultationSlot.time` | String | `"HH:MM"` 24h |
| `consultationCompleted` | Boolean, default `false` | Did the consult actually happen? |
| `consultationCompletedAt` | Date | When |
| `physioSlot.date` | String | `"YYYY-MM-DD"` — first physio session |
| `physioSlot.time` | String | `"HH:MM"` |
| `physioAssignmentConfirmed` | Boolean, default `false` | Therapist's availability verified, assignment locked in |
| `physioAssignmentConfirmedAt` | Date | When |

### Funnel stage derivation

The frontend computes a funnel stage from the booleans + slots using a
pure function (see
`WellnessFrontend/src/components/pages/enquiries/stage.ts`):

```
status="cancelled"             → cancelled
physioAssignmentConfirmed=true → assigned    (terminal happy state)
physioSlot has date+time       → physio_booked
consultationCompleted=true     → consult_done
consultationSlot has date+time → consult_booked
executiveReachedOut=true       → reached_out
else                           → enquiry     (default state)
```

The DB doesn't store the derived stage — it's recomputed on read.

### Duplicate-phone behavior

`POST /api/appointments` blocks creation if a record with the same
`phonenumber` has `status` in `["enquiry", "scheduled", "ongoing"]` (i.e.
an "open" lead). Cancelled or completed records do NOT block — clients
can be re-engaged later.

### Schema options

`{ timestamps: true, versionKey: false }` — auto `createdAt` / `updatedAt`,
no `__v` field.
