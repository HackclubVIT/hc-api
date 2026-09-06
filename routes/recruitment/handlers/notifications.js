import prisma from "../../../prismaClient.js";
import { getSession } from "../lib/auth.js";

export const getNotifications = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session) return res.status(401).json({ error: "Unauthorized" });

    const searchParams = new URLSearchParams(req.query);
    const page = Math.max(1, parseInt(searchParams.get("page") || "1") || 1);
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "20") || 20));
    const skip = (page - 1) * limit;

    const userId = BigInt(session.id);

    const [notifications, total] = await Promise.all([
      prisma.recruitmentNotification.findMany({
        where: { user_id: userId },
        orderBy: { created_at: 'desc' },
        skip,
        take: limit
      }),
      prisma.recruitmentNotification.count({
        where: { user_id: userId }
      })
    ]);

    const unreadCount = await prisma.recruitmentNotification.count({
      where: { user_id: userId, read: false }
    });

    const formattedNotifications = notifications.map(n => ({
      ...n,
      user_id: n.user_id.toString()
    }));

    return res.status(200).json({ 
      notifications: formattedNotifications, 
      unreadCount,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error("Get notifications error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const readNotifications = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session) return res.status(401).json({ error: "Unauthorized" });

    const { id } = req.body || {};
    const userId = BigInt(session.id);

    if (id) {
      const result = await prisma.recruitmentNotification.updateMany({
        where: { id: parseInt(id, 10), user_id: userId },
        data: { read: true }
      });
      if (result.count === 0) {
        return res.status(404).json({ error: "Notification not found or unauthorized" });
      }
    } else {
      await prisma.recruitmentNotification.updateMany({
        where: { user_id: userId, read: false },
        data: { read: true }
      });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Read notifications error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
