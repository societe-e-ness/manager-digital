import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router'
import { API } from '../api.ts'
// même style minimal que la page Réseaux sociaux (classes .rs)
import './ReseauxSociauxPage.css'

// le seul message qui n'est pas une erreur
const LINK_SENT = 'Si cet email est connu, un lien de connexion vient de vous être envoyé.'

/** Seul un chemin local est un retour acceptable, sinon c'est une redirection ouverte. */
function safeReturnTo(path: string | null) {
  return path && /^\/(?![/\\])/.test(path) && !path.includes('\\') ? path : '/'
}

/**
 * Connexion : SSO auth.eness, ou lien magique en secours. Après connexion, retour vers
 * `returnTo` (par exemple l'autorisation du Plugin WP). Le lien magique arrive ici avec `token`.
 */
export function ConnexionPage() {
  const [params] = useSearchParams()
  const returnTo = safeReturnTo(params.get('returnTo'))
  const token = params.get('token')
  const [message, setMessage] = useState<string | null>(params.get('erreur') ? 'La connexion a échoué, réessayez.' : null)
  const [email, setEmail] = useState('')
  // le jeton ne sert qu'une fois : pas de seconde validation (StrictMode, nouveau rendu)
  const verified = useRef(false)

  // lien magique : on envoie le jeton à l'API (jamais un simple GET, voir AuthController)
  useEffect(() => {
    if (!token || verified.current) return
    verified.current = true
    fetch(`${API}/auth/magic-link/verify`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then((res) => {
        if (res.ok) window.location.replace(returnTo)
        else setMessage('Ce lien a expiré ou a déjà servi : demandez-en un nouveau.')
      })
      .catch(() => setMessage('Manager Digital injoignable : réessayez dans un instant.'))
  }, [token, returnTo])

  async function sendMagicLink(event: FormEvent) {
    event.preventDefault()
    try {
      await fetch(`${API}/auth/magic-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, returnTo }),
      })
      setMessage(LINK_SENT)
    } catch {
      setMessage('Manager Digital injoignable : réessayez dans un instant.')
    }
  }

  if (token && !message)
    return (
      <main className="rs">
        <p className="rs-muted">Connexion en cours…</p>
      </main>
    )

  return (
    <main className="rs">
      <h1>Connexion</h1>
      {message && (
        <p className={`rs-notice ${message === LINK_SENT ? 'rs-notice-ok' : 'rs-notice-error'}`}>{message}</p>
      )}
      <section className="rs-card">
        <div className="rs-card-head">
          <h2>Compte eness</h2>
          <button
            type="button"
            className="rs-primary"
            onClick={() => (window.location.href = `${API}/auth/sso/login?returnTo=${encodeURIComponent(returnTo)}`)}
          >
            Se connecter avec le compte eness
          </button>
        </div>
      </section>
      <section className="rs-card">
        <h2>SSO indisponible ?</h2>
        <p className="rs-muted">Recevez un lien de connexion par email.</p>
        <form className="rs-actions" onSubmit={sendMagicLink}>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" />
          <button type="submit">Recevoir un lien</button>
        </form>
      </section>
    </main>
  )
}
