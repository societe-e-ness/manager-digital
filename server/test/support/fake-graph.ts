import { assertNoUnexpectedCalls, interceptHost, jsonResponse, releaseHost } from "./network";

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
 * Un faux Graph API Meta : seules les routes déclarées avec `on()` répondent.
 * Tout autre appel est refusé et signalé par `assertNoUnexpectedCalls()`.
 */
export class FakeGraph {
  readonly calls: GraphCall[] = [];
  private routes: Route[] = [];

  install() {
    this.calls.length = 0;
    this.routes = [];
    interceptHost(GRAPH_HOST, ({ method, url, body }) => {
      const path = url.pathname.replace(/^\/v\d+\.\d+/, "");
      const route = this.routes.find((r) => r.method === method && r.path === path);
      if (!route) return undefined;
      this.calls.push({ method, path, query: url.searchParams, body });
      return jsonResponse(route.body, route.status);
    });
  }

  uninstall() {
    releaseHost(GRAPH_HOST);
  }

  /** Déclare une réponse. `path` sans la version de l'API : "/me/accounts". */
  on(method: string, path: string, body: unknown, status = 200) {
    this.routes.push({ method: method.toUpperCase(), path, status, body });
    return this;
  }

  assertNoUnexpectedCalls() {
    assertNoUnexpectedCalls();
  }
}
