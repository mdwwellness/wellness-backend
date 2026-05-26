# MyDawaiWala — Wellness Backend

Express 5 + Mongoose 8 + TypeScript REST API powering the MDW wellness /
therapy booking platform. Deployed on Render at
`https://wellnessbackend-8fxe.onrender.com`.

## 📚 Documentation

| Doc | What's in it |
|---|---|
| [`docs/README.md`](docs/README.md) | **Start here.** Architecture, request lifecycle, auth flow, local setup. |
| [`docs/api.md`](docs/api.md) | Every HTTP endpoint with request / response examples. |
| [`docs/models.md`](docs/models.md) | Mongoose schemas (User, Doctor, AppointmentBooking) + relationships. |
| [`docs/known-issues.md`](docs/known-issues.md) | Security holes, bugs, dead code. **Read before making changes.** |

## Quick start

```bash
npm install
# Set .env (see docs/README.md → Local development for required vars)
npm run start          # nodemon + tsx, hot-reloads on save
curl http://localhost:10000/  # health check
```

## Repo layout

```
├── server.ts        # Express entrypoint
├── controllers/     # business logic
├── routes/          # thin Express routers
├── models/          # Mongoose schemas
├── middlewares/     # userAuth (active) + checkPermissions (dead)
├── lib/             # PERMISSIONS + ROLES constants
└── docs/            # ← onboarding documentation
```

## Sister repo

The frontend dashboard that consumes this API lives in
**`WellnessFrontend`** (Next.js 16, deployed on Vercel).
