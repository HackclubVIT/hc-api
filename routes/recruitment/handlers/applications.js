import crypto from "crypto";
import prisma from "../../../prismaClient.js";
import { getSession } from "../lib/auth.js";
import { createNotification } from "../lib/notify.js";
import { logAudit } from "../lib/audit.js";
import { sendEmail, templates } from "../lib/email.js";
import { z } from "zod";

const applicationSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters"),
  email: z.string().trim().email("Please provide a valid email address"),
  phone: z.string().trim().min(7, "Please provide a valid phone number"),
  department: z.string().trim().min(1, "Department is required"),
  registration_number: z.string().trim().min(3, "Registration number is required"),
  yearOfStudy: z.string().optional().nullable(),
  resume_url: z.preprocess((val) => {
    if (!val || typeof val !== "string" || !val.trim()) return "";
    let trimmed = val.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      trimmed = `https://${trimmed}`;
    }
    return trimmed;
  }, z.string().url("Please provide a valid URL").optional().or(z.literal(''))),
  form_id: z.coerce.number().int().positive("Invalid form ID"),
  answers: z.record(z.string(), z.any()).optional().default({})
});

export const createApplication = async (req, res) => {
  try {
    const body = req.body;
    const parsed = applicationSchema.safeParse(body);
    
    if (!parsed.success) {
      const issue = parsed.error.issues?.[0];
      const field = issue?.path?.join('.') || 'Form';
      const errMsg = issue?.message ? `${field}: ${issue.message}` : "Invalid form data";
      return res.status(400).json({ error: errMsg, details: parsed.error.format() });
    }

    const data = parsed.data;

    const form = await prisma.recruitmentForm.findUnique({ 
      where: { id: data.form_id },
      include: { questions: true }
    });
    
    if (!form || form.status !== "PUBLISHED") {
      return res.status(400).json({ error: "Form is not active or does not exist." });
    }

    const submittedAnswers = data.answers || {};
    
    // Sanitize submitted answers: only keep keys that correspond to questions on this form
    const validQuestionIds = new Set(form.questions.map(q => q.id.toString()));
    const sanitizedAnswers = {};
    for (const [key, val] of Object.entries(submittedAnswers)) {
      if (validQuestionIds.has(key.toString())) {
        sanitizedAnswers[key.toString()] = val;
      }
    }

    for (const q of form.questions) {
      const answer = sanitizedAnswers[q.id.toString()];
      const isEmpty = answer === undefined || answer === null || answer === "" || (Array.isArray(answer) && answer.length === 0);

      if (q.required && isEmpty) {
        return res.status(400).json({ error: `Question '${q.question}' is required.` });
      }

      if (!isEmpty && q.options && q.options.length > 0) {
        const validOptions = q.options.map(o => String(o).trim());
        if (q.type === 'RADIO' || q.type === 'DROPDOWN') {
          const selected = String(answer).trim();
          const matches = validOptions.some(o => o.toLowerCase() === selected.toLowerCase());
          if (!matches && q.required) {
            return res.status(400).json({ error: `Invalid option selected for '${q.question}'.` });
          }
        }
        if (q.type === 'CHECKBOX') {
          let selected = [];
          if (Array.isArray(answer)) selected = answer.map(s => String(s).trim());
          else if (typeof answer === 'string') selected = answer.split(',').map(s => s.trim());
          else selected = [String(answer).trim()];
          
          const validSet = new Set(validOptions.map(o => o.toLowerCase()));
          const invalid = selected.filter(s => s && !validSet.has(s.toLowerCase()));
          if (invalid.length > 0 && q.required) {
            return res.status(400).json({ error: `Invalid option '${invalid.join(", ")}' selected for '${q.question}'.` });
          }
        }
      }
    }

    // Optional user lookup: applicants may or may not already have a user account
    let existingUser = null;
    try {
      existingUser = await prisma.user.findFirst({
        where: {
          OR: [
            { email: { equals: data.email.trim(), mode: "insensitive" } },
            { registerNumber: { equals: data.registration_number.trim(), mode: "insensitive" } }
          ]
        }
      });
    } catch (e) {
      console.warn("User lookup non-fatal error:", e);
    }

    const application = await prisma.$transaction(async (tx) => {
      const existingApp = await tx.recruitmentApplication.findFirst({
        where: {
          recruitmentId: "recruitment-2026",
          OR: [
            { email: { equals: data.email.trim(), mode: "insensitive" } },
            { registerNumber: { equals: data.registration_number.trim(), mode: "insensitive" } }
          ]
        }
      });
      
      if (existingApp) {
        throw new Error("DUPLICATE_APPLICATION");
      }

      const newAppId = crypto.randomBytes(8).readBigUInt64LE() & 0x7FFFFFFFFFFFFFFFn;

      return await tx.recruitmentApplication.create({
        data: {
          id: newAppId,
          recruitmentId: "recruitment-2026",
          name: data.name || existingUser?.name || "Applicant",
          email: data.email || existingUser?.email,
          phoneNumber: data.phone || existingUser?.phoneNumber,
          domain: data.department || existingUser?.department,
          registerNumber: data.registration_number || existingUser?.registerNumber,
          portfolio: data.resume_url || null,
          yearOfStudy: data.yearOfStudy || (() => {
            const regMatch = (data.registration_number || existingUser?.registerNumber || "").match(/^(\d{2})/);
            if (regMatch) {
              const startYear = 2000 + parseInt(regMatch[1], 10);
              const currentYear = new Date().getFullYear();
              const studyYear = currentYear - startYear;
              return studyYear > 0 && studyYear <= 5 ? studyYear.toString() : "";
            }
            return "";
          })(),
          status: "APPLIED",
          appliedDate: new Date().toISOString(),
          formSubmission: {
            create: {
              form_id: form.id,
              answers: {
                create: form.questions.map(q => {
                  const rawAns = sanitizedAnswers[q.id.toString()] ?? "";
                  const ansStr = Array.isArray(rawAns) ? rawAns.join(", ") : String(rawAns);
                  return {
                    question_id: q.id,
                    answer: ansStr
                  };
                })
              }
            }
          }
        },
      });
    });

    const recruiters = await prisma.recruitmentRoleAssignment.findMany({
      where: {
        role: "RECRUITER",
        active: true
      },
    });

    const notificationsToCreate = [];
    for (const recruiter of recruiters) {
      if (application.domain && recruiter.departments.includes(application.domain)) {
         notificationsToCreate.push({
           user_id: recruiter.user_id,
           title: "New Application Submitted",
           message: `${application.name} applied for the ${application.domain} department.`,
           read: false
         });
      }
    }
    
    if (notificationsToCreate.length > 0) {
      await prisma.recruitmentNotification.createMany({
        data: notificationsToCreate
      });
    }

    await logAudit(undefined, "APPLICATION_SUBMITTED", "Application", application.id.toString());

    sendEmail({
      to: application.email,
      subject: `HackClub VIT Recruitment - Application Received`,
      html: templates.applicationSubmitted(application.name, "HackClub VIT Recruitment 2026"),
      eventType: "APPLICATION_SUBMITTED",
      entityId: application.id.toString()
    }).catch(console.error);

    return res.status(201).json({ message: "Application submitted successfully", applicationId: application.id.toString() });
  } catch (error) {
    console.error("Application submission error:", error);
    if (error instanceof Error && error.message === "DUPLICATE_APPLICATION") {
      return res.status(409).json({ error: "An application already exists for this candidate." });
    }
    if (error && typeof error === 'object' && error.code === 'P2002') {
      return res.status(409).json({ error: "An application already exists." });
    }
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const getApplications = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || session.role === "NONE") {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const searchParams = new URLSearchParams(req.query);
    const page = Math.max(1, parseInt(searchParams.get("page") || "1") || 1);
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "10") || 10));
    const search = searchParams.get("search") || "";
    const status = searchParams.get("status") || "";
    const department = searchParams.get("department") || "";
    const date_from = searchParams.get("date_from") || "";
    const date_to = searchParams.get("date_to") || "";
    const sort = searchParams.get("sort") || "";
    
    const skip = (page - 1) * limit;

    function buildDepartmentCondition(deptNames) {
      const allVariants = new Set();
      for (const d of deptNames) {
        allVariants.add(d);
        if (d.toLowerCase().includes("research")) {
          allVariants.add("Research and Development");
          allVariants.add("Research & Development");
          allVariants.add("R&D");
        }
        if (d.toLowerCase().includes("design")) {
          allVariants.add("Design & Social Media");
          allVariants.add("Design and Social Media");
          allVariants.add("Design");
        }
        if (d.toLowerCase().includes("technical")) {
          allVariants.add("Technical");
          allVariants.add("Web Development");
        }
      }

      const conditions = [];
      for (const variant of allVariants) {
        conditions.push(
          { domain: { equals: variant, mode: "insensitive" } },
          { firstPreference: { equals: variant, mode: "insensitive" } },
          { secondPreference: { equals: variant, mode: "insensitive" } }
        );
      }
      return { OR: conditions };
    }

    const andConditions = [
      { recruitmentId: "recruitment-2026" }
    ];

    if (department && department !== "ALL") {
      if (session.role === "RECRUITER") {
        const matchesDept = session.departments.some(d => d.toLowerCase() === department.toLowerCase() || d === "*");
        if (matchesDept) {
          andConditions.push(buildDepartmentCondition([department]));
        } else {
          return res.status(403).json({ error: "Forbidden: Department not assigned" });
        }
      } else if (session.role === "ADMIN") {
        andConditions.push(buildDepartmentCondition([department]));
      }
    } else if (session.role === "RECRUITER") {
      if (!session.departments.includes("*") && session.departments.length > 0) {
        andConditions.push(buildDepartmentCondition(session.departments));
      }
    } else if (session.role === "PANEL_MEMBER") {
      andConditions.push({
        interviews: {
          some: {
            assigned_members: {
              some: { user_id: BigInt(session.id) }
            }
          }
        }
      });
    }

    if (search) {
      andConditions.push({
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { email: { contains: search, mode: "insensitive" } },
          { registerNumber: { contains: search, mode: "insensitive" } }
        ]
      });
    }

    if (status) {
      andConditions.push({ status });
    }

    if (date_from || date_to) {
      const dateFilter = {};
      if (date_from) dateFilter.gte = date_from;
      if (date_to) dateFilter.lte = date_to;
      andConditions.push({ appliedDate: dateFilter });
    }

    const where = { AND: andConditions };

    let orderBy = { id: "desc" };
    if (sort) {
      const [field, dir] = sort.split(":");
      const direction = dir === "asc" ? "asc" : "desc";
      const allowed = ["appliedDate", "status", "name", "id", "domain"];
      if (allowed.includes(field)) {
        orderBy = { [field]: direction };
      }
    }

    const [applications, total] = await Promise.all([
      prisma.recruitmentApplication.findMany({
        where,
        include: {
          interviews: {
            include: {
              feedback: true
            }
          }
        },
        orderBy,
        skip,
        take: limit,
      }),
      prisma.recruitmentApplication.count({ where })
    ]);

    const formattedApplications = applications.map(app => ({
      ...app,
      id: app.id.toString(),
      decided_by: app.decided_by ? app.decided_by.toString() : null,
      interviews: app.interviews ? app.interviews.map(i => ({
        ...i,
        id: i.id,
        application_id: i.application_id.toString(),
        recruiter_id: i.recruiter_id ? i.recruiter_id.toString() : null,
        feedback: i.feedback ? i.feedback.map(f => ({
          ...f,
          id: f.id,
          user_id: f.user_id ? f.user_id.toString() : null,
        })) : []
      })) : []
    }));

    return res.status(200).json({
      items: formattedApplications,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error("Fetch applications error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const getApplicationMe = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || !session.email) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const application = await prisma.recruitmentApplication.findFirst({
      where: {
        email: { equals: session.email, mode: "insensitive" },
        recruitmentId: "recruitment-2026"
      },
      orderBy: { id: "desc" },
      include: {
        interviews: {
          where: { status: { not: "CANCELLED" } },
          orderBy: { date: "asc" },
          take: 5
        }
      }
    });

    if (!application) {
      return res.status(404).json({ error: "No recruitment application found" });
    }

    const formatted = {
      ...application,
      id: application.id.toString(),
      decided_by: application.decided_by?.toString() || null,
      interviews: application.interviews.map(i => ({
        ...i,
        application_id: i.application_id.toString(),
        recruiter_id: i.recruiter_id?.toString() || null
      }))
    };

    return res.status(200).json({ application: formatted });
  } catch (error) {
    console.error("Get /applications/me error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const getApplicationById = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const id = BigInt(req.params.id);

    const includeClause = {
      formSubmission: {
        include: {
          form: { include: { questions: true } },
          answers: true
        }
      },
      interviews: {
        include: {
          assigned_members: true,
          feedback: true
        }
      }
    };

    const application = await prisma.recruitmentApplication.findUnique({
      where: { id },
      include: includeClause
    });

    if (!application) {
      return res.status(404).json({ error: "Application not found" });
    }

    if (session.role === "RECRUITER" && !session.departments?.includes("*")) {
      const allowedDepts = new Set((session.departments || []).map(d => d.toLowerCase()));
      const matches = [application.domain, application.firstPreference, application.secondPreference]
        .filter(Boolean)
        .some(d => {
          const str = String(d).toLowerCase();
          return allowedDepts.has(str) || 
                 (str.includes("research") && Array.from(allowedDepts).some(ad => ad.includes("research"))) ||
                 (str.includes("design") && Array.from(allowedDepts).some(ad => ad.includes("design"))) ||
                 (str.includes("technical") && Array.from(allowedDepts).some(ad => ad.includes("technical")));
        });

      if (!matches) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    if (session.role === "PANEL_MEMBER") {
      const hasAccess = await prisma.recruitmentInterview.findFirst({
        where: {
          application_id: id,
          assigned_members: { some: { user_id: BigInt(session.id) } }
        }
      });
      if (!hasAccess) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    if (session.role === "NONE") {
      if (application.email !== session.email) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }
    
    const formattedApp = {
      ...application,
      id: application.id.toString(),
      decided_by: application.decided_by?.toString() || null,
    };

    return res.status(200).json({ application: formattedApp });
  } catch (error) {
    console.error("Fetch application error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

const updateSchema = z.object({
  status: z.enum([
    "Pending", "APPLIED", "UNDER_REVIEW", "SHORTLISTED", "REJECTED", 
    "INTERVIEW_SCHEDULED", "INTERVIEW_COMPLETED", 
    "SELECTED", "WAITLISTED", "FURTHER_ROUND"
  ]),
  reason: z.string().optional()
});

const VALID_STATUS_TRANSITIONS = {
  "Pending": ["APPLIED", "UNDER_REVIEW", "SHORTLISTED", "REJECTED"],
  "APPLIED": ["UNDER_REVIEW", "SHORTLISTED", "REJECTED"],
  "UNDER_REVIEW": ["SHORTLISTED", "REJECTED", "WAITLISTED"],
  "SHORTLISTED": ["INTERVIEW_SCHEDULED", "REJECTED", "WAITLISTED", "SELECTED"],
  "INTERVIEW_SCHEDULED": ["INTERVIEW_COMPLETED", "REJECTED", "CANCELLED", "SHORTLISTED"],
  "INTERVIEW_COMPLETED": ["SELECTED", "REJECTED", "WAITLISTED", "FURTHER_ROUND"],
  "FURTHER_ROUND": ["INTERVIEW_SCHEDULED", "SELECTED", "REJECTED", "WAITLISTED"],
  "WAITLISTED": ["SHORTLISTED", "SELECTED", "REJECTED"],
  "SELECTED": [],
  "REJECTED": []
};

export const updateApplication = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || (session.role !== "ADMIN" && session.role !== "RECRUITER")) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const id = BigInt(req.params.id);
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid status data", details: parsed.error.format() });
    }

    const { status, reason } = parsed.data;

    const existingApplication = await prisma.recruitmentApplication.findUnique({
      where: { id }
    });

    if (!existingApplication) {
      return res.status(404).json({ error: "Application not found" });
    }

    if (session.role === "RECRUITER") {
      const allowedDepts = new Set((session.departments || []).map(d => d.toLowerCase()));
      const matches = session.departments?.includes("*") || [existingApplication.domain, existingApplication.firstPreference, existingApplication.secondPreference]
        .filter(Boolean)
        .some(d => {
          const str = String(d).toLowerCase();
          return allowedDepts.has(str) || 
                 (str.includes("research") && Array.from(allowedDepts).some(ad => ad.includes("research"))) ||
                 (str.includes("design") && Array.from(allowedDepts).some(ad => ad.includes("design"))) ||
                 (str.includes("technical") && Array.from(allowedDepts).some(ad => ad.includes("technical")));
        });

      if (!matches) {
        return res.status(403).json({ error: "Forbidden: You are not assigned to this candidate's department preferences" });
      }

      if (["SELECTED", "REJECTED"].includes(status)) {
        return res.status(403).json({ error: "Forbidden: Only Administrators can set final decisions (SELECTED/REJECTED)" });
      }
    }

    const currentStatus = existingApplication.status;
    const allowedTransitions = VALID_STATUS_TRANSITIONS[currentStatus] || [];
    
    if (status !== currentStatus && !allowedTransitions.includes(status)) {
      return res.status(400).json({ 
        error: `Invalid status transition from ${currentStatus} to ${status}` 
      });
    }

    const updateData = { status };
    if (["SELECTED", "REJECTED"].includes(status)) {
      updateData.decided_by = session.id.startsWith("dev-mock") ? null : BigInt(session.id);
      updateData.decided_at = new Date();
      updateData.decision_reason = reason || null;
    }

    const updated = await prisma.recruitmentApplication.update({
      where: { id },
      data: updateData
    });

    await logAudit(session.id, `STATUS_CHANGED_TO_${status}`, "Application", id.toString());

    if (["SHORTLISTED", "SELECTED", "REJECTED", "WAITLISTED", "FURTHER_ROUND"].includes(status)) {
      if (updated.email) {
        sendEmail({
          to: updated.email,
          subject: status === "SELECTED"
            ? `🎉 Congratulations! You have been selected for HackClub VIT!`
            : status === "SHORTLISTED"
            ? `🎉 Update on your HackClub VIT Application - Shortlisted!`
            : status === "FURTHER_ROUND"
            ? `📋 Next Round of Interview - HackClub VIT Recruitment`
            : `Update on your HackClub VIT Application`,
          html: templates.statusUpdated(updated.name, status, reason),
          eventType: `APPLICATION_STATUS_${status}`,
          entityId: updated.id.toString()
        }).catch(console.error);
      }
    }

    return res.status(200).json({
      application: {
        ...updated,
        id: updated.id.toString(),
        decided_by: updated.decided_by?.toString() || null
      }
    });
  } catch (error) {
    console.error("Update application error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

const VALID_BULK_STATUSES = [
  "APPLIED", "UNDER_REVIEW", "SHORTLISTED", "REJECTED",
  "INTERVIEW_SCHEDULED", "INTERVIEW_COMPLETED",
  "SELECTED", "WAITLISTED", "FURTHER_ROUND"
];

const bulkSchema = z.object({
  ids: z.array(z.string()).min(1),
  status: z.enum(VALID_BULK_STATUSES)
});

export const bulkUpdateApplications = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || (session.role !== "ADMIN" && session.role !== "RECRUITER")) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const parsed = bulkSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid bulk update payload", details: parsed.error.format() });
    }

    const { ids, status } = parsed.data;
    const results = [];

    for (const idStr of ids) {
      try {
        const id = BigInt(idStr);
        const existing = await prisma.recruitmentApplication.findUnique({ where: { id } });
        if (!existing) {
          results.push({ id: idStr, success: false, error: "Application not found" });
          continue;
        }

        if (session.role === "RECRUITER") {
          const allowedDepts = new Set((session.departments || []).map(d => d.toLowerCase()));
          const hasAccess = session.departments?.includes("*") || [existing.domain, existing.firstPreference, existing.secondPreference]
            .filter(Boolean)
            .some(d => allowedDepts.has(String(d).toLowerCase()));
          if (!hasAccess) {
            results.push({ id: idStr, success: false, error: "Forbidden: department not assigned" });
            continue;
          }
          if (["SELECTED", "REJECTED"].includes(status)) {
            results.push({ id: idStr, success: false, error: "Forbidden: Only Administrators can set final decisions" });
            continue;
          }
        }

        await prisma.recruitmentApplication.update({
          where: { id },
          data: { status }
        });

        await logAudit(session.id, `BULK_UPDATED_APPLICATION_STATUS_TO_${status}`, "Application", id.toString());
        results.push({ id: idStr, success: true });
      } catch (err) {
        results.push({ id: idStr, success: false, error: "Update failed" });
      }
    }

    const failed = results.filter(r => !r.success);
    return res.status(failed.length === 0 ? 200 : 207).json({
      message: `Updated ${results.length - failed.length} of ${results.length} applications`,
      results
    });
  } catch (error) {
    console.error("Bulk update error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

async function authorizeAppAccess(session, applicationId) {
  if (!session) return { error: "Unauthorized", status: 401 };
  if (session.role === "ADMIN") return { error: null };

  const application = await prisma.recruitmentApplication.findUnique({ where: { id: applicationId } });
  if (!application) return { error: "Application not found", status: 404 };

  if (session.role === "RECRUITER") {
    const allowedDepts = new Set((session.departments || []).map(d => d.toLowerCase()));
    const hasAccess = session.departments?.includes("*") || [application.domain, application.firstPreference, application.secondPreference]
      .filter(Boolean)
      .some(d => allowedDepts.has(String(d).toLowerCase()));
    if (!hasAccess) {
      return { error: "Forbidden", status: 403 };
    }
    return { error: null };
  }

  if (session.role === "PANEL_MEMBER") {
    const hasAccess = await prisma.recruitmentInterview.findFirst({
      where: {
        application_id: applicationId,
        assigned_members: { some: { user_id: BigInt(session.id) } }
      }
    });
    if (!hasAccess) return { error: "Forbidden", status: 403 };
    return { error: null };
  }

  return { error: "Forbidden", status: 403 };
}

export const getApplicationNotes = async (req, res) => {
  try {
    const session = await getSession(req);
    const id = BigInt(req.params.id);
    const auth = await authorizeAppAccess(session, id);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });

    const notes = await prisma.recruitmentNote.findMany({
      where: { application_id: id },
      include: { author: { select: { name: true } } },
      orderBy: { created_at: "desc" }
    });

    const items = notes.map(n => ({
      id: n.id,
      content: n.content,
      authorName: n.author?.name || "Unknown",
      createdAt: n.created_at
    }));

    return res.status(200).json({ notes: items });
  } catch (error) {
    console.error("Fetch notes error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

const noteSchema = z.object({
  content: z.string().min(1).max(5000)
});

export const createApplicationNote = async (req, res) => {
  try {
    const session = await getSession(req);
    const id = BigInt(req.params.id);
    const auth = await authorizeAppAccess(session, id);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });

    const parsed = noteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Note content is required" });
    }

    const note = await prisma.recruitmentNote.create({
      data: {
        application_id: id,
        author_id: BigInt(session.id),
        content: parsed.data.content
      },
      include: { author: { select: { name: true } } }
    });

    await logAudit(session.id, "CREATED_NOTE", "Application", id.toString());

    return res.status(201).json({
      note: {
        id: note.id,
        content: note.content,
        authorName: note.author?.name || "Unknown",
        createdAt: note.created_at
      }
    });
  } catch (error) {
    console.error("Create note error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const deleteApplicationNote = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session) return res.status(401).json({ error: "Unauthorized" });

    const noteId = parseInt(req.params.noteId, 10);
    const note = await prisma.recruitmentNote.findUnique({ where: { id: noteId } });
    if (!note) return res.status(404).json({ error: "Note not found" });

    if (session.role !== "ADMIN" && note.author_id.toString() !== session.id) {
      return res.status(403).json({ error: "Forbidden" });
    }

    await prisma.recruitmentNote.delete({ where: { id: noteId } });
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Delete note error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const getApplicationHistory = async (req, res) => {
  try {
    const session = await getSession(req);
    const id = BigInt(req.params.id);
    const auth = await authorizeAppAccess(session, id);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });

    const logs = await prisma.recruitmentAuditLog.findMany({
      where: {
        entity: "Application",
        entity_id: id.toString()
      },
      include: { user: { select: { name: true } } },
      orderBy: { timestamp: "desc" }
    });

    const items = logs.map(l => ({
      id: l.id,
      action: l.action,
      user: l.user?.name || "System",
      timestamp: l.timestamp
    }));

    return res.status(200).json({ history: items });
  } catch (error) {
    console.error("Fetch history error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
