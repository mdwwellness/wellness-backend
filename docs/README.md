# WellnessBackend — engineering onboarding

> **Welcome.** This doc gets you productive on the WellnessBackend in under an hour.
> Read this file top to bottom, then dip into the others as you need them.

## What this service is

A small **Express 5 + Mongoose 8 + TypeScript** REST API that powers a
wellness/therapy booking platform. It is the source of truth for users
(staff + therapists), the therapist directory, appointments, and the
inbound-lead enquiry funnel.

Deployed on **Render** at `https://wellnessbackend-8fxe.onrender.com`.

There is **no public-facing UI in this repo**. The dashboard lives in a
separate Next.js app called **`WellnessFrontend`** and talks to this API
exclusively via HTTP. Treat this repo as a back-office API server.

## The two-repo layout

```
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│   WellnessFrontend  (Next.js 16, deployed on Vercel)           │
│   - /dashboard/enquiries, /dashboard/appointments, etc.        │
│   - Auth cookies stored in browser                             │
│   - "Server actions" that fetch this backend                   │
│                                                                │
└────────────────────────┬───────────────────────────────────────┘
                         │ HTTPS + JWT cookies
                         ▼
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│   WellnessBackend  (this repo, deployed on Render)             │
│   - /api/users, /api/appointments, /api/therapist, /api/metrics│
│   - Mongoose models on top of MongoDB Atlas (or local mongo)   │
│                                                                │
└────────────────────────┬───────────────────────────────────────┘
                         │
                         ▼
                    MongoDB
```

## Request lifecycle — what happens when the dashboard loads `/dashboard/enquiries`

```mermaid
sequenceDiagram
    autonumber
    participant Browser
    participant NextMW as Next.js middleware<br/>(src/middleware.ts)
    participant SA as Next.js Server Action<br/>(getAllAppointments)
    participant Express as Express (this repo)<br/>userAuth → controller
    participant Mongo as MongoDB<br/>(AppointmentBooking)

    Browser->>NextMW: GET /dashboard/enquiries<br/>(cookies: accessToken, refreshToken)
    Note over NextMW: Decodes accessToken<br/>If expired → POST /api/users/refresh-token
    NextMW->>Express: POST /api/users/refresh-token (only if access expired)
    Express-->>NextMW: new accessToken
    NextMW-->>Browser: Set-Cookie: accessToken=…; render page

    Browser->>SA: React Query mounts → useGetAllEnquiries(user)
    SA->>Express: GET /api/appointments?role=…&id=…&email=…<br/>Cookie: accessToken
    Note over Express: userAuth middleware verifies JWT<br/>and attaches req.user
    Express->>Mongo: AppointmentBooking.find({...}).sort({createdAt:-1})
    Mongo-->>Express: rows
    Express-->>SA: 200 {success:true, data:[...]}
    SA-->>Browser: hydrated React Query cache
    Browser->>Browser: render table
```

**Key things to internalize:**

1. **The frontend never talks to MongoDB directly.** Every read/write goes
   through this Express service.
2. **Auth is JWT in httpOnly cookies, not a session.** Access token lives
   15 minutes; refresh token lives 7 days and rotates per login.
3. **The Next.js middleware silently refreshes expired access tokens** by
   calling `POST /api/users/refresh-token`. The user never sees a re-login
   unless their refresh token expires too.
4. **Backend trusts `req.user`** (populated by [`middlewares/userAuth.ts`](../middlewares/userAuth.ts)
   from the verified JWT), NOT query params. Query params on the appointments
   endpoint exist for back-compat but are ignored for authz decisions.

## Auth flow detailed

```
┌──────────────┐                          ┌──────────────┐
│   Browser    │                          │   Backend    │
└──────┬───────┘                          └──────┬───────┘
       │                                         │
       │  POST /api/users/login                  │
       │  { userEmailOrPhone, userPassword }     │
       │────────────────────────────────────────▶│
       │                                         │ bcrypt.compare()
       │                                         │ generate access+refresh JWT
       │                                         │ user.refreshToken = newRefresh
       │                                         │ save()
       │  Set-Cookie: accessToken=… (15m)        │
       │  Set-Cookie: refreshToken=… (7d)        │
       │◀────────────────────────────────────────│
       │  Body: { user: {id, role, ...} }        │
       │                                         │
       │  ── 15 minutes later ──                 │
       │                                         │
       │  GET /api/anything (cookies attached)   │
       │────────────────────────────────────────▶│
       │                                         │ userAuth: jwt.verify(accessToken)
       │                                         │ → TokenExpiredError
       │  401 { code: "TOKEN_EXPIRED" }          │
       │◀────────────────────────────────────────│
       │                                         │
       │  POST /api/users/refresh-token          │
       │  (refreshToken cookie attached)         │
       │────────────────────────────────────────▶│
       │                                         │ jwt.verify(refreshToken)
       │                                         │ check it matches user.refreshToken
       │                                         │ issue new access JWT
       │  Body: { accessToken }                  │
       │◀────────────────────────────────────────│
       │                                         │
       │  Retry original GET (Next.js middleware │
       │  re-issues the cookie automatically)    │
       │                                         │
```

**JWT secrets** come from `JWT_SECRET` and `JWT_REFRESH_SECRET` env vars.
Defaults `"vivo123"` and `"vivo123refresh"` exist for local dev but you
**MUST** set real secrets in production (see [known-issues](known-issues.md#jwt-secret-fallbacks)).

## Where to look next

| Want to know… | Go to |
|---|---|
| Every HTTP endpoint, its payload shape, and what it returns | [api.md](api.md) |
| What's in each Mongoose collection + relationships between them | [models.md](models.md) |
| Security holes / bugs / dead code I should be aware of before I touch things | [known-issues.md](known-issues.md) |
| The executive enquiries dashboard feature (spec + funnel design) | the spec in `WellnessFrontend/docs/superpowers/specs/2026-05-26-executive-enquiries-dashboard-design.md` |

## Codebase tour

```
WellnessBackend/
├── server.ts              ← Express entrypoint, mounts the 4 route groups
├── controllers/           ← Business logic per route group
│   ├── userController.ts
│   ├── DoctorController.ts
│   ├── appointmentController.ts
│   └── getAnalytics.ts
├── routes/                ← Thin Express routers, mostly userAuth + controller
│   ├── userRoute.ts
│   ├── DoctorsRoute.ts
│   ├── appointmentBookingRoutes.ts
│   └── analyticsRoute.ts
├── models/                ← Mongoose schemas
│   ├── userModel.ts
│   ├── doctorsModel.ts
│   └── appointmentsBookingModel.ts
├── middlewares/
│   ├── userAuth.ts         ← JWT verification, attaches req.user
│   └── checkPermissions.ts ← Dead code: exists but is never wired. See known-issues.
├── lib/index.ts            ← PERMISSIONS + ROLES constants (also misused, see known-issues)
└── docs/                   ← (you are here)
```

Every router file follows the same pattern:

```ts
router.METHOD(path, userAuth, controllerFn);
```

The `userAuth` middleware verifies the JWT and attaches the full Mongoose
User document at `req.user`. Public endpoints (login, refresh-token) skip
this middleware.

## Local development

```bash
# 1. Install
npm install

# 2. Create .env with at minimum:
#    DATABASE_URL=mongodb://127.0.0.1:27017/wellness
#    JWT_SECRET=<random 32+ char string>
#    JWT_REFRESH_SECRET=<another random string>
#    FRONT_END_URL=http://localhost:3000
#    PORT=10000

# 3. Run
npm run start     # uses nodemon + tsx, hot-reloads on save

# 4. Sanity check
curl http://localhost:10000/
# → { "message": "Welcome to the MDW Wellness Backend", "status": "success" }
```

The frontend's `.env.local` should set `BACKEND_BASE_URL=http://localhost:10000`
to talk to your local backend instead of the deployed one.

## Production gotchas

- Render auto-deploys on every push to `main`. Cold starts can take ~30s.
- The CORS allow-list is exactly one origin: `process.env.FRONT_END_URL`.
  Multi-origin support requires code change in `server.ts`.
- `credentials: true` in CORS means cookies are sent cross-origin — only
  works if the frontend is HTTPS in production.
- The MongoDB connection string defaults to `mongodb://127.0.0.1:27017/test`
  if `DATABASE_URL` is unset — almost certainly NOT what you want in prod.
