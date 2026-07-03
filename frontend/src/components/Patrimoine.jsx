import React, { useEffect, useState } from 'react'
import { api, eur, eurAsset, classColor, applyTypeColors } from '../lib/api.js'
import Pyramide from './Pyramide.jsx'
import { Eye, EyeOff } from './icons.jsx'

const blank = { type: 'livret_a', nom: '', valeur: '', quantite: '', ticker: '', commentaire: '' }

// Regroupe par classe, trie les items par valeur puis les classes par poids total.
function groupAssets(assets) {
  const by = {}
  for (const a of assets) {
    (by[a.type] ||= { type: a.type, items: [], total: 0 })
    by[a.type].items.push(a)
    by[a.type].total += a.valeur || 0
  }
  return Object.values(by)
    .map((g) => ({ ...g, items: [...g.items].sort((x, y) => (y.valeur || 0) - (x.valeur || 0)) }))
    .sort((x, y) => y.total - x.total)
}

export default function Patrimoine({ onChange }) {
  const [assets, setAssets] = useState(null)
  const [types, setTypes] = useState([])
  const [form, setForm] = useState(blank)
  const [results, setResults] = useState([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [binanceOn, setBinanceOn] = useState(false)
  const [keys, setKeys] = useState({ api_key: '', api_secret: '' })
  const [newType, setNewType] = useState(null)   // null = fermé, sinon texte saisi
  // même réglage que le total du tableau de bord (localStorage partagé)
  const [maskTotal, setMaskTotal] = useState(localStorage.getItem('mask_total') === '1')
  const toggleTotal = () => {
    const v = !maskTotal
    setMaskTotal(v); localStorage.setItem('mask_total', v ? '1' : '0')
  }

  const typeLabel = Object.fromEntries(types.map((t) => [t.slug, t.label]))

  const load = () => api.assets().then(setAssets)
  const loadTypes = () => api.assetTypes().then((ts) => { setTypes(ts); applyTypeColors(ts) })
  useEffect(() => {
    load(); loadTypes()
    api.binanceStatus().then((s) => setBinanceOn(s.configured)).catch(() => {})
  }, [])

  const total = (assets || []).reduce((s, a) => s + (a.valeur || 0), 0)
  // 'crypto' -> recherche CoinGecko ; 'pea' -> recherche titres Yahoo ; sinon saisie manuelle.
  const market = form.type === 'crypto' ? 'crypto' : form.type === 'pea' ? 'stock' : null
  const useTicker = market && form.ticker

  const searchMarket = async (q) => {
    setForm((f) => ({ ...f, nom: q, ticker: '' }))
    if (q.length < 2) { setResults([]); return }
    setResults(market === 'crypto' ? await api.cryptoSearch(q) : await api.stockSearch(q))
  }
  const pick = (r) => {
    const ticker = market === 'crypto' ? r.id : r.symbol
    setForm((f) => ({ ...f, nom: r.name, ticker })); setResults([])
  }

  const save = async () => {
    if (!form.nom) return
    // Sans ticker : quantité × valeur unitaire (ex : 3 coffrets identiques).
    // La base stocke le TOTAL dans `valeur` (les calculs existants sont inchangés)
    // et la quantité pour l'affichage et la ré-édition.
    const qty = useTicker ? parseFloat(form.quantite) || 0
                          : Math.max(1, parseFloat(form.quantite) || 1)
    await api.saveAsset({
      id: form.id, type: form.type, nom: form.nom,
      valeur: useTicker ? 0 : (parseFloat(form.valeur) || 0) * qty,
      quantite: useTicker ? qty : (qty > 1 ? qty : null),
      ticker: useTicker ? form.ticker : null,
      source: 'manuel',
      commentaire: form.commentaire || '',
    })
    setForm(blank); setResults([]); await load()
  }

  const edit = (a) => setForm({
    id: a.id, type: a.type, nom: a.nom,
    // ré-édition : on réaffiche la valeur UNITAIRE si une quantité est stockée
    valeur: !a.ticker && a.quantite
      ? +((a.valeur || 0) / a.quantite).toFixed(2) : (a.valeur ?? ''),
    quantite: a.quantite ?? '', ticker: a.ticker ?? '', commentaire: a.commentaire ?? '',
  })
  const remove = async (id) => { await api.deleteAsset(id); await load() }

  const toggleMask = async (a) => {
    await api.toggleMask(a.id)
    setAssets((prev) => prev.map((x) => x.id === a.id ? { ...x, masque: !x.masque } : x))
  }

  const createType = async () => {
    if (!newType?.trim()) { setNewType(null); return }
    try {
      const t = await api.addAssetType(newType.trim())
      await loadTypes()
      setForm((f) => ({ ...f, type: t.slug }))
      setNewType(null)
    } catch (e) { setMsg(`Type non créé : ${e.message}`) }
  }

  const refreshPrices = async () => {
    setBusy(true); setMsg('Rafraîchissement des cours (crypto + titres)…')
    try { const r = await api.pricesRefresh(); setMsg(`${r.maj.length} valeur(s) mise(s) à jour.`); await load() }
    catch { setMsg('Impossible de rafraîchir les cours.') } finally { setBusy(false) }
  }
  const syncBinance = async () => {
    setBusy(true); setMsg('Synchronisation Binance (lecture seule)…')
    try { const r = await api.binanceSync(); setMsg(`Binance : ${r.importes} avoirs importés.`); await load() }
    catch (e) { setMsg(`Binance : ${e.message}`) } finally { setBusy(false) }
  }
  const saveKeys = async () => {
    if (!keys.api_key || !keys.api_secret) return
    try {
      const r = await api.binanceKeysSet(keys.api_key, keys.api_secret)
      setBinanceOn(r.configured); setKeys({ api_key: '', api_secret: '' })
      setMsg('Clés Binance enregistrées. Tu peux synchroniser.')
    } catch { setMsg('Échec de l\'enregistrement des clés.') }
  }

  if (!assets) return <div className="row" style={{ padding: 40 }}><span className="spinner" /></div>

  return (
    <>
      <div className="page-head row between">
        <div><h1>Patrimoine</h1>
          <p>Total des actifs : {maskTotal ? '•••• €' : eur(total)}
            <button className="mask-btn" onClick={toggleTotal}
              title={maskTotal ? 'Afficher le total' : 'Masquer le total'}>
              {maskTotal ? <EyeOff size={13} /> : <Eye size={13} />}</button></p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" onClick={refreshPrices} disabled={busy}>
            {busy ? '…' : '↻ Rafraîchir les cours'}</button>
          <button className="btn" onClick={syncBinance} disabled={busy}
            title={binanceOn ? '' : 'Renseigne les clés Binance (lecture seule) dans docker-compose.yml'}>
            Synchroniser Binance{binanceOn ? '' : ' ⚠'}</button>
        </div>
      </div>

      {msg && <div className="banner" style={{ marginBottom: 16 }}>{msg}</div>}

      {/* Pyramide patrimoniale — étages alimentés par les actifs réels */}
      <div className="card" style={{ marginBottom: 18 }}>
        <h3>La pyramide patrimoniale</h3>
        <Pyramide assets={assets} />
        <p className="muted" style={{ fontSize: 12, textAlign: 'center', marginBottom: 0 }}>
          Base solide d'abord : sécurité (comptes, livrets) → croissance (PEA, ETF)
          → diversification (cryptos, collections) → optimisation.
        </p>
      </div>

      <div className="grid cols-2">
        {/* Liste des actifs — groupés par classe, triés par poids */}
        <div className="card">
          <h3>Mes actifs</h3>
          {assets.length === 0
            ? <p className="muted">Aucun actif. Ajoute-en un avec le formulaire →</p>
            : groupAssets(assets).map((g) => (
              <details key={g.type} open={g.items.length <= 4}
                style={{ marginBottom: 8, borderBottom: '1px solid var(--surface-2)' }}>
                <summary style={{ display: 'flex', alignItems: 'center', gap: 8,
                  cursor: 'pointer', padding: '8px 4px', listStyle: 'none' }}>
                  <span className="swatch" style={{ width: 10, height: 10, borderRadius: 3,
                    background: classColor(g.type) }} />
                  <span style={{ fontWeight: 600 }}>{typeLabel[g.type] || g.type}</span>
                  <span className="muted" style={{ fontSize: 12 }}>({g.items.length})</span>
                  <span className="num" style={{ marginLeft: 'auto', fontWeight: 600 }}>
                    {eur(g.total)}</span>
                </summary>
                <table style={{ marginBottom: 6 }}>
                  <tbody>
                    {g.items.map((a) => (
                      <tr key={a.id}>
                        <td style={{ paddingLeft: 26 }}>
                          {a.nom}
                          {a.quantite ? <span className="muted">
                            {' '}· {a.ticker ? `${a.quantite} u.` : `× ${a.quantite}`}</span> : null}
                          {a.source && a.source !== 'manuel'
                            ? <span className="src-tag" style={{ marginLeft: 6 }}>{a.source}</span> : null}
                          {a.commentaire
                            ? <div className="muted asset-note">{a.commentaire}</div> : null}
                        </td>
                        <td className="num">{eurAsset(a)}</td>
                        <td className="num" style={{ whiteSpace: 'nowrap', width: 1 }}>
                          <button className="btn ghost icon" onClick={() => toggleMask(a)}
                            title={a.masque ? 'Afficher ce montant' : 'Masquer ce montant'}>
                            {a.masque ? <EyeOff /> : <Eye />}</button>
                          <button className="btn ghost" onClick={() => edit(a)}>Éditer</button>
                          <button className="btn ghost" style={{ color: 'var(--clay)' }}
                            onClick={() => remove(a.id)}>Suppr.</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            ))}
        </div>

        {/* Formulaire ajout / édition */}
        <div className="card">
          <h3>{form.id ? 'Modifier un actif' : 'Ajouter un actif'}</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Type</div>
              <div className="row" style={{ gap: 8 }}>
                <select value={form.type} style={{ flex: 1 }}
                  onChange={(e) => {
                    setForm({ ...blank, type: e.target.value, id: form.id }); setResults([])
                  }}>
                  {types.map((t) => <option key={t.slug} value={t.slug}>{t.label}</option>)}
                </select>
                <button className="btn" title="Créer un nouveau type d'actif"
                  onClick={() => setNewType(newType === null ? '' : null)}>+ Type</button>
              </div>
              {newType !== null && (
                <div className="row" style={{ gap: 8, marginTop: 8 }}>
                  <input autoFocus placeholder="ex : Immobilier, Montres, Assurance-vie…"
                    value={newType} style={{ flex: 1 }}
                    onChange={(e) => setNewType(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && createType()} />
                  <button className="btn primary" onClick={createType}>Créer</button>
                </div>
              )}
            </label>

            <label>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                {market === 'crypto' ? 'Crypto (cherche puis sélectionne)'
                  : market === 'stock' ? 'Titre / ETF (cherche puis sélectionne)' : 'Nom'}</div>
              <input value={form.nom} style={{ width: '100%' }}
                placeholder={market === 'crypto' ? 'bitcoin, ethereum…'
                  : market === 'stock' ? 'Air Liquide, MSCI World…' : 'ex : Livret A'}
                onChange={(e) => market ? searchMarket(e.target.value)
                  : setForm({ ...form, nom: e.target.value })} />
              {results.length > 0 && (
                <div className="card" style={{ padding: 6, marginTop: 4 }}>
                  {results.map((r) => (
                    <div key={r.id || r.symbol} className="row"
                      style={{ padding: '6px 8px', cursor: 'pointer', borderRadius: 6,
                        justifyContent: 'space-between' }}
                      onClick={() => pick(r)}>
                      <span>{r.name} <span className="muted">
                        {(r.symbol || '').toUpperCase()}{r.exchange ? ` · ${r.exchange}` : ''}</span></span>
                      <span className="src-tag">{r.id || r.symbol}</span>
                    </div>
                  ))}
                </div>
              )}
            </label>

            {useTicker ? (
              <label>
                <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                  Quantité détenue · {form.ticker}</div>
                <input type="number" step="any" value={form.quantite}
                  style={{ width: '100%' }} placeholder={market === 'crypto' ? '0.0085' : '12'}
                  onChange={(e) => setForm({ ...form, quantite: e.target.value })} />
                <p className="muted" style={{ fontSize: 11.5, margin: '4px 0 0' }}>
                  La valeur € est calculée au rafraîchissement des cours
                  ({market === 'crypto' ? 'CoinGecko' : 'Yahoo Finance'}).</p>
              </label>
            ) : (
              <div>
                <div className="row" style={{ gap: 10 }}>
                  <label style={{ width: 110 }}>
                    <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Quantité</div>
                    <input type="number" min="1" step="1" value={form.quantite}
                      style={{ width: '100%' }} placeholder="1"
                      onChange={(e) => setForm({ ...form, quantite: e.target.value })} />
                  </label>
                  <label style={{ flex: 1 }}>
                    <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                      Valeur unitaire (€)</div>
                    <input type="number" step="any" value={form.valeur}
                      style={{ width: '100%' }} placeholder="0"
                      onChange={(e) => setForm({ ...form, valeur: e.target.value })} />
                  </label>
                </div>
                {(parseFloat(form.quantite) || 1) > 1 && (
                  <p className="muted" style={{ fontSize: 11.5, margin: '4px 0 0' }}>
                    {form.quantite} exemplaires ×&nbsp;
                    {eur(parseFloat(form.valeur) || 0)} = total&nbsp;
                    <b>{eur((parseFloat(form.quantite) || 1) * (parseFloat(form.valeur) || 0))}</b>
                  </p>
                )}
                {market === 'stock' && (
                  <p className="muted" style={{ fontSize: 11.5, margin: '4px 0 0' }}>
                    Astuce : cherche un titre ci-dessus pour un suivi automatique, ou saisis
                    une valeur fixe (ex : liquidités du PEA).</p>
                )}
              </div>
            )}

            <label>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                Commentaire <span style={{ opacity: .6 }}>(optionnel)</span></div>
              <textarea rows={2} value={form.commentaire} style={{ width: '100%' }}
                placeholder="ex : acheté en 2024, à réévaluer en fin d'année…"
                onChange={(e) => setForm({ ...form, commentaire: e.target.value })} />
            </label>

            <div className="row" style={{ gap: 8 }}>
              <button className="btn primary" onClick={save}>
                {form.id ? 'Enregistrer' : 'Ajouter'}</button>
              {form.id && <button className="btn"
                onClick={() => { setForm(blank); setResults([]) }}>Annuler</button>}
            </div>
          </div>
        </div>
      </div>

      {/* Connexion Binance (lecture seule) */}
      <div className="card" style={{ marginTop: 18 }}>
        <h3>Connexion Binance (lecture seule)</h3>
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          Crée sur Binance une clé API avec la <b>seule</b> permission « Read Info »
          (aucun retrait, aucun trade). Elle est stockée localement sur ton Pi.
        </p>
        {binanceOn && (
          <div className="banner" style={{ marginBottom: 12 }}>
            ✓ Binance connecté — utilise « Synchroniser Binance » en haut de page.
          </div>)}
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input type="password" placeholder="API Key" value={keys.api_key}
            style={{ flex: 1, minWidth: 200 }}
            onChange={(e) => setKeys({ ...keys, api_key: e.target.value })} />
          <input type="password" placeholder="API Secret" value={keys.api_secret}
            style={{ flex: 1, minWidth: 200 }}
            onChange={(e) => setKeys({ ...keys, api_secret: e.target.value })} />
          <button className="btn primary" onClick={saveKeys}>Enregistrer</button>
        </div>
      </div>
    </>
  )
}
