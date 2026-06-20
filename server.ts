import express from "express";
import type { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";
import cors from "cors";
import mongoose from "mongoose";
import cookieParser from "cookie-parser";
import appointmentRouter from "./routes/appointmentBookingRoutes.ts";
import doctorRouter from "./routes/DoctorsRoute.ts";
import analyticsRoute from "./routes/analyticsRoute.ts";
import userRouter from "./routes/userRoute.ts";
import serviceRouter from "./routes/serviceRoutes.ts";
import { logger } from "./lib/logger.ts";

dotenv.config();

const app = express();
const allowedOrigins = [
  process.env.FRONT_END_URL, // back-office dashboard (prod)
  process.env.PUBLIC_SITE_URL, // public mdw patient site (prod)
].filter(Boolean) as string[];

// Any localhost / 127.0.0.1 port is allowed for local dev (e.g. dashboard on
// :3000, patient site on :3003). The browser sets Origin, so only pages truly
// served from localhost match — safe to allow.
const isLocalhost = (origin: string) =>
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

app.use(
  cors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      // No Origin header = same-origin / server-to-server (e.g. curl) — allow.
      if (!origin || isLocalhost(origin) || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin ${origin} not allowed`));
      }
    },
    credentials: true,
  }),
);
app.use(cookieParser());
app.use(express.json());

// ── Request logger: one line per request with status + duration ──
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    const line = `${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)`;
    if (res.statusCode >= 500) logger.error(line);
    else if (res.statusCode >= 400) logger.warn(line);
    else logger.info(line);
  });
  next();
});

// Optional deep DB logging: set LOG_DB=true on Render to log every Mongo query.
if (process.env.LOG_DB === "true") {
  mongoose.set(
    "debug",
    (collection: string, method: string, ...args: unknown[]) => {
      logger.info(`db ${collection}.${method}`, args[0]);
    },
  );
}

const connect = async () => {
  try {
    await mongoose.connect(
      process.env.DATABASE_URL || "mongodb://127.0.0.1:27017/test",
    );
  } catch (error) {
    logger.error("MongoDB initial connection failed — exiting", error);
    process.exit(1);
  }
};

mongoose.connection.on("connected", () => logger.info("MongoDB connected"));
mongoose.connection.on("error", (err) => logger.error("MongoDB error", err));
mongoose.connection.on("disconnected", () =>
  logger.warn("MongoDB disconnected"),
);

// Routes
app.use("/api/metrics", analyticsRoute);
app.use("/api/users", userRouter);
app.use("/api/appointments", appointmentRouter);
app.use("/api/therapist", doctorRouter);
app.use("/api/services", serviceRouter);
app.get("/", (req, res) => {
  res.json({
    message: "Welcome to the MDW Wellness Backend",
    status: "success",
  });
});
// ── Catch-all error handler: logs any thrown/rejected error from a route
//    (Express 5 forwards async errors here) so failures show up in the logs. ──
app.use(
  (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    logger.error(`Unhandled error on ${req.method} ${req.originalUrl}`, err);
    if (res.headersSent) return;
    res.status(500).send({ success: false, message: "Server error" });
  },
);

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  logger.info(`Backend listening on port ${PORT}`);
  connect();
});
