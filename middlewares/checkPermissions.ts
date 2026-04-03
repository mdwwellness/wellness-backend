import express from "express";
import type { NextFunction, Request, Response } from "express";
import { ROLES } from "../lib/index.ts";

const checkPermission = (requiredPermission:any) => {
  return (req:Request,res:Response,next:NextFunction) => {
    const user = req.user;

    if (!user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const rolePermissions = ROLES[user.role];
    if (!rolePermissions) {
      return res.status(403).json({
        message: "Invalid role configuration",
      });
    }

    const userPermissions = new Set([
      ...rolePermissions,
      ...(user.customPermissions || []),
    ]);

    if (!userPermissions.has(requiredPermission)) {
      return res.status(403).json({
        message: `Missing permission: ${requiredPermission}`,
      });
    }

    next();
  };
};

export default checkPermission;