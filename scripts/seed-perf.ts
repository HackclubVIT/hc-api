import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('Starting performance data seed...');
  
  // 1. Create Users
  const users = [];
  
  // 50 Recruiters
  for (let i = 0; i < 50; i++) {
    users.push({
      id: BigInt(20000 + i),
      name: `Recruiter ${i}`,
      email: `recruiter${i}@test.com`,
      role: 'Member'
    });
  }
  
  // 50 Panel Members
  for (let i = 0; i < 50; i++) {
    users.push({
      id: BigInt(30000 + i),
      name: `Panel Member ${i}`,
      email: `pm${i}@test.com`,
      role: 'Member'
    });
  }
  
  // 100 Candidates (Recruities)
  for (let i = 0; i < 100; i++) {
    users.push({
      id: BigInt(40000 + i),
      name: `Candidate ${i}`,
      email: `candidate${i}@test.com`,
      role: 'Member'
    });
  }
  
  await prisma.user.createMany({ data: users, skipDuplicates: true });
  console.log(`Created ${users.length} users.`);

  // 2. Create Roles
  const roles = [];
  for (let i = 0; i < 50; i++) {
    roles.push({
      user_id: BigInt(20000 + i),
      role: 'RECRUITER',
      departments: ['Engineering', 'Design']
    });
    roles.push({
      user_id: BigInt(30000 + i),
      role: 'PANEL_MEMBER',
      departments: []
    });
  }
  await prisma.recruitmentRoleAssignment.createMany({ data: roles, skipDuplicates: true });
  
  // 3. Create Applications
  const applications = [];
  // 100 from actual candidates
  for (let i = 0; i < 100; i++) {
    applications.push({
      id: BigInt(50000 + i),
      recruitmentId: 'recruitment-2026',
      name: `Candidate ${i}`,
      registerNumber: `REG${40000 + i}`,
      email: `candidate${i}@test.com`,
      yearOfStudy: '2',
      domain: 'Engineering',
      status: i % 5 === 0 ? 'SELECTED' : (i % 3 === 0 ? 'REJECTED' : 'Pending')
    });
  }
  // 400 extra random applications
  for (let i = 100; i < 500; i++) {
    applications.push({
      id: BigInt(50000 + i),
      recruitmentId: 'recruitment-2026',
      name: `Candidate ${i}`,
      registerNumber: `REG${40000 + i}`,
      email: `candidate${i}@test.com`,
      yearOfStudy: '2',
      domain: 'Design',
      status: 'Pending'
    });
  }
  await prisma.recruitmentApplication.createMany({ data: applications, skipDuplicates: true });
  console.log(`Created ${applications.length} applications.`);

  // 4. Create Panels & Panel Members
  let panel = await prisma.recruitmentPanel.findFirst({ where: { name: 'Main Panel 2026' } });
  if (!panel) {
    panel = await prisma.recruitmentPanel.create({
      data: { name: 'Main Panel 2026' }
    });
  }
  
  const panelMembers = [];
  for (let i = 0; i < 50; i++) {
    panelMembers.push({
      panel_id: panel.id,
      user_id: BigInt(30000 + i)
    });
  }
  await prisma.recruitmentPanelMember.createMany({ data: panelMembers, skipDuplicates: true });

  // Fetch created panel members to get their IDs
  const createdPMs = await prisma.recruitmentPanelMember.findMany();

  // 5. Create Interviews
  console.log('Creating interviews...');
  let interviewCount = 0;
  for (let i = 0; i < 100; i++) {
    const interview = await prisma.recruitmentInterview.create({
      data: {
        application_id: BigInt(50000 + i),
        panel_id: panel.id,
        recruiter_id: BigInt(20000 + (i % 50)),
        date: new Date(),
        start_time: new Date(),
        end_time: new Date(),
        status: i % 2 === 0 ? 'COMPLETED' : 'SCHEDULED',
      }
    });
    
    // Assign 2 panel members to each interview
    const pm1 = createdPMs[i % 50];
    const pm2 = createdPMs[(i + 1) % 50];
    
    await prisma.$executeRaw`INSERT INTO "_InterviewAssignments" ("A", "B") VALUES (${interview.id}, ${pm1.id}) ON CONFLICT DO NOTHING`;
    await prisma.$executeRaw`INSERT INTO "_InterviewAssignments" ("A", "B") VALUES (${interview.id}, ${pm2.id}) ON CONFLICT DO NOTHING`;
    
    interviewCount++;
  }
  console.log(`Created ${interviewCount} interviews.`);

  // 6. Notifications
  const notifications = [];
  for (let i = 0; i < 50; i++) {
    // Notifications for Recruiters
    for(let j=0; j < 10; j++) {
        notifications.push({
            user_id: BigInt(20000 + i),
            title: 'New Application',
            message: 'A new application was received.'
        });
    }
  }
  await prisma.recruitmentNotification.createMany({ data: notifications, skipDuplicates: true });
  console.log(`Created ${notifications.length} notifications.`);
  
  console.log('Seed complete!');
}

main().catch(console.error).finally(() => prisma.$disconnect());
