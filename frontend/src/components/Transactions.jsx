import React, { useEffect, useMemo, useState } from 'react'
import { api, eur, dateFr } from '../lib/api.js'
import { Download, Check, Refund, Link } from './icons.jsx'

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

  // Groupes de remboursement : N virements reçus remboursent N dépenses
  // (mois différents acceptés). Sélection par « panier » : clique 🔗 sur
  // chaque opération concernée, puis « Lier ». Même prorata que le backend :
  // les virements s'effacent, les dépenses sont réduites au prorata.
  const [panier, setPanier] = useState(() => new Set())
  const [fLie, setFLie] = useState(false)        // ne montrer que les liées
  const liens = useMemo(() => {
    const groupes = new Map()
    for (const t of tx || []) {
      if (!t.lien_groupe) continue
      if (!groupes.has(t.lien_groupe)) groupes.set(t.lien_groupe, [])
      groupes.get(t.lien_groupe).push(t)
    }
    // net : op_id -> {montant net, rembourse?, drop?} ; partenaires : tooltip
    const net = new Map(), partenaires = new Map()
    let n = 0
    for (const items of groupes.values()) {
      const virements = items.filter((t) => t.montant > 0)
        .sort((a, b) => b.montant - a.montant)
      const depenses = items.filter((t) => t.montant < 0)
      if (!virements.length || !depenses.length) continue
      n += items.length
      const recu = virements.reduce((s, t) => s + t.montant, 0)
      const du = depenses.reduce((s, t) => s - t.montant, 0)
      const utilise = Math.min(recu, du)
      for (const t of items)
        partenaires.set(t.op_id, items.filter((x) => x.op_id !== t.op_id)
          .map((x) => x.libelle).join(' · '))
      for (const t of depenses) {
        const part = utilise * (-t.montant) / du
        net.set(t.op_id, { montant: t.montant + part, rembourse: part })
      }
      const reste = recu - utilise
      virements.forEach((t, i) => net.set(t.op_id,
        i === 0 && reste > 0 ? { montant: reste, reste: true } : { drop: true }))
    }
    return { net, partenaires, n }
  }, [tx])

  const togglePanier = (t) => setPanier((prev) => {
    const next = new Set(prev)
    next.has(t.op_id) ? next.delete(t.op_id) : next.add(t.op_id)
    return next
  })
  const lierPanier = async () => {
    try {
      const r = await api.lierOps([...panier])
      setPanier(new Set())
      setMsg(`${r.n} opérations liées — les stats comptent maintenant le net.`)
      await load()
    } catch (e) { setMsg(e.message) }
  }
  const delier = async (t) => {
    try { await api.delierOp(t.op_id); await load() } catch (e) { setMsg(e.message) }
  }

  const txById = useMemo(() => new Map((tx || []).map((t) => [t.op_id, t])), [tx])
  // Aperçu du panier : sélection valide = au moins 1 dépense + 1 virement reçu.
  const panierInfo = useMemo(() => {
    const items = [...panier].map((id) => txById.get(id)).filter(Boolean)
    const recu = items.filter((t) => t.montant > 0).reduce((s, t) => s + t.montant, 0)
    const paye = items.filter((t) => t.montant < 0).reduce((s, t) => s - t.montant, 0)
    return { items, recu, paye, net: paye - recu,
             valide: items.length >= 2 && recu > 0 && paye > 0 }
  }, [panier, txById])

  const [debut, fin] = bounds(periode, dec)

  const rows = useMemo(() => (tx || []).filter((t) => {
    const jour = t.date.slice(0, 10)
    return (!debut || jour >= debut) && (!fin || jour <= fin) &&
      (fSource === 'tous' || t.source === fSource) &&
      (fCat === 'toutes' || t.categorie === fCat) &&
      (fSens === 'tout' || (fSens === 'depenses' ? t.montant < 0 : t.montant >= 0)) &&
      (fConf === 'tout' || (fConf === 'ok' ? etat(t) === 'ok' : etat(t) !== 'ok')) &&
      (!fDu || t.a_rembourser) &&
      (!fLie || t.lien_groupe) &&
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
  }), [tx, debut, fin, fSource, fCat, fSens, fConf, fDu, fLie, liens, fMods, modMap, q, tri])

  // Synthèse de la sélection courante : entrées / sorties / net, en montants
  // NETS (virements liés effacés, dépenses liées réduites au prorata).
  const totaux = useMemo(() => {
    let entrees = 0, sorties = 0
    for (const t of rows) {
      const a = liens.net.get(t.op_id)
      if (a?.drop) continue
      const m = a ? a.montant : t.montant
      m >= 0 ? entrees += m : sorties -= m
    }
    return { entrees, sorties, net: entrees - sorties }
  }, [rows, liens])

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

      {/* Panier de liaison : ajoute autant de dépenses et de virements reçus
          que tu veux (mois différents ok), puis « Lier ». */}
      {panier.size > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
            <h3 style={{ marginBottom: 0 }}>
              Lier des opérations · {panierInfo.items.length} sélectionnée{panierInfo.items.length > 1 ? 's' : ''}</h3>
            <span className="row" style={{ gap: 8 }}>
              <button className="btn primary" onClick={lierPanier}
                disabled={!panierInfo.valide}
                title={panierInfo.valide ? 'Créer le groupe de remboursement'
                  : 'Il faut au moins une dépense ET un virement reçu'}>
                Lier {panierInfo.items.length} opérations</button>
              <button className="btn ghost" onClick={() => setPanier(new Set())}>
                Vider</button>
            </span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '10px 0' }}>
            {panierInfo.items.map((t) => (
              <button key={t.op_id} className="btn" style={{ fontSize: 12 }}
                onClick={() => togglePanier(t)} title="Retirer de la sélection">
                {dateFr(t.date)} · {t.libelle.slice(0, 34)}{t.libelle.length > 34 ? '…' : ''}
                {' '}<b className={t.montant >= 0 ? 'pos' : 'neg'}>
                  {t.montant >= 0 ? '+' : '−'}{eur(Math.abs(t.montant))}</b> ✕
              </button>
            ))}
          </div>
          <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
            {panierInfo.valide
              ? <>Dépensé <b className="neg">−{eur(panierInfo.paye)}</b> · remboursé{' '}
                  <b className="pos">+{eur(panierInfo.recu)}</b> → les stats compteront{' '}
                  <b>{panierInfo.net >= 0 ? '−' : '+'}{eur(Math.abs(panierInfo.net))}</b>,
                  réparti sur les dépenses au prorata.</>
              : <>Ajoute encore {panierInfo.paye <= 0 ? 'une dépense' : 'un virement reçu'}
                  {' '}avec l'icône 🔗 (utilise la recherche et les filtres — toutes
                  les périodes sont acceptées).</>}
          </p>
        </div>
      )}

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
          {(liens.n > 0 || fLie) && (
            <button className={'btn' + (fLie ? ' primary' : '')}
              title={fLie ? 'Revoir toutes les opérations'
                : 'Voir les dépenses remboursées et leurs virements liés'}
              onClick={() => {
                const v = !fLie
                setFLie(v)
                if (v) { setPeriode('toujours'); setDec(0) }  // les liens traversent les mois
              }}>
              <Link /> Liées · {liens.n}
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
              <th title="Dépense : à te faire rembourser ? · Virement reçu : lier à la dépense qu'il rembourse"
                style={{ textAlign: 'center' }}>Dû</th></tr>
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
                    {t.a_rembourser ? <span className="due-pill">à rembourser</span> : null}
                    {t.lien_groupe ? <span className="due-pill"
                      title={`Groupe de remboursement, avec : ${liens.partenaires.get(t.op_id) || '(incomplet)'}`}>
                      lié ↩</span> : null}</td>
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
                  <td className="num">
                    {(() => {
                      const a = liens.net.get(t.op_id)
                      // virement absorbé par le groupe : neutralisé
                      if (a?.drop) return (
                        <span className="muted" style={{ textDecoration: 'line-through' }}
                          title="Compté dans le net des dépenses du groupe">
                          +{eur(t.montant)}</span>)
                      // virement partiellement utilisé : il en reste en revenu
                      if (a?.reste) return <>
                        <span className="pos">+{eur(a.montant)}</span>
                        <div className="muted" style={{ fontSize: 11 }}>
                          sur +{eur(t.montant)} reçus (le reste rembourse le groupe)</div>
                      </>
                      // dépense remboursée : le paiement « passe » au net (50 → 25)
                      if (a) return <>
                        <span className={a.montant >= 0 ? 'pos' : 'neg'}>
                          {a.montant >= 0 ? '+' : '−'}{eur(Math.abs(a.montant))}</span>
                        <div className="muted" style={{ fontSize: 11 }}>
                          payé −{eur(Math.abs(t.montant))}, remboursé +{eur(a.rembourse)}</div>
                      </>
                      return (
                        <span className={t.montant >= 0 ? 'pos' : 'neg'}>
                          {t.montant >= 0 ? '+' : '−'}{eur(Math.abs(t.montant))}</span>)
                    })()}
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
                  <td style={{ textAlign: 'center', whiteSpace: 'nowrap', width: 1 }}>
                    {t.montant < 0 && (
                      <button className={'due-btn' + (t.a_rembourser ? ' on' : '')}
                        onClick={() => toggleDue(t)}
                        title={t.a_rembourser
                          ? 'Remboursé — cliquer pour retirer le suivi'
                          : 'Marquer « à rembourser » (on te doit cette dépense)'}>
                        <Refund size={15} />
                      </button>
                    )}
                    <button
                      className={'due-btn' + (t.lien_groupe || panier.has(t.op_id) ? ' on' : '')}
                      onClick={() => t.lien_groupe ? delier(t) : togglePanier(t)}
                      title={t.lien_groupe
                        ? `Lié avec : ${liens.partenaires.get(t.op_id) || '?'} — cliquer pour retirer cette opération du groupe`
                        : panier.has(t.op_id)
                          ? 'Retirer de la sélection à lier'
                          : 'Ajouter à la sélection à lier (dépenses ↔ virements reçus, mois différents ok)'}>
                      <Link size={15} />
                    </button>
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
