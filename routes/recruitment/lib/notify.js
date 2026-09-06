import prisma from '../../../prismaClient.js';

export async function createNotification(user_id, title, message) {
  try {
    await prisma.recruitmentNotification.create({
      data: {
        user_id: BigInt(user_id),
        title,
        message,
        read: false,
      },
    });
  } catch (error) {
    console.error("Failed to create notification:", error);
  }
}

export async function getRecruitersByDepartment(department) {
  try {
    const recruiters = await prisma.recruitmentRoleAssignment.findMany({
      where: {
        role: "RECRUITER",
        active: true,
        departments: { has: department }
      },
      include: { user: { select: { email: true, name: true } } }
    });
    return recruiters.map(r => ({ email: r.user.email, name: r.user.name }));
  } catch (error) {
    console.error("Failed to get recruiters by department:", error);
    return [];
  }
}

export async function getAdmins() {
  try {
    const admins = await prisma.recruitmentRoleAssignment.findMany({
      where: {
        role: "ADMIN",
        active: true
      },
      include: { user: { select: { email: true, name: true } } }
    });
    return admins.map(a => ({ email: a.user.email, name: a.user.name }));
  } catch (error) {
    console.error("Failed to get admins:", error);
    return [];
  }
}
