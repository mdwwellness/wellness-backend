import express  from "express";
import { adminRegisterUser, getAllUsers, login, logoutUser, refreshToken } from "../controllers/userController.ts";

const userRouter = express.Router();

userRouter.post("/login",login)
userRouter.post("/logout",logoutUser)
userRouter.get("/getallusers",getAllUsers)
userRouter.post("/admin/register-user",adminRegisterUser)
userRouter.post("/refresh-token",refreshToken)


export default userRouter