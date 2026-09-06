import prisma from '../../../prismaClient.js';

export async function logAudit(user_id, action, entity, entity_id) {
  try {
    const parsedUserId = user_id ? BigInt(user_id) : null;
    await prisma.recruitmentAuditLog.create({
      data: {
        user_id: parsedUserId,
        action,
        entity,
        entity_id: entity_id !== undefined && entity_id !== null ? String(entity_id) : null,
      },
    });
  } catch (error) {
    console.error("Failed to log audit event:", error);
  }
}
