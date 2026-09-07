import { Router } from "express";
import rateLimit from "express-rate-limit";

import * as authHandler from "./handlers/auth.js";
import * as appsHandler from "./handlers/applications.js";
import * as candidatesHandler from "./handlers/candidates.js";
import * as formsHandler from "./handlers/forms.js";
import * as panelsHandler from "./handlers/panels.js";
import * as interviewsHandler from "./handlers/interviews.js";
import * as feedbackHandler from "./handlers/feedback.js";
import * as notifsHandler from "./handlers/notifications.js";
import * as recruiterHandler from "./handlers/recruiter.js";
import * as analyticsHandler from "./handlers/analytics.js";
import * as auditLogsHandler from "./handlers/auditLogs.js";
import * as settingsHandler from "./handlers/settings.js";
import * as announcementsHandler from "./handlers/announcements.js";
import * as usersHandler from "./handlers/users.js";
import * as healthHandler from "./handlers/health.js";

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { error: 'Too many login attempts from this network, please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV !== 'production' && process.env.DEV_AUTH_BYPASS === 'true',
});

const submissionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  skipFailedRequests: true,
  message: { error: 'Too many applications submitted from this network, please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV !== 'production' && process.env.DEV_AUTH_BYPASS === 'true',
});

const router = Router();

// Health
router.get('/health', healthHandler.healthCheck);

// Auth
router.post('/auth/login', authLimiter, authHandler.login);
router.post('/auth/logout', authHandler.logout);
router.get('/auth/me', authHandler.me);

// Users
router.get('/users', usersHandler.getUsers);
router.post('/users', usersHandler.createUser);
router.put('/users', usersHandler.updateUser);
router.delete('/users', usersHandler.deleteUser);

// Forms
router.get('/forms', formsHandler.getForms);
router.get('/forms/published', formsHandler.getPublishedForms);
router.post('/forms', formsHandler.createForm);
router.get('/forms/:id', formsHandler.getFormById);
router.put('/forms/:id', formsHandler.updateForm);
router.delete('/forms/:id', formsHandler.deleteForm);
router.post('/forms/:id/questions', formsHandler.createQuestion);
router.put('/forms/:id/questions/:questionId', formsHandler.updateQuestion);
router.delete('/forms/:id/questions/:questionId', formsHandler.deleteQuestion);

// Applications
router.get('/applications', appsHandler.getApplications);
router.post('/applications', submissionLimiter, appsHandler.createApplication);
router.post('/applications/bulk', appsHandler.bulkUpdateApplications);
router.get('/applications/me', appsHandler.getApplicationMe);
router.get('/applications/:id', appsHandler.getApplicationById);
router.put('/applications/:id', appsHandler.updateApplication);
router.get('/applications/:id/notes', appsHandler.getApplicationNotes);
router.post('/applications/:id/notes', appsHandler.createApplicationNote);
router.delete('/applications/:id/notes/:noteId', appsHandler.deleteApplicationNote);
router.get('/applications/:id/history', appsHandler.getApplicationHistory);

// Candidates
router.get('/candidates', candidatesHandler.getCandidates);
router.get('/candidates/:id', candidatesHandler.getCandidateById);

// Panels
router.get('/panels', panelsHandler.getPanels);
router.post('/panels', panelsHandler.createPanel);
router.put('/panels', panelsHandler.updatePanel);
router.delete('/panels', panelsHandler.deletePanel);
router.post('/panels/members', panelsHandler.addPanelMember);
router.delete('/panels/members', panelsHandler.removePanelMember);
router.get('/panels/dashboard', panelsHandler.getPanelDashboard);

// Interviews
router.get('/interviews', interviewsHandler.getInterviews);
router.post('/interviews/schedule', interviewsHandler.scheduleInterview);
router.get('/interviews/:id', interviewsHandler.getInterviewById);
router.put('/interviews/:id', interviewsHandler.updateInterview);

// Feedback
router.get('/feedback', feedbackHandler.getFeedback);
router.post('/feedback', feedbackHandler.submitFeedback);

// Notifications
router.get('/notifications', notifsHandler.getNotifications);
router.put('/notifications/read', notifsHandler.readNotifications);

// Dashboards & Analytics & Audit Logs
router.get('/recruiter/dashboard', recruiterHandler.getRecruiterDashboard);
router.get('/analytics', analyticsHandler.getAnalytics);
router.get('/audit-logs', auditLogsHandler.getAuditLogs);

// Settings
router.get('/settings/email', settingsHandler.getEmailSettings);
router.post('/settings/email', settingsHandler.updateEmailSettings);
router.post('/settings/email/test', settingsHandler.testEmailSettings);
router.get('/settings/email/logs', settingsHandler.getEmailLogs);
router.post('/settings/email/announcement', settingsHandler.sendEmailAnnouncement);

// Announcements
router.get('/announcements', announcementsHandler.getAnnouncements);
router.post('/announcements', announcementsHandler.createAnnouncement);

export default router;
