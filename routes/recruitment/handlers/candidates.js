import prisma from "../../../prismaClient.js";
import { getSession } from "../lib/auth.js";

export const getCandidates = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || session.role === "NONE") {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const searchParams = new URLSearchParams(req.query);
    const q = searchParams.get("q") || "";
    const status = searchParams.get("status") || "ALL";
    const department = searchParams.get("department");

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
      const userId = BigInt(session.id);
      andConditions.push({
        interviews: {
          some: {
            OR: [
              { assigned_members: { some: { user_id: userId } } },
              { panel: { members: { some: { user_id: userId, active: true } } } }
            ]
          }
        }
      });
    } 
    
    if (status !== "ALL") {
       andConditions.push({ status });
    }

    if (q) {
      andConditions.push({
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
          { registerNumber: { contains: q, mode: 'insensitive' } },
        ]
      });
    }

    const whereClause = { AND: andConditions };

    const page = Math.max(1, parseInt(searchParams.get("page") || "1") || 1);
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "10") || 10));
    const skip = (page - 1) * limit;

    let includeClause = {
      interviews: true
    };

    if (session.role === "PANEL_MEMBER") {
      const userId = BigInt(session.id);
      includeClause = {
        interviews: {
          where: {
            OR: [
              { assigned_members: { some: { user_id: userId } } },
              { panel: { members: { some: { user_id: userId, active: true } } } }
            ]
          }
        }
      };
    }

    const [applications, total] = await Promise.all([
      prisma.recruitmentApplication.findMany({
        where: whereClause,
        include: includeClause,
        skip,
        take: limit,
        orderBy: { id: 'desc' }
      }),
      prisma.recruitmentApplication.count({ where: whereClause })
    ]);

    const candidates = applications.map(app => ({
      ...app,
      id: app.id.toString(),
      decided_by: app.decided_by ? app.decided_by.toString() : null,
      registration_number: app.registerNumber,
      department: app.domain || app.firstPreference || '',
      interviews: app.interviews ? app.interviews.map(i => ({
        ...i,
        id: typeof i.id === 'bigint' ? i.id.toString() : i.id,
        application_id: i.application_id.toString(),
        recruiter_id: i.recruiter_id ? i.recruiter_id.toString() : null
      })) : []
    }));

    return res.status(200).json({ 
      candidates,
      items: candidates,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error("Error fetching candidates:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const getCandidateById = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || session.role === "NONE") return res.status(401).json({ error: "Unauthorized" });
    
    const id = BigInt(req.params.id);

    let includeClause = {
      interviews: {
        include: { panel: true, feedback: true }
      },
      formSubmission: {
        include: { answers: true }
      }
    };

    if (session.role === "PANEL_MEMBER") {
      const userId = BigInt(session.id);
      includeClause = {
        interviews: {
          where: {
            OR: [
              { assigned_members: { some: { user_id: userId } } },
              { panel: { members: { some: { user_id: userId, active: true } } } }
            ]
          },
          include: { feedback: true }
        }
      };
    }

    const application = await prisma.recruitmentApplication.findUnique({
      where: { id },
      include: includeClause
    });

    if (!application) return res.status(404).json({ error: "Not found" });

    if (session.role === "RECRUITER" && !session.departments.includes("*")) {
      const allowedDepts = new Set(session.departments.map(d => d.toLowerCase()));
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

    if (session.role === "PANEL_MEMBER" && (!application.interviews || application.interviews.length === 0)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const serializedApplication = {
      ...application,
      id: application.id.toString(),
      decided_by: application.decided_by ? application.decided_by.toString() : null,
      interviews: application.interviews ? application.interviews.map(i => ({
        ...i,
        id: typeof i.id === 'bigint' ? i.id.toString() : i.id,
        application_id: i.application_id ? i.application_id.toString() : null,
        recruiter_id: i.recruiter_id ? i.recruiter_id.toString() : null,
        panel_id: typeof i.panel_id === 'bigint' ? i.panel_id.toString() : i.panel_id,
        feedback: i.feedback ? i.feedback.map(f => ({
          ...f,
          id: typeof f.id === 'bigint' ? f.id.toString() : f.id,
          interview_id: f.interview_id ? f.interview_id.toString() : null,
          user_id: f.user_id ? f.user_id.toString() : null,
        })) : [],
      })) : [],
      formSubmission: application.formSubmission ? {
        ...application.formSubmission,
        id: typeof application.formSubmission.id === 'bigint' ? application.formSubmission.id.toString() : application.formSubmission.id,
        application_id: application.formSubmission.application_id ? application.formSubmission.application_id.toString() : null,
        answers: application.formSubmission.answers ? application.formSubmission.answers.map(a => ({
          ...a,
          id: typeof a.id === 'bigint' ? a.id.toString() : a.id,
          submission_id: a.submission_id ? a.submission_id.toString() : null,
        })) : [],
      } : null,
    };

    return res.status(200).json({ candidate: serializedApplication });
  } catch (error) {
    console.error("Fetch candidate error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
