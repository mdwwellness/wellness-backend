import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import mongoose from "mongoose";
import cookieParser from "cookie-parser";
import appointmentRouter from "./routes/appointmentBookingRoutes.ts";
import doctorRouter from "./routes/DoctorsRoute.ts";
import analyticsRoute from "./routes/analyticsRoute.ts";
import userRouter from "./routes/userRoute.ts";

dotenv.config();

const app = express();
app.use(
  cors({
    origin: process.env.FRONT_END_URL,
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
