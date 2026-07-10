import express from "express";
import type { NextFunction, Request, Response } from "express";

const requireRole = (...roles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.user;

    if (!user) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    if (!roles.includes(user.role)) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: insufficient role",
      });
    }

    next();
  };
};

export default requireRole;
