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
export const adminEditUserProfile = async (req:Request, res:Response) => {
  try {
    const {
      userId,
      userfName,
      userlName,
      userEmail,
      userPhone,
      role,
      userPassword,
    } = req.body;
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    const roleChanged = role && role !== user.role;
    if (userfName !== undefined) user.userfName = userfName;
    if (userlName !== undefined) user.userlName = userlName;
    if (userEmail !== undefined) user.userEmail = userEmail;
    if (userPhone !== undefined) user.userPhone = userPhone;
    if (role !== undefined) user.role = role;

    if (userPassword) {
      if (userPassword.length < 6) {
        return res
          .status(400)
          .json({ message: "Password must be at least 6 characters" });
      }

      user.userPassword = userPassword;
    }
    if (roleChanged) {
      user.refreshToken = "";
    }
    await user.save();
    return res.status(200).json({
      success: true,
      message: "User updated successfully",
    });
  } catch (error) {
    console.error("Admin update user error:", error);
    return res.status(500).json({
      message: "Server error",
    });
  }
};
export const completeProfile = async (req:Request, res:Response) => {
    try {
        const { userfName, userlName, userEmail, userPhone, gender, dob } = req.body;
        const userId = req.user!._id;

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }
        if (userEmail && userEmail !== user.userEmail) {
            const existingEmail = await User.findOne({ 
                userEmail, 
                _id: { $ne: userId } 
            });
            if (existingEmail) {
                return res.status(400).json({
                    success: false,
                    message: "Email already taken by another user"
                });
            }
        }
        if (userPhone && userPhone !== user.userPhone) {
            const existingPhone = await User.findOne({ 
                userPhone, 
                _id: { $ne: userId } 
            });
            if (existingPhone) {
                return res.status(400).json({
                    success: false,
                    message: "Phone number already taken by another user"
                });
            }
        }
        const updateData = {
            userfName: userfName || user.userfName,
            userlName: userlName || user.userlName,
            userEmail: userEmail || user.userEmail,
            userPhone: userPhone || user.userPhone,
            gender: gender || user.gender || "",
            dob: dob ? new Date(dob) : user.dob
        };
        const isComplete = !!(updateData.userfName && 
                             updateData.userlName && 
                             updateData.userEmail && 
                             updateData.userPhone && 
                             updateData.gender && 
                             updateData.dob);

                             const updatedUser = await User.findByIdAndUpdate(
            userId,
            updateData,
            { 
                new: true, 
                runValidators: true 
            }
        ).select("-userPassword");

        res.status(200).json({
            success: true,
            message: "Profile updated successfully",
            user: updatedUser,
            profileComplete: isComplete
        });

    } catch (error:any) {
        console.error('Complete profile error:', error);
    
        if (error.name === 'ValidationError') {
            const errors = Object.values(error.errors).map((err:any) => err.message);
            return res.status(400).json({
                success: false,
                message: "Validation error",
                errors: errors
            });
        }
        
        if (error.name === 'CastError') {
            return res.status(400).json({
                success: false,
                message: "Invalid user ID"
            });
        }

        if (error.code === 11000) {
            const field = Object.keys(error.keyPattern)[0];
            return res.status(400).json({
                success: false,
                message: `${field === 'userEmail' ? 'Email' : 'Phone number'} already exists`
            });
        }

        res.status(500).json({
            success: false,
            message: "Server error while updating profile",
            error: error.message
        });
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

export const getUserById = async (req:Request, res:Response) => {
  try {
    const { userId } = req.params;
    if (!userId.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({
        success: false,
        message: "Invalid user ID format",
      });
    }

    const user = await User.findById(userId)
      .select("-userPassword -refreshToken") 
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "User retrieved successfully",
      data: {
        user,
      },
    });
  } catch (error:any) {
    console.error("Error fetching user by ID:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching user",
      error: error.message,
    });
  }
};
export const deleteUser = async (req:Request, res:Response) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ message: "User ID required" });
    }

    const deletedUser = await User.findByIdAndDelete(userId);

    if (!deletedUser) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.status(200).json({
      success: true,
      message: "User deleted successfully",
    });
  } catch (error:any) {
    return res.status(500).json({
      message: "Server error",
      error: error.message,
    });
  }
};
