import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./support/app";

describe("Santé (HTTP)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /health répond ok", async () => {
    const res = await request(app.getHttpServer()).get("/health").expect(200);
    expect(res.body.status).toBe("ok");
  });

  it("GET /health/ready voit la base de test", async () => {
    const res = await request(app.getHttpServer()).get("/health/ready").expect(200);
    expect(res.body.details).toEqual({ database: "up" });
  });
});
