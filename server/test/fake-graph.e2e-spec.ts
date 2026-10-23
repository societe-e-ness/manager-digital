import { FakeGraph } from "./support/fake-graph";

describe("FakeGraph", () => {
  const graph = new FakeGraph();

  afterEach(() => graph.uninstall());

  it("répond aux routes déclarées", async () => {
    graph.install();
    graph.on("GET", "/me", { id: "42" });

    const res = await fetch("https://graph.facebook.com/v21.0/me?fields=id&access_token=t");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "42" });
    expect(graph.calls).toHaveLength(1);
  });

  it("peut simuler une erreur Meta", async () => {
    graph.install();
    graph.on("GET", "/me", { error: { message: "expired" } }, 401);

    const res = await fetch("https://graph.facebook.com/v21.0/me");

    expect(res.status).toBe(401);
  });

  it("refuse un appel non prévu sans partir sur le réseau, et le signale", async () => {
    graph.install();

    await expect(fetch("https://graph.facebook.com/v21.0/me/accounts")).rejects.toThrow("non prévu");
    await expect(fetch("https://example.com/")).rejects.toThrow("non prévu");
    expect(() => graph.assertNoUnexpectedCalls()).toThrow("GET https://graph.facebook.com/v21.0/me/accounts");
  });
});
