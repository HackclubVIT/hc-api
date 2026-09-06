import prisma from "../../../prismaClient.js";
import { getSession } from "../lib/auth.js";
import { getISTDateBounds } from "../lib/timezone.js";

export const getRecruiterDashboard = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || session.role !== "RECRUITER") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { startOfDay: startOfToday, endOfDay: endOfToday } = getISTDateBounds();
    const departments = session.departments || [];

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

    const deptCondition = session.departments.includes("*") ? {} : buildDepartmentCondition(departments);

    const pendingReviewsCount = await prisma.recruitmentApplication.count({
      where: {
        AND: [
          { status: { in: ["APPLIED", "UNDER_REVIEW"] } },
          { recruitmentId: "recruitment-2026" },
          deptCondition
        ]
      }
    });

    const shortlistedCount = await prisma.recruitmentApplication.count({
      where: {
        AND: [
          { status: "SHORTLISTED" },
          { recruitmentId: "recruitment-2026" },
          deptCondition
        ]
      }
    });

    const selectedCount = await prisma.recruitmentApplication.count({
      where: {
        AND: [
          { status: "SELECTED" },
          { recruitmentId: "recruitment-2026" },
          deptCondition
        ]
      }
    });

    const interviewsTodayCount = await prisma.recruitmentInterview.count({
      where: {
        date: {
          gte: startOfToday,
          lte: endOfToday
        },
        status: { not: "CANCELLED" },
        application: {
          AND: [
            { recruitmentId: "recruitment-2026" },
            deptCondition
          ]
        }
      }
    });

    const recentApplications = await prisma.recruitmentApplication.findMany({
      where: {
        AND: [
          { recruitmentId: "recruitment-2026" },
          deptCondition
        ]
      },
      orderBy: { id: 'desc' },
      take: 5
    });

    const serializedApplications = recentApplications.map(app => ({
      ...app,
      id: app.id.toString(),
    }));

    return res.status(200).json({
      stats: {
        pendingReviewsCount,
        shortlistedCount,
        selectedCount,
        interviewsTodayCount
      },
      recentApplications: serializedApplications,
      departments
    });
  } catch (error) {
    console.error("Recruiter dashboard error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
