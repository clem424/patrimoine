import React, { lazy, Suspense, useEffect, useState } from 'react'
import Login from './components/Login.jsx'
import { api, applyTypeColors, isHidden, setHidden, hasToken, setToken,
         getTheme, applyTheme } from './lib/api.js'
import { Eye, EyeOff, Sun, Moon } from './components/icons.jsx'

applyTheme(getTheme())   // avant le premier rendu : pas de flash de thème

// Pages chargées à la demande : l'écran de connexion n'embarque ni les pages
// ni recharts (chunk séparé), gros gain au premier chargement sur mobile.
const Dashboard    = lazy(() => import('./components/Dashboard.jsx'))
const Transactions = lazy(() => import('./components/Transactions.jsx'))
const Patrimoine   = lazy(() => import('./components/Patrimoine.jsx'))
const Budget       = lazy(() => import('./components/Budget.jsx'))
const Import       = lazy(() => import('./components/Import.jsx'))
const Settings     = lazy(() => import('./components/Settings.jsx'))

const PAGES = [
  { id: 'dashboard', label: 'Tableau de bord', ic: '◆', comp: Dashboard },
  { id: 'patrimoine', label: 'Patrimoine', ic: '▲', comp: Patrimoine },
  { id: 'budget', label: 'Budget', ic: '◎', comp: Budget },
  { id: 'transactions', label: 'Opérations', ic: '≡', comp: Transactions },
  { id: 'import', label: 'Importer', ic: '↥', comp: Import },
  { id: 'reglages', label: 'Réglages', ic: '⚙', comp: Settings },
]

export default function App() {
  const [user, setUser] = useState(undefined)      // undefined = vérification en cours
  const [page, setPage] = useState('dashboard')
  const [refresh, setRefresh] = useState(0)        // bump pour forcer un rechargement
  const [hidden, setHiddenState] = useState(isHidden())
  const [theme, setTheme] = useState(getTheme())
  const bump = () => setRefresh((r) => r + 1)

  const toggleTheme = () => {
    const t = theme === 'dark' ? 'light' : 'dark'
    applyTheme(t); setTheme(t); bump()   // re-rend les graphiques avec les couleurs du thème
  }

  // Session : vérifie le jeton au démarrage, écoute les expirations (401).
  useEffect(() => {
    if (!hasToken()) { setUser(null); return }
    api.me().then((u) => setUser(u.pseudo)).catch(() => setUser(null))
  }, [])
  useEffect(() => {
    const onExpire = () => setUser(null)
    window.addEventListener('auth-expired', onExpire)
    return () => window.removeEventListener('auth-expired', onExpire)
  }, [])

  // Couleurs des types d'actifs personnalisés (variables CSS globales).
  useEffect(() => {
    if (user) api.assetTypes().then(applyTypeColors).catch(() => {})
  }, [refresh, user])

  const toggleHidden = () => {
    const v = !hidden
    setHidden(v); setHiddenState(v); bump()   // remonte la page active -> reformate tout
  }

  const logout = async () => {
    try { await api.logout() } catch { /* la session locale est effacée quoi qu'il arrive */ }
    setToken(null); setUser(null); setPage('dashboard')
  }

  if (user === undefined)
    return <div className="login-wrap"><span className="spinner" /></div>
  if (!user)
    return <Login onLogin={(pseudo) => { setUser(pseudo); setPage('dashboard'); bump() }} />

  const Active = PAGES.find((p) => p.id === page).comp

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="dot" />
          <span className="txt">Patrimoine</span>
        </div>
        <div className="brand"><small>self-hosted · raspberry pi</small></div>
        <nav className="nav">
          {PAGES.map((p) => (
            <button key={p.id} className={page === p.id ? 'active' : ''}
                    onClick={() => setPage(p.id)}>
              <span className="ic">{p.ic}</span>
              <span className="lbl">{p.label}</span>
            </button>
          ))}
        </nav>
        <button className="theme-toggle" onClick={toggleTheme}
          title={theme === 'dark' ? 'Passer en thème clair' : 'Passer en thème sombre'}>
          <span className="ic">{theme === 'dark' ? <Sun /> : <Moon />}</span>
          <span className="lbl">{theme === 'dark' ? 'Thème clair' : 'Thème sombre'}</span>
        </button>
        <button className={'privacy-toggle' + (hidden ? ' on' : '')}
          onClick={toggleHidden}
          title={hidden ? 'Montants masqués — cliquer pour afficher' : 'Masquer tous les montants'}>
          <span className="ic">{hidden ? <EyeOff /> : <Eye />}</span>
          <span className="lbl">{hidden ? 'Montants masqués' : 'Masquer les montants'}</span>
        </button>
        <div className="user-box">
          <span className="lbl" title={`Connecté : ${user}`}>{user}</span>
          <button className="btn-logout" onClick={logout} title="Se déconnecter">⎋</button>
        </div>
        <div className="foot">Tes données restent<br />sur ta machine.</div>
      </aside>
      <main className="main">
        <Suspense fallback={<div className="row" style={{ padding: 40 }}><span className="spinner" /></div>}>
          <Active key={refresh} goImport={() => setPage('import')} onChange={bump} />
        </Suspense>
      </main>
    </div>
  )
}
