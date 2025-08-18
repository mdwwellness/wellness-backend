import express from "express"
import dotenv from "dotenv"
import cors from "cors"
import mongoose from "mongoose";
import appointmentRouter from "./routes/appointmentBookingRoutes.ts";
import doctorRouter from "./routes/DoctorsRoute.ts";
dotenv.config();

const app = express();
app.use(cors())
app.use(express.json());
//connection to mongodb
const connect = async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL || "mongodb://127.0.0.1:27017/test")
    console.log('Connected to MongoDB')
  } catch (error) {
    console.log(error);
    throw error
  }
}
mongoose.connection.on("disconnect",()=>{
  console.log("Mongodb disconnected");
})

app.use("/api/appointments",appointmentRouter)
app.use("/api/adddoctor",doctorRouter)

app.listen(process.env.PORT ||  5000, () => {
  connect();
  console.log('Connected to backend')
})
