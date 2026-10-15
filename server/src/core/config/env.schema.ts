import { z } from "zod";

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().default(3000),
    APP_PUBLIC_URL: z.url(),

    DATABASE_URL: z.string().min(1),
    DIRECT_URL: z.string().min(1).optional(),

    // Clé AES-256 (32 octets en base64) : chiffrement des jetons en BDD
    // et signature HMAC du state OAuth.
    ENCRYPTION_KEY: z
      .string()
      .refine(
        (k) => Buffer.from(k, "base64").length === 32,
        "ENCRYPTION_KEY doit faire 32 octets en base64",
      ),

    // --- Meta (Facebook / Instagram Ads) ---
    META_ENABLED: z.stringbool().default(false),
    META_APP_ID: z.string().optional(),
    META_APP_SECRET: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.META_ENABLED && !(env.META_APP_ID && env.META_APP_SECRET)) {
      ctx.addIssue({
        code: "custom",
        message: "META_APP_ID et META_APP_SECRET sont requis quand META_ENABLED=true",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** À passer à ConfigModule.forRoot({ validate }). Lève une erreur lisible au démarrage. */
export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    throw new Error(
      `Variables d'environnement invalides :\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

export default envSchema;
