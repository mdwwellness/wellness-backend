import jwt from "jsonwebtoken";
import User from "../models/userModel.ts";
import express from "express";
import type { NextFunction, Request, Response } from "express";

declare global {
  namespace Express {
    interface Request {
      user?: InstanceType<typeof User>;
    }
  }
}
const userAuth = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token =
    req.cookies?.accessToken || req.headers.authorization?.split(" ")[1];
    if (!token) {
      return res.status(401).json({
        message: "Authentication failed: No token provided",
      });
    }

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET!,
    ) as jwt.JwtPayload;

    const user = await User.findById(decoded.id).select("-userPassword");

    if (!user) {
      return res.status(404).json({ message: "User no longer exists" });
    }

    if (!user.isActive) {
      return res.status(403).json({ message: "User account is deactivated" });
    }

    req.user = user;
    next();
  } catch (error: any) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        message: "Token expired",
        code: "TOKEN_EXPIRED",
      });
    }
    return res.status(401).json({ message: "Invalid token" });
  }
};

export default userAuth;
