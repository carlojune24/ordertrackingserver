import { z } from "zod";

export const createQcRejectionReasonBodySchema = z.object({
  name: z.string().min(1),
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, "slug must be lowercase letters, numbers, and hyphens only")
    .optional()
    .describe("Auto-derived from name if omitted — only pass this to override the derived value."),
});

export const updateQcRejectionReasonBodySchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, "slug must be lowercase letters, numbers, and hyphens only").optional(),
  isActive: z.boolean().optional().describe("Set to false to retire the reason from qc-decision pickers without deleting it — historical rework routes that reference it are unaffected."),
});

export const listQcRejectionReasonsQuerySchema = z.object({
  includeInactive: z.coerce.boolean().optional().describe("Include retired (isActive: false) reasons — off by default."),
});

export const qcRejectionReasonIdParamsSchema = z.object({ id: z.string() });

export const qcRejectionReasonResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  isActive: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const qcRejectionReasonListResponseSchema = z.array(qcRejectionReasonResponseSchema);
