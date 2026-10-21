import { useEffect, useState } from 'react'
import { useLocation } from 'react-router'
import { API } from '../api.ts'

type Site = { id: number; domain: string; client: string }
type Context = { client: string; redirectHost: string; sites: Site[] }

const UNREACHABLE = 'Manager Digital injoignable, réessayez dans un instant'

/** Pas (ou plus) connecté : connexion, puis retour ici. */
function goToLogin(search: string) {
  window.location.replace(`/connexion?returnTo=${encodeURIComponent(`/autoriser${search}`)}`)
}

/** Le `detail` d'une erreur Problem Details, ou un message générique si la réponse n'en est pas une. */
async function problemDetail(res: Response) {
  const body = await res.json().catch(() => null)
  return body?.detail ?? `erreur ${res.status}`
}

/**
 * Autorisation du Plugin WP (OAuth) : l'API y envoie l'utilisateur avec la demande du Plugin WP
 * dans l'URL. Il choisit le Site, puis l'API renvoie vers le Plugin WP avec un code (ou un refus).
 */
export function AutoriserPage() {
  const { search } = useLocation()
  const [context, setContext] = useState<Context | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [siteId, setSiteId] = useState<number | null>(null)

  useEffect(() => {
    fetch(`${API}/oauth/consent${search}`, { credentials: 'include' })
      .then(async (res) => {
        if (res.status === 401) return goToLogin(search)
        if (!res.ok) return setError(await problemDetail(res))
        const body: Context = await res.json()
        setContext(body)
        if (body.sites.length === 1) setSiteId(body.sites[0].id)
      })
      .catch(() => setError(UNREACHABLE))
  }, [search])

  async function decide(decision: 'allow' | 'deny') {
    try {
      const res = await fetch(`${API}/oauth/consent`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...Object.fromEntries(new URLSearchParams(search)), decision, siteId }),
      })
      if (res.status === 401) return goToLogin(search)
      if (!res.ok) return setError(await problemDetail(res))
      window.location.href = (await res.json()).redirectTo
    } catch {
      setError(UNREACHABLE)
    }
  }

  if (error) return <p>Autorisation impossible : {error}</p>
  if (!context) return <p>Chargement…</p>

  return (
    <main>
      <h1>Autoriser le {context.client}</h1>
      <p>
        Le {context.client} installé sur <strong>{context.redirectHost}</strong> demande à agir en votre nom sur ce Site.
      </p>
      {context.sites.length === 0 ? (
        <p>Aucun de vos Sites ne correspond à {context.redirectHost}.</p>
      ) : (
        context.sites.map((site) => (
          <label key={site.id}>
            <input type="radio" name="site" checked={siteId === site.id} onChange={() => setSiteId(site.id)} />
            {site.domain} ({site.client})
          </label>
        ))
      )}
      <button type="button" disabled={siteId === null} onClick={() => decide('allow')}>
        Autoriser
      </button>
      <button type="button" onClick={() => decide('deny')}>
        Refuser
      </button>
    </main>
  )
}
