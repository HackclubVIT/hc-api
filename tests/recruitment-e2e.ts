import { PrismaClient } from '@prisma/client'
import { signToken } from '../src/lib/auth.js'


if (!process.env.TEST_DATABASE_URL) {
  console.error('CRITICAL ERROR: E2E tests MUST use an isolated TEST_DATABASE_URL to prevent destroying HC data.');
  process.exit(1);
}
if (process.env.TEST_DATABASE_URL === process.env.DATABASE_URL) {
  console.error('CRITICAL ERROR: TEST_DATABASE_URL cannot be the same as DATABASE_URL. Safety check failed.');
  process.exit(1);
}
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.TEST_DATABASE_URL } }
})

const API_URL = "http://localhost:3001/api"

async function makeRequest(path: string, method: string, payload?: any, role: string = 'ADMIN', userId: string = 'admin-1', departments: string[] = []) {
  const token = await signToken({ id: userId, role, departments })
  
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `session=${token}`
    },
    body: payload ? JSON.stringify(payload) : undefined
  })
  
  const text = await res.text()
  try {
    return { status: res.status, data: JSON.parse(text) }
  } catch (e) {
    return { status: res.status, data: text }
  }
}

async function runTests() {
  console.log("Starting Security and Consistency E2E Test Pass...")
  
  // 1. Clean DB (Safe cleanup for local test)
  
  // Safe scoped cleanup for local test namespace
  await prisma.recruitmentAuditLog.deleteMany({});
  await prisma.recruitmentNotification.deleteMany({});
  await prisma.recruitmentFeedback.deleteMany({});
  await prisma.recruitmentInterview.deleteMany({});
  await prisma.recruitmentPanelMember.deleteMany({});
  await prisma.recruitmentPanel.deleteMany({ where: { name: { contains: 'Panel' } } });
  await prisma.recruitmentApplication.deleteMany({ where: { email: { endsWith: '@test.com' } } });
  await prisma.recruitmentFormQuestion.deleteMany({});
  await prisma.recruitmentForm.deleteMany({});
  await prisma.recruitmentRoleAssignment.deleteMany({});
  await prisma.user.deleteMany({ where: { email: { endsWith: '@test.com' } } });

  
  // Seed basic users as standard HC Members
  const admin = await prisma.user.create({ data: { id: BigInt(Date.now() + Math.floor(Math.random() * 10000)), name: 'Admin', email: 'admin@test.com', role: 'Member', password: 'pw' } })
  const recruiter = await prisma.user.create({ data: { id: BigInt(Date.now() + Math.floor(Math.random() * 10000)), name: 'Recruiter', email: 'recruiter@test.com', role: 'Member', password: 'pw' } })
  const panelMemberA = await prisma.user.create({ data: { id: BigInt(Date.now() + Math.floor(Math.random() * 10000)), name: 'PM_A', email: 'a@test.com', role: 'Member', password: 'pw' } })
  const panelMemberB = await prisma.user.create({ data: { id: BigInt(Date.now() + Math.floor(Math.random() * 10000)), name: 'PM_B', email: 'b@test.com', role: 'Member', password: 'pw' } })
  
  // Assign Recruitment Roles
  await prisma.recruitmentRoleAssignment.create({ data: { user_id: admin.id, role: 'ADMIN', departments: [], active: true } })
  await prisma.recruitmentRoleAssignment.create({ data: { user_id: recruiter.id, role: 'RECRUITER', departments: ['Engineering'], active: true } })
  await prisma.recruitmentRoleAssignment.create({ data: { user_id: panelMemberA.id, role: 'PANEL_MEMBER', departments: [], active: true } })
  await prisma.recruitmentRoleAssignment.create({ data: { user_id: panelMemberB.id, role: 'PANEL_MEMBER', departments: [], active: true } })
  
  // Create Panel A and Panel B
  const panelA = await prisma.recruitmentPanel.create({ data: { name: 'Panel A', status: 'ACTIVE' } })
  const panelB = await prisma.recruitmentPanel.create({ data: { name: 'Panel B', status: 'ACTIVE' } })
  
  // Create memberships
  await prisma.recruitmentPanelMember.create({ data: { panel_id: panelA.id, user_id: panelMemberA.id.toString() } })
  await prisma.recruitmentPanelMember.create({ data: { panel_id: panelA.id, user_id: panelMemberB.id.toString() } }) // Both in Panel A
  
  // 2. FORM TEST (Req 43)
  const formRes = await makeRequest('/forms', 'POST', { title: 'Test Form', description: 'desc', status: 'PUBLISHED' }, 'ADMIN', admin.id.toString())
  if (formRes.status !== 201) throw new Error("Form creation failed: " + JSON.stringify(formRes.data))
  const form = formRes.data.form
  
  const q1Res = await makeRequest(`/forms/${form.id}/questions`, 'POST', { form_id: form.id, type: 'TEXT', question: 'Q1', required: true }, 'ADMIN', admin.id.toString())
  if (q1Res.status !== 201) throw new Error("Question 1 creation failed: " + JSON.stringify(q1Res.data))
  const q1 = q1Res.data.question

  const q2Res = await makeRequest(`/forms/${form.id}/questions`, 'POST', { form_id: form.id, type: 'CHECKBOX', question: 'Q2', required: true, options: ['A','B','C'] }, 'ADMIN', admin.id.toString())
  if (q2Res.status !== 201) throw new Error("Question 2 creation failed: " + JSON.stringify(q2Res.data))
  const q2 = q2Res.data.question
  
  const pubRes = await makeRequest(`/forms/${form.id}`, 'PUT', { status: 'PUBLISHED' }, 'ADMIN', admin.id.toString())
  if (pubRes.status !== 200) throw new Error("Form publish failed: " + JSON.stringify(pubRes.data))
  
  // PUBLIC FORM SECURITY & APPLICATION SUBMISSION REGRESSION TEST (Req Final)
  // Create a DRAFT form
  const draftFormRes = await makeRequest('/forms', 'POST', { title: 'Draft Form', description: 'desc', status: 'DRAFT' }, 'ADMIN', admin.id.toString())
  const draftForm = draftFormRes.data.form
  const draftGetPublic = await fetch(`${API_URL}/forms/${draftForm.id}`)
  if (draftGetPublic.status !== 404) throw new Error("Publicly retrieved a DRAFT form! Status: " + draftGetPublic.status)
  
  const draftSubmit = await fetch(`${API_URL}/applications`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ form_id: draftForm.id, name: 'T', email: 't@t.com', phone: '1', department: 'Engineering', registration_number: 'R1' }) })
  if (draftSubmit.status !== 400) throw new Error("Successfully submitted to a DRAFT form! Status: " + draftSubmit.status)

  // Create a CLOSED form
  const closedFormRes = await makeRequest('/forms', 'POST', { title: 'Closed Form', description: 'desc', status: 'CLOSED' }, 'ADMIN', admin.id.toString())
  const closedForm = closedFormRes.data.form
  const closedGetPublic = await fetch(`${API_URL}/forms/${closedForm.id}`)
  if (closedGetPublic.status !== 404) throw new Error("Publicly retrieved a CLOSED form! Status: " + closedGetPublic.status)

  const closedSubmit = await fetch(`${API_URL}/applications`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ form_id: closedForm.id, name: 'T2', email: 't2@t.com', phone: '2', department: 'Engineering', registration_number: 'R2' }) })
  if (closedSubmit.status !== 400) throw new Error("Successfully submitted to a CLOSED form! Status: " + closedSubmit.status)

  // Test PUBLISHED form GET public
  const pubGetPublic = await fetch(`${API_URL}/forms/${form.id}`)
  if (pubGetPublic.status !== 200) throw new Error("Public failed to retrieve PUBLISHED form! Status: " + pubGetPublic.status)

  // Public Apply (Candidate A)
  const applyResA = await fetch(`${API_URL}/applications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      form_id: form.id,
      name: 'Candidate A',
      email: 'candA@test.com',
      phone: '1234567890',
      department: 'Engineering',
      registration_number: 'REG001',
      answers: {
        [q1.id.toString()]: "My text answer",
        [q2.id.toString()]: ['A', 'B'] // Correct checkbox format
      }
    })
  })
  if (applyResA.status !== 201) throw new Error("Application A failed: " + await applyResA.text())
  const appA = (await applyResA.json()).applicationId
  
  // Validate duplicate rejection
  const dupApply = await fetch(`${API_URL}/applications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      form_id: form.id,
      name: 'Candidate A',
      email: 'candA@test.com',
      phone: '1234567890',
      department: 'Engineering',
      registration_number: 'REG001',
      answers: {
        [q1.id.toString()]: "My text answer",
        [q2.id.toString()]: ['A', 'B'] // Correct checkbox format
      }
    })
  })
  if (dupApply.status !== 409) throw new Error("Duplicate rejection failed. Status: " + dupApply.status)
  
  // Public Apply (Candidate B) - Unrelated department
  const applyResB = await fetch(`${API_URL}/applications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      form_id: form.id,
      name: 'Candidate B',
      email: 'candB@test.com',
      phone: '1234567890',
      department: 'Sales',
      registration_number: 'REG002',
      answers: {
        [q1.id.toString()]: "Another answer",
        [q2.id.toString()]: ['A']
      }
    })
  })
  if (applyResB.status !== 201) throw new Error("Application B failed: " + await applyResB.text())
  const appB = (await applyResB.json()).applicationId
  
  // Get Candidates directly
  const candA = await prisma.recruitmentApplication.findFirst({ where: { email: 'candA@test.com' } })
  const candB = await prisma.recruitmentApplication.findFirst({ where: { email: 'candB@test.com' } })

  const urResA = await makeRequest(`/applications/${appA}`, 'PUT', { status: 'UNDER_REVIEW' }, 'RECRUITER', recruiter.id.toString(), ['Engineering'])
  if (urResA.status !== 200) throw new Error("Recruiter UNDER_REVIEW failed: " + JSON.stringify(urResA.data))

  const slResA = await makeRequest(`/applications/${appA}`, 'PUT', { status: 'SHORTLISTED' }, 'RECRUITER', recruiter.id.toString(), ['Engineering'])
  if (slResA.status !== 200) throw new Error("Recruiter shortlisting failed: " + JSON.stringify(slResA.data))

  // SCHEDULE INTERVIEW A
  const schedARes = await makeRequest('/interviews/schedule', 'POST', {
    candidate_id: candA!.id,
    application_id: appA,
    panel_id: panelA.id,
    date: '2026-10-15',
    start_time: '10:00'
  }, 'RECRUITER', recruiter.id.toString(), ['Engineering'])
  if (schedARes.status !== 201) throw new Error("Scheduling failed: " + JSON.stringify(schedARes.data))
  const intA = schedARes.data.interview
  
  // Double Booking Test (Req 42)
  // Create Cand C to book the same slot for Panel A
  const applyResC = await fetch(`${API_URL}/applications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      form_id: form.id, name: 'Candidate C', email: 'candC@test.com', phone: '1234567890', department: 'Engineering', registration_number: 'REG003',
      answers: { [q1.id.toString()]: "C text", [q2.id.toString()]: ['A'] }
    })
  })
  const appC = (await applyResC.json()).applicationId
  const candC = await prisma.recruitmentApplication.findFirst({ where: { email: 'candC@test.com' } })
  await makeRequest(`/applications/${appC}`, 'PUT', { status: 'UNDER_REVIEW' }, 'RECRUITER', recruiter.id.toString(), ['Engineering'])
  await makeRequest(`/applications/${appC}`, 'PUT', { status: 'SHORTLISTED' }, 'RECRUITER', recruiter.id.toString(), ['Engineering'])

  const doubleSched = await makeRequest('/interviews/schedule', 'POST', {
    candidate_id: candC!.id,
    application_id: appC,
    panel_id: panelA.id,
    date: '2026-10-15',
    start_time: '10:00'
  }, 'RECRUITER', recruiter.id.toString(), ['Engineering'])
  if (doubleSched.status !== 409) throw new Error("Double booking not blocked. Status: " + doubleSched.status + " Data: " + JSON.stringify(doubleSched.data))
  
  // SECURITY TEST (Req 38)
  // Panel Member A CAN access Interview A
  const intAGet = await makeRequest(`/interviews/${intA.id}`, 'GET', null, 'PANEL_MEMBER', panelMemberA.id.toString())
  if (intAGet.status !== 200) throw new Error("Panel A access Interview A failed. Status: " + intAGet.status)
  
  // NEW PANEL MEMBER TEST (Req 6)
  // Interview 1 has A and B assigned. We add a new member D to the live panel A.
  const pmD = await prisma.user.create({ data: { id: BigInt(Date.now() + Math.floor(Math.random() * 10000)), name: 'PM_D', email: 'd@test.com', role: 'PANEL_MEMBER', password: 'pw' } })
  await prisma.recruitmentPanelMember.create({ data: { user_id: pmD.id, panel_id: panelA.id } })
  
  // Verify D is NOT added to assigned_members
  const intACheckMembers = await prisma.recruitmentInterview.findUnique({ where: { id: intA.id }, include: { assigned_members: true } })
  if (intACheckMembers!.assigned_members.length !== 2) throw new Error("New panel member was improperly assigned to a historical interview!")
  
  // Verify D cannot submit feedback for Interview A
  const fD = await makeRequest('/feedback', 'POST', {
    interview_id: intA.id, technical_score: 5, communication_score: 5, problem_solving_score: 5,
    confidence_score: 5, teamwork_score: 5, decision: 'RECOMMENDED', comments: 'test'
  }, 'PANEL_MEMBER', pmD.id)
  if (fD.status !== 403) throw new Error("Unassigned live panel member submitted feedback! Status: " + fD.status)

  // Clean up D so they don't get assigned to future Panel A interviews in this test script
  await prisma.recruitmentPanelMember.deleteMany({ where: { user_id: pmD.id } })

  
  // Panel Member A CANNOT access Application B
  const appBGet = await makeRequest(`/applications/${appB}`, 'GET', null, 'PANEL_MEMBER', panelMemberA.id.toString())
  if (appBGet.status !== 403 && appBGet.status !== 404) throw new Error("Panel A accessed Application B incorrectly: " + appBGet.status)

  // Start Interview A
  const startIntRes = await makeRequest(`/interviews/${intA.id}`, 'PUT', { status: 'IN_PROGRESS' }, 'PANEL_MEMBER', panelMemberA.id.toString())
  if (startIntRes.status !== 200) throw new Error("Failed to start interview: " + JSON.stringify(startIntRes.data))
  
  const compIntRes = await makeRequest(`/interviews/${intA.id}`, 'PUT', { status: 'COMPLETED' }, 'PANEL_MEMBER', panelMemberA.id.toString())
  if (compIntRes.status !== 200) throw new Error("Failed to complete interview: " + JSON.stringify(compIntRes.data))
  
  // FEEDBACK TEST (Req 39, Req 23)
  // A submits feedback
  const f1 = await makeRequest('/feedback', 'POST', {
    interview_id: intA.id,
    technical_score: 5, communication_score: 5, problem_solving_score: 5,
    confidence_score: 5, teamwork_score: 5, decision: 'RECOMMENDED', comments: 'good'
  }, 'PANEL_MEMBER', panelMemberA.id.toString())
  if (f1.status !== 201) throw new Error("Feedback submission A failed: " + JSON.stringify(f1.data))

  // Check interview status -> should still be FEEDBACK_PENDING since B hasn't submitted
  const intACheck = await prisma.recruitmentInterview.findUnique({ where: { id: intA.id } })
  if (intACheck!.status !== 'FEEDBACK_PENDING') throw new Error("Interview prematurely submitted: " + intACheck!.status)
  
  // B submits feedback
  const f2 = await makeRequest('/feedback', 'POST', {
    interview_id: intA.id,
    technical_score: 5, communication_score: 5, problem_solving_score: 5,
    confidence_score: 5, teamwork_score: 5, decision: 'RECOMMENDED', comments: 'good'
  }, 'PANEL_MEMBER', panelMemberB.id.toString())
  if (f2.status !== 201) throw new Error("Feedback submission B failed: " + JSON.stringify(f2.data))

  // Check interview status -> should be FEEDBACK_SUBMITTED
  const intAFin = await prisma.recruitmentInterview.findUnique({ where: { id: intA.id } })
  if (intAFin!.status !== 'FEEDBACK_SUBMITTED') throw new Error("Interview not marked FEEDBACK_SUBMITTED")
  
  // Check application -> INTERVIEW_COMPLETED
  const appAFin = await prisma.recruitmentApplication.findUnique({ where: { id: appA } })
  if (appAFin!.status !== 'INTERVIEW_COMPLETED') throw new Error("Application not marked INTERVIEW_COMPLETED")

  // FINAL DECISION TEST (Req 40)
  const decisionRes = await makeRequest(`/applications/${appA}`, 'PUT', { status: 'SELECTED' }, 'RECRUITER', recruiter.id.toString(), ['Engineering'])
  if (decisionRes.status !== 200) throw new Error("Final decision failed: " + JSON.stringify(decisionRes.data))
  
  // Verify audit logs and decided_by
  const decApp = await prisma.recruitmentApplication.findUnique({ where: { id: appA } })
  if (decApp!.decided_by !== recruiter.id.toString()) throw new Error("decided_by not set")
  
  // FURTHER ROUND TEST (Req 41)
  const urResB = await makeRequest(`/applications/${appB}`, 'PUT', { status: 'UNDER_REVIEW' }, 'ADMIN', admin.id.toString())
  if (urResB.status !== 200) throw new Error("Admin UNDER_REVIEW B failed: " + JSON.stringify(urResB.data))

  const slResB = await makeRequest(`/applications/${appB}`, 'PUT', { status: 'SHORTLISTED' }, 'ADMIN', admin.id.toString())
  if (slResB.status !== 200) throw new Error("Admin shortlisting B failed: " + JSON.stringify(slResB.data))

  const schedBRes = await makeRequest('/interviews/schedule', 'POST', {
    candidate_id: candB!.id, application_id: appB, panel_id: panelA.id,
    date: '2026-10-16', start_time: '10:00'
  }, 'ADMIN', admin.id.toString())
  if (schedBRes.status !== 201) throw new Error("Admin scheduling B failed: " + JSON.stringify(schedBRes.data))
  const intB = schedBRes.data.interview
  
  const startIntB = await makeRequest(`/interviews/${intB.id}`, 'PUT', { status: 'IN_PROGRESS' }, 'ADMIN', admin.id.toString())
  if (startIntB.status !== 200) throw new Error("Admin starting B failed: " + JSON.stringify(startIntB.data))

  const compIntB = await makeRequest(`/interviews/${intB.id}`, 'PUT', { status: 'COMPLETED' }, 'ADMIN', admin.id.toString())
  if (compIntB.status !== 200) throw new Error("Admin completing B failed: " + JSON.stringify(compIntB.data))
  
  const fb1 = await makeRequest('/feedback', 'POST', {
    interview_id: intB.id,
    technical_score: 5, communication_score: 5, problem_solving_score: 5,
    confidence_score: 5, teamwork_score: 5, decision: 'RECOMMENDED', comments: 'good'
  }, 'PANEL_MEMBER', panelMemberA.id.toString())
  if (fb1.status !== 201) throw new Error("Feedback B1 failed: " + JSON.stringify(fb1.data))
  
  const fb2 = await makeRequest('/feedback', 'POST', {
    interview_id: intB.id,
    technical_score: 5, communication_score: 5, problem_solving_score: 5,
    confidence_score: 5, teamwork_score: 5, decision: 'RECOMMENDED', comments: 'good'
  }, 'PANEL_MEMBER', panelMemberB.id.toString())
  if (fb2.status !== 201) throw new Error("Feedback B2 failed: " + JSON.stringify(fb2.data))

  const intBFin = await prisma.recruitmentInterview.findUnique({ where: { id: intB.id } })
  if (intBFin!.status !== 'FEEDBACK_SUBMITTED') throw new Error("Interview B not marked FEEDBACK_SUBMITTED")
  
  const appBFin = await prisma.recruitmentApplication.findUnique({ where: { id: appB } })
  if (appBFin!.status !== 'INTERVIEW_COMPLETED') throw new Error("Application B not marked INTERVIEW_COMPLETED")

  const frRes = await makeRequest(`/applications/${appB}`, 'PUT', { status: 'FURTHER_ROUND' }, 'ADMIN', admin.id.toString())
  if (frRes.status !== 200) throw new Error("Further round transition failed: " + JSON.stringify(frRes.data))
  
  const frApp = await prisma.recruitmentApplication.findUnique({ where: { id: appB } })
  if (frApp!.decided_by !== null) throw new Error("decided_by should be null for FURTHER_ROUND")
  
  // Schedule next round
  const schedB2Res = await makeRequest('/interviews/schedule', 'POST', {
    candidate_id: candB!.id, application_id: appB, panel_id: panelB.id,
    date: '2026-10-17', start_time: '10:00'
  }, 'ADMIN', admin.id.toString())
  if (schedB2Res.status !== 201) throw new Error("Admin scheduling B round 2 failed: " + JSON.stringify(schedB2Res.data))
  if (schedB2Res.data.interview.round !== 2) throw new Error("Further round did not increment round number")
  
  // NEW INTERVIEW CONFLICT TEST (Req 14)
  // Panel A currently has A and B (Wait, it actually has A and B, we added them at line 48).
  // Let's add C to Panel A.
  const pmC = await prisma.user.create({ data: { id: BigInt(Date.now() + Math.floor(Math.random() * 10000)), name: 'PM_C', email: 'c@test.com', role: 'PANEL_MEMBER', password: 'pw' } })
  const panelMemberC = await prisma.recruitmentPanelMember.create({ data: { user_id: pmC.id, panel_id: panelA.id } })
  
  // Create Cand D
  const applyResD = await fetch(`${API_URL}/applications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      form_id: form.id, name: 'Candidate D', email: 'candD@test.com', phone: '1234567890', department: 'Engineering', registration_number: 'REG004',
      answers: { [q1.id.toString()]: "D text", [q2.id.toString()]: ['A'] }
    })
  })
  const appD = (await applyResD.json()).applicationId
  const candD = await prisma.recruitmentApplication.findFirst({ where: { email: 'candD@test.com' } })
  await makeRequest(`/applications/${appD}`, 'PUT', { status: 'UNDER_REVIEW' }, 'RECRUITER', recruiter.id.toString(), ['Engineering'])
  await makeRequest(`/applications/${appD}`, 'PUT', { status: 'SHORTLISTED' }, 'RECRUITER', recruiter.id.toString(), ['Engineering'])

  // Schedule Int D for Panel A (now has A, B, C)
  const schedDRes = await makeRequest('/interviews/schedule', 'POST', {
    candidate_id: candD!.id, application_id: appD, panel_id: panelA.id,
    date: '2026-10-20', start_time: '10:00'
  }, 'ADMIN', admin.id.toString())
  if (schedDRes.status !== 201) throw new Error("Scheduling D failed: " + JSON.stringify(schedDRes.data))
  const intD = schedDRes.data.interview

  // Remove C from Panel A
  await prisma.recruitmentPanelMember.update({ where: { id: panelMemberC.id }, data: { active: false } })
  
  // Add C to Panel B
  await prisma.recruitmentPanelMember.create({ data: { user_id: pmC.id, panel_id: panelB.id } })

  // Schedule Int E for Panel B at same time as Int D
  // Create Cand E
  const applyResG = await fetch(`${API_URL}/applications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      form_id: form.id, name: 'Candidate G', email: 'candG@test.com', phone: '1234567890', department: 'Engineering', registration_number: 'REG007',
      answers: { [q1.id.toString()]: "E text", [q2.id.toString()]: ['A'] }
    })
  })
  const appG = (await applyResG.json()).applicationId
  const candG = await prisma.recruitmentApplication.findFirst({ where: { email: 'candG@test.com' } })
  await makeRequest(`/applications/${appG}`, 'PUT', { status: 'UNDER_REVIEW' }, 'RECRUITER', recruiter.id.toString(), ['Engineering'])
  await makeRequest(`/applications/${appG}`, 'PUT', { status: 'SHORTLISTED' }, 'RECRUITER', recruiter.id.toString(), ['Engineering'])

  const schedERes = await makeRequest('/interviews/schedule', 'POST', {
    candidate_id: candG!.id, application_id: appG, panel_id: panelB.id,
    date: '2026-10-20', start_time: '10:00' // SAME TIME AS INT D
  }, 'ADMIN', admin.id.toString())
  
  if (schedERes.status !== 409) throw new Error("Historical conflict scheduling failed to block. Status: " + schedERes.status)

  // FINAL DECISION REGRESSION TEST (Req 15)
  // Int D has assigned members A, B, C.
  await makeRequest(`/interviews/${intD.id}`, 'PUT', { status: 'IN_PROGRESS' }, 'PANEL_MEMBER', panelMemberA.id.toString())
  await makeRequest(`/interviews/${intD.id}`, 'PUT', { status: 'COMPLETED' }, 'PANEL_MEMBER', panelMemberA.id.toString())
  
  // Submit A and B feedback
  await makeRequest('/feedback', 'POST', { interview_id: intD.id, technical_score: 5, communication_score: 5, problem_solving_score: 5, confidence_score: 5, teamwork_score: 5, decision: 'RECOMMENDED', comments: 'good' }, 'PANEL_MEMBER', panelMemberA.id.toString())
  await makeRequest('/feedback', 'POST', { interview_id: intD.id, technical_score: 5, communication_score: 5, problem_solving_score: 5, confidence_score: 5, teamwork_score: 5, decision: 'RECOMMENDED', comments: 'good' }, 'PANEL_MEMBER', panelMemberB.id.toString())
  
  // Attempt final decision - MUST FAIL because C has not submitted, even though C is no longer on Panel A
  const decDFail = await makeRequest(`/applications/${appD}`, 'PUT', { status: 'SELECTED' }, 'RECRUITER', recruiter.id.toString(), ['Engineering'])
  if (decDFail.status !== 400) throw new Error("Final decision succeeded improperly without historical C feedback. Status: " + decDFail.status)
  
  // Submit C feedback (using C's original panelMemberC id from Panel A, which is inactive, but they can still submit for historical assignments)
  const cFbRes = await makeRequest('/feedback', 'POST', { interview_id: intD.id, technical_score: 5, communication_score: 5, problem_solving_score: 5, confidence_score: 5, teamwork_score: 5, decision: 'RECOMMENDED', comments: 'good' }, 'PANEL_MEMBER', pmC.id)
  if (cFbRes.status !== 201) throw new Error("Historical member C failed to submit feedback: " + JSON.stringify(cFbRes.data))

  // Now attempt final decision - MUST SUCCEED
  const decDSuccess = await makeRequest(`/applications/${appD}`, 'PUT', { status: 'SELECTED' }, 'RECRUITER', recruiter.id.toString(), ['Engineering'])
  if (decDSuccess.status !== 200) throw new Error("Final decision failed after C feedback: " + JSON.stringify(decDSuccess.data))
  
  // Req 6: Active Membership Security
  await prisma.recruitmentPanelMember.updateMany({
    where: { user_id: panelMemberA.id.toString() },
    data: { active: false }
  })

  // Panel Member A CANNOT access newly assigned interviews
  const schedCRes = await makeRequest('/interviews/schedule', 'POST', {
    candidate_id: candC!.id, application_id: appC, panel_id: panelA.id,
    date: '2026-10-18', start_time: '10:00'
  }, 'ADMIN', admin.id.toString())
  if (schedCRes.status !== 201) throw new Error("Scheduling C failed: " + JSON.stringify(schedCRes.data))
  const intC = schedCRes.data.interview

  // A cannot access intC
  const intCGet = await makeRequest(`/interviews/${intC.id}`, 'GET', null, 'PANEL_MEMBER', panelMemberA.id.toString())
  if (intCGet.status !== 403 && intCGet.status !== 404) throw new Error("Inactive Member A accessed new interview incorrectly: " + intCGet.status)

  // APPLICATION AUTHORIZATION REGRESSION TEST
  // C is no longer on Panel A but was assigned to intD for appD.
  // C MUST be able to GET appD.
  const appDGetByC = await makeRequest(`/applications/${appD}`, 'GET', null, 'PANEL_MEMBER', pmC.id)
  if (appDGetByC.status !== 200) throw new Error("Historical Member C could not access appD: " + appDGetByC.status)

  // D is on Panel A, but D was NOT assigned to intD.
  // D MUST NOT be able to GET appD.
  const appDGetByD = await makeRequest(`/applications/${appD}`, 'GET', null, 'PANEL_MEMBER', pmD.id)
  if (appDGetByD.status !== 403 && appDGetByD.status !== 404) throw new Error("Unassigned Member D improperly accessed appD: " + appDGetByD.status)
  
  // E2E CANDIDATE AUTHORIZATION TEST (Req 18)
  const candDGetByC = await makeRequest(`/candidates/${candD!.id}`, 'GET', null, 'PANEL_MEMBER', pmC.id)
  if (candDGetByC.status !== 200) throw new Error("Historical Member C could not access candD: " + candDGetByC.status)

  const candDGetByD = await makeRequest(`/candidates/${candD!.id}`, 'GET', null, 'PANEL_MEMBER', pmD.id)
  if (candDGetByD.status !== 403 && candDGetByD.status !== 404) throw new Error("Unassigned Member D improperly accessed candD: " + candDGetByD.status)
  
  // SAME PANEL CONFLICT TEST (Req 9)
  const emptyPanel = await prisma.recruitmentPanel.create({ data: { name: 'Empty Panel', status: 'ACTIVE' } })
  
  // Create fresh candidate E2 for conflict test
  const applyResE2 = await fetch(`${API_URL}/applications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      form_id: form.id, name: 'Candidate E2', email: 'candE2@test.com', phone: '1234567890', department: 'Engineering', registration_number: 'REG010',
      answers: { [q1.id.toString()]: "E text", [q2.id.toString()]: ['A'] }
    })
  })
  const appE2 = (await applyResE2.json()).applicationId
  const candE2 = await prisma.recruitmentApplication.findFirst({ where: { email: 'candE2@test.com' } })
  
  // Transition E2 to SHORTLISTED so it can be scheduled
  await makeRequest(`/applications/${appE2}`, 'PUT', { status: 'UNDER_REVIEW' }, 'RECRUITER', recruiter.id.toString(), ['Engineering'])
  await makeRequest(`/applications/${appE2}`, 'PUT', { status: 'SHORTLISTED' }, 'RECRUITER', recruiter.id.toString(), ['Engineering'])

  const emptyInt1 = await makeRequest('/interviews/schedule', 'POST', {
    candidate_id: candE2!.id, application_id: appE2, panel_id: emptyPanel.id,
    date: '2026-11-01', start_time: '12:00'
  }, 'ADMIN', admin.id.toString())
  if (emptyInt1.status !== 201) throw new Error("Could not schedule on empty panel: " + JSON.stringify(emptyInt1.data))
  
  // Create fresh Candidate H for the second conflict
  const applyResH = await fetch(`${API_URL}/applications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      form_id: form.id, name: 'Candidate H', email: 'candH@test.com', phone: '1234567890', department: 'Engineering', registration_number: 'REG008',
      answers: { [q1.id.toString()]: "F text", [q2.id.toString()]: ['A'] }
    })
  })
  const appH = (await applyResH.json()).applicationId
  const candH = await prisma.recruitmentApplication.findFirst({ where: { email: 'candH@test.com' } })
  await makeRequest(`/applications/${appH}`, 'PUT', { status: 'UNDER_REVIEW' }, 'RECRUITER', recruiter.id.toString(), ['Engineering'])
  await makeRequest(`/applications/${appH}`, 'PUT', { status: 'SHORTLISTED' }, 'RECRUITER', recruiter.id.toString(), ['Engineering'])

  const emptyInt2 = await makeRequest('/interviews/schedule', 'POST', {
    candidate_id: candH!.id, application_id: appH, panel_id: emptyPanel.id,
    date: '2026-11-01', start_time: '12:00'
  }, 'ADMIN', admin.id.toString())
  
  if (emptyInt2.status !== 409) throw new Error("Failed to detect exact same panel conflict! Status: " + emptyInt2.status)

  // TRUE JWT REVOCATION TEST (Req 13)
  // We need to use the EXACT same token before and after deactivation
  const cToken = await signToken({ id: pmC.id, role: 'PANEL_MEMBER', departments: [] })
  
  // Ensure C is active
  await prisma.user.update({ where: { id: pmC.id }, data: {  } })
  
  const jwtTestBefore = await fetch(`${API_URL}/interviews/${intD.id}`, {
    headers: { 'Cookie': `session=${cToken}` }
  })
  if (jwtTestBefore.status !== 200) throw new Error("C could not access interview initially with explicit JWT")

  // Deactivate C
  await prisma.user.update({ where: { id: pmC.id }, data: { active: false } })
  
  const jwtTestAfter = await fetch(`${API_URL}/interviews/${intD.id}`, {
    headers: { 'Cookie': `session=${cToken}` }
  })
  if (jwtTestAfter.status !== 401 && jwtTestAfter.status !== 403) throw new Error("C accessed interview with a revoked explicit JWT! Status: " + jwtTestAfter.status)

  // FINAL SMALL SECURITY FIX (Req 7)
  // pmB is still an active PanelMember on Panel A.
  // We globally deactivate User B.
  await prisma.user.update({ where: { id: panelMemberB.id.toString() }, data: { active: false } })
  
  // Schedule a new interview (use candE2 since they are available again if we use a different date or they don't have overlapping times)
  // Actually let's create a new candidate I to be safe.
  const applyResI = await fetch(`${API_URL}/applications`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      form_id: form.id, name: 'Candidate I', email: 'candI@test.com', phone: '1234567890', department: 'Engineering', registration_number: 'REG011',
      answers: { [q1.id.toString()]: "I text", [q2.id.toString()]: ['A'] }
    })
  })
  const appI = (await applyResI.json()).applicationId
  const candI = await prisma.recruitmentApplication.findFirst({ where: { email: 'candI@test.com' } })
  await makeRequest(`/applications/${appI}`, 'PUT', { status: 'UNDER_REVIEW' }, 'RECRUITER', recruiter.id.toString(), ['Engineering'])
  await makeRequest(`/applications/${appI}`, 'PUT', { status: 'SHORTLISTED' }, 'RECRUITER', recruiter.id.toString(), ['Engineering'])

  const schedIRes = await makeRequest('/interviews/schedule', 'POST', {
    candidate_id: candI!.id, application_id: appI, panel_id: panelA.id,
    date: '2026-11-05', start_time: '10:00'
  }, 'ADMIN', admin.id.toString())
  if (schedIRes.status !== 201) throw new Error("Scheduling I failed: " + JSON.stringify(schedIRes.data))
  const intI = schedIRes.data.interview

  // Verify B is NOT in assigned_members
  const verifyI = await prisma.recruitmentInterview.findUnique({ where: { id: intI.id }, include: { assigned_members: true } })
  if (verifyI!.assigned_members.some((m: any) => m.user_id === panelMemberB.id.toString())) {
    throw new Error("Globally deactivated User B was improperly assigned to new interview!")
  }

  // Reactivate User B
  await prisma.user.update({ where: { id: panelMemberB.id.toString() }, data: {  } })

  // Schedule another
  const applyResJ = await fetch(`${API_URL}/applications`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      form_id: form.id, name: 'Candidate J', email: 'candJ@test.com', phone: '1234567890', department: 'Engineering', registration_number: 'REG012',
      answers: { [q1.id.toString()]: "J text", [q2.id.toString()]: ['A'] }
    })
  })
  const appJ = (await applyResJ.json()).applicationId
  const candJ = await prisma.recruitmentApplication.findFirst({ where: { email: 'candJ@test.com' } })
  await makeRequest(`/applications/${appJ}`, 'PUT', { status: 'UNDER_REVIEW' }, 'RECRUITER', recruiter.id.toString(), ['Engineering'])
  await makeRequest(`/applications/${appJ}`, 'PUT', { status: 'SHORTLISTED' }, 'RECRUITER', recruiter.id.toString(), ['Engineering'])

  const schedJRes = await makeRequest('/interviews/schedule', 'POST', {
    candidate_id: candJ!.id, application_id: appJ, panel_id: panelA.id,
    date: '2026-11-06', start_time: '10:00'
  }, 'ADMIN', admin.id.toString())
  if (schedJRes.status !== 201) throw new Error("Scheduling J failed: " + JSON.stringify(schedJRes.data))
  const intJ = schedJRes.data.interview

  // Verify B IS in assigned_members
  const verifyJ = await prisma.recruitmentInterview.findUnique({ where: { id: intJ.id }, include: { assigned_members: true } })
  if (!verifyJ!.assigned_members.some((m: any) => m.user_id === panelMemberB.id.toString())) {
    throw new Error("Reactivated User B was improperly excluded from new interview!")
  }

  console.log("All Security and E2E Tests Passed Successfully!")
}

runTests().catch(e => {
  console.error("Test Failed!", e)
  process.exit(1)
})
