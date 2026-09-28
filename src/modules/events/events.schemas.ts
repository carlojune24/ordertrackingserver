import { z } from "zod";

export const streamQuerySchema = z.object({
  token: z
    .string()
    .optional()
    .describe(
      "Access token, required if you can't set an Authorization header (e.g. the browser's native EventSource API). Prefer the header when your client supports it — Authorization takes priority if both are present.",
    ),
});
