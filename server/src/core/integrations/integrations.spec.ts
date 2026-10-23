import { UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomBytes } from "node:crypto";
import { DatabaseService } from "../database/database.service";
import { IntegrationsService } from "./integrations.service";
import { MetaService } from "./meta.service";

const key = randomBytes(32).toString("base64");
const config = {
  get: (name: string) => (name === "META_ENABLED" ? true : undefined),
  getOrThrow: (name: string) => {
    if (name === "ENCRYPTION_KEY") return key;
    if (name === "APP_PUBLIC_URL") return "http://localhost:3000";
    if (name === "META_APP_ID") return "app-id";
    throw new Error(`config ${name} absente`);
  },
} as unknown as ConfigService;

const integrations = new IntegrationsService({} as DatabaseService, config);
const meta = new MetaService(config, integrations);

describe("IntegrationsService : chiffrement du jeton", () => {
  it("chiffre puis déchiffre à l'identique, sans exposer le texte en clair", () => {
    const encrypted = integrations.encrypt("EAAB.secret-token");
    expect(encrypted).not.toContain("secret");
    expect(integrations.decrypt(encrypted)).toBe("EAAB.secret-token");
  });

  it("produit un chiffré différent à chaque appel (IV aléatoire)", () => {
    expect(integrations.encrypt("x")).not.toBe(integrations.encrypt("x"));
  });

  it("refuse un chiffré altéré", () => {
    const encrypted = integrations.encrypt("payload");
    expect(() => integrations.decrypt(encrypted.slice(0, -4) + "AAAA")).toThrow();
  });
});

describe("MetaService : state signé", () => {
  it("signe puis relit le client et l'utilisateur", () => {
    const state = meta.signState({ clientId: 1, userId: 7 });
    expect(meta.verifyState(state)).toEqual({ clientId: 1, userId: 7 });
  });

  it("accepte un accès agence (clientId null)", () => {
    expect(meta.verifyState(meta.signState({ clientId: null, userId: 7 })).clientId).toBeNull();
  });

  it("rejette un state forgé ou absent", () => {
    const [, signature] = meta.signState({ clientId: 1, userId: 7 }).split(".");
    const forged = Buffer.from(JSON.stringify({ clientId: 2, userId: 7, expiresAt: 9e15 })).toString("base64url");
    expect(() => meta.verifyState(`${forged}.${signature}`)).toThrow(UnauthorizedException);
    expect(() => meta.verifyState(undefined)).toThrow(UnauthorizedException);
  });

  it("rejette un state expiré", () => {
    const now = Date.now();
    const spy = jest.spyOn(Date, "now").mockReturnValue(now);
    const state = meta.signState({ clientId: 1, userId: 7 });
    spy.mockReturnValue(now + 11 * 60 * 1000);
    expect(() => meta.verifyState(state)).toThrow("expiré");
    spy.mockRestore();
  });

  it("construit l'URL de consentement avec le state et la redirect URI", () => {
    const url = new URL(meta.buildAuthorizationUrl("the-state"));
    expect(url.hostname).toBe("www.facebook.com");
    expect(url.searchParams.get("state")).toBe("the-state");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/integrations/oauth/callback");
  });
});
