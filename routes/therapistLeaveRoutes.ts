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

// One-off date blocks
therapistLeaveRouter.get("/:doctorId", userAuth, getLeaves);
therapistLeaveRouter.post("/", userAuth, createLeave);
therapistLeaveRouter.delete("/:id", userAuth, deleteLeave);

export default therapistLeaveRouter;
