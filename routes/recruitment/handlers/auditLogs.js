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
    const q = (searchParams.get("q") || "").trim();
    const action = (searchParams.get("action") || "").trim();
    const entity = (searchParams.get("entity") || "").trim();

    const where = {};

    if (action) {
      where.action = { contains: action, mode: "insensitive" };
    }

    if (entity) {
      where.entity = { equals: entity, mode: "insensitive" };
    }

    if (q) {
      where.OR = [
        { action: { contains: q, mode: "insensitive" } },
        { entity: { contains: q, mode: "insensitive" } },
        { entity_id: { contains: q, mode: "insensitive" } },
        {
          user: {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } }
            ]
          }
        }
      ];
    }

    const [items, total] = await Promise.all([
      prisma.recruitmentAuditLog.findMany({
        where,
        include: {
          user: {
            select: {
              name: true,
              email: true,
              role: true,
              recruitmentRole: {
                select: {
                  role: true
                }
              }
            }
          }
        },
        orderBy: { timestamp: 'desc' },
        skip,
        take: limit
      }),
      prisma.recruitmentAuditLog.count({ where })
    ]);

    const formattedItems = items.map(log => ({
      ...log,
      user_id: log.user_id ? log.user_id.toString() : null,
      user: log.user ? {
        name: log.user.name,
        email: log.user.email,
        role: log.user.recruitmentRole?.role || log.user.role || "Member"
      } : null
    }));

    return res.status(200).json({
      items: formattedItems,
      logs: formattedItems, // backward-compatibility for frontend
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
