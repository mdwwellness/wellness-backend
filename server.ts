import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import mongoose from "mongoose";

import appointmentRouter from "./routes/appointmentBookingRoutes.ts";
import doctorRouter from "./routes/DoctorsRoute.ts";
import analyticsRoute from "./routes/analyticsRoute.ts";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// MongoDB connection
const connect = async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL || "mongodb://127.0.0.1:27017/test");
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
app.use('/api/metrics', analyticsRoute);
app.use("/api/appointments", appointmentRouter);
app.use("/api/therapist", doctorRouter);
app.get('/',(rreq,res)=>{
  res.send("Hello there")
})
// Start server
app.listen(process.env.PORT || 10000, () => {
  connect().then(() => {
    console.log("Connected to backend");
  });
});
