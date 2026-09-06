import nodemailer from "nodemailer";
import prisma from "../../../prismaClient.js";
import { decryptPassword } from "./encryption.js";

const getSmtpSettings = async () => {
  try {
    const setting = await prisma.collection.findUnique({
      where: { name: "smtp_settings" }
    });
    
    if (setting && setting.data) {
      const data = setting.data;
      if (data.host && data.user && data.pass) {
        return {
          host: data.host,
          port: Number(data.port) || 587,
          secure: data.secure === true,
          auth: {
            user: data.user,
            pass: decryptPassword(data.pass),
          },
          fromEmail: data.fromEmail,
          fromName: data.fromName
        };
      }
    }
  } catch (err) {
    console.error("[EMAIL CONFIG ERROR] Failed to fetch settings from DB", err);
  }
  return null;
};

const createTransporter = (config) => {
  return nodemailer.createTransport(config);
};

export const sendEmail = async (payload) => {
  let config = await getSmtpSettings();
  
  let fromAddress = `"${process.env.SMTP_FROM_NAME || 'HC Recruitment'}" <${process.env.SMTP_FROM || process.env.SMTP_USER || 'recruitment@hackclubvit.co'}>`;

  if (!config) {
    const smtpHost = process.env.SMTP_HOST || 'smtp.gmail.com';
    const smtpUser = process.env.SMTP_USER || '';
    const smtpPass = process.env.SMTP_PASS || '';
    if (!smtpUser || !smtpPass) {
      console.warn(`[EMAIL SKIPPED] SMTP not fully configured. Would have sent email to ${payload.to} with subject: ${payload.subject}`);
      return { success: false, error: "SMTP not configured" };
    }
    config = {
      host: smtpHost,
      port: Number(process.env.SMTP_PORT) || 465,
      secure: process.env.SMTP_SECURE === "true" || (!process.env.SMTP_PORT && smtpHost === 'smtp.gmail.com'),
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
      fromEmail: undefined,
      fromName: undefined
    };
  } else {
    fromAddress = `"${config.fromName || 'HC Recruitment'}" <${config.fromEmail || config.auth.user}>`;
  }

  const transporter = createTransporter(config);

  let recipients = [];
  if (Array.isArray(payload.to)) {
    recipients = Array.from(new Set(payload.to.filter(email => email && typeof email === 'string' && email.trim() !== '')));
  } else if (typeof payload.to === 'string' && payload.to.trim() !== '') {
    recipients = [payload.to.trim()];
  }

  if (recipients.length === 0) {
    console.warn(`[EMAIL SKIPPED] No valid recipients provided for subject: ${payload.subject}`);
    return { success: false, error: "No valid recipients" };
  }

  try {
    await transporter.sendMail({
      from: fromAddress,
      to: recipients.length === 1 ? recipients[0] : undefined,
      bcc: recipients.length > 1 ? recipients : undefined,
      subject: payload.subject,
      html: payload.html,
    });
    console.log(`[EMAIL SENT] to ${recipients.length} recipient(s) - ${payload.subject}`);
    
    await prisma.recruitmentEmailLog.create({
      data: {
        event_type: payload.eventType || "General",
        entity_id: payload.entityId ? String(payload.entityId) : null,
        recipient_count: recipients.length,
        status: "SUCCESS"
      }
    }).catch(console.error);

    return { success: true };

  } catch (error) {
    console.error(`[EMAIL ERROR] Failed to send email to ${recipients.join(', ')}:`, error);
    
    await prisma.recruitmentEmailLog.create({
      data: {
        event_type: payload.eventType || "General",
        entity_id: payload.entityId ? String(payload.entityId) : null,
        recipient_count: recipients.length,
        status: "FAILED",
        error_message: error?.message?.substring(0, 500) || "Unknown error"
      }
    }).catch(console.error);

    return { success: false, error: error?.message || "Unknown error" };
  }
};

export const templates = {
  applicationSubmitted: (name, recruitmentName) => `
    <h2>Application Received</h2>
    <p>Hi ${name},</p>
    <p>We have successfully received your application for <strong>${recruitmentName}</strong>.</p>
    <p>Our team will review your profile and get back to you soon.</p>
    <br/>
    <p>Best regards,<br/>HackClub VIT</p>
  `,
  
  statusUpdated: (name, status, message) => {
    if (status === "SHORTLISTED") {
      return `
        <h2>Congratulations! 🎉</h2>
        <p>Hi ${name},</p>
        <p><strong>Your application has been shortlisted.</strong></p>
        <p>We are pleased to inform you that you have successfully moved to the next stage of the selection process.</p>
        ${message ? `<p>${message}</p>` : ''}
        <p>Our team will reach out to you shortly with further details about the next steps.</p>
        <br/>
        <p>Best regards,<br/><strong>HackClub VIT Recruitment Team</strong></p>
      `;
    }
    if (status === "SELECTED") {
      return `
        <h2>🎉 Congratulations, ${name}!</h2>
        <p>We are thrilled to inform you that you have been <strong>selected</strong> as part of <strong>HackClub VIT</strong>!</p>
        <p>Your skills, passion, and dedication truly stood out during the selection process, and we're excited to have you on board.</p>
        ${message ? `<p>${message}</p>` : ''}
        <p>Our team will reach out to you shortly with the onboarding details and next steps.</p>
        <p>Welcome to the team! 🚀</p>
        <br/>
        <p>Best regards,<br/><strong>HackClub VIT Recruitment Team</strong></p>
      `;
    }
    if (status === "REJECTED") {
      return `
        <h2>Application Update</h2>
        <p>Hi ${name},</p>
        <p>Thank you for your interest in <strong>HackClub VIT</strong> and for taking the time to go through our recruitment process.</p>
        <p>After careful consideration, we regret to inform you that we are unable to move forward with your application at this time.</p>
        ${message ? `<p><strong>Feedback:</strong> ${message}</p>` : ''}
        <p>We encourage you to continue building your skills and apply again in future recruitment cycles. We wish you all the best in your future endeavours!</p>
        <br/>
        <p>Best regards,<br/><strong>HackClub VIT Recruitment Team</strong></p>
      `;
    }
    if (status === "WAITLISTED") {
      return `
        <h2>Application Update</h2>
        <p>Hi ${name},</p>
        <p>Thank you for your interest in <strong>HackClub VIT</strong>.</p>
        <p>After careful review, your application has been placed on the <strong>waitlist</strong>. This means you are still being considered and may be selected if positions become available.</p>
        ${message ? `<p>${message}</p>` : ''}
        <p>We will keep you updated on any changes. Thank you for your patience!</p>
        <br/>
        <p>Best regards,<br/><strong>HackClub VIT Recruitment Team</strong></p>
      `;
    }
    if (status === "FURTHER_ROUND") {
      return `
        <h2>Next Round of Interview 📋</h2>
        <p>Hi ${name},</p>
        <p>Thank you for your participation in the interview process for <strong>HackClub VIT</strong>.</p>
        <p>We are pleased to inform you that you have been advanced to the <strong>next round</strong> of interviews.</p>
        ${message ? `<p>${message}</p>` : ''}
        <p>Our team will reach out to you shortly with the details for your next interview. Stay tuned!</p>
        <br/>
        <p>Best of luck! 🚀<br/><strong>HackClub VIT Recruitment Team</strong></p>
      `;
    }
    return `
      <h2>Application Update</h2>
      <p>Hi ${name},</p>
      <p>Your application status has been updated to: <strong>${status}</strong>.</p>
      ${message ? `<p>${message}</p>` : ''}
      <br/>
      <p>Best regards,<br/><strong>HackClub VIT Recruitment Team</strong></p>
    `;
  },

  interviewScheduled: (name, date, time, duration, round, link, department) => `
    <h2>🎉 Interview Scheduled</h2>
    <p>Hi ${name},</p>
    <p>Congratulations! Your application for <strong>HackClub VIT Recruitment${department ? ` – ${department} Department` : ''}</strong> has been shortlisted, and we're pleased to invite you for an interview.</p>
    <p>Please find your interview details below:</p>
    <p>
      📅 <strong>Date:</strong> ${date}<br/>
      ⏰ <strong>Time:</strong> ${time}<br/>
      ⏱ <strong>Duration:</strong> Approximately ${duration} minutes<br/>
      💻 <strong>Mode:</strong> Online<br/>
      🔗 <strong>Meeting Link:</strong> <a href="${link}">Click here to join</a>
    </p>
    <p>Please make sure to join the meeting a few minutes before the scheduled time and ensure that your camera, microphone, and internet connection are working properly.</p>
    <p>We look forward to meeting you and learning more about you!</p>
    <br/>
    <p>Best of luck! 🚀<br/><strong>HackClub VIT Recruitment Team</strong></p>
  `,

  interviewRescheduled: (name, date, time, round, link) => `
    <h2>Interview Rescheduled (Round ${round})</h2>
    <p>Hi ${name},</p>
    <p>Your interview has been rescheduled.</p>
    <ul>
      <li><strong>New Date:</strong> ${date}</li>
      <li><strong>New Time:</strong> ${time}</li>
      <li><strong>Meeting Link:</strong> <a href="${link}">${link}</a></li>
    </ul>
    <br/>
    <p>Best regards,<br/>HackClub VIT</p>
  `,

  interviewCancelled: (name, round) => `
    <h2>Interview Cancelled</h2>
    <p>Hi ${name},</p>
    <p>Your Round ${round} interview has been cancelled. Our team will reach out with further updates soon.</p>
    <br/>
    <p>Best regards,<br/>HackClub VIT</p>
  `
};
