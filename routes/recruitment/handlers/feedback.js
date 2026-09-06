import prisma from "../../../prismaClient.js";
import { getSession } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";
import { createNotification, getRecruitersByDepartment } from "../lib/notify.js";
import { sendEmail } from "../lib/email.js";
import { z } from "zod";

const feedbackSchema = z.object({
  interview_id: z.number().int().positive(),
  technical_score: z.number().int().min(1).max(5),
  communication_score: z.number().int().min(1).max(5),
  problem_solving_score: z.number().int().min(1).max(5),
  confidence_score: z.number().int().min(1).max(5),
  teamwork_score: z.number().int().min(1).max(5),
  comments: z.string().optional(),
  decision: z.enum(["RECOMMENDED", "MAYBE", "REJECTED"])
});

export const getFeedback = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || session.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const searchParams = new URLSearchParams(req.query);
    const page = Math.max(1, parseInt(searchParams.get("page") || "1") || 1);
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "20") || 20));
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.recruitmentFeedback.findMany({
        include: {
          interview: {
            include: {
              application: { select: { id: true, name: true, domain: true } },
              panel: { select: { name: true } }
            }
          },
          panel_member: { include: { user: { select: { name: true } } } }
        },
        orderBy: { id: "desc" },
        skip,
        take: limit
      }),
      prisma.recruitmentFeedback.count()
    ]);

    const formatted = items.map((f) => ({
      id: f.id,
      decision: f.decision,
      comments: f.comments,
      technical_score: f.technical_score,
      communication_score: f.communication_score,
      problem_solving_score: f.problem_solving_score,
      confidence_score: f.confidence_score,
      teamwork_score: f.teamwork_score,
      overall_score: Math.round((f.technical_score + f.communication_score + f.problem_solving_score + f.confidence_score + f.teamwork_score) / 5),
      panelMemberName: f.panel_member?.user?.name || "Unknown",
      candidateName: f.interview?.application?.name || "Unknown",
      candidateId: f.interview?.application?.id?.toString() || null,
      department: f.interview?.application?.domain || "-",
      panelName: f.interview?.panel?.name || "-",
      interviewId: f.interview_id
    }));

    return res.status(200).json({ feedback: formatted, page, limit, total, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    console.error("Fetch feedback error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const submitFeedback = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || session.role !== "PANEL_MEMBER") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const parsed = feedbackSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid feedback data", details: parsed.error.format() });
    }

    const {
      interview_id,
      technical_score,
      communication_score,
      problem_solving_score,
      confidence_score,
      teamwork_score,
      comments,
      decision
    } = parsed.data;

    const interview = await prisma.recruitmentInterview.findUnique({
      where: { id: interview_id },
      include: { assigned_members: true, application: true }
    });

    if (!interview) {
      return res.status(404).json({ error: "Interview not found" });
    }

    const panelMember = interview.assigned_members.find(m => m.user_id.toString() === session.id.toString());
    if (!panelMember) {
      return res.status(403).json({ error: "You are not authorized to review this interview." });
    }

    if (!interview.application_id) {
      return res.status(400).json({ error: "Interview does not belong to a valid application." });
    }

    if (interview.status === "SCHEDULED" || interview.status === "CANCELLED" || interview.status === "IN_PROGRESS") {
      return res.status(400).json({ error: "Interview is not yet ready for feedback." });
    }

    if (interview.status === "FEEDBACK_SUBMITTED") {
      return res.status(409).json({ error: "All feedback has already been submitted for this interview." });
    }

    const existingFeedback = await prisma.recruitmentFeedback.findFirst({
      where: {
        interview_id,
        panel_member_id: panelMember.id
      }
    });

    if (existingFeedback) {
      return res.status(409).json({ error: "Feedback already submitted for this interview." });
    }

    const feedback = await prisma.$transaction(async (tx) => {
      const newFeedback = await tx.recruitmentFeedback.create({
        data: {
          interview_id,
          panel_member_id: panelMember.id,
          technical_score,
          communication_score,
          problem_solving_score,
          confidence_score,
          teamwork_score,
          comments: comments || null,
          decision
        }
      });

      const expectedMemberIds = interview.assigned_members.map(m => m.id).sort();
      const submittedFeedbacks = await tx.recruitmentFeedback.findMany({
        where: { interview_id },
        select: { panel_member_id: true }
      });
      const submittedMemberIds = submittedFeedbacks.map(f => f.panel_member_id).sort();

      const allFeedbackReceived = expectedMemberIds.every(id => submittedMemberIds.includes(id));

      if (allFeedbackReceived) {
        await tx.recruitmentInterview.update({
          where: { id: interview_id },
          data: { status: "FEEDBACK_SUBMITTED" }
        });
      } else {
        await tx.recruitmentInterview.update({
          where: { id: interview_id },
          data: { status: "FEEDBACK_PENDING" }
        });
      }

      return newFeedback;
    });

    await logAudit(session.id, "SUBMITTED_FEEDBACK", "InterviewFeedback", feedback.id);

    const recruiters = await getRecruitersByDepartment(interview.application.domain || "");
    for (const r of recruiters) {
      if (r.email) {
        sendEmail({
          to: r.email,
          subject: `HackClub VIT Recruitment - Feedback Submitted for ${interview.application.name}`,
          html: `<p>Panel member feedback has been submitted for candidate <strong>${interview.application.name}</strong> (Round ${interview.round}).</p><p>Decision: <strong>${decision}</strong></p>`,
          eventType: "FEEDBACK_SUBMITTED",
          entityId: interview.id.toString()
        }).catch(console.error);
      }
    }

    return res.status(201).json({ message: "Feedback submitted successfully", feedback });
  } catch (error) {
    console.error("Submit feedback error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
