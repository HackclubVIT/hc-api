import prisma from "../../../prismaClient.js";
import { getSession } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";
import { getISTDateBounds } from "../lib/timezone.js";
import { z } from "zod";

const panelSchema = z.object({
  name: z.string().min(2),
  description: z.string().optional(),
});

const panelUpdateSchema = panelSchema.extend({
  id: z.number().int().positive(),
  status: z.enum(["ACTIVE", "INACTIVE"])
});

export const getPanels = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || !["ADMIN", "RECRUITER"].includes(session.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const whereClause = session.role === "RECRUITER" ? { status: "ACTIVE" } : {};

    const panels = await prisma.recruitmentPanel.findMany({
      where: whereClause,
      include: {
        members: {
          include: { user: { select: { name: true, email: true } } }
        }
      },
      orderBy: { created_at: 'desc' }
    });

    const formattedPanels = panels.map(p => ({
      ...p,
      members: p.members.map(m => ({
        ...m,
        user_id: m.user_id.toString()
      }))
    }));

    return res.status(200).json({ panels: formattedPanels });
  } catch (error) {
    console.error("Fetch panels error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const createPanel = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || session.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const parsed = panelSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid panel data", details: parsed.error.format() });
    }

    const { name, description } = parsed.data;

    const panel = await prisma.recruitmentPanel.create({
      data: { name, description },
    });

    await logAudit(session.id, "CREATED_PANEL", "Panel", panel.id);

    return res.status(201).json({ panel });
  } catch (error) {
    console.error("Create panel error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const updatePanel = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || session.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const parsed = panelUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid panel update data", details: parsed.error.format() });
    }

    const { id, name, description, status } = parsed.data;

    const panel = await prisma.recruitmentPanel.update({
      where: { id },
      data: { name, description, status }
    });

    await logAudit(session.id, "UPDATED_PANEL", "Panel", panel.id);

    return res.status(200).json({ panel });
  } catch (error) {
    console.error("Update panel error:", error);
    if (error && error.code === 'P2025') {
      return res.status(404).json({ error: "Panel not found" });
    }
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const deletePanel = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || session.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ error: "Missing panel ID" });
    }

    const panelRelations = await prisma.recruitmentPanel.findUnique({
      where: { id },
      include: { interviews: { take: 1 } }
    });

    if (!panelRelations) {
      return res.status(404).json({ error: "Panel not found" });
    }

    if (panelRelations.interviews.length > 0) {
      await prisma.recruitmentPanel.update({
        where: { id },
        data: { status: "INACTIVE" }
      });
      await logAudit(session.id, "DEACTIVATED_PANEL", "Panel", id);
      return res.status(200).json({ success: true, message: "Panel deactivated because it has historical interviews." });
    }

    await prisma.recruitmentPanelMember.deleteMany({
      where: { panel_id: id }
    });

    await prisma.recruitmentPanel.delete({
      where: { id }
    });

    await logAudit(session.id, "DELETED_PANEL", "Panel", id);

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Delete panel error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const addPanelMember = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || session.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { panel_id, user_id } = req.body;
    if (!panel_id || !user_id) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const userId = BigInt(user_id);

    const panel = await prisma.recruitmentPanel.findUnique({ where: { id: panel_id } });
    if (!panel) {
      return res.status(404).json({ error: "Panel not found" });
    }
    if (panel.status !== "ACTIVE") {
      return res.status(400).json({ error: "Cannot add members to an inactive panel" });
    }

    const roleAssignment = await prisma.recruitmentRoleAssignment.findUnique({ 
      where: { user_id: userId } 
    });
    
    if (!roleAssignment || roleAssignment.role !== "PANEL_MEMBER") {
      return res.status(400).json({ error: "User is not a Panel Member" });
    }
    if (!roleAssignment.active) {
      return res.status(400).json({ error: "Cannot add inactive user to panel" });
    }

    const existing = await prisma.recruitmentPanelMember.findFirst({
      where: { panel_id, user_id: userId }
    });
    
    let member;
    if (existing) {
      if (existing.active) {
        return res.status(409).json({ error: "User already in panel" });
      } else {
        member = await prisma.recruitmentPanelMember.update({
          where: { id: existing.id },
          data: { active: true }
        });
      }
    } else {
      member = await prisma.recruitmentPanelMember.create({
        data: { panel_id, user_id: userId }
      });
    }

    await logAudit(session.id, "ADDED_PANEL_MEMBER", "PanelMember", member.id.toString());

    return res.status(201).json({ member: { ...member, user_id: member.user_id.toString() } });
  } catch (error) {
    console.error("Add panel member error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const removePanelMember = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || session.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { panel_id, user_id } = req.body;
    if (!panel_id || !user_id) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const userId = BigInt(user_id);

    const member = await prisma.recruitmentPanelMember.findFirst({
      where: { panel_id, user_id: userId, active: true }
    });

    if (!member) {
      return res.status(404).json({ error: "Member not found in panel" });
    }

    await prisma.recruitmentPanelMember.update({
      where: { id: member.id },
      data: { active: false }
    });

    await logAudit(session.id, "REMOVED_PANEL_MEMBER", "PanelMember", member.id.toString());

    return res.status(200).json({ message: "Member removed" });
  } catch (error) {
    console.error("Remove panel member error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const getPanelDashboard = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || session.role !== "PANEL_MEMBER") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { startOfDay: startOfToday, endOfDay: endOfToday, endOfWeek } = getISTDateBounds();

    const todayInterviewsCount = await prisma.recruitmentInterview.count({
      where: {
        date: {
          gte: startOfToday,
          lte: endOfToday
        },
        status: { not: "CANCELLED" },
        assigned_members: {
          some: { user_id: BigInt(session.id) }
        }
      }
    });

    const upcomingInterviewsCount = await prisma.recruitmentInterview.count({
      where: {
        date: {
          gt: endOfToday,
          lte: endOfWeek
        },
        status: { not: "CANCELLED" },
        assigned_members: {
          some: { user_id: BigInt(session.id) }
        }
      }
    });

    const panelMemberRows = await prisma.recruitmentPanelMember.findMany({
      where: { user_id: BigInt(session.id) }
    });
    const panelMemberIds = panelMemberRows.map(pm => pm.id);

    const pendingFeedbackCount = await prisma.recruitmentInterview.count({
      where: {
        status: { in: ["COMPLETED", "FEEDBACK_PENDING"] },
        assigned_members: {
          some: { user_id: BigInt(session.id) }
        },
        NOT: {
          feedback: {
            some: {
              panel_member_id: { in: panelMemberIds }
            }
          }
        }
      }
    });

    const todaySchedule = await prisma.recruitmentInterview.findMany({
      where: {
        date: {
          gte: startOfToday,
          lte: endOfToday
        },
        status: { not: "CANCELLED" },
        assigned_members: {
          some: { user_id: BigInt(session.id) }
        }
      },
      include: {
        application: {
          select: {
            id: true,
            name: true,
            email: true,
            domain: true,
            registerNumber: true
          }
        }
      },
      orderBy: {
        start_time: 'asc'
      }
    });

    const mappedSchedule = todaySchedule.map(i => ({
      ...i,
      application_id: i.application_id.toString(),
      candidate: i.application ? {
        id: i.application.id.toString(),
        name: i.application.name,
        email: i.application.email,
        department: i.application.domain,
        registration_number: i.application.registerNumber
      } : undefined
    }));

    return res.status(200).json({
      stats: {
        todayInterviewsCount,
        upcomingInterviewsCount,
        pendingFeedbackCount
      },
      todaySchedule: mappedSchedule
    });
  } catch (error) {
    console.error("Panel dashboard error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
