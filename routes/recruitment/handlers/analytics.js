import prisma from "../../../prismaClient.js";
import { getSession } from "../lib/auth.js";
import { toISTDateString } from "../lib/timezone.js";

export const getAnalytics = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || session.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const totalApplications = await prisma.recruitmentApplication.count({ where: { recruitmentId: "recruitment-2026" } });
    const totalCandidates = await prisma.recruitmentApplication.count({ where: { recruitmentId: "recruitment-2026" } });
    const totalInterviews = await prisma.recruitmentInterview.count({
      where: { application: { recruitmentId: "recruitment-2026" } }
    });
    
    const totalRecruiters = await prisma.recruitmentRoleAssignment.count({ 
      where: { role: 'RECRUITER', active: true } 
    });
    const totalPanels = await prisma.recruitmentPanel.count();

    const shortlisted = await prisma.recruitmentApplication.count({ where: { status: 'SHORTLISTED', recruitmentId: "recruitment-2026" } });
    const scheduledInterviews = await prisma.recruitmentApplication.count({ where: { status: 'INTERVIEW_SCHEDULED', recruitmentId: "recruitment-2026" } });
    const completedInterviews = await prisma.recruitmentApplication.count({ where: { status: 'INTERVIEW_COMPLETED', recruitmentId: "recruitment-2026" } });
    const selectedCandidates = await prisma.recruitmentApplication.count({ where: { status: 'SELECTED', recruitmentId: "recruitment-2026" } });
    const rejectedCandidates = await prisma.recruitmentApplication.count({ where: { status: 'REJECTED', recruitmentId: "recruitment-2026" } });
    
    const pendingFeedback = await prisma.recruitmentInterview.count({ where: { status: 'FEEDBACK_PENDING', application: { recruitmentId: "recruitment-2026" } } });

    const applicationsByStatusRaw = await prisma.recruitmentApplication.groupBy({
      by: ['status'],
      where: { recruitmentId: "recruitment-2026" },
      _count: { status: true }
    });
    const applicationsByStatus = applicationsByStatusRaw.reduce((acc, curr) => {
      acc[curr.status] = curr._count.status;
      return acc;
    }, {});

    const departmentsWithApps = await prisma.recruitmentApplication.groupBy({
      by: ['domain'],
      where: { recruitmentId: "recruitment-2026" },
      _count: { id: true }
    });
    
    const applicationsByDepartment = departmentsWithApps.map((d) => ({
      department: d.domain || "Unknown",
      count: d._count.id
    }));

    const selectedVsRejected = {
      SELECTED: selectedCandidates,
      REJECTED: rejectedCandidates
    };

    const allInterviews = await prisma.recruitmentInterview.findMany({
      where: { application: { recruitmentId: "recruitment-2026" } },
      select: { start_time: true }
    });
    
    const interviewsByDayRaw = {};
    allInterviews.forEach((inv) => {
      const istDate = toISTDateString(inv.start_time);
      interviewsByDayRaw[istDate] = (interviewsByDayRaw[istDate] || 0) + 1;
    });

    const interviewsByDay = Object.keys(interviewsByDayRaw)
      .sort()
      .map(date => ({ date, count: interviewsByDayRaw[date] }));

    const recentActivity = await prisma.recruitmentAuditLog.findMany({
      orderBy: { timestamp: 'desc' },
      take: 10
    });

    const formattedActivity = recentActivity.map((a) => ({
       ...a,
       id: a.id.toString(),
       user_id: a.user_id ? a.user_id.toString() : null
    }));

    return res.status(200).json({
      metrics: {
        totalApplications,
        totalCandidates,
        totalInterviews,
        totalRecruiters,
        totalPanels,
        shortlisted,
        scheduledInterviews,
        completedInterviews,
        selectedCandidates,
        rejectedCandidates,
        pendingFeedback
      },
      applicationsByStatus,
      applicationsByDepartment,
      selectedVsRejected,
      interviewsByDay,
      recentActivity: formattedActivity
    });
  } catch (error) {
    console.error("Fetch analytics error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
