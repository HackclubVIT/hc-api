import prisma from "../../../prismaClient.js";
import { getSession } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";
import { encryptPassword, decryptPassword } from "../lib/encryption.js";
import { sendEmail } from "../lib/email.js";
import nodemailer from "nodemailer";
import { z } from "zod";

const emailSettingsSchema = z.object({
  host: z.string().trim().min(1, "SMTP host is required"),
  port: z.coerce.number().int().positive("Invalid port number"),
  secure: z.boolean(),
  user: z.string().trim().min(1, "Username is required"),
  pass: z.string().optional(),
  fromEmail: z.string().trim().email("Invalid sender email").optional().or(z.literal('')),
  fromName: z.string().trim().min(1, "Sender name is required")
});

export const getEmailSettings = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || session.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const setting = await prisma.collection.findUnique({
      where: { name: "smtp_settings" }
    });

    if (setting && setting.data) {
      const data = setting.data;
      data.pass = data.pass ? "********" : "";
      return res.status(200).json(data);
    }

    return res.status(200).json(null);
  } catch (error) {
    console.error("Failed to fetch email settings:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const updateEmailSettings = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || session.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const parsed = emailSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues?.[0];
      const field = issue?.path?.join('.') || 'Form';
      const errMsg = issue?.message ? `${field}: ${issue.message}` : "Invalid payload data";
      return res.status(400).json({ error: errMsg, details: parsed.error.format() });
    }

    const newSettings = parsed.data;

    const existing = await prisma.collection.findUnique({
      where: { name: "smtp_settings" }
    });

    let finalPass = newSettings.pass;
    
    if (!finalPass || finalPass === "********") {
       if (existing && existing.data) {
         finalPass = existing.data.pass;
       }
    } else {
       finalPass = encryptPassword(finalPass);
    }

    const effectiveFromEmail = newSettings.fromEmail || (newSettings.user.includes('@') ? newSettings.user : 'recruitment@hackclubvit.co');

    const updatedData = {
      host: newSettings.host,
      port: newSettings.port,
      secure: newSettings.secure,
      user: newSettings.user,
      pass: finalPass,
      fromEmail: effectiveFromEmail,
      fromName: newSettings.fromName
    };

    await prisma.collection.upsert({
      where: { name: "smtp_settings" },
      update: { data: updatedData },
      create: { name: "smtp_settings", data: updatedData }
    });

    await logAudit(session.id, "UPDATED_SMTP_SETTINGS", "Settings", "smtp_settings");

    updatedData.pass = updatedData.pass ? "********" : "";
    
    return res.status(200).json({ message: "Settings saved successfully", settings: updatedData });
  } catch (error) {
    console.error("Failed to update email settings:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

const emailTestSchema = z.object({
  host: z.string().trim().min(1, "SMTP host is required"),
  port: z.coerce.number().int().positive("Invalid port number"),
  secure: z.boolean(),
  user: z.string().trim().min(1, "Username is required"),
  pass: z.string().optional(),
  fromEmail: z.string().trim().email("Invalid sender email").optional().or(z.literal('')),
  fromName: z.string().trim().min(1, "Sender name is required"),
  testRecipient: z.string().trim().email("Invalid test recipient email address")
});

export const testEmailSettings = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || session.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const parsed = emailTestSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues?.[0];
      const field = issue?.path?.join('.') || 'Form';
      const errMsg = issue?.message ? `${field}: ${issue.message}` : "Invalid payload data";
      return res.status(400).json({ error: errMsg, details: parsed.error.format() });
    }

    const data = parsed.data;
    let finalPass = data.pass;
    
    if (!finalPass || finalPass === "********") {
      const existing = await prisma.collection.findUnique({
        where: { name: "smtp_settings" }
      });
      if (existing && existing.data) {
        finalPass = decryptPassword(existing.data.pass);
      }
    }

    if (!finalPass) {
       return res.status(400).json({ error: "Password is required to test email delivery" });
    }

    const transporter = nodemailer.createTransport({
      host: data.host,
      port: data.port,
      secure: data.secure,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      auth: {
        user: data.user,
        pass: finalPass
      }
    });

    try {
      await transporter.verify();
    } catch (verifyError) {
      console.error("[SMTP TEST VERIFY ERROR]:", verifyError);
      const errorMsg = verifyError?.message || "Unable to connect to the configured SMTP server.";
      return res.status(400).json({ 
        error: `SMTP Connection Failed: ${errorMsg}`, 
        details: errorMsg 
      });
    }

    const senderEmail = data.fromEmail || (data.user.includes('@') ? data.user : (process.env.SMTP_FROM || 'recruitment@hackclubvit.co'));
    const fromAddress = `"${data.fromName || 'HC Recruitment'}" <${senderEmail}>`;
    try {
      await transporter.sendMail({
        from: fromAddress,
        to: data.testRecipient,
        subject: "HackClub VIT Recruitment - Test Email",
        html: `<h2>SMTP Test Successful</h2><p>If you are receiving this email, your SMTP configuration is correct and ready for recruitment notifications.</p>`
      });
      
      await logAudit(session.id, "TEST_SMTP_EMAIL", "Settings", data.testRecipient);
      
      return res.status(200).json({ message: "Test email sent successfully!" });
    } catch (sendError) {
      console.error("[SMTP TEST SEND ERROR]:", sendError);
      const errorMsg = sendError?.message || "Test email could not be sent.";
      return res.status(400).json({ 
        error: `Failed to send email: ${errorMsg}`, 
        details: errorMsg 
      });
    }

  } catch (error) {
    console.error("Failed to test email settings:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const getEmailLogs = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || session.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const logs = await prisma.recruitmentEmailLog.findMany({
      orderBy: { timestamp: 'desc' },
      take: 100
    });

    return res.status(200).json(logs);
  } catch (error) {
    console.error("Failed to fetch email logs:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

const announcementSchema = z.object({
  subject: z.string().min(1),
  html: z.string().min(1),
  preview: z.boolean().optional(),
  recipients: z.object({
    specificUsers: z.array(z.string()).optional(),
    departments: z.array(z.string()).optional(),
    roles: z.array(z.string()).optional(),
    customEmails: z.array(z.string().email()).optional()
  })
});

export const sendEmailAnnouncement = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || session.role !== "ADMIN") {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const parsed = announcementSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid payload", details: parsed.error.format() });
    }

    const { subject, html, preview, recipients } = parsed.data;
    const { specificUsers = [], departments = [], roles = [], customEmails = [] } = recipients;

    const emailsToNotify = new Set();

    if (specificUsers.length > 0) {
      const users = await prisma.user.findMany({
        where: { id: { in: specificUsers.map(u => BigInt(u)) } },
        select: { email: true }
      });
      users.forEach(u => { if (u.email) emailsToNotify.add(u.email); });
    }

    let effectiveRoles = roles;
    if (roles.length === 0 && departments.length > 0) {
      effectiveRoles = ["CANDIDATE", "RECRUITER"];
    }

    if (effectiveRoles.includes("RECRUITER")) {
      const whereClause = { role: "RECRUITER", active: true };
      if (departments.length > 0) {
        whereClause.departments = { hasSome: departments };
      }
      const recruiters = await prisma.recruitmentRoleAssignment.findMany({
        where: whereClause,
        include: { user: { select: { email: true } } }
      });
      recruiters.forEach(r => { if (r.user?.email) emailsToNotify.add(r.user.email); });
    }

    if (effectiveRoles.includes("PANEL_MEMBER")) {
      const panelMembers = await prisma.recruitmentPanelMember.findMany({
        where: { active: true },
        include: { user: { select: { email: true } } }
      });
      panelMembers.forEach(pm => { if (pm.user?.email) emailsToNotify.add(pm.user.email); });
    }

    if (effectiveRoles.includes("CANDIDATE")) {
      const whereClause = {};
      if (departments.length > 0) {
        whereClause.domain = { in: departments };
      }
      const candidates = await prisma.recruitmentApplication.findMany({
        where: whereClause,
        select: { email: true }
      });
      candidates.forEach(c => { if (c.email) emailsToNotify.add(c.email); });
    }

    if (customEmails.length > 0) {
      customEmails.forEach(email => emailsToNotify.add(email));
    }

    const finalRecipients = Array.from(emailsToNotify).filter(email => email && email.trim() !== "");

    if (preview) {
      return res.status(200).json({ count: finalRecipients.length });
    }

    if (finalRecipients.length === 0) {
      return res.status(400).json({ error: "No valid recipients found based on the provided criteria." });
    }

    const result = await sendEmail({
      to: finalRecipients,
      subject,
      html,
      eventType: "CUSTOM_ANNOUNCEMENT"
    });

    if (result && !result.success) {
      return res.status(500).json({ error: "Email delivery failed", details: result.error });
    }

    return res.status(200).json({ message: "Announcement sent successfully", count: finalRecipients.length });
  } catch (error) {
    console.error("Email announcement error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
