import { z } from "zod";

export const permissionResponseSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
});

export const permissionListResponseSchema = z.array(permissionResponseSchema);
