import jwt from "jsonwebtoken";
import User from "../models/userModel.ts";
import bcrypt from "bcryptjs";
import { ROLES } from "../lib/index.ts";
import { Request, Response } from "express";

const generateAccessToken = (userId: string) => {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET || "vivo123", {
    expiresIn: "15m",
  });
};

const generateRefreshToken = (userId: string) => {
  return jwt.sign(
    { id: userId },
    process.env.JWT_REFRESH_SECRET || "vivo123refresh",
    {
      expiresIn: "7d", // Long-lived refresh token
    },
  );
};

export const refreshToken = async (req: Request, res: Response) => {
  try {
    const refreshToken = req.cookies.refreshToken;
    if (!refreshToken)
      return res.status(401).json({ message: "Refresh token required" });

    const decoded = jwt.verify(
      refreshToken,
      process.env.JWT_REFRESH_SECRET || "vivo123refresh",
    ) as jwt.JwtPayload;

    const user = await User.findById(decoded.id);

    if (!user || user.refreshToken !== refreshToken) {
      return res.status(403).json({ message: "Invalid refresh token" });
    }

    // Rotate tokens (important for security)
    const newAccessToken = generateAccessToken(user._id.toString());

    res.json({
      success: true,
      accessToken: newAccessToken,
      refreshToken: refreshToken,
    });
  } catch (err) {
    console.log(err);
    return res
      .status(403)
      .json({ message: "Expired or invalid refresh token" });
  }
};

export const login = async (req: Request, res: Response) => {
  try {
    const { userEmailOrPhone, userPassword } = req.body;
    const user = await User.findOne({
      $or: [{ userEmail: userEmailOrPhone }, { userPhone: userEmailOrPhone }],
    });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const isMatch = await bcrypt.compare(userPassword, user.userPassword);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const accessToken = generateAccessToken(user._id.toString());
    const refreshToken = generateRefreshToken(user._id.toString());
    user.refreshToken = refreshToken;
    await user.save();
    const basePermissions = ROLES[user.role] || [];
    const finalPermissions = [
      ...new Set([...basePermissions, ...(user.customPermissions || [])]),
    ];
    res.cookie("accessToken", accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 15 * 60 * 1000, // 15 Minutes
    });

    res.cookie("refreshToken", user.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 Days
    });

    res.status(200).json({
      success: true,
      message: "Login successful",
      user: {
        id: user._id,
        userfName: user.userfName,
        userlName: user.userlName,
        userEmail: user.userEmail,
        userPhone: user.userPhone,
        gender: user.gender,
        dob: user.dob,
        role: user.role,
        permissions: finalPermissions,
        isActive: user.isActive,
        isProfileComplete: user.isProfileComplete,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
    });
  } catch (error: any) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

export const logoutUser = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;

    if (userId) {
      await User.findByIdAndUpdate(userId, {
        $unset: { refreshToken: 1 },
      });
    }
    res.status(200).json({
      success: true,
      message: "Logged out successfully",
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

export const adminRegisterUser = async (req: Request, res: Response) => {
  try {
    const { userfName,userlName, userEmail, userPhone, userPassword, role } = req.body;

    if (!role) {
      return res.status(400).json({
        message: "Role is required for admin user creation",
      });
    }
    const existingUserEmail = await User.findOne({ userEmail });
    const existingUserPhone = await User.findOne({ userPhone });
    if (existingUserEmail || existingUserPhone) {
      return res.status(400).json({
        message: "User already exists with this email or phone number",
      });
    }
    const validRoles = [
      "SUPER_ADMIN",
      "ADMIN",
      "THERAPIST",
      "STAFF",
      "CUSTOMER_CARE",
    ];
    const userRole =
      role && validRoles.includes(role.toUpperCase())
        ? role.toUpperCase()
        : "CUSTOMER";

    const newUser = new User({
      userfName,
      userlName,
      userEmail,
      userPhone,
      userPassword,
      role: userRole,
    });
    await newUser.save();

    res.status(201).json({
      success: true,
      message: "User registered successfully",
      user: {
        id: newUser._id,
        userfName: newUser.userfName,
        userlName: newUser.userlName,
        userEmail: newUser.userEmail,
        userPhone: newUser.userPhone,
        role: newUser.role,
      },
    });
  } catch (error: any) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

export const getAllUsers = async (req: Request, res: Response) => {
  try {
    const search = req.query.search || "";
    const searchQuery = {
      $or: [
        { userfName: { $regex: search, $options: "i" } },
        { userlName: { $regex: search, $options: "i" } },
        { userEmail: { $regex: search, $options: "i" } },
        { userPhone: { $regex: search, $options: "i" } },
      ],
    };
    const users = await User.find(searchQuery)
      .select("-userPassword -refreshToken") // Exclude sensitive fields
      .sort({ createdAt: -1 }) // Sort by newest first
      .lean(); // Convert to plain JavaScript objects for better performance

    res.status(200).json({
      success: true,
      message: "Users retrieved successfully",
      data: {
        users,
      },
    });
  } catch (error: any) {
    console.error("Error fetching users:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching users",
      error: error.message,
    });
  }
};
