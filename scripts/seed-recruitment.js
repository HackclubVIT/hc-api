import prisma from '../prismaClient.js';
import bcrypt from 'bcryptjs';

async function main() {
  console.log('Seeding recruitment initial data (additive only)...');

  const adminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@vitstudent.ac.in';
  const adminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD || 'pass@123';

  let user = await prisma.user.findFirst({
    where: { email: { equals: adminEmail, mode: 'insensitive' } }
  });

  if (!user) {
    if (process.env.ALLOW_USER_CREATION !== 'true') {
      console.warn(`[WARNING] Bootstrap Admin user ${adminEmail} not found in HC database. Creating user (set ALLOW_USER_CREATION=false to disable)...`);
    }

    const hashedPassword = await bcrypt.hash(adminPassword, 10);
    const newId = BigInt(Date.now());

    user = await prisma.user.create({
      data: {
        id: newId,
        name: 'System Admin',
        email: adminEmail,
        password: hashedPassword,
        role: 'Admin',
        status: 'Active',
      }
    });
    console.log(`[INFO] Created new HC user for admin: ${adminEmail}`);
  } else {
    console.log(`Found existing HC user for admin: ${adminEmail}`);
  }

  // Create or update RecruitmentRoleAssignment
  await prisma.recruitmentRoleAssignment.upsert({
    where: { user_id: user.id },
    update: {
      role: 'ADMIN',
      departments: ['CSE', 'ECE', 'DESIGN', 'MANAGEMENT', 'Technical', 'Research and Development', 'Operations', 'Finance', '*'],
      active: true
    },
    create: {
      user_id: user.id,
      role: 'ADMIN',
      departments: ['CSE', 'ECE', 'DESIGN', 'MANAGEMENT', 'Technical', 'Research and Development', 'Operations', 'Finance', '*'],
      active: true
    }
  });
  console.log(`Assigned ADMIN role for recruitment to ${user.email}`);

  // Create a default Form
  const defaultForm = await prisma.recruitmentForm.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      title: 'HackClub VIT General Recruitment',
      description: 'Standard recruitment application form for all departments.',
      status: 'PUBLISHED',
      published_at: new Date()
    }
  });
  console.log(`Verified default recruitment form ID: ${defaultForm.id}`);

  // Create default form questions
  const questions = [
    { form_id: 1, question: 'Why do you want to join HackClub VIT?', type: 'PARAGRAPH', required: true },
    { form_id: 1, question: 'What is your primary tech stack?', type: 'TEXT', required: true },
    { form_id: 1, question: 'Are you available for weekend hackathons?', type: 'RADIO', required: true, options: ['Yes', 'No', 'Maybe'] }
  ];

  for (const q of questions) {
    const existing = await prisma.recruitmentFormQuestion.findFirst({
      where: { form_id: q.form_id, question: q.question }
    });

    if (!existing) {
      await prisma.recruitmentFormQuestion.create({
        data: {
          form_id: q.form_id,
          question: q.question,
          type: q.type,
          required: q.required,
          options: q.options || []
        }
      });
    }
  }

  console.log('Recruitment seed completed successfully.');
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
