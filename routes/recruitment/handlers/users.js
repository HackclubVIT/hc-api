import prisma from "../../../prismaClient.js";
import { getSession } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";
import { z } from "zod";

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

    const userId = BigInt(id);

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
