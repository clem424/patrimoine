import React, { useEffect, useMemo, useState } from 'react'
import { api, eur, dateFr } from '../lib/api.js'
import { Download, Check, Refund } from './icons.jsx'

// État de vérification d'une opération : vide (non catégorisée),
// auto (catégorie posée par règle/cache/Ollama, à vérifier), ok (confirmée).
const etat = (t) => t.categorie === 'Non catégorisé' ? 'vide'
  : t.categorized_by === 'manual' ? 'ok' : 'auto'

const PERIODES = [
  { id: 'semaine', label: 'Semaine' },
  { id: 'mois', label: 'Mois' },
  { id: 'annee', label: 'Année' },
  { id: 'toujours', label: 'Toujours' },
]

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// Fenêtre calendaire [debut, fin] (ISO, inclusifs) — même logique que le dashboard.
function bounds(periode, dec) {
  const today = new Date()
  if (periode === 'semaine') {
    const lundi = new Date(today)
    lundi.setDate(today.getDate() - ((today.getDay() + 6) % 7) + dec * 7)
    const fin = new Date(lundi); fin.setDate(lundi.getDate() + 6)
    return [iso(lundi), iso(fin)]
  }
  if (periode === 'mois') {
    const d = new Date(today.getFullYear(), today.getMonth() + dec, 1)
    const f = new Date(today.getFullYear(), today.getMonth() + dec + 1, 0)
    return [iso(d), iso(f)]
  }
  if (periode === 'annee') {
    const y = today.getFullYear() + dec
    return [`${y}-01-01`, `${y}-12-31`]
  }
  return [null, null]
}

function periodeLabel(periode, debut, fin) {
  if (!debut) return 'Toutes les opérations'
  if (periode === 'annee') return debut.slice(0, 4)
  if (periode === 'mois')
    return new Date(debut).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })
  const f = (s) => new Date(s).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
  return `${f(debut)} → ${f(fin)} ${fin.slice(0, 4)}`
}

export default function Transactions({ onChange }) {
  const [tx, setTx] = useState(null)
  const [cats, setCats] = useState([])
  const [fSource, setFSource] = useState('tous')
  const [fCat, setFCat] = useState('toutes')
  const [fSens, setFSens] = useState('tout')      // tout | depenses | revenus
  const [fConf, setFConf] = useState('tout')      // tout | a_verifier | ok
  const [fDu, setFDu] = useState(false)           // ne montrer que l'« à rembourser »
  const [tri, setTri] = useState({ key: 'date', dir: -1 })   // -1 = décroissant
  // Modifications du dernier réexamen (persistées : contrôlables même après reload)
  const [mods, setMods] = useState(() => {
    try { return JSON.parse(localStorage.getItem('recat_mods'))?.mods || null }
    catch { return null }
  })
  const [fMods, setFMods] = useState(false)       // ne montrer que les modifiées
  const modMap = useMemo(() => new Map((mods || []).map((m) => [m.op_id, m])), [mods])
  const clearMods = () => {
    localStorage.removeItem('recat_mods'); setMods(null); setFMods(false)
  }
  const [periode, setPeriode] = useState('mois')
  const [dec, setDec] = useState(0)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  const load = () => api.transactions(10000).then(setTx)
  useEffect(() => { load(); api.categories().then(setCats) }, [])

  const sources = useMemo(
    () => [...new Set((tx || []).map((t) => t.source))], [tx])

  // Catégories triées alphabétiquement pour tous les selects de la page.
  const catsTriees = useMemo(
    () => [...cats].sort((a, b) => a.localeCompare(b, 'fr')), [cats])

  // Total « à rembourser » (toutes périodes confondues) : ce qu'on te doit.
  const du = useMemo(() => {
    const items = (tx || []).filter((t) => t.a_rembourser)
    return { n: items.length,
             total: items.reduce((s, t) => s + Math.abs(t.montant), 0) }
  }, [tx])

  const [debut, fin] = bounds(periode, dec)

  const rows = useMemo(() => (tx || []).filter((t) => {
    const jour = t.date.slice(0, 10)
    return (!debut || jour >= debut) && (!fin || jour <= fin) &&
      (fSource === 'tous' || t.source === fSource) &&
      (fCat === 'toutes' || t.categorie === fCat) &&
      (fSens === 'tout' || (fSens === 'depenses' ? t.montant < 0 : t.montant >= 0)) &&
      (fConf === 'tout' || (fConf === 'ok' ? etat(t) === 'ok' : etat(t) !== 'ok')) &&
      (!fDu || t.a_rembourser) &&
      (!fMods || modMap.has(t.op_id)) &&
      (!q || t.libelle.toLowerCase().includes(q.toLowerCase()))
  }).sort((a, b) => {
    if (tri.key === 'date')
      return (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) * tri.dir
    if (tri.key === 'montant')   // « prix » = valeur absolue : grosses sommes ensemble
      return (Math.abs(a.montant) - Math.abs(b.montant)) * tri.dir
    // texte (catégorie, libellé) : alphabétique, puis date récente à égalité
    return a[tri.key].localeCompare(b[tri.key], 'fr') * tri.dir
      || (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)
  }), [tx, debut, fin, fSource, fCat, fSens, fConf, fDu, fMods, modMap, q, tri])

  // Synthèse de la sélection courante : entrées / sorties / net.
  const totaux = useMemo(() => {
    let entrees = 0, sorties = 0
    for (const t of rows) t.montant >= 0 ? entrees += t.montant : sorties -= t.montant
    return { entrees, sorties, net: entrees - sorties }
  }, [rows])

  const recat = async (op_id, categorie) => {
    await api.setCategory(op_id, categorie)
    setTx((prev) => prev.map((t) => t.op_id === op_id
      ? { ...t, categorie, categorized_by: 'manual' } : t))
  }

  const toggleDue = async (t) => {
    const v = !t.a_rembourser
    try {
      await api.setDue(t.op_id, v)
      setTx((prev) => prev.map((x) => x.op_id === t.op_id
        ? { ...x, a_rembourser: v ? 1 : 0 } : x))
    } catch (e) { setMsg(e.message) }
  }

  // Confirme (ou remet « à vérifier ») la catégorie proposée, sans la changer.
  const confirm = async (t) => {
    const v = etat(t) !== 'ok'
    try {
      await api.confirmTx(t.op_id, v)
      setTx((prev) => prev.map((x) => x.op_id === t.op_id
        ? { ...x, categorized_by: v ? 'manual' : 'auto' } : x))
    } catch (e) { setMsg(e.message) }
  }

  // Réexamen des non-confirmées avec l'apprentissage à jour (corrections + few-shot).
  const reCat = async () => {
    setBusy(true)
    setMsg('Réexamen des opérations non confirmées avec tes corrections… (peut prendre plusieurs minutes)')
    try {
      const r = await api.recategorize()
      setMsg(`${r.examinees} réexaminées · ${r.modifiees} modifiée${r.modifiees > 1 ? 's' : ''}`
        + ` · ${r.inchangees} inchangées`
        + (r.reste ? ` · ${r.reste} restantes — relance pour continuer` : ''))
      if (r.modifications?.length) {
        localStorage.setItem('recat_mods',
          JSON.stringify({ ts: Date.now(), mods: r.modifications }))
        setMods(r.modifications); setFMods(true)
        setPeriode('toujours'); setDec(0)   // les modifiées peuvent être anciennes
      }
      await load()
    } catch {
      setMsg('Ollama injoignable. Vérifie qu\'il tourne sur le Pi.')
    } finally { setBusy(false) }
  }

  const autoCat = async () => {
    setBusy(true); setMsg('Catégorisation en cours (Ollama)…')
    try {
      const r = await api.categorize(true)
      const det = r.detail || {}
      setMsg(`${r.traitees} traitées · ${det.rule || 0} par règles · ${det.ollama || 0} par Ollama · ${det.none || 0} restantes`)
      await load()
    } catch {
      setMsg('Ollama injoignable. Vérifie qu\'il tourne (ollama serve) sur le Pi.')
    } finally { setBusy(false) }
  }

  if (!tx) return <div className="row" style={{ padding: 40 }}><span className="spinner" /></div>

  return (
    <>
      <div className="page-head row between">
        <div>
          <h1>Opérations</h1>
          <p style={{ textTransform: 'capitalize' }}>{periodeLabel(periode, debut, fin)}
            <span style={{ textTransform: 'none' }}> · {rows.length} opération{rows.length > 1 ? 's' : ''}</span></p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" title="Télécharger toutes les opérations (CSV Excel)"
            onClick={() => api.exportCsv().catch((e) => setMsg(e.message))}>
            <Download /> Exporter</button>
          <button className="btn" onClick={reCat} disabled={busy}
            title="Réexamine les opérations non confirmées (✓) en s'appuyant sur tes corrections — ce que tu as validé n'est jamais touché">
            {busy ? '…' : 'Recatégoriser (non confirmées)'}
          </button>
          <button className="btn primary" onClick={autoCat} disabled={busy}>
            {busy ? '…' : 'Catégoriser automatiquement'}
          </button>
        </div>
      </div>

      {msg && <div className="banner" style={{ marginBottom: 16 }}>{msg}</div>}

      {/* Contrôle du dernier réexamen : retrouver exactement ce qu'il a changé */}
      {mods?.length > 0 && (
        <div className="banner warn" style={{ marginBottom: 16, display: 'flex',
          alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span>Dernier réexamen : <b>{mods.length} catégorie{mods.length > 1 ? 's' : ''}
            {' '}modifiée{mods.length > 1 ? 's' : ''}</b> — l'ancienne catégorie est
            affichée sous chaque opération concernée.</span>
          <span className="row" style={{ gap: 8, marginLeft: 'auto' }}>
            <button className={'btn' + (fMods ? ' primary' : '')}
              onClick={() => {
                const v = !fMods
                setFMods(v)
                if (v) { setPeriode('toujours'); setDec(0) }
              }}>
              {fMods ? 'Revoir toute la liste' : 'Ne voir que les modifiées'}</button>
            <button className="btn ghost" title="J'ai fini de contrôler — oublier ce réexamen"
              onClick={clearMods}>Fermer</button>
          </span>
        </div>
      )}

      <div className="card">
        {/* Période : semaine / mois / année / toujours + navigation ‹ › */}
        <div className="row" style={{ gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <div className="seg">
            {PERIODES.map((p) => (
              <button key={p.id} className={periode === p.id ? 'on' : ''}
                onClick={() => { setPeriode(p.id); setDec(0) }}>{p.label}</button>
            ))}
          </div>
          {periode !== 'toujours' && (
            <div className="seg">
              <button onClick={() => setDec((x) => x - 1)} title="Période précédente">‹</button>
              <button onClick={() => setDec((x) => Math.min(0, x + 1))}
                disabled={dec === 0} title="Période suivante">›</button>
            </div>
          )}
          {/* Synthèse de la sélection */}
          <span className="muted" style={{ fontSize: 12.5, marginLeft: 'auto',
            fontFamily: 'var(--mono)' }}>
            <span className="pos">+{eur(totaux.entrees)}</span>
            {' · '}<span className="neg">−{eur(totaux.sorties)}</span>
            {' · net '}<b className={totaux.net >= 0 ? 'pos' : 'neg'}>
              {totaux.net >= 0 ? '+' : '−'}{eur(Math.abs(totaux.net))}</b>
          </span>
        </div>

        <div className="row" style={{ gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
          <input placeholder="Rechercher un libellé…" value={q}
            onChange={(e) => setQ(e.target.value)} style={{ minWidth: 220 }} />
          <select value={fSource} onChange={(e) => setFSource(e.target.value)}>
            <option value="tous">Toutes les banques</option>
            {sources.map((s) => <option key={s}>{s}</option>)}
          </select>
          <select value={fCat} onChange={(e) => setFCat(e.target.value)}>
            <option value="toutes">Toutes catégories</option>
            {catsTriees.map((c) => <option key={c}>{c}</option>)}
          </select>
          <select value={fSens} onChange={(e) => setFSens(e.target.value)}>
            <option value="tout">Dépenses + revenus</option>
            <option value="depenses">Dépenses seules</option>
            <option value="revenus">Revenus seuls</option>
          </select>
          <select value={fConf} onChange={(e) => setFConf(e.target.value)}>
            <option value="tout">Vérifiées ou non</option>
            <option value="a_verifier">À vérifier</option>
            <option value="ok">Confirmées ✓</option>
          </select>
          <select value={fDu ? 'du' : 'tout'}
            onChange={(e) => {
              const v = e.target.value === 'du'
              setFDu(v)
              if (v) { setPeriode('toujours'); setDec(0) }  // aucune dette ne doit échapper à la liste
            }}>
            <option value="tout">Remboursements : tout</option>
            <option value="du">À rembourser ↩</option>
          </select>
          {(du.n > 0 || fDu) && (
            <button className={'btn' + (fDu ? ' primary' : '')}
              title={fDu ? 'Revoir toutes les opérations'
                : `${du.n} dépense${du.n > 1 ? 's' : ''} en attente de remboursement — cliquer pour les voir`}
              onClick={() => {
                const v = !fDu
                setFDu(v)
                if (v) { setPeriode('toujours'); setDec(0) }
              }}>
              <Refund /> À rembourser · {eur(du.total)}
            </button>
          )}
        </div>

        <table>
          <thead>
            <tr>
              <th className="sortable" title="Trier par date"
                onClick={() => setTri((t) => ({ key: 'date', dir: t.key === 'date' ? -t.dir : -1 }))}>
                Date{tri.key === 'date' ? (tri.dir === -1 ? ' ▼' : ' ▲') : ''}</th>
              <th className="sortable" title="Trier par libellé"
                onClick={() => setTri((t) => ({ key: 'libelle', dir: t.key === 'libelle' ? -t.dir : 1 }))}>
                Libellé{tri.key === 'libelle' ? (tri.dir === 1 ? ' ▲' : ' ▼') : ''}</th>
              <th>Source</th>
              <th className="sortable" title="Trier par catégorie"
                onClick={() => setTri((t) => ({ key: 'categorie', dir: t.key === 'categorie' ? -t.dir : 1 }))}>
                Catégorie{tri.key === 'categorie' ? (tri.dir === 1 ? ' ▲' : ' ▼') : ''}</th>
              <th className="sortable" style={{ textAlign: 'right' }} title="Trier par montant"
                onClick={() => setTri((t) => ({ key: 'montant', dir: t.key === 'montant' ? -t.dir : -1 }))}>
                Montant{tri.key === 'montant' ? (tri.dir === -1 ? ' ▼' : ' ▲') : ''}</th>
              <th title="Catégorie vérifiée ?" style={{ textAlign: 'center' }}>✓</th>
              <th title="À te faire rembourser ?" style={{ textAlign: 'center' }}>Dû</th></tr>
          </thead>
          <tbody>
            {rows.slice(0, 400).map((t) => {
              const e = etat(t)
              return (
                <tr key={t.op_id} className={'tx-' + e}
                  title={e === 'vide' ? undefined
                    : e === 'ok' ? 'Cliquer pour repasser « à vérifier »'
                    : 'Cliquer pour confirmer la catégorie'}
                  onClick={(ev) => {
                    // un clic sur le select ou un bouton garde son comportement propre
                    if (e !== 'vide' && !ev.target.closest('select, button')) confirm(t)
                  }}>
                  <td className="num muted" style={{ textAlign: 'left' }}>
                    {dateFr(t.date)}</td>
                  <td className="lib">{t.libelle}
                    {t.a_rembourser ? <span className="due-pill">à rembourser</span> : null}</td>
                  <td><span className="src-tag">{t.source}</span></td>
                  <td>
                    <select value={t.categorie} className={'cat-' + e}
                      onChange={(ev) => recat(t.op_id, ev.target.value)}>
                      {catsTriees.map((c) => <option key={c}>{c}</option>)}
                    </select>
                    {modMap.has(t.op_id) && (
                      <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                        avant : {modMap.get(t.op_id).avant}</div>
                    )}
                  </td>
                  <td className={'num ' + (t.montant >= 0 ? 'pos' : 'neg')}>
                    {t.montant >= 0 ? '+' : '−'}{eur(Math.abs(t.montant))}
                  </td>
                  <td style={{ textAlign: 'center', width: 34 }}>
                    <button className={'confirm-btn' + (e === 'ok' ? ' on' : '')}
                      disabled={e === 'vide'} onClick={() => confirm(t)}
                      title={e === 'vide' ? 'Catégorise d\'abord cette opération'
                        : e === 'ok' ? 'Catégorie confirmée — cliquer pour repasser « à vérifier »'
                        : 'Confirmer cette catégorie'}>
                      <Check size={16} />
                    </button>
                  </td>
                  <td style={{ textAlign: 'center', width: 34 }}>
                    {t.montant < 0 && (
                      <button className={'due-btn' + (t.a_rembourser ? ' on' : '')}
                        onClick={() => toggleDue(t)}
                        title={t.a_rembourser
                          ? 'Remboursé — cliquer pour retirer le suivi'
                          : 'Marquer « à rembourser » (on te doit cette dépense)'}>
                        <Refund size={15} />
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {rows.length === 0 &&
          <p className="muted" style={{ padding: '24px 0', textAlign: 'center' }}>
            Aucune opération sur cette période avec ces filtres.</p>}
        {rows.length > 400 &&
          <p className="muted" style={{ marginTop: 12 }}>
            400 premières affichées — affine avec les filtres.</p>}
      </div>
    </>
  )
}
