export interface InterceptedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body?: string;
}

/** Répond à une requête, ou renvoie undefined si elle n'était pas prévue. */
export type HostHandler = (req: InterceptedRequest) => Response | undefined | Promise<Response | undefined>;

/**
 * Le seul remplaçant de `fetch` pendant les tests. Chaque faux service (Graph Meta,
 * auth.eness…) s'y déclare pour son hôte. Toute requête vers un hôte non déclaré, ou
 * non prévue par son faux, est refusée (rien ne part sur Internet) et notée, pour que
 * le test échoue même si l'application a avalé l'erreur.
 */
const handlers = new Map<string, HostHandler>();
const unexpected: string[] = [];
let spy: jest.SpyInstance | undefined;

/** Chaque installation repart d'une liste vide d'appels non prévus. */
export function interceptHost(host: string, handler: HostHandler) {
  unexpected.length = 0;
  spy ??= jest.spyOn(globalThis, "fetch").mockImplementation(dispatch);
  handlers.set(host, handler);
}

export function releaseHost(host: string) {
  handlers.delete(host);
  if (handlers.size === 0) {
    spy?.mockRestore();
    spy = undefined;
  }
}

export function assertNoUnexpectedCalls() {
  if (unexpected.length > 0) {
    throw new Error(`Appels réseau non prévus :\n${unexpected.join("\n")}`);
  }
}

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function dispatch(input: string | URL | Request, init?: RequestInit) {
  const request = input instanceof Request ? input : undefined;
  const url = new URL(request ? request.url : input.toString());
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers ?? request?.headers);
  const body = init?.body != null ? String(init.body) : request ? await request.clone().text() : undefined;

  const response = await handlers.get(url.hostname)?.({ method, url, headers, body: body || undefined });
  if (!response) {
    const call = `${method} ${url.origin}${url.pathname}`;
    unexpected.push(call);
    throw new Error(`Appel réseau non prévu : ${call}`);
  }
  return response;
}
