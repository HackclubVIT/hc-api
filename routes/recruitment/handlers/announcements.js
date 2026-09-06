import prisma from "../../../prismaClient.js";
import { getSession } from "../lib/auth.js";
import { sendEmail } from "../lib/email.js";

export const getAnnouncements = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // If candidate (role NONE)
    if (session.role === "NONE") {
      const candidateEmail = session.email?.trim();
      const app = await prisma.recruitmentApplication.findFirst({
        where: {
          email: {
            equals: candidateEmail,
            mode: "insensitive"
          },
          recruitmentId: "recruitment-2026"
        },
        orderBy: {
          id: "desc"
        },
        select: { domain: true, status: true }
      });

      if (!app) {
        return res.status(200).json({ announcements: [] });
      }

      const announcements = await prisma.$queryRawUnsafe(`
        SELECT id, department, target_status, title, message, created_by, created_at
        FROM recruitment_announcements
        WHERE (LOWER(department) = LOWER($1) OR department = 'ALL')
          AND (target_status = 'ALL' OR target_status = $2 OR ($2 IN ('SHORTLISTED', 'FURTHER_ROUND', 'INTERVIEW_SCHEDULED') AND target_status = 'SHORTLISTED'))
        ORDER BY created_at DESC
      `, app.domain || "", app.status || "APPLIED");

      return res.status(200).json({ announcements });
    }

    // Admin or Recruiter
    let query = `
      SELECT id, department, target_status, title, message, created_by, created_at
      FROM recruitment_announcements
    `;
    const params = [];

    if (session.role === "RECRUITER" && !session.departments.includes("*")) {
      const depts = session.departments || [];
      if (depts.length > 0) {
        query += ` WHERE department = ANY($1::text[]) OR department = 'ALL'`;
        params.push(depts);
      }
    }

    query += ` ORDER BY created_at DESC LIMIT 50`;

    const announcements = await prisma.$queryRawUnsafe(query, ...params);
    return res.status(200).json({ announcements });
  } catch (error) {
    console.error("Fetch announcements error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const createAnnouncement = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || (session.role !== "ADMIN" && session.role !== "RECRUITER")) {
      return res.status(403).json({ error: "Forbidden: Only Admin or Recruiter can broadcast messages" });
    }

    const { department, target_status = "SHORTLISTED", title, message } = req.body;

    if (!department || !title?.trim() || !message?.trim()) {
      return res.status(400).json({ error: "Department, title, and message are required" });
    }

    if (session.role === "RECRUITER") {
      const allowedDepts = session.departments || [];
      const hasWildcard = allowedDepts.includes("*");
      const hasDept = allowedDepts.some(d => d.toLowerCase() === department.toLowerCase());
      if (!hasWildcard && !hasDept) {
        return res.status(403).json({ error: "Forbidden: You cannot broadcast to unassigned departments" });
      }
    }

    const createdList = await prisma.$queryRawUnsafe(`
      INSERT INTO recruitment_announcements (department, target_status, title, message, created_by, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING id, department, target_status, title, message, created_by, created_at
    `, department, target_status, title.trim(), message.trim(), session.email || session.id);

    const newAnnouncement = createdList[0];

    // Asynchronously send notification emails to affected candidates
    (async () => {
      try {
        let whereClause = {
          recruitmentId: "recruitment-2026"
        };

        if (department !== "ALL") {
          whereClause.domain = { equals: department, mode: "insensitive" };
        }

        if (target_status === "SHORTLISTED") {
          whereClause.status = { in: ["SHORTLISTED", "FURTHER_ROUND", "INTERVIEW_SCHEDULED"] };
        } else if (target_status !== "ALL") {
          whereClause.status = target_status;
        }

        const candidates = await prisma.recruitmentApplication.findMany({
          where: whereClause,
          select: { email: true, name: true }
        });

        const emails = Array.from(new Set(candidates.map(c => c.email).filter(Boolean)));
        if (emails.length > 0) {
          await sendEmail({
            to: emails,
            subject: `[HackClub VIT Recruitment] ${title.trim()}`,
            html: `
              <h2>Recruitment Announcement - ${department} Department</h2>
              <p>${message.trim().replace(/\n/g, '<br/>')}</p>
              <br/>
              <p>Please log in to your candidate dashboard to view more updates.</p>
              <p>Best regards,<br/><strong>HackClub VIT Recruitment Team</strong></p>
            `,
            eventType: "DEPARTMENT_ANNOUNCEMENT",
            entityId: newAnnouncement.id.toString()
          });
        }
      } catch (emailErr) {
        console.error("Failed to broadcast announcement emails:", emailErr);
      }
    })();

    return res.status(201).json({ message: "Announcement published successfully", announcement: newAnnouncement });
  } catch (error) {
    console.error("Create announcement error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
