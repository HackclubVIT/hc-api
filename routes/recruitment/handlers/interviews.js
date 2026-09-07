import prisma from "../../../prismaClient.js";
import { getSession } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";
import { createNotification } from "../lib/notify.js";
import { sendEmail, templates } from "../lib/email.js";
import { parseISTDateToUTC, getISTDateBounds, toISTDateString, toISTTimeString } from "../lib/timezone.js";
import { z } from "zod";

const VALID_INTERVIEW_STATUSES = ["SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "FEEDBACK_PENDING", "FEEDBACK_SUBMITTED"];

const VALID_STATUS_TRANSITIONS = {
  "SCHEDULED": ["IN_PROGRESS", "COMPLETED", "CANCELLED"],
  "IN_PROGRESS": ["COMPLETED", "CANCELLED"],
  "COMPLETED": ["FEEDBACK_PENDING"],
  "FEEDBACK_PENDING": ["FEEDBACK_SUBMITTED"],
  "CANCELLED": [],
  "FEEDBACK_SUBMITTED": []
};

const scheduleSchema = z.object({
  application_id: z.string(),
  panel_id: z.number().int().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "Invalid date format, use YYYY-MM-DD" }),
  start_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, { message: "Invalid time format, use HH:MM (00:00 - 23:59)" }),
  meeting_link: z.string().url().optional().or(z.literal(''))
});

export const getInterviews = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || session.role === "NONE") {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const searchParams = new URLSearchParams(req.query);
    const page = Math.max(1, parseInt(searchParams.get("page") || "1") || 1);
    const limit = Math.min(200, Math.max(1, parseInt(searchParams.get("limit") || "100") || 100));
    const skip = (page - 1) * limit;

    const dateParam = searchParams.get("date");
    const panelIdParam = searchParams.get("panel_id");
    const statusParam = searchParams.get("status");

    let whereClause = {};

    if (session.role === "PANEL_MEMBER") {
      whereClause = {
        assigned_members: {
          some: { user_id: BigInt(session.id) }
        }
      };
    } else if (session.role === "RECRUITER") {
      whereClause = {
        application: {
          domain: { in: session.departments }
        }
      };
    }

    if (dateParam) {
      const { startOfDay, endOfDay } = getISTDateBounds(dateParam);
      whereClause.date = {
        gte: startOfDay,
        lte: endOfDay
      };
    }

    if (panelIdParam && !isNaN(parseInt(panelIdParam, 10))) {
      whereClause.panel_id = parseInt(panelIdParam, 10);
    }

    if (statusParam && statusParam !== "ALL") {
      whereClause.status = statusParam;
    }

    const includeClause = {
      panel: {
        include: {
          members: {
            include: {
              user: {
                select: { id: true, name: true, email: true }
              }
            }
          }
        }
      },
      assigned_members: {
        include: {
          user: {
            select: { id: true, name: true, email: true }
          }
        }
      }
    };

    if (session.role === "PANEL_MEMBER") {
      includeClause.application = {
        select: {
          id: true,
          name: true,
          email: true,
          domain: true,
          registerNumber: true,
        }
      };
    } else {
      includeClause.application = true;
    }

    const [interviews, total] = await Promise.all([
      prisma.recruitmentInterview.findMany({
        where: whereClause,
        include: includeClause,
        orderBy: [{ date: 'asc' }, { start_time: 'asc' }],
        skip,
        take: limit
      }),
      prisma.recruitmentInterview.count({ where: whereClause })
    ]);

    const formattedInterviews = interviews.map((i) => {
      const interview = {
        ...i,
        application_id: i.application_id.toString(),
        recruiter_id: i.recruiter_id ? i.recruiter_id.toString() : null,
        assigned_members: (i.assigned_members || []).map(m => ({
          ...m,
          user_id: m.user_id ? m.user_id.toString() : null,
          user: m.user ? {
            ...m.user,
            id: m.user.id ? m.user.id.toString() : undefined
          } : null
        }))
      };
      if (interview.application) {
         interview.application = {
           ...interview.application,
           id: interview.application.id.toString(),
           decided_by: interview.application.decided_by ? interview.application.decided_by.toString() : null,
         };
      }
      return interview;
    });

    return res.status(200).json({ 
      interviews: formattedInterviews,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error("Error fetching interviews:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const exportInterviewsCsv = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || (session.role !== "ADMIN" && session.role !== "RECRUITER")) {
      return res.status(403).json({ error: "Forbidden: insufficient permissions to export" });
    }

    const searchParams = new URLSearchParams(req.query);
    const dateParam = searchParams.get("date");
    const panelIdParam = searchParams.get("panel_id");
    const statusParam = searchParams.get("status");

    let whereClause = {};

    if (session.role === "RECRUITER") {
      whereClause = {
        application: {
          domain: { in: session.departments }
        }
      };
    }

    if (dateParam) {
      const { startOfDay, endOfDay } = getISTDateBounds(dateParam);
      whereClause.date = {
        gte: startOfDay,
        lte: endOfDay
      };
    }

    if (panelIdParam && !isNaN(parseInt(panelIdParam, 10))) {
      whereClause.panel_id = parseInt(panelIdParam, 10);
    }

    if (statusParam && statusParam !== "ALL") {
      whereClause.status = statusParam;
    }

    const interviews = await prisma.recruitmentInterview.findMany({
      where: whereClause,
      include: {
        panel: {
          include: {
            members: {
              include: { user: { select: { name: true } } }
            }
          }
        },
        assigned_members: {
          include: { user: { select: { name: true } } }
        },
        application: true
      },
      orderBy: [{ date: 'asc' }, { start_time: 'asc' }]
    });

    const headers = [
      "Interview ID",
      "Date (IST)",
      "Time (IST)",
      "Round",
      "Candidate Name",
      "Registration Number",
      "Department",
      "Email",
      "Phone",
      "Panel Name",
      "Assigned Panelists",
      "Status",
      "Meeting Link",
      "Portfolio / Resume"
    ];

    const escapeCsv = (str) => {
      if (str === null || str === undefined) return '""';
      const s = String(str).replace(/"/g, '""');
      return `"${s}"`;
    };

    const rows = interviews.map((inv) => {
      const dateStr = toISTDateString(inv.date);
      const startTimeStr = toISTTimeString(inv.start_time);
      const endTimeStr = toISTTimeString(inv.end_time);
      const timeSlot = `${startTimeStr} - ${endTimeStr}`;
      
      const panelMembers = (inv.assigned_members && inv.assigned_members.length > 0)
        ? inv.assigned_members.map(m => m.user?.name).filter(Boolean).join(", ")
        : (inv.panel?.members ? inv.panel.members.map(m => m.user?.name).filter(Boolean).join(", ") : "");

      return [
        escapeCsv(inv.id),
        escapeCsv(dateStr),
        escapeCsv(timeSlot),
        escapeCsv(`Round ${inv.round}`),
        escapeCsv(inv.application?.name || "N/A"),
        escapeCsv(inv.application?.registerNumber || "N/A"),
        escapeCsv(inv.application?.domain || "N/A"),
        escapeCsv(inv.application?.email || "N/A"),
        escapeCsv(inv.application?.phoneNumber || "N/A"),
        escapeCsv(inv.panel?.name || "N/A"),
        escapeCsv(panelMembers || "N/A"),
        escapeCsv(inv.status),
        escapeCsv(inv.meeting_link || ""),
        escapeCsv(inv.application?.portfolio || "")
      ].join(",");
    });

    const csvContent = "\uFEFF" + [headers.join(","), ...rows].join("\r\n");

    const dateSlug = dateParam || "all-dates";
    const panelSlug = panelIdParam ? `panel-${panelIdParam}` : "all-panels";
    const filename = `interviews-${dateSlug}-${panelSlug}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(csvContent);
  } catch (error) {
    console.error("Export interviews CSV error:", error);
    return res.status(500).json({ error: "Failed to export interviews" });
  }
};

export const scheduleInterview = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || (session.role !== "ADMIN" && session.role !== "RECRUITER")) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const body = req.body;
    const parsed = scheduleSchema.safeParse(body);
    
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid payload data", details: parsed.error.format() });
    }

    const { application_id, panel_id, date, start_time, meeting_link } = parsed.data;
    const appIdBigInt = BigInt(application_id);

    const [year, month, day] = date.split('-').map(Number);
    const dateObj = new Date(year, month - 1, day);
    if (dateObj.getFullYear() !== year || dateObj.getMonth() !== month - 1 || dateObj.getDate() !== day) {
      return res.status(400).json({ error: `Invalid calendar date: ${date}` });
    }

    const application = await prisma.recruitmentApplication.findUnique({
      where: { id: appIdBigInt }
    });

    if (!application) {
      return res.status(404).json({ error: "Application not found" });
    }

    if (session.role === "RECRUITER") {
      const isAssigned = session.departments?.includes(application.domain);
      if (!isAssigned) {
        return res.status(403).json({ error: "Forbidden: Candidate belongs to unassigned department" });
      }
    }

    const appStatus = application.status;
    if (appStatus !== "SHORTLISTED" && appStatus !== "FURTHER_ROUND") {
      return res.status(400).json({ error: `Application is not eligible for scheduling (Current status: ${appStatus})` });
    }

    const panel = await prisma.recruitmentPanel.findUnique({ 
      where: { id: panel_id },
      include: { members: { where: { active: true, user: { status: "Active" } }, include: { user: true } } }
    });
    if (!panel) {
      return res.status(404).json({ error: "Panel not found" });
    }
    if (panel.status !== "ACTIVE") {
      return res.status(400).json({ error: "Panel is not active" });
    }

    const startObj = parseISTDateToUTC(date, start_time);
    const endObj = new Date(startObj.getTime() + 10 * 60000);

    const lastInterview = await prisma.recruitmentInterview.findFirst({
      where: { application_id: appIdBigInt, status: { not: "CANCELLED" } },
      orderBy: { round: 'desc' }
    });
    const nextRound = lastInterview ? lastInterview.round + 1 : 1;

    const interview = await prisma.$transaction(async (tx) => {
      const candidateConflict = await tx.recruitmentInterview.findFirst({
        where: {
          application_id: appIdBigInt,
          date: new Date(date),
          status: { not: "CANCELLED" },
          OR: [
            { start_time: { lt: endObj }, end_time: { gt: startObj } }
          ]
        }
      });
      if (candidateConflict) {
        throw new Error("CANDIDATE_CONFLICT");
      }

      const panelConflict = await tx.recruitmentInterview.findFirst({
        where: {
          panel_id: panel_id,
          date: new Date(date),
          status: { not: "CANCELLED" },
          OR: [
            { start_time: { lt: endObj }, end_time: { gt: startObj } }
          ]
        }
      });
      if (panelConflict) {
        throw new Error("SLOT_UNAVAILABLE");
      }

      const memberUserIds = panel.members.map(m => m.user_id);
      if (memberUserIds.length > 0) {
        const memberConflict = await tx.recruitmentInterview.findFirst({
          where: {
            date: new Date(date),
            status: { not: "CANCELLED" },
            OR: [
              { start_time: { lt: endObj }, end_time: { gt: startObj } }
            ],
            assigned_members: {
              some: { user_id: { in: memberUserIds } }
            }
          }
        });
        if (memberConflict) {
          throw new Error("MEMBER_CONFLICT");
        }
      }

      const activePanelMembers = panel.members.map(m => ({ id: m.id }));

      const newInterview = await tx.recruitmentInterview.create({
        data: {
          application_id: appIdBigInt,
          panel_id,
          recruiter_id: session.id.startsWith("dev-mock") ? null : BigInt(session.id),
          round: nextRound,
          date: new Date(date),
          start_time: startObj,
          end_time: endObj,
          meeting_link: meeting_link || null,
          status: "SCHEDULED",
          assigned_members: {
            connect: activePanelMembers
          }
        },
        include: { application: true, panel: true, assigned_members: true }
      });

      await tx.recruitmentApplication.update({
        where: { id: appIdBigInt },
        data: { status: "INTERVIEW_SCHEDULED" }
      });

      return newInterview;
    }, {
      timeout: 15000
    });

    await logAudit(session.id, "SCHEDULED_INTERVIEW", "Interview", interview.id);

    for (const pm of panel.members) {
      await createNotification(
        pm.user_id.toString(),
        "New Interview Scheduled",
        `You have a new interview scheduled with ${application.name} on ${date} at ${start_time}.`
      );
      
      if (pm.user.email) {
        sendEmail({
          to: pm.user.email,
          subject: `HackClub VIT Recruitment - Interview Panel Assignment`,
          html: `You have been assigned to an interview panel for candidate ${application.name} (Round ${interview.round}).<br/>Date: ${date}<br/>Time: ${start_time}<br/>Link: ${meeting_link || "TBD"}`,
          eventType: "INTERVIEW_SCHEDULED",
          entityId: interview.id.toString()
        }).catch(console.error);
      }
    }

    if (application.email) {
      sendEmail({
        to: application.email,
        subject: `HackClub VIT Recruitment - Interview Scheduled`,
        html: templates.interviewScheduled(application.name, date, start_time, 10, interview.round, meeting_link || "TBD", application.domain || undefined),
        eventType: "INTERVIEW_SCHEDULED",
        entityId: interview.id.toString()
      }).catch(console.error);
    }

    return res.status(201).json({ message: "Interview scheduled successfully", interview: { ...interview, application_id: interview.application_id.toString() } });
  } catch (error) {
    if (error.message === "SLOT_UNAVAILABLE") {
      return res.status(409).json({ error: "Slot unavailable. The panel is already booked for this time." });
    }
    if (error.message === "MEMBER_CONFLICT") {
      return res.status(409).json({ error: "Slot unavailable. One or more panel members are already booked in another panel for this time." });
    }
    if (error.message === "CANDIDATE_CONFLICT") {
      return res.status(409).json({ error: "Candidate is already scheduled for an interview during this time." });
    }
    console.error("Schedule interview error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const getInterviewById = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || session.role === "NONE") return res.status(401).json({ error: "Unauthorized" });
    
    const id = parseInt(req.params.id, 10);

    const includeClause = {
      panel: {
        include: { members: { include: { user: { select: { name: true, email: true } } } } }
      },
      assigned_members: { include: { user: { select: { name: true, email: true } } } },
      feedback: true,
      application: true
    };

    if (session.role === "PANEL_MEMBER") {
      includeClause.application = {
        select: {
          id: true,
          name: true,
          email: true,
          domain: true,
          registerNumber: true
        }
      };
    }

    const interview = await prisma.recruitmentInterview.findUnique({
      where: { id },
      include: includeClause
    });

    if (!interview) return res.status(404).json({ error: "Not found" });

    if (session.role === "PANEL_MEMBER") {
      const isMember = interview.assigned_members.some(m => m.user_id.toString() === session.id);
      if (!isMember) return res.status(403).json({ error: "Forbidden" });
    } else if (session.role === "RECRUITER") {
      if (!session.departments.includes(interview.application?.domain)) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    if (session.role === "PANEL_MEMBER") {
      delete interview.panel;
    }

    const formattedInterview = {
       ...interview,
       application_id: interview.application_id.toString(),
       candidate: interview.application ? {
           id: interview.application.id.toString(),
           name: interview.application.name,
           department: interview.application.domain,
           registration_number: interview.application.registerNumber
       } : undefined
    };

    return res.status(200).json({ interview: formattedInterview });
  } catch (error) {
    console.error("Fetch interview error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const updateInterview = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || (session.role !== "ADMIN" && session.role !== "RECRUITER" && session.role !== "PANEL_MEMBER")) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const id = parseInt(req.params.id, 10);
    const { status, date, start_time, meeting_link } = req.body;

    if (session.role === "PANEL_MEMBER") {
      if (date || start_time || meeting_link !== undefined) {
        return res.status(403).json({ error: "Panel members cannot reschedule or change meeting links" });
      }
    }

    if ((date && !start_time) || (!date && start_time)) {
      return res.status(400).json({ error: "Both date and start_time must be provided together when rescheduling." });
    }

    if (start_time && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(start_time)) {
      return res.status(400).json({ error: "Invalid time format, use HH:MM (00:00 - 23:59)" });
    }

    if (date) {
      const [yr, mo, dy] = date.split('-').map(Number);
      const dateCheck = new Date(yr, mo - 1, dy);
      if (isNaN(dateCheck.getTime()) || dateCheck.getFullYear() !== yr || dateCheck.getMonth() !== mo - 1 || dateCheck.getDate() !== dy) {
        return res.status(400).json({ error: `Invalid calendar date: ${date}` });
      }
    }

    const existingInterview = await prisma.recruitmentInterview.findUnique({
      where: { id },
      include: { application: true, panel: { include: { members: true } }, assigned_members: true }
    });

    if (!existingInterview) {
      return res.status(404).json({ error: "Interview not found" });
    }

    if (session.role === "RECRUITER" && !session.departments.includes(existingInterview.application.domain)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (session.role === "PANEL_MEMBER") {
      const isMember = existingInterview.assigned_members.some(m => m.user_id.toString() === session.id);
      if (!isMember) {
        return res.status(403).json({ error: "Forbidden: Not an active member of this interview panel" });
      }
    }

    if (status) {
      if (session.role === "PANEL_MEMBER" && !["IN_PROGRESS", "COMPLETED"].includes(status)) {
        return res.status(403).json({ error: "Panel Members may only transition status to IN_PROGRESS or COMPLETED." });
      }
      if (!VALID_INTERVIEW_STATUSES.includes(status)) {
        return res.status(400).json({ error: `Invalid interview status. Must be one of: ${VALID_INTERVIEW_STATUSES.join(", ")}` });
      }

      if (status === "FEEDBACK_PENDING" || status === "FEEDBACK_SUBMITTED") {
        return res.status(400).json({ error: "Cannot manually transition to feedback states. These are managed automatically." });
      }

      const allowed = VALID_STATUS_TRANSITIONS[existingInterview.status] || [];
      if (!allowed.includes(status)) {
        return res.status(400).json({ error: `Invalid status transition from ${existingInterview.status} to ${status}` });
      }
    }

    const updateData = {};
    if (status) updateData.status = status;
    if (meeting_link !== undefined) updateData.meeting_link = meeting_link;

    let startObj = existingInterview.start_time;
    let endObj = existingInterview.end_time;
    let targetDate = existingInterview.date;

    if (date && start_time) {
      startObj = parseISTDateToUTC(date, start_time);
      endObj = new Date(startObj.getTime() + 10 * 60000);
      targetDate = new Date(date);
      
      updateData.date = targetDate;
      updateData.start_time = startObj;
      updateData.end_time = endObj;
    }

    const interview = await prisma.$transaction(async (tx) => {
      if (date && start_time) {
        const memberUserIds = existingInterview.assigned_members.map(m => m.user_id);
        const conflict = await tx.recruitmentInterview.findFirst({
          where: {
            id: { not: id },
            date: targetDate,
            status: { not: "CANCELLED" },
            OR: [
              {
                start_time: { lt: endObj },
                end_time: { gt: startObj }
              }
            ],
            assigned_members: {
              some: {
                user_id: { in: memberUserIds }
              }
            }
          }
        });

        if (conflict) {
          if (conflict.panel_id === existingInterview.panel_id) {
            throw new Error("SLOT_UNAVAILABLE");
          } else {
            throw new Error("MEMBER_CONFLICT");
          }
        }
      }

      return await tx.recruitmentInterview.update({
        where: { id },
        data: updateData,
        include: { application: true, assigned_members: { include: { user: true } } }
      });
    });

    await logAudit(session.id, `UPDATED_INTERVIEW_${interview.status}`, "Interview", id);

    if (status === "CANCELLED") {
      await prisma.recruitmentApplication.update({
        where: { id: existingInterview.application_id },
        data: { status: "SHORTLISTED" }
      });

      if (interview.application?.email) {
        sendEmail({
          to: interview.application.email,
          subject: `HackClub VIT Recruitment - Interview Cancelled`,
          html: templates.interviewCancelled(interview.application.name, interview.round),
          eventType: "INTERVIEW_CANCELLED",
          entityId: interview.id.toString()
        }).catch(console.error);
      }
    } else if (date && start_time) {
      if (interview.application?.email) {
        sendEmail({
          to: interview.application.email,
          subject: `HackClub VIT Recruitment - Interview Rescheduled`,
          html: templates.interviewRescheduled(interview.application.name, date, start_time, interview.round, interview.meeting_link || "TBD"),
          eventType: "INTERVIEW_RESCHEDULED",
          entityId: interview.id.toString()
        }).catch(console.error);
      }
    }

    return res.status(200).json({ interview: { ...interview, application_id: interview.application_id.toString() } });
  } catch (error) {
    if (error.message === "SLOT_UNAVAILABLE") {
      return res.status(409).json({ error: "Slot unavailable. The panel is already booked for this time." });
    }
    if (error.message === "MEMBER_CONFLICT") {
      return res.status(409).json({ error: "Slot unavailable. One or more panel members are already booked in another panel for this time." });
    }
    console.error("Update interview error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
