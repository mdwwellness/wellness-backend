import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import mongoose from "mongoose";
import cookieParser from "cookie-parser";
import appointmentRouter from "./routes/appointmentBookingRoutes.ts";
import doctorRouter from "./routes/DoctorsRoute.ts";
import analyticsRoute from "./routes/analyticsRoute.ts";
import userRouter from "./routes/userRoute.ts";
import serviceRouter from "./routes/serviceRoutes.ts";

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

const connect = async () => {
  try {
    await mongoose.connect(
      process.env.DATABASE_URL || "mongodb://127.0.0.1:27017/test",
    );
    console.log("Connected to MongoDB");
  } catch (error) {
    console.error("MongoDB connection error:", error);
    process.exit(1);
  }
};

mongoose.connection.on("disconnect", () => {
  console.log("MongoDB disconnected");
});

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
// Start server
app.listen(process.env.PORT || 10000, () => {
  connect().then(() => {
    console.log(
      "Connected to backend. Running on port " + (process.env.PORT || 10000),
    );
  });
});
