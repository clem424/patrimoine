import React, { useEffect, useState } from 'react'
import { api, eur, eurAsset, classColor, applyTypeColors, dateFr } from '../lib/api.js'
import { useSort, arrow } from '../lib/useSort.js'
import Pyramide from './Pyramide.jsx'
import { Eye, EyeOff } from './icons.jsx'

const blank = { type: 'livret_a', nom: '', valeur: '', quantite: '', ticker: '',
  commentaire: '', prix_achat: '', date_achat: '', pays: '', croissance_pct: '' }

const PAYS_COLORS = ['#3A55C4', '#16887A', '#BE862C', '#BC4A33', '#6A7BE6',
  '#54A89B', '#9B6BD0', '#8A93A6']

// pourcentage signé, 1 décimale : +12,3 % / −4 %
const pct = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toLocaleString('fr-FR',
  { maximumFractionDigits: 1 }) + ' %'

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
  // Routines d'investissement (achats récurrents sur un actif coté)
  const [routines, setRoutines] = useState([])
  const [rForm, setRForm] = useState({ asset_id: '', montant: '', jour: '' })
  // même réglage que le total du tableau de bord (localStorage partagé)
  const [maskTotal, setMaskTotal] = useState(localStorage.getItem('mask_total') === '1')
  const toggleTotal = () => {
    const v = !maskTotal
    setMaskTotal(v); localStorage.setItem('mask_total', v ? '1' : '0')
  }

  const typeLabel = Object.fromEntries(types.map((t) => [t.slug, t.label]))

  const suiviTri = useSort('valeur')
  // Croissance visée par classe (héritée par les actifs sans croissance propre)
  const [growth, setGrowth] = useState({})
  const saveGrowth = async (slug, val) => {
    const pct = val === '' ? null : parseFloat(val)
    try {
      await api.setCroissanceClasse(slug, pct)
      setGrowth((g) => ({ ...g, [slug]: pct || undefined }))
      await load()                       // rafraîchit croissance_classe des actifs
    } catch (e) { setMsg(e.message) }
  }

  const load = () => api.assets().then(setAssets)
  const loadTypes = () => api.assetTypes().then((ts) => { setTypes(ts); applyTypeColors(ts) })
  const loadRoutines = () => api.routines().then(setRoutines).catch(() => {})
  useEffect(() => {
    load(); loadTypes(); loadRoutines()
    api.croissanceClasses().then(setGrowth).catch(() => {})
    api.binanceStatus().then((s) => setBinanceOn(s.configured)).catch(() => {})
  }, [])

  const addRoutine = async () => {
    if (!rForm.asset_id || !(parseFloat(rForm.montant) > 0)) return
    try {
      await api.routineAdd(parseInt(rForm.asset_id, 10), parseFloat(rForm.montant),
        Math.min(31, Math.max(1, parseInt(rForm.jour, 10) || 1)))
      setRForm({ asset_id: '', montant: '', jour: '' })
      await loadRoutines(); await load()   // une échéance du jour s'applique aussitôt
    } catch (e) { setMsg(`Routine non créée : ${e.message}`) }
  }
  const removeRoutine = async (id) => {
    await api.routineDelete(id); await loadRoutines()
  }

  const total = (assets || []).reduce((s, a) => s + (a.valeur || 0), 0)

  // Suivi de croissance : actifs dont le prix d'achat est renseigné.
  const suivis = suiviTri.sortRows((assets || []).filter((a) => a.prix_achat), {
    nom: (a) => a.nom, investi: (a) => a.prix_achat, valeur: (a) => a.valeur,
    pv: (a) => a.plus_value, reel: (a) => a.perf_annuelle,
    vise: (a) => a.croissance_pct ?? a.croissance_classe ?? null,
  })
  const investi = suivis.reduce((s, a) => s + a.prix_achat, 0)
  const valeurSuivie = suivis.reduce((s, a) => s + (a.valeur || 0), 0)

  // Diversification géographique (champ pays libre ; vide -> Non renseigné).
  // Comptes courants exclus : liquidités de passage, pas une exposition pays.
  const horsCC = (assets || []).filter((a) => a.type !== 'compte_courant')
  const totalPays = horsCC.reduce((s, a) => s + (a.valeur || 0), 0)
  const parPays = Object.entries(horsCC.reduce((m, a) => {
    const p = (a.pays || '').trim() || 'Non renseigné'
    m[p] = (m[p] || 0) + (a.valeur || 0)
    return m
  }, {})).filter(([, v]) => v > 0)
    .map(([pays, valeur]) => ({ pays, valeur }))
    .sort((a, b) => b.valeur - a.valeur)
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
      prix_achat: parseFloat(form.prix_achat) || null,
      date_achat: form.date_achat || null,
      pays: (form.pays || '').trim(),
      croissance_pct: form.croissance_pct === '' ? null
        : parseFloat(form.croissance_pct),
    })
    setForm(blank); setResults([]); await load()
  }

  const edit = (a) => setForm({
    id: a.id, type: a.type, nom: a.nom,
    // ré-édition : on réaffiche la valeur UNITAIRE si une quantité est stockée
    valeur: !a.ticker && a.quantite
      ? +((a.valeur || 0) / a.quantite).toFixed(2) : (a.valeur ?? ''),
    quantite: a.quantite ?? '', ticker: a.ticker ?? '', commentaire: a.commentaire ?? '',
    prix_achat: a.prix_achat ?? '', date_achat: (a.date_achat || '').slice(0, 10),
    pays: a.pays ?? '', croissance_pct: a.croissance_pct ?? '',
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
      setMsg('Clés Binance enregistrées.')
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
            title={binanceOn ? '' : 'Clés Binance non configurées (carte en bas de page)'}>
            Synchroniser Binance{binanceOn ? '' : ' ⚠'}</button>
        </div>
      </div>

      {msg && <div className="banner" style={{ marginBottom: 16 }}>{msg}</div>}

      {/* Pyramide patrimoniale — étages alimentés par les actifs réels */}
      <div className="card" style={{ marginBottom: 18 }}>
        <h3>La pyramide patrimoniale</h3>
        <Pyramide assets={assets} />
      </div>

      <div className="grid cols-2">
        {/* Liste des actifs — groupés par classe, triés par poids */}
        <div className="card">
          <h3>Mes actifs</h3>
          {assets.length === 0
            ? <p className="muted">Aucun actif pour l'instant.</p>
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
                          {a.var_jour_pct != null ? (
                            <span className={a.var_jour_pct >= 0 ? 'pos' : 'neg'}
                              style={{ marginLeft: 6, fontSize: 12, fontFamily: 'var(--mono)' }}
                              title="Variation du jour">
                              {pct(a.var_jour_pct)} auj.
                            </span>
                          ) : null}
                          {a.source && a.source !== 'manuel'
                            ? <span className="src-tag" style={{ marginLeft: 6 }}>{a.source}</span> : null}
                          {a.prix_achat && !a.masque ? (
                            <span className={a.plus_value >= 0 ? 'pos' : 'neg'}
                              style={{ marginLeft: 6, fontSize: 12, fontFamily: 'var(--mono)' }}
                              title={`Investi : ${eur(a.prix_achat)}`}>
                              {a.plus_value >= 0 ? '+' : '−'}{eur(Math.abs(a.plus_value))}
                              {' '}({pct(a.perf_pct)})
                            </span>
                          ) : null}
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
                {useTicker ? 'Nom affiché (alias)'
                  : market === 'crypto' ? 'Crypto (recherche CoinGecko)'
                  : market === 'stock' ? 'Titre / ETF (recherche Yahoo)' : 'Nom'}</div>
              <input value={form.nom} style={{ width: '100%' }}
                placeholder={market === 'crypto' ? 'bitcoin, ethereum…'
                  : market === 'stock' ? 'Air Liquide, MSCI World…' : 'ex : Livret A'}
                onChange={(e) => market && !form.ticker ? searchMarket(e.target.value)
                  : setForm({ ...form, nom: e.target.value })} />
              {useTicker && (
                <p className="muted" style={{ fontSize: 11.5, margin: '4px 0 0' }}>
                  Titre suivi : <b>{form.ticker}</b> ·{' '}
                  <a style={{ cursor: 'pointer', textDecoration: 'underline' }}
                    onClick={() => { setForm({ ...form, ticker: '' }); setResults([]) }}>
                    changer de titre</a>
                </p>
              )}
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
                  Valeur € calculée au rafraîchissement des cours
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
              </div>
            )}

            <label>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                Commentaire <span style={{ opacity: .6 }}>(optionnel)</span></div>
              <textarea rows={2} value={form.commentaire} style={{ width: '100%' }}
                placeholder="ex : acheté en 2024, à réévaluer en fin d'année…"
                onChange={(e) => setForm({ ...form, commentaire: e.target.value })} />
            </label>

            {/* Suivi de croissance & diversification (tout est optionnel) */}
            <details open={!!(form.prix_achat || form.pays || form.croissance_pct)}>
              <summary className="muted" style={{ cursor: 'pointer', fontSize: 12.5 }}>
                Suivi de croissance & pays (optionnel)</summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
                <div className="row" style={{ gap: 10 }}>
                  <label style={{ flex: 1 }}>
                    <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                      Prix d'achat total (€)</div>
                    <input type="number" step="any" value={form.prix_achat}
                      style={{ width: '100%' }} placeholder="ex : 1500"
                      onChange={(e) => setForm({ ...form, prix_achat: e.target.value })} />
                  </label>
                  <label style={{ flex: 1 }}>
                    <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                      Date d'achat</div>
                    <input type="date" value={form.date_achat} style={{ width: '100%' }}
                      onChange={(e) => setForm({ ...form, date_achat: e.target.value })} />
                  </label>
                </div>
                <div className="row" style={{ gap: 10 }}>
                  <label style={{ flex: 1 }}>
                    <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                      Croissance visée (%/an)</div>
                    <input type="number" step="any" value={form.croissance_pct}
                      style={{ width: '100%' }}
                      placeholder={growth[form.type] != null
                        ? `classe : ${growth[form.type]}` : 'ex : 7'}
                      onChange={(e) => setForm({ ...form, croissance_pct: e.target.value })} />
                  </label>
                  <label style={{ flex: 1 }}>
                    <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                      Pays</div>
                    <input value={form.pays} style={{ width: '100%' }}
                      placeholder="ex : France, USA, Monde…"
                      onChange={(e) => setForm({ ...form, pays: e.target.value })} />
                  </label>
                </div>
              </div>
            </details>

            <div className="row" style={{ gap: 8 }}>
              <button className="btn primary" onClick={save}>
                {form.id ? 'Enregistrer' : 'Ajouter'}</button>
              {form.id && <button className="btn"
                onClick={() => { setForm(blank); setResults([]) }}>Annuler</button>}
            </div>
          </div>
        </div>
      </div>

      {/* Routines d'investissement : achats récurrents sur les actifs cotés */}
      {(routines.length > 0 || assets.some((a) => a.ticker)) && (
        <div className="card" style={{ marginTop: 18 }}>
          <h3>Routines d'investissement</h3>
          <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
            À chaque échéance, ce montant est investi au cours du jour : la quantité
            de parts et le prix d'achat de l'actif augmentent.
          </p>
          {routines.length > 0 && (
            <table style={{ marginBottom: 10 }}>
              <thead><tr>
                <th>Actif</th>
                <th style={{ textAlign: 'right' }}>Montant / mois</th>
                <th style={{ textAlign: 'right' }}>Jour du mois</th>
                <th>Prochaine échéance</th>
                <th />
              </tr></thead>
              <tbody>
                {routines.map((r) => (
                  <tr key={r.id}>
                    <td>{r.asset_nom} <span className="src-tag">{r.ticker}</span></td>
                    <td className="num">{eur(r.montant)}</td>
                    <td className="num">{r.jour}</td>
                    <td>{dateFr(r.prochain)}</td>
                    <td className="num" style={{ width: 1 }}>
                      <button className="btn ghost" style={{ color: 'var(--clay)' }}
                        onClick={() => removeRoutine(r.id)}>Suppr.</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <select value={rForm.asset_id} style={{ flex: 1, minWidth: 180 }}
              onChange={(e) => setRForm({ ...rForm, asset_id: e.target.value })}>
              <option value="">Actif coté…</option>
              {assets.filter((a) => a.ticker).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.nom} ({typeLabel[a.type] || a.type})
                  {a.commentaire ? ` — ${a.commentaire}` : ''}</option>
              ))}
            </select>
            <input type="number" step="any" min="0" placeholder="Montant €"
              value={rForm.montant} style={{ width: 110 }}
              onChange={(e) => setRForm({ ...rForm, montant: e.target.value })} />
            <label className="row" style={{ gap: 6 }}>
              <span className="muted" style={{ fontSize: 12 }}>le</span>
              <input type="number" min="1" max="31" placeholder="1"
                value={rForm.jour} style={{ width: 64, textAlign: 'right' }}
                onChange={(e) => setRForm({ ...rForm, jour: e.target.value })} />
              <span className="muted" style={{ fontSize: 12 }}>du mois</span>
            </label>
            <button className="btn primary" onClick={addRoutine}>Ajouter</button>
          </div>
        </div>
      )}

      {/* Croissance visée par classe : héritée par les actifs de la classe */}
      {assets.length > 0 && (
        <div className="card" style={{ marginTop: 18 }}>
          <h3>Croissance visée par classe d'actif</h3>
          <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
            Utilisée par le patrimoine projeté ; la croissance propre d'un actif prime.
          </p>
          <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
            {groupAssets(assets)
              .filter((g) => g.type !== 'compte_courant')
              .map((g) => (
                <label key={g.type} className="row" style={{ gap: 8 }}>
                  <span className="swatch" style={{ width: 10, height: 10,
                    borderRadius: 3, background: classColor(g.type) }} />
                  <span style={{ fontSize: 13 }}>{typeLabel[g.type] || g.type}</span>
                  <input type="number" step="any" placeholder="0"
                    key={`${g.type}:${growth[g.type] ?? ''}`}
                    defaultValue={growth[g.type] ?? ''}
                    style={{ width: 72, textAlign: 'right' }}
                    onBlur={(e) => (parseFloat(e.target.value) || null)
                      !== (growth[g.type] ?? null) && saveGrowth(g.type, e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} />
                  <span className="muted" style={{ fontSize: 12 }}>%/an</span>
                </label>
              ))}
          </div>
        </div>
      )}

      {/* Croissance des actifs : investi vs valeur, %/an réel vs visé */}
      {suivis.length > 0 && (
        <div className="card" style={{ marginTop: 18 }}>
          <h3>Croissance des actifs</h3>
          <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
            Investi : <b>{eur(investi)}</b> · valeur actuelle :{' '}
            <b>{eur(valeurSuivie)}</b> · plus-value :{' '}
            <b className={valeurSuivie - investi >= 0 ? 'pos' : 'neg'}>
              {valeurSuivie - investi >= 0 ? '+' : '−'}{eur(Math.abs(valeurSuivie - investi))}
            </b>
          </p>
          <table>
            <thead><tr>
              <th className="sortable" onClick={() => suiviTri.toggle('nom', 1)}>
                Actif{arrow(suiviTri.tri, 'nom')}</th>
              <th className="sortable" style={{ textAlign: 'right' }}
                onClick={() => suiviTri.toggle('investi')}>Investi{arrow(suiviTri.tri, 'investi')}</th>
              <th className="sortable" style={{ textAlign: 'right' }}
                onClick={() => suiviTri.toggle('valeur')}>Valeur{arrow(suiviTri.tri, 'valeur')}</th>
              <th className="sortable" style={{ textAlign: 'right' }}
                onClick={() => suiviTri.toggle('pv')}>Plus-value{arrow(suiviTri.tri, 'pv')}</th>
              <th className="sortable" style={{ textAlign: 'right' }}
                title="Croissance annualisée réelle depuis la date d'achat"
                onClick={() => suiviTri.toggle('reel')}>Réel %/an{arrow(suiviTri.tri, 'reel')}</th>
              <th className="sortable" style={{ textAlign: 'right' }}
                title="Croissance visée (actif, sinon classe)"
                onClick={() => suiviTri.toggle('vise')}>Visé %/an{arrow(suiviTri.tri, 'vise')}</th></tr></thead>
            <tbody>
              {suivis.map((a) => (
                <tr key={a.id}>
                  <td>{a.nom}</td>
                  <td className="num">{a.masque ? '••••' : eur(a.prix_achat)}</td>
                  <td className="num">{eurAsset(a)}</td>
                  <td className={'num ' + (a.plus_value >= 0 ? 'pos' : 'neg')}>
                    {a.masque ? '••••' : <>{a.plus_value >= 0 ? '+' : '−'}
                      {eur(Math.abs(a.plus_value))} ({pct(a.perf_pct)})</>}</td>
                  <td className={'num ' + (a.perf_annuelle == null ? 'muted'
                    : a.perf_annuelle >= 0 ? 'pos' : 'neg')}>
                    {a.perf_annuelle == null ? '—' : pct(a.perf_annuelle)}</td>
                  <td className="num muted">
                    {a.croissance_pct != null ? pct(a.croissance_pct)
                      : a.croissance_classe != null
                        ? <>{pct(a.croissance_classe)} <span style={{ opacity: .65 }}>(classe)</span></>
                        : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
            « Réel %/an » : nécessite une date d'achat et ≥ 30 jours de détention.
          </p>
        </div>
      )}

      {/* Diversification par pays */}
      {parPays.length > 0 && parPays.some((p) => p.pays !== 'Non renseigné') && (
        <div className="card" style={{ marginTop: 18 }}>
          <h3>Diversification par pays</h3>
          <div className="allocbar" style={{ marginTop: 4 }}>
            {parPays.map((p, i) => (
              <span key={p.pays} title={`${p.pays} · ${eur(p.valeur)}`}
                style={{ width: `${(p.valeur / totalPays) * 100}%`,
                         background: PAYS_COLORS[i % PAYS_COLORS.length] }} />
            ))}
          </div>
          <div className="alloc-legend">
            {parPays.map((p, i) => (
              <div className="item" key={p.pays}>
                <span className="swatch"
                  style={{ background: PAYS_COLORS[i % PAYS_COLORS.length] }} />
                <span>{p.pays}</span>
                <span className="val">{eur(p.valeur)}</span>
                <span className="pct">{Math.round((p.valeur / totalPays) * 100)}%</span>
              </div>
            ))}
          </div>
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
            Hors comptes courants.
          </p>
        </div>
      )}

      {/* Connexion Binance (lecture seule) */}
      <div className="card" style={{ marginTop: 18 }}>
        <h3>Connexion Binance (lecture seule)</h3>
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          Clé API avec la <b>seule</b> permission « Read Info » (aucun retrait,
          aucun trade), stockée localement.
        </p>
        {binanceOn && (
          <div className="banner" style={{ marginBottom: 12 }}>
            ✓ Binance connecté.
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
