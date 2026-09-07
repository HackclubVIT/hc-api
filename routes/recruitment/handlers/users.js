import prisma from "../../../prismaClient.js";
import { getSession } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";
import bcrypt from "bcryptjs";
import { z } from "zod";

const createSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  email: z.string().trim().email("Valid email is required"),
  password: z.string().trim().min(6, "Password must be at least 6 characters").optional(),
  role: z.enum(["ADMIN", "RECRUITER", "PANEL_MEMBER", "NONE"]).default("PANEL_MEMBER"),
  departments: z.array(z.string()).optional().default([]),
  registerNumber: z.string().trim().nullable().optional(),
  phoneNumber: z.string().trim().nullable().optional(),
  department: z.string().trim().nullable().optional(),
  active: z.boolean().optional().default(true)
});

const updateSchema = z.object({
  id: z.string(),
  role: z.enum(["ADMIN", "RECRUITER", "PANEL_MEMBER", "NONE"]),
  departments: z.array(z.string()).optional(),
  active: z.boolean().optional()
});

export const getUsers = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || session.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const searchParams = new URLSearchParams(req.query);
    const search = searchParams.get("q") || "";

    const where = {};
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { registerNumber: { contains: search, mode: "insensitive" } }
      ];
    }

    const users = await prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        email: true,
        registerNumber: true,
        department: true,
        status: true,
        recruitmentRole: {
          select: {
            role: true,
            departments: true,
            active: true
          }
        }
      },
    });

    const formattedUsers = users.map(u => ({
      id: u.id.toString(),
      name: u.name,
      email: u.email,
      registerNumber: u.registerNumber,
      hcDepartment: u.department,
      status: u.status,
      role: u.recruitmentRole?.role || "NONE",
      departments: u.recruitmentRole?.departments || [],
      active: u.recruitmentRole?.active ?? true
    }));

    return res.status(200).json({ users: formattedUsers });
  } catch (error) {
    console.error("Fetch users error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const updateUser = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || session.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid user data", details: parsed.error.format() });
    }

    const { id, role, departments, active } = parsed.data;
    const userId = BigInt(id);

    const existingUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!existingUser) {
      return res.status(404).json({ error: "HC User not found" });
    }

    const assignment = await prisma.recruitmentRoleAssignment.upsert({
      where: { user_id: userId },
      update: {
        role,
        departments: departments || [],
        active: active !== undefined ? active : true
      },
      create: {
        user_id: userId,
        role,
        departments: departments || [],
        active: active !== undefined ? active : true
      }
    });

    if (role !== "PANEL_MEMBER") {
      await prisma.recruitmentPanelMember.updateMany({
        where: { user_id: userId },
        data: { active: false }
      });
    }

    await logAudit(session.id, "UPDATED_RECRUITMENT_ROLE", "RecruitmentRoleAssignment", assignment.id.toString());

    return res.status(200).json({ 
      user: {
        id: id,
        role: assignment.role,
        departments: assignment.departments,
        active: assignment.active
      } 
    });
  } catch (error) {
    console.error("Update user error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const createUser = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || session.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid user data", details: parsed.error.format() });
    }

    const { name, email, password, role, departments, registerNumber, phoneNumber, department, active } = parsed.data;
    const cleanEmail = email.toLowerCase();

    // Check if user already exists
    let existingUser = await prisma.user.findFirst({
      where: { email: { equals: cleanEmail, mode: "insensitive" } },
      include: { recruitmentRole: true }
    });

    if (existingUser) {
      // User exists in HC database. Assign or update recruitment role.
      const assignment = await prisma.recruitmentRoleAssignment.upsert({
        where: { user_id: existingUser.id },
        update: {
          role,
          departments: departments || [],
          active: active !== undefined ? active : true
        },
        create: {
          user_id: existingUser.id,
          role,
          departments: departments || [],
          active: active !== undefined ? active : true
        }
      });

      // Update password if provided
      if (password) {
        const hashedPassword = await bcrypt.hash(password, 10);
        await prisma.user.update({
          where: { id: existingUser.id },
          data: { password: hashedPassword }
        });
      }

      await logAudit(session.id, "ASSIGNED_RECRUITMENT_ROLE", "User", existingUser.id.toString());

      return res.status(200).json({
        message: "Existing user assigned recruitment role successfully",
        user: {
          id: existingUser.id.toString(),
          name: existingUser.name,
          email: existingUser.email,
          registerNumber: existingUser.registerNumber,
          hcDepartment: existingUser.department,
          status: existingUser.status,
          role: assignment.role,
          departments: assignment.departments,
          active: assignment.active
        }
      });
    }

    // New user: hash password (or default initial password)
    const emailPrefix = cleanEmail.split('@')[0];
    const initialPassword = password || `hackclub@${emailPrefix}`;
    const hashedPassword = await bcrypt.hash(initialPassword, 10);

    const newUserId = BigInt(Date.now() + Math.floor(Math.random() * 100000));

    const newUser = await prisma.user.create({
      data: {
        id: newUserId,
        name,
        email: cleanEmail,
        password: hashedPassword,
        registerNumber: registerNumber || null,
        phoneNumber: phoneNumber || null,
        department: department || null,
        role: "Member",
        status: "Active",
        recruitmentRole: {
          create: {
            role,
            departments: departments || [],
            active: active !== undefined ? active : true
          }
        }
      },
      include: {
        recruitmentRole: true
      }
    });

    await logAudit(session.id, "CREATED_USER", "User", newUser.id.toString());

    return res.status(201).json({
      message: "User created successfully",
      user: {
        id: newUser.id.toString(),
        name: newUser.name,
        email: newUser.email,
        registerNumber: newUser.registerNumber,
        hcDepartment: newUser.department,
        status: newUser.status,
        role: newUser.recruitmentRole?.role || "NONE",
        departments: newUser.recruitmentRole?.departments || [],
        active: newUser.recruitmentRole?.active ?? true
      }
    });
  } catch (error) {
    console.error("Create user error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const deleteUser = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || session.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ error: "Missing user ID" });
    }

    if (session.id === id) {
      return res.status(400).json({ error: "Cannot deactivate yourself" });
    }

    let userId;
    try {
      userId = BigInt(id);
    } catch (e) {
      return res.status(400).json({ error: "Invalid user ID" });
    }

    await prisma.recruitmentRoleAssignment.update({
      where: { user_id: userId },
      data: { active: false, role: 'NONE' }
    });
    
    await prisma.recruitmentPanelMember.updateMany({
      where: { user_id: userId },
      data: { active: false }
    });
    
    await logAudit(session.id, "DEACTIVATED_RECRUITMENT_ROLE", "User", id);
    return res.status(200).json({ success: true, message: "User recruitment access deactivated." });
  } catch (error) {
    console.error("Deactivate user error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
