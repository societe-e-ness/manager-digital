const GRAPH_HOST = "graph.facebook.com";

interface Route {
  method: string;
  path: string;
  status: number;
  body: unknown;
}

export interface GraphCall {
  method: string;
  path: string; // sans la version : "/me/accounts"
  query: URLSearchParams;
  body?: string;
}

/**
 * Un faux Graph API Meta. Remplace `fetch` le temps d'un test : seules les routes
 * déclarées avec `on()` répondent. Tout autre appel réseau est refusé (rien ne part
 * sur Internet) et noté, pour que `assertNoUnexpectedCalls()` fasse échouer le test
 * même si l'application a avalé l'erreur.
 */
export class FakeGraph {
  readonly calls: GraphCall[] = [];
  private routes: Route[] = [];
  private unexpected: string[] = [];
  private spy?: jest.SpyInstance;

  install() {
    this.calls.length = 0;
    this.routes = [];
    this.unexpected = [];
    this.spy = jest.spyOn(globalThis, "fetch").mockImplementation((input, init) => this.handle(input, init));
  }

  uninstall() {
    this.spy?.mockRestore();
    this.spy = undefined;
  }

  /** Déclare une réponse. `path` sans la version de l'API : "/me/accounts". */
  on(method: string, path: string, body: unknown, status = 200) {
    this.routes.push({ method: method.toUpperCase(), path, status, body });
    return this;
  }

  assertNoUnexpectedCalls() {
    if (this.unexpected.length > 0) {
      throw new Error(`Appels réseau non prévus :\n${this.unexpected.join("\n")}`);
    }
  }

  private async handle(input: string | URL | Request, init?: RequestInit) {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const path = url.pathname.replace(/^\/v\d+\.\d+/, "");

    const route = url.hostname === GRAPH_HOST ? this.routes.find((r) => r.method === method && r.path === path) : undefined;
    if (!route) {
      const call = `${method} ${url.origin}${url.pathname}`;
      this.unexpected.push(call);
      throw new Error(`Appel réseau non prévu : ${call}`);
    }

    this.calls.push({ method, path, query: url.searchParams, body: typeof init?.body === "string" ? init.body : undefined });
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
