import jwt from "jsonwebtoken";
import User from "../models/userModel.ts";

const superAdminAuth = async (req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => {
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
      return res.status(401).json({ message: "User no longer exists" });
    }

    if (user.role !== "SUPER_ADMIN") {
      return res.status(403).json({ message: "Super admin access required" });
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

export default superAdminAuth;