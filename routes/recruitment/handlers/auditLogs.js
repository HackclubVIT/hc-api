import prisma from "../../../prismaClient.js";
import { getSession } from "../lib/auth.js";

export const getAuditLogs = async (req, res) => {
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
      prisma.recruitmentAuditLog.findMany({
        include: {
          user: { select: { name: true, email: true, role: true } }
        },
        orderBy: { timestamp: 'desc' },
        skip,
        take: limit
      }),
      prisma.recruitmentAuditLog.count()
    ]);

    const formattedItems = items.map(log => ({
      ...log,
      user_id: log.user_id ? log.user_id.toString() : null
    }));

    return res.status(200).json({
      items: formattedItems,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error("Fetch audit logs error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
