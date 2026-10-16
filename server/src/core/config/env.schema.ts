import { z } from "zod";

// une URL facultative : "" (valeur vide de .env.example) vaut absence
const optionalUrl = z.preprocess((v) => (v === "" ? undefined : v), z.url().optional());

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().default(3000),
    APP_PUBLIC_URL: z.url(),
    // le front : les liens magiques y mènent (obligatoire en production)
    CLIENT_PUBLIC_URL: optionalUrl,

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

    // --- SSO auth.eness (OpenID Connect) ---
    SSO_ENABLED: z.stringbool().default(false),
    OIDC_ISSUER: optionalUrl, // https://auth.eness.fr
    OIDC_CLIENT_ID: z.string().optional(),
    OIDC_CLIENT_SECRET: z.string().optional(),
    OIDC_RESOURCE: optionalUrl, // la valeur affichée par auth, slash final compris
  })
  .superRefine((env, ctx) => {
    if (env.SSO_ENABLED && !(env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET && env.OIDC_RESOURCE)) {
      ctx.addIssue({
        code: "custom",
        message: "OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET et OIDC_RESOURCE sont requis quand SSO_ENABLED=true",
      });
    }
    if (env.NODE_ENV === "production" && !env.CLIENT_PUBLIC_URL) {
      ctx.addIssue({ code: "custom", message: "CLIENT_PUBLIC_URL est requis en production" });
    }
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
  return { ...result.data, CLIENT_PUBLIC_URL: result.data.CLIENT_PUBLIC_URL ?? "http://localhost:5173" };
}

export default envSchema;
