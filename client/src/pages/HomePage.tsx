import { useEffect, useState } from 'react'
import { API } from '../api.ts'

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
    <main>
      <h1>Manager Digital</h1>
      {user === undefined && <p>Vérification de la connexion…</p>}
      {user === null && (
        // navigation complète (pas un fetch) : l'API redirige vers auth.eness, qui revient ici
        <button type="button" onClick={() => (window.location.href = `${API}/auth/sso/login?returnTo=/`)}>
          Se connecter
        </button>
      )}
      {user && (
        <>
          <p>
            Connecté : {user.name ?? user.email} ({user.email})
          </p>
          <p>
            <a href="/reseaux-sociaux">Réseaux sociaux</a>
          </p>
          <button type="button" onClick={logout}>
            Se déconnecter
          </button>
        </>
      )}
    </main>
  )
}
