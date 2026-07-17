import React, { useEffect, useState } from 'react'
import { api, eur, eur0 } from '../lib/api.js'
import { useSort, arrow } from '../lib/useSort.js'

// Catégories qui ne sont pas des dépenses : pas de budget possible dessus.
const SANS_BUDGET = ['Revenus', 'Virements internes', 'Non catégorisé', 'Épargne']

function moisStr(decalage) {
  const d = new Date()
  d.setDate(1); d.setMonth(d.getMonth() + decalage)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
const moisLabel = (m) => new Date(m + '-01')
  .toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })

export default function Budget({ onChange }) {
  const [dec, setDec] = useState(0)
  const [cats, setCats] = useState([])
  const [status, setStatus] = useState(null)     // budgets + dépenses du mois
  const [depenses, setDepenses] = useState(null) // dépenses par catégorie du mois
  const [draft, setDraft] = useState({})         // saisies en cours {cat: '250'}
  const [revDraft, setRevDraft] = useState(null) // saisie du revenu estimé
  const { tri, toggle, sortRows } = useSort('categorie', 1)

  const saveRevenu = async () => {
    if (revDraft === null) return
    const val = parseFloat(String(revDraft).replace(',', '.'))
    await api.revenuSet(isNaN(val) ? 0 : val)
    setRevDraft(null)
    await load()
  }

  const mois = moisStr(dec)

  const load = () => Promise.all([
    api.budgetGet(mois), api.depenses('mois', dec),
  ]).then(([b, d]) => { setStatus(b); setDepenses(d) })

  useEffect(() => { api.categories().then(setCats) }, [])
  useEffect(() => { load() }, [dec])

  if (!status || !depenses) return (
    <div className="row" style={{ padding: 40 }}><span className="spinner" /></div>)

  const budgets = Object.fromEntries(status.lignes.map((l) => [l.categorie, l.budget]))
  const spent = Object.fromEntries(depenses.categories.map((c) => [c.categorie, c.montant]))
  const rows = sortRows(
    cats.filter((c) => !SANS_BUDGET.includes(c))
      .map((c) => ({ categorie: c, budget: budgets[c] ?? null, depense: spent[c] ?? 0 })),
    { categorie: (r) => r.categorie, budget: (r) => r.budget,
      depense: (r) => r.depense,
      reste: (r) => r.budget != null ? r.budget - r.depense : null })

  const save = async (cat) => {
    if (!(cat in draft)) return
    const val = parseFloat(String(draft[cat]).replace(',', '.'))
    await api.budgetSet(cat, isNaN(val) ? 0 : val)
    setDraft((d) => { const { [cat]: _, ...rest } = d; return rest })
    await load()
  }

  const totalBudget = status.budget_total
  const totalDep = rows.reduce((s, r) => s + (r.budget != null ? r.depense : 0), 0)
  const ok = totalDep <= totalBudget

  // Revenu estimé -> reste à dépenser (réel) et épargne prévue (si budgets tenus).
  const revenu = status.revenu || 0
  const depMois = totalDep + (status.hors_budget || 0)   // toutes dépenses du mois
  const reste = revenu - depMois
  const epargnePrevue = revenu - totalBudget
  // Barre de répartition du revenu : dépensé | budget restant engagé | libre
  const segDep = Math.min(depMois, revenu)
  const segEngage = Math.max(0, Math.min(totalBudget - depMois, revenu - segDep))
  const segLibre = Math.max(0, revenu - segDep - segEngage)

  return (
    <>
      <div className="page-head row between">
        <div>
          <h1>Budget prévisionnel</h1>
          <p>Plafond mensuel par catégorie, suivi mois par mois.</p>
        </div>
        <div className="seg">
          <button onClick={() => setDec((x) => x - 1)} title="Mois précédent">‹</button>
          <button className="on" style={{ cursor: 'default', textTransform: 'capitalize' }}>
            {moisLabel(mois)}</button>
          <button onClick={() => setDec((x) => Math.min(0, x + 1))}
            disabled={dec === 0} title="Mois suivant">›</button>
        </div>
      </div>

      {/* Revenu mensuel estimé -> reste à dépenser calculé automatiquement */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>Revenu mensuel estimé</h3>
          <input type="number" step="50" min="0" placeholder="ex : 1800"
            style={{ width: 120, textAlign: 'right', marginLeft: 'auto' }}
            value={revDraft ?? (status.revenu ?? '')}
            onChange={(e) => setRevDraft(e.target.value)}
            onBlur={saveRevenu}
            onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} />
          <span className="muted" style={{ fontSize: 12 }}>€/mois</span>
        </div>
        {revenu > 0 && (
          <p className="muted" style={{ fontSize: 12.5, margin: '8px 0 0' }}>
            Repère 50/30/20 : besoins ~{eur0(revenu * 0.5)} · envies ~{eur0(revenu * 0.3)}
            {' '}· épargne ~{eur0(revenu * 0.2)}.
          </p>
        )}
      </div>

      {(revenu > 0 || totalBudget > 0) && (
        <div className="card hero" style={{ marginBottom: 18 }}>
          <div className="eyebrow">{moisLabel(mois)}</div>
          {revenu > 0 ? (
            <>
              <div className="total" style={{ fontSize: 38 }}>
                <span className={reste >= 0 ? 'pos' : 'neg'}>{eur0(reste)}</span>
                <span className="cts"> restants sur {eur0(revenu)}</span>
              </div>
              <div className="sub">
                Dépensé ce mois : {eur0(depMois)}
                {totalBudget > 0 && (epargnePrevue >= 0
                  ? ` · épargne prévue si budgets tenus : ${eur0(epargnePrevue)}/mois`
                  : ` · ⚠ budgets (${eur0(totalBudget)}) supérieurs au revenu`)}
              </div>
              <div className="allocbar" style={{ marginBottom: 4 }}>
                {segDep > 0 && <span title={`Dépensé · ${eur0(segDep)}`}
                  style={{ width: `${(segDep / revenu) * 100}%`, background: 'var(--clay)' }} />}
                {segEngage > 0 && <span title={`Encore budgété · ${eur0(segEngage)}`}
                  style={{ width: `${(segEngage / revenu) * 100}%`, background: 'var(--indigo)' }} />}
                {segLibre > 0 && <span title={`Libre / épargne · ${eur0(segLibre)}`}
                  style={{ width: `${(segLibre / revenu) * 100}%`, background: 'var(--emerald)' }} />}
              </div>
              <div className="sub" style={{ fontSize: 11.5 }}>
                <span style={{ color: 'var(--clay)' }}>■</span> dépensé ·{' '}
                <span style={{ color: 'var(--indigo)' }}>■</span> encore budgété ·{' '}
                <span style={{ color: 'var(--emerald)' }}>■</span> libre / épargne
              </div>
            </>
          ) : (
            <>
              <div className="total" style={{ fontSize: 38 }}>
                <span className={ok ? 'pos' : 'neg'}>{eur0(totalDep)}</span>
                <span className="cts"> / {eur0(totalBudget)} budgétés</span>
              </div>
              <div className="allocbar" style={{ marginBottom: 4 }}>
                <span style={{ width: `${Math.min(100, (totalDep / totalBudget) * 100)}%`,
                  background: ok ? 'var(--emerald)' : 'var(--clay)' }} />
              </div>
            </>
          )}
          {totalBudget > 0 && (
            <div className="sub">
              {ok
                ? `✓ Budgets respectés — reste ${eur0(totalBudget - totalDep)} sur les catégories budgétées.`
                : `⚠ Dépassement de ${eur0(totalDep - totalBudget)} sur les catégories budgétées.`}
              {status.hors_budget > 0 &&
                ` (+ ${eur0(status.hors_budget)} hors catégories budgétées)`}
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h3>Plafonds mensuels par catégorie</h3>
        {totalBudget === 0 && (
          <div className="banner" style={{ marginBottom: 14 }}>
            Aucun budget défini — saisir un montant en face d'une catégorie
            (0 ou vide pour le retirer).
          </div>
        )}
        <table className="budget-table">
          <thead>
            <tr>
              <th className="sortable" onClick={() => toggle('categorie', 1)}>
                Catégorie{arrow(tri, 'categorie')}</th>
              <th className="sortable" style={{ width: 130 }} onClick={() => toggle('budget')}>
                Budget / mois{arrow(tri, 'budget')}</th>
              <th>Progression</th>
              <th className="sortable" style={{ textAlign: 'right' }}
                onClick={() => toggle('depense')}>Dépensé{arrow(tri, 'depense')}</th>
              <th className="sortable" style={{ textAlign: 'right' }}
                onClick={() => toggle('reste')}>Reste{arrow(tri, 'reste')}</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const pct = r.budget ? Math.min(100, (r.depense / r.budget) * 100) : 0
              const over = r.budget != null && r.depense > r.budget
              const near = !over && r.budget != null && pct >= 80
              return (
                <tr key={r.categorie}>
                  <td>{r.categorie}</td>
                  <td>
                    <input type="number" step="10" min="0" placeholder="—"
                      style={{ width: 100, textAlign: 'right' }}
                      value={draft[r.categorie] ?? r.budget ?? ''}
                      onChange={(e) => setDraft((d) => ({ ...d, [r.categorie]: e.target.value }))}
                      onBlur={() => save(r.categorie)}
                      onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} />
                  </td>
                  <td>
                    {r.budget != null
                      ? <div className="track"><span
                          className={'fill' + (over ? ' over' : near ? ' near' : '')}
                          style={{ width: `${pct}%` }} /></div>
                      : <span className="muted" style={{ fontSize: 12 }}>pas de budget</span>}
                  </td>
                  <td className={'num ' + (over ? 'neg' : '')}>{eur(r.depense)}</td>
                  <td className="num">
                    {r.budget != null
                      ? <span className={over ? 'neg' : 'pos'}>
                          {over ? '−' : ''}{eur(Math.abs(r.budget - r.depense))}</span>
                      : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}
