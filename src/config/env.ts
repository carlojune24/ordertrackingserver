import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  // The public-facing origin (behind Nginx in production, e.g. http://51.79.159.222:8080) —
  // NOT necessarily http://localhost:${PORT}. Used to build absolute URLs for uploaded
  // product images, so ProductImage.url looks identical whether the image was uploaded here
  // or is an externally-hosted link. Must be overridden per environment; the default only
  // matches local dev's actual PORT default (3000).
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment variables");
}

export const env = parsed.data;
