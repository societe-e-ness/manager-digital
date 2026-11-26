import { useEffect, useState } from 'react'
import { API } from '../api.ts'
// même style minimal que la page Réseaux sociaux (classes .rs)
import './ReseauxSociauxPage.css'

type User = { id: number; email: string; name: string | null; type: 'AGENCY' | 'CLIENT' }

export function HomePage() {
  // undefined = vérification en cours, null = non connecté
  const [user, setUser] = useState<User | null | undefined>(undefined)

  useEffect(() => {
    fetch(`${API}/auth/me`, { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then(setUser)
      .catch(() => setUser(null))
  }, [])

  async function logout() {
    const res = await fetch(`${API}/auth/logout`, { method: 'POST', credentials: 'include' })
    // session SSO : auth.eness propose de quitter le Manager Digital seul ou tous les services
    if (res.status === 200) {
      const { logoutUrl } = await res.json()
      window.location.href = logoutUrl
      return
    }
    setUser(null)
  }

  return (
    <main className="rs">
      <h1>Manager Digital</h1>
      {user === undefined && <p className="rs-muted">Vérification de la connexion…</p>}
      {user === null && (
        <section className="rs-card">
          <div className="rs-card-head">
            <h2>Connexion</h2>
            <button
              type="button"
              className="rs-primary"
              // navigation complète (pas un fetch) : l'API redirige vers auth.eness, qui revient ici
              onClick={() => (window.location.href = `${API}/auth/sso/login?returnTo=/`)}
            >
              Se connecter
            </button>
          </div>
        </section>
      )}
      {user && (
        <>
          <section className="rs-card">
            <div className="rs-card-head">
              <h2>
                {user.name ?? user.email} <span className="rs-muted">· {user.email}</span>
              </h2>
              <button type="button" onClick={logout}>
                Se déconnecter
              </button>
            </div>
          </section>
          <section className="rs-card">
            <div className="rs-card-head">
              <h2>Réseaux sociaux</h2>
              <button type="button" className="rs-primary" onClick={() => (window.location.href = '/reseaux-sociaux')}>
                Ouvrir
              </button>
            </div>
          </section>
        </>
      )}
    </main>
  )
}
