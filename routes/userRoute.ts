import express from "express";
import {
  adminRegisterUser,
  completeProfile,
  deleteUser,
  getAllUsers,
  login,
  logoutUser,
  refreshToken,
} from "../controllers/userController.ts";
import userAuth from "../middlewares/userAuth.ts";
const userRouter = express.Router();

userRouter.post("/login", login);
userRouter.post("/logout", userAuth, logoutUser);
userRouter.post("/refresh-token", refreshToken);
userRouter.get("/getallusers", userAuth, getAllUsers);
userRouter.put("/complete-profile", userAuth, completeProfile);
userRouter.delete("/admin/delete-user", userAuth, deleteUser);
userRouter.post("/admin/register-user", userAuth, adminRegisterUser);

export default userRouter;
