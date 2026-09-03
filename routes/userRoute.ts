import express from "express";
import {
  adminEditUserProfile,
  adminRegisterUser,
  changePassword,
  completeProfile,
  deleteUser,
  forgotPassword,
  getAllUsers,
  login,
  logoutUser,
  refreshToken,
  resetPassword,
} from "../controllers/userController.ts";
import userAuth from "../middlewares/userAuth.ts";
import requireRole from "../middlewares/requireRole.ts";
const userRouter = express.Router();

userRouter.post("/login", login);
userRouter.post("/forgot-password", forgotPassword);
userRouter.post("/reset-password", resetPassword);
userRouter.post("/logout", userAuth, logoutUser);
userRouter.post("/refresh-token", refreshToken);
userRouter.get("/getallusers", userAuth, getAllUsers);
userRouter.put("/complete-profile", userAuth, completeProfile);
userRouter.put("/change-password", userAuth, changePassword);
userRouter.delete(
  "/admin/delete-user",
  userAuth,
  requireRole("SUPER_ADMIN", "ADMIN"),
  deleteUser,
);
userRouter.patch(
  "/admin/update-user",
  userAuth,
  requireRole("SUPER_ADMIN", "ADMIN"),
  adminEditUserProfile,
);
userRouter.post(
  "/admin/register-user",
  userAuth,
  requireRole("SUPER_ADMIN", "ADMIN"),
  adminRegisterUser,
);

export default userRouter;
