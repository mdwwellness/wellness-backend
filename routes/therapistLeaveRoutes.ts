import express from "express";
import {
  getLeaves,
  createLeave,
  deleteLeave,
  updateWeekOffDays,
} from "../controllers/therapistLeaveController.ts";
import userAuth from "../middlewares/userAuth.ts";

const therapistLeaveRouter = express.Router();

// Weekly off-days (recurring schedule)
therapistLeaveRouter.patch("/week-off/:doctorId", userAuth, updateWeekOffDays);

// All leaves (optionally filter by ?doctorId=xxx or ?date=yyyy-mm-dd)
therapistLeaveRouter.get("/", userAuth, getLeaves);
// Leaves for a specific therapist
therapistLeaveRouter.get("/:doctorId", userAuth, getLeaves);
therapistLeaveRouter.post("/", userAuth, createLeave);
therapistLeaveRouter.delete("/:id", userAuth, deleteLeave);

export default therapistLeaveRouter;
