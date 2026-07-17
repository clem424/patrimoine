import React, { useState } from 'react'
import { api, setToken } from '../lib/api.js'

// Écran de connexion / création de profil. Chaque membre de la famille a son
// pseudo + mot de passe et ne voit que ses propres données.
export default function Login({ onLogin }) {
  const [mode, setMode] = useState('login')   // login | register
  const [pseudo, setPseudo] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setErr(null)
    if (mode === 'register' && password !== confirm) {
      setErr('Les deux mots de passe ne correspondent pas.'); return
    }
    setBusy(true)
    try {
      const r = mode === 'login'
        ? await api.login(pseudo, password)
        : await api.register(pseudo, password)
      setToken(r.token)
      onLogin(r.pseudo)
    } catch (e2) {
      setErr(e2.message)
    } finally { setBusy(false) }
  }

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <div className="brand" style={{ color: 'var(--ink)', paddingLeft: 0 }}>
          <span className="dot" />
          <span className="txt">Patrimoine</span>
        </div>
        <p className="muted" style={{ margin: '2px 0 18px', fontSize: 13 }}>
          {mode === 'login'
            ? 'Chaque profil ne voit que ses propres comptes.'
            : 'Nouveau profil : comptes, opérations et actifs privés.'}
        </p>

        <form onSubmit={submit} className="login-form">
          <input autoFocus placeholder="Pseudo" value={pseudo} autoComplete="username"
            onChange={(e) => setPseudo(e.target.value)} />
          <input type="password" placeholder="Mot de passe" value={password}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            onChange={(e) => setPassword(e.target.value)} />
          {mode === 'register' &&
            <input type="password" placeholder="Confirmation du mot de passe" value={confirm}
              autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} />}
          {err && <div className="banner warn">{err}</div>}
          <button className="btn primary" disabled={busy || !pseudo || !password}>
            {busy ? '…' : mode === 'login' ? 'Se connecter' : 'Créer mon profil'}
          </button>
        </form>

        <button className="btn ghost" style={{ marginTop: 12, width: '100%' }}
          onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setErr(null) }}>
          {mode === 'login' ? 'Première visite ? Créer un profil' : 'J\'ai déjà un profil — me connecter'}
        </button>
      </div>
      <div className="login-foot">self-hosted · raspberry pi · données 100 % locales</div>
    </div>
  )
}
