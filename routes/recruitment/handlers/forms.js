import prisma from "../../../prismaClient.js";
import { getSession } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";
import { z } from "zod";

const VALID_QUESTION_TYPES = ["TEXT", "PARAGRAPH", "RADIO", "DROPDOWN", "CHECKBOX"];

const questionSchema = z.object({
  question: z.string().min(2),
  type: z.enum(["TEXT", "PARAGRAPH", "RADIO", "DROPDOWN", "CHECKBOX"]),
  required: z.boolean().optional(),
  options: z.array(z.string()).optional()
}).refine(data => {
  if (["RADIO", "DROPDOWN", "CHECKBOX"].includes(data.type)) {
    return data.options && data.options.length > 0;
  }
  return true;
}, { message: "Options are required for this question type", path: ["options"] });

const createFormSchema = z.object({
  title: z.string().min(2),
  description: z.string().optional()
});

const updateFormSchema = z.object({
  title: z.string().min(2).optional(),
  description: z.string().optional(),
  status: z.enum(["DRAFT", "PUBLISHED", "CLOSED"]).optional()
});

export const getForms = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || session.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const forms = await prisma.recruitmentForm.findMany({
      include: { questions: true },
      orderBy: { created_at: 'desc' }
    });

    return res.status(200).json({ forms });
  } catch (error) {
    console.error("Fetch forms error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const getPublishedForms = async (req, res) => {
  try {
    const forms = await prisma.recruitmentForm.findMany({
      where: { status: "PUBLISHED" },
      orderBy: { created_at: "desc" }
    });

    return res.status(200).json({ forms });
  } catch (error) {
    console.error("Fetch published forms error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const createForm = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || session.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const parsed = createFormSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid form data", details: parsed.error.format() });
    }

    const { title, description } = parsed.data;

    const form = await prisma.recruitmentForm.create({
      data: {
        title,
        description,
        status: "DRAFT"
      },
      include: { questions: true }
    });

    await logAudit(session.id, "CREATED_FORM", "Form", form.id);

    return res.status(201).json({ form });
  } catch (error) {
    console.error("Create form error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const getFormById = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);

    const form = await prisma.recruitmentForm.findUnique({
      where: { id },
      include: { questions: { orderBy: { id: 'asc' } } }
    });

    if (!form) {
      return res.status(404).json({ error: "Form not found or not currently available" });
    }

    if (form.status !== "PUBLISHED") {
      const session = await getSession(req);
      if (!session || session.role !== "ADMIN") {
        return res.status(404).json({ error: "Form not found or not currently available" });
      }
    }

    return res.status(200).json({ form });
  } catch (error) {
    console.error("Fetch form error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const updateForm = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || session.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }
    
    const id = parseInt(req.params.id, 10);
    
    const parsed = updateFormSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid form data", details: parsed.error.format() });
    }
    const { status, title, description } = parsed.data;

    const existingForm = await prisma.recruitmentForm.findUnique({ where: { id } });
    if (!existingForm) {
      return res.status(404).json({ error: "Form not found" });
    }

    const updateData = {};
    if (title) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    
    if (status && status !== existingForm.status) {
      const validFormTransitions = {
        "DRAFT": ["PUBLISHED", "CLOSED"],
        "PUBLISHED": ["CLOSED"],
        "CLOSED": []
      };
      const allowed = validFormTransitions[existingForm.status] || [];
      if (!allowed.includes(status)) {
        return res.status(400).json({ error: `Invalid form status transition from ${existingForm.status} to ${status}` });
      }
      
      updateData.status = status;
      if (status === "PUBLISHED") updateData.published_at = new Date();
      if (status === "CLOSED") updateData.closed_at = new Date();
    }

    const form = await prisma.recruitmentForm.update({
      where: { id },
      data: updateData,
      include: { questions: true }
    });

    await logAudit(session.id, `UPDATED_FORM`, "Form", id);

    return res.status(200).json({ form });
  } catch (error) {
    console.error("Update form error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const deleteForm = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || session.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }
    
    const id = parseInt(req.params.id, 10);

    const form = await prisma.recruitmentForm.findUnique({ where: { id } });
    if (!form) return res.status(404).json({ error: "Form not found" });

    if (form.status !== "DRAFT") {
      return res.status(409).json({ error: "This form cannot be deleted because it has been published. Close the form instead." });
    }

    await prisma.$transaction([
      prisma.recruitmentFormQuestion.deleteMany({ where: { form_id: id } }),
      prisma.recruitmentForm.delete({ where: { id } })
    ]);

    await logAudit(session.id, `DELETED_FORM`, "Form", id);

    return res.status(200).json({ message: "Form deleted" });
  } catch (error) {
    console.error("Delete form error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const createQuestion = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || session.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }
    
    const id = parseInt(req.params.id, 10);
    
    const parsed = questionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid question data", details: parsed.error.format() });
    }

    const { question, type, required, options } = parsed.data;

    const form = await prisma.recruitmentForm.findUnique({ where: { id } });
    if (!form) {
      return res.status(404).json({ error: "Form not found" });
    }
    if (form.status !== "DRAFT") {
      return res.status(400).json({ error: "Cannot add questions to a non-DRAFT form" });
    }

    const formQuestion = await prisma.recruitmentFormQuestion.create({
      data: {
        form_id: id,
        question,
        type,
        required: Boolean(required),
        options: options || []
      }
    });

    await logAudit(session.id, "CREATED_FORM_QUESTION", "FormQuestion", formQuestion.id);

    return res.status(201).json({ question: formQuestion });
  } catch (error) {
    console.error("Create form question error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const updateQuestion = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || session.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const formId = parseInt(req.params.id, 10);
    const questionId = parseInt(req.params.questionId, 10);

    if (isNaN(formId) || isNaN(questionId)) {
      return res.status(400).json({ error: "Invalid ID" });
    }

    const form = await prisma.recruitmentForm.findUnique({ where: { id: formId } });
    if (!form) return res.status(404).json({ error: "Form not found" });
    if (form.status !== "DRAFT") {
      return res.status(400).json({ error: "Cannot modify questions on a non-DRAFT form" });
    }

    const parsed = questionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid question data", details: parsed.error.format() });
    }

    const { question, type, required, options } = parsed.data;

    const existingQuestion = await prisma.recruitmentFormQuestion.findFirst({
      where: { id: questionId, form_id: formId }
    });

    if (!existingQuestion) {
      return res.status(404).json({ error: "Question not found or does not belong to this form" });
    }

    const updatedQuestion = await prisma.recruitmentFormQuestion.update({
      where: { id: questionId },
      data: {
        question,
        type,
        required: required ?? false,
        options: options || []
      }
    });

    await logAudit(session.id, "UPDATED_QUESTION", "FormQuestion", updatedQuestion.id);

    return res.status(200).json({ question: updatedQuestion });
  } catch (error) {
    console.error("Update question error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const deleteQuestion = async (req, res) => {
  try {
    const session = await getSession(req);
    if (!session || session.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const formId = parseInt(req.params.id, 10);
    const questionId = parseInt(req.params.questionId, 10);

    if (isNaN(formId) || isNaN(questionId)) {
      return res.status(400).json({ error: "Invalid ID" });
    }

    const form = await prisma.recruitmentForm.findUnique({ where: { id: formId } });
    if (!form) return res.status(404).json({ error: "Form not found" });
    if (form.status !== "DRAFT") {
      return res.status(400).json({ error: "Cannot delete questions on a non-DRAFT form" });
    }

    const existingQuestion = await prisma.recruitmentFormQuestion.findFirst({
      where: { id: questionId, form_id: formId }
    });

    if (!existingQuestion) {
      return res.status(404).json({ error: "Question not found or does not belong to this form" });
    }

    await prisma.recruitmentFormQuestion.delete({
      where: { id: questionId }
    });

    await logAudit(session.id, "DELETED_QUESTION", "FormQuestion", questionId);

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Delete question error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
