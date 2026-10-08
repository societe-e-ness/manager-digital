import { z } from "zod";

export default z.object({
  PORT: z.coerce.number().default(3000),
  APP_PUBLIC_URL: z.url(),
  ENCRYPTION_KEY: z
    .string()
    .refine(
      (k) => Buffer.from(k, "base64").length === 32,
      "ENCRIPTION_KEY doit faire 32 octets en base 64",
    ),
  META_ENABLED: z.coerce.boolean().default(false),
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
});
