import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { API } from '../api.ts'
import './ReseauxSociauxPage.css'

type Site = { id: number; domain: string }
type Client = { id: number; name: string; sites: Site[] }
type Resource = {
  id: number
  type: 'FACEBOOK_PAGE' | 'INSTAGRAM_ACCOUNT' | 'AD_ACCOUNT'
  name: string
  site_id: number | null
  attached_elsewhere: boolean
  accessible: boolean
}
type Integration = {
  id: number
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED'
  created_by: { email: string; name: string | null }
  resources: Resource[]
}

const RESOURCE_TYPES = { FACEBOOK_PAGE: 'Page Facebook', INSTAGRAM_ACCOUNT: 'Instagram', AD_ACCOUNT: 'Compte publicitaire' }
const STATUSES = { ACTIVE: 'Active', EXPIRED: 'Expirée', REVOKED: 'Révoquée' }

// les erreurs de l'API, d'après leur `type` stable ; à défaut, le `detail` renvoyé par l'API
const MESSAGES: Record<string, string> = {
  'missing-feature': "Vous n'avez pas le droit de gérer les réseaux sociaux de ce Client.",
  'agency-only': "Action réservée à l'agence.",
  'resource-already-attached': 'Cette Ressource est déjà rattachée à un autre Site : détachez-la d’abord.',
  'resource-not-reachable': 'Aucun compte Meta de ce Client ne mène à cette Ressource.',
  'not-integration-owner': 'Seule la personne qui a connecté ce compte, ou l’agence, peut le déconnecter.',
  'meta-consent-refused': 'La connexion à Meta a été annulée.',
  'oauth-state-mismatch': 'La connexion Meta a été lancée depuis une autre session : recommencez.',
  'oauth-state-invalid': 'La connexion Meta a expiré : recommencez.',
  'meta-unavailable': 'Meta est injoignable pour le moment : réessayez plus tard.',
  'meta-connection-failed': 'Meta a refusé la connexion : réessayez, ou vérifiez les permissions accordées.',
  'internal-error': 'Erreur interne du Manager Digital : réessayez plus tard.',
}

type Result<T> = { data: T } | { error: string }

/** Appel à l'API avec le cookie de session ; sans session, retour à la connexion puis ici. */
async function api<T>(path: string, init: RequestInit = {}): Promise<Result<T>> {
  try {
    const res = await fetch(`${API}${path}`, { credentials: 'include', ...init })
    if (res.status === 401) {
      window.location.replace(`/connexion?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`)
      return { error: '' }
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      return { error: MESSAGES[body?.type] ?? body?.detail ?? `Erreur ${res.status}` }
    }
    return { data: res.status === 204 ? (undefined as T) : await res.json() }
  } catch {
    return { error: 'Manager Digital injoignable : réessayez dans un instant.' }
  }
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

/** Gestion des branchements Meta d'un Client : comptes connectés, pages, rattachement aux Sites. */
export function ReseauxSociauxPage() {
  const [params, setParams] = useSearchParams()
  const [clients, setClients] = useState<Client[] | null>(null)
  const [integrations, setIntegrations] = useState<Integration[]>([])
  const [resources, setResources] = useState<Resource[]>([])
  // retour de Meta : ?connexion=ok ou ?erreur=<type>
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(() => {
    if (params.get('connexion') === 'ok') return { ok: true, text: 'Compte Meta connecté : ses pages sont listées ci-dessous.' }
    const error = params.get('erreur')
    return error ? { ok: false, text: MESSAGES[error] ?? 'La connexion à Meta a échoué.' } : null
  })

  // seul un Client de la liste compte (un clientId inconnu est ignoré) ; un seul Client : choisi d'office
  const requested = Number(params.get('clientId'))
  const client = clients?.find((c) => c.id === requested) ?? (clients?.length === 1 ? clients[0] : undefined)
  const clientId = client?.id ?? null
  // le Client affiché : une réponse arrivée après un changement de Client est ignorée
  const shown = useRef(clientId)
  shown.current = clientId

  useEffect(() => {
    api<Client[]>('/me/clients').then((r) => ('data' in r ? setClients(r.data) : setNotice({ ok: false, text: r.error })))
    // le message de retour de Meta est lu : on le retire de l'URL pour qu'il ne revienne pas à l'actualisation
    if (params.has('connexion') || params.has('erreur')) {
      const clientParam = params.get('clientId')
      setParams(clientParam ? { clientId: clientParam } : {}, { replace: true })
    }
  }, []) // une seule fois, à l'arrivée sur la page

  const reload = useCallback(async () => {
    if (!clientId) return
    const [i, r] = await Promise.all([
      api<Integration[]>(`/integrations?clientId=${clientId}`),
      api<Resource[]>(`/integrations/resources?clientId=${clientId}`),
    ])
    if (shown.current !== clientId) return
    const error = 'error' in i ? i.error : 'error' in r ? r.error : null
    setIntegrations('data' in i && !error ? i.data : [])
    setResources('data' in r && !error ? r.data : [])
    if (error) setNotice({ ok: false, text: error })
  }, [clientId])

  useEffect(() => {
    reload()
  }, [reload])

  /** Une action, puis la liste à jour ; en cas d'erreur, le message de l'API. */
  async function act(path: string, init: RequestInit, success: string) {
    const result = await api(path, init)
    setNotice('error' in result ? { ok: false, text: result.error } : { ok: true, text: success })
    await reload()
  }

  const siteDomain = (siteId: number) => client?.sites.find((s) => s.id === siteId)?.domain ?? `Site ${siteId}`

  function state(resource: Resource) {
    if (resource.attached_elsewhere) return <span className="rs-tag">Rattachée à un autre Client</span>
    const site = resource.site_id ? `Rattachée à ${siteDomain(resource.site_id)}` : 'Libre'
    return (
      <>
        <span className={resource.site_id ? 'rs-tag rs-tag-ok' : 'rs-tag'}>{site}</span>
        {!resource.accessible && <span className="rs-tag rs-tag-warn">À reconnecter</span>}
      </>
    )
  }

  return (
    <main className="rs">
      <a href="/" className="rs-back">
        ← Accueil
      </a>
      <h1>Réseaux sociaux</h1>

      {notice?.text && <p className={notice.ok ? 'rs-notice rs-notice-ok' : 'rs-notice rs-notice-error'}>{notice.text}</p>}

      {clients === null && <p className="rs-muted">Chargement…</p>}
      {clients?.length === 0 && <p className="rs-muted">Vous n'êtes rattaché à aucun Client.</p>}
      {clients && clients.length > 1 && (
        <label className="rs-client">
          Client
          <select value={clientId ?? ''} onChange={(e) => setParams({ clientId: e.target.value })}>
            <option value="" disabled>
              Choisir un Client…
            </option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {client && (
        <>
          <section className="rs-card">
            <div className="rs-card-head">
              <h2>Comptes Meta connectés · {client.name}</h2>
              <button
                type="button"
                className="rs-primary"
                // navigation complète : l'API redirige vers Meta, qui revient sur cette page
                onClick={() => (window.location.href = `${API}/integrations/oauth/connect?clientId=${client.id}`)}
              >
                Connecter un compte Meta
              </button>
            </div>
            {integrations.length === 0 ? (
              <p className="rs-muted">Aucun compte Meta connecté pour ce Client.</p>
            ) : (
              <ul className="rs-list">
                {integrations.map((i) => (
                  <li key={i.id}>
                    <span>
                      <strong>{i.created_by.name ?? i.created_by.email}</strong>
                      <span className="rs-muted"> · {i.resources.length} ressource(s)</span>
                    </span>
                    <span className={i.status === 'ACTIVE' ? 'rs-tag rs-tag-ok' : 'rs-tag rs-tag-warn'}>{STATUSES[i.status]}</span>
                    <span className="rs-actions">
                      <button type="button" onClick={() => act(`/integrations/${i.id}/resources/sync`, { method: 'POST' }, 'Liste des pages mise à jour.')}>
                        Actualiser
                      </button>
                      <button
                        type="button"
                        className="rs-danger"
                        onClick={() =>
                          confirm('Déconnecter ce compte Meta ?') && act(`/integrations/${i.id}`, { method: 'DELETE' }, 'Compte Meta déconnecté.')
                        }
                      >
                        Déconnecter
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rs-card">
            <h2>Pages et comptes</h2>
            {resources.length === 0 ? (
              <p className="rs-muted">Connectez un compte Meta pour voir ses pages et comptes.</p>
            ) : (
              <table className="rs-table">
                <tbody>
                  {resources.map((r) => (
                    <tr key={r.id}>
                      <td className="rs-muted">{RESOURCE_TYPES[r.type]}</td>
                      <td>
                        <strong>{r.name}</strong>
                      </td>
                      <td>{state(r)}</td>
                      <td>
                        {r.attached_elsewhere ? null : r.site_id ? (
                          <button type="button" onClick={() => act(`/integrations/resources/${r.id}`, json('PATCH', { siteId: null }), `${r.name} détachée.`)}>
                            Détacher
                          </button>
                        ) : (
                          <select
                            value=""
                            onChange={(e) =>
                              act(`/integrations/resources/${r.id}`, json('PATCH', { siteId: Number(e.target.value) }), `${r.name} rattachée.`)
                            }
                          >
                            <option value="" disabled>
                              Rattacher à…
                            </option>
                            {client.sites.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.domain}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </main>
  )
}
