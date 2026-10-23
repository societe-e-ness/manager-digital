import { createBrowserRouter } from 'react-router'
import { AutoriserPage } from './pages/AutoriserPage.tsx'
import { ConnexionPage } from './pages/ConnexionPage.tsx'
import { HomePage } from './pages/HomePage.tsx'
import { ReseauxSociauxPage } from './pages/ReseauxSociauxPage.tsx'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <HomePage />,
  },
  {
    path: '/connexion',
    element: <ConnexionPage />,
  },
  {
    // autorisation du Plugin WP (OAuth) : l'API y envoie l'utilisateur
    path: '/autoriser',
    element: <AutoriserPage />,
  },
  {
    path: '/reseaux-sociaux',
    element: <ReseauxSociauxPage />,
  },
])
