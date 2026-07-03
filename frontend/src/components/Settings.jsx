import React, { useEffect, useState } from 'react'
import { api, eur, applyTypeColors } from '../lib/api.js'

// Champ éditable en place : valide sur Entrée ou perte de focus (si modifié).
function InlineEdit({ value, onSave, placeholder, disabled, style }) {
  const [v, setV] = useState(value ?? '')
  useEffect(() => { setV(value ?? '') }, [value])
  const commit = () => { if (v.trim() !== (value ?? '') && !disabled) onSave(v.trim()) }
  return (
    <input value={v} placeholder={placeholder} disabled={disabled} style={style}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') setV(value ?? '') }} />
  )
}

// Page Réglages : catégories d'opérations (renommables, description = guide
// Ollama), types d'actifs, renommage des actifs, mot de passe du profil.
export default function Settings({ onChange }) {
  const [cats, setCats] = useState(null)
  const [types, setTypes] = useState([])
  const [assets, setAssets] = useState([])
  const [msg, setMsg] = useState(null)
  const [newCat, setNewCat] = useState('')
  const [newCatDesc, setNewCatDesc] = useState('')
  const [newType, setNewType] = useState('')
  const [pwd, setPwd] = useState({ ancien: '', nouveau: '' })
  const [objectif, setObjectif] = useState('')

  const load = () => Promise.all([api.categoriesFull(), api.assetTypes(), api.assets()])
    .then(([c, t, a]) => { setCats(c); setTypes(t); setAssets(a); applyTypeColors(t) })
  useEffect(() => {
    load()
    api.objectifGet().then((o) => setObjectif(o.montant ?? '')).catch(() => {})
  }, [])

  const saveObjectif = () => {
    const val = parseFloat(String(objectif).replace(',', '.')) || 0
    act(() => api.objectifSet(val),
      val > 0 ? `Objectif fixé à ${eur(val)} — visible sur le tableau de bord.`
              : 'Objectif retiré.')
  }

  const act = async (fn, okMsg) => {
    setMsg(null)
    try { await fn(); await load(); if (okMsg) setMsg(okMsg) }
    catch (e) { setMsg(e.message) }
  }

  if (!cats) return <div className="row" style={{ padding: 40 }}><span className="spinner" /></div>

  return (
    <>
      <div className="page-head">
        <h1>Réglages</h1>
        <p>Catégories, types d'actifs, noms d'actifs et profil — modifie tout ici.</p>
      </div>

      {msg && <div className="banner" style={{ marginBottom: 16 }}>{msg}</div>}

      <div className="card" style={{ marginBottom: 18 }}>
        <h3>Catégories d'opérations</h3>
        <p className="muted" style={{ fontSize: 13, marginTop: -8 }}>
          Renommer une catégorie met à jour toutes tes opérations, budgets et
          l'apprentissage. La <b>description</b> guide Ollama : plus elle est précise
          (mots-clés, noms de marchands), mieux il classe.</p>
        <table>
          <thead><tr><th>Nom</th><th>Description (guide Ollama)</th>
            <th style={{ textAlign: 'right' }}>Opérations</th><th /></tr></thead>
          <tbody>
            {cats.map((c) => (
              <tr key={c.nom}>
                <td style={{ width: 230 }}>
                  <InlineEdit value={c.nom} disabled={c.protected}
                    style={{ width: '100%', fontWeight: 600 }}
                    onSave={(nom) => act(() => api.patchCategory(c.nom, { nom }))} />
                  {c.protected && <div className="muted" style={{ fontSize: 11 }}>
                    rôle spécial — non modifiable</div>}
                </td>
                <td>
                  <InlineEdit value={c.description} placeholder="ex : croquettes, vétérinaire, toilettage…"
                    disabled={c.protected} style={{ width: '100%' }}
                    onSave={(description) => act(() => api.patchCategory(c.nom, { description }))} />
                </td>
                <td className="num">{c.usage}</td>
                <td style={{ textAlign: 'right' }}>
                  {!c.protected &&
                    <button className="btn ghost icon" style={{ color: 'var(--clay)' }}
                      title={c.usage ? 'Encore utilisée — recatégorise d\'abord ses opérations' : 'Supprimer'}
                      onClick={() => act(() => api.deleteCategory(c.nom))}>×</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row" style={{ gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          <input placeholder="Nouvelle catégorie (ex : Animaux)" value={newCat}
            onChange={(e) => setNewCat(e.target.value)} style={{ minWidth: 200 }} />
          <input placeholder="Description pour Ollama (facultatif)" value={newCatDesc}
            onChange={(e) => setNewCatDesc(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
          <button className="btn primary" disabled={!newCat.trim()}
            onClick={() => act(async () => {
              await api.addCategory(newCat.trim(), newCatDesc.trim())
              setNewCat(''); setNewCatDesc('')
            })}>Ajouter</button>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginBottom: 18 }}>
        <div className="card">
          <h3>Types d'actifs</h3>
          <table>
            <tbody>
              {types.map((t) => (
                <tr key={t.slug}>
                  <td>
                    {t.builtin
                      ? <span>{t.label} <span className="muted" style={{ fontSize: 11 }}>· intégré</span></span>
                      : <InlineEdit value={t.label} style={{ width: '100%' }}
                          onSave={(label) => act(() => api.renameAssetType(t.slug, label))} />}
                  </td>
                  <td style={{ textAlign: 'right', width: 40 }}>
                    {!t.builtin &&
                      <button className="btn ghost icon" style={{ color: 'var(--clay)' }}
                        title="Supprimer (si aucun actif ne l'utilise)"
                        onClick={() => act(() => api.deleteAssetType(t.slug))}>×</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ gap: 8, marginTop: 14 }}>
            <input placeholder="Nouveau type (ex : Immobilier)" value={newType}
              onChange={(e) => setNewType(e.target.value)} style={{ flex: 1 }} />
            <button className="btn primary" disabled={!newType.trim()}
              onClick={() => act(async () => { await api.addAssetType(newType.trim()); setNewType('') })}>
              Ajouter</button>
          </div>
        </div>

        <div className="card">
          <h3>Objectif de patrimoine</h3>
          <p className="muted" style={{ fontSize: 13, marginTop: -8 }}>
            Fixe un cap (ex : 50 000 €) : la progression s'affiche sur le tableau
            de bord. Laisse vide ou mets 0 pour le retirer.</p>
          <div className="row" style={{ gap: 8 }}>
            <input type="number" step="1000" min="0" placeholder="ex : 50000"
              value={objectif} style={{ flex: 1 }}
              onChange={(e) => setObjectif(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveObjectif()} />
            <button className="btn primary" onClick={saveObjectif}>Enregistrer</button>
          </div>
        </div>

        <div className="card">
          <h3>Mon profil</h3>
          <p className="muted" style={{ fontSize: 13, marginTop: -8 }}>
            Changer ton mot de passe déconnecte toutes tes sessions.</p>
          <div className="login-form">
            <input type="password" placeholder="Ancien mot de passe" value={pwd.ancien}
              autoComplete="current-password"
              onChange={(e) => setPwd({ ...pwd, ancien: e.target.value })} />
            <input type="password" placeholder="Nouveau mot de passe" value={pwd.nouveau}
              autoComplete="new-password"
              onChange={(e) => setPwd({ ...pwd, nouveau: e.target.value })} />
            <button className="btn" disabled={!pwd.ancien || !pwd.nouveau}
              onClick={() => act(async () => {
                await api.changePassword(pwd.ancien, pwd.nouveau)
                setPwd({ ancien: '', nouveau: '' })
              }, 'Mot de passe changé — reconnecte-toi à la prochaine visite.')}>
              Changer le mot de passe</button>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Noms des actifs</h3>
        <p className="muted" style={{ fontSize: 13, marginTop: -8 }}>
          Renomme un actif directement ici (valeurs et quantités se gèrent dans « Patrimoine »).</p>
        {assets.length === 0
          ? <p className="muted" style={{ fontSize: 13 }}>Aucun actif pour l'instant.</p>
          : <table>
              <thead><tr><th>Nom</th><th>Type</th>
                <th style={{ textAlign: 'right' }}>Valeur</th><th /></tr></thead>
              <tbody>
                {assets.map((a) => (
                  <tr key={a.id}>
                    <td style={{ width: '45%' }}>
                      <InlineEdit value={a.nom} style={{ width: '100%' }}
                        onSave={(nom) => act(() => api.saveAsset({ ...a, nom }))} />
                    </td>
                    <td><span className="src-tag">
                      {(types.find((t) => t.slug === a.type) || {}).label || a.type}</span></td>
                    <td className="num">{eur(a.valeur)}</td>
                    <td style={{ textAlign: 'right', width: 40 }}>
                      <button className="btn ghost icon" style={{ color: 'var(--clay)' }}
                        title="Supprimer cet actif"
                        onClick={() => window.confirm(`Supprimer « ${a.nom} » ?`)
                          && act(() => api.deleteAsset(a.id))}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>}
      </div>
    </>
  )
}
