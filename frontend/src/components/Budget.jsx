import React, { useEffect, useState } from 'react'
import { api, eur, eur0 } from '../lib/api.js'

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
  const rows = cats.filter((c) => !SANS_BUDGET.includes(c))
    .map((c) => ({ categorie: c, budget: budgets[c] ?? null, depense: spent[c] ?? 0 }))
    .sort((a, b) => (b.budget ?? -1) - (a.budget ?? -1) || b.depense - a.depense)

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

  return (
    <>
      <div className="page-head row between">
        <div>
          <h1>Budget prévisionnel</h1>
          <p>Fixe un plafond mensuel par catégorie et suis-le mois par mois.</p>
        </div>
        <div className="seg">
          <button onClick={() => setDec((x) => x - 1)} title="Mois précédent">‹</button>
          <button className="on" style={{ cursor: 'default', textTransform: 'capitalize' }}>
            {moisLabel(mois)}</button>
          <button onClick={() => setDec((x) => Math.min(0, x + 1))}
            disabled={dec === 0} title="Mois suivant">›</button>
        </div>
      </div>

      {totalBudget > 0 && (
        <div className="card hero" style={{ marginBottom: 18 }}>
          <div className="eyebrow">{moisLabel(mois)}</div>
          <div className="total" style={{ fontSize: 38 }}>
            <span className={ok ? 'pos' : 'neg'}>{eur0(totalDep)}</span>
            <span className="cts"> / {eur0(totalBudget)} budgétés</span>
          </div>
          <div className="sub">
            {ok
              ? `✓ Budget respecté — il reste ${eur0(totalBudget - totalDep)} ce mois-ci.`
              : `⚠ Dépassement de ${eur0(totalDep - totalBudget)} sur les catégories budgétées.`}
            {status.hors_budget > 0 &&
              ` (+ ${eur0(status.hors_budget)} hors catégories budgétées)`}
          </div>
          <div className="allocbar" style={{ marginBottom: 4 }}>
            <span style={{ width: `${Math.min(100, (totalDep / totalBudget) * 100)}%`,
              background: ok ? 'var(--emerald)' : 'var(--clay)' }} />
          </div>
        </div>
      )}

      <div className="card">
        <h3>Plafonds mensuels par catégorie</h3>
        {totalBudget === 0 && (
          <div className="banner" style={{ marginBottom: 14 }}>
            Aucun budget défini. Saisis un montant en face d'une catégorie (il s'applique
            à tous les mois) — laisse vide ou mets 0 pour le retirer.
          </div>
        )}
        <table className="budget-table">
          <thead>
            <tr><th>Catégorie</th><th style={{ width: 130 }}>Budget / mois</th>
              <th>Progression</th>
              <th style={{ textAlign: 'right' }}>Dépensé</th>
              <th style={{ textAlign: 'right' }}>Reste</th></tr>
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
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          Le budget est mensuel et identique chaque mois. Les dépenses comptées sont celles
          des catégories ci-dessus (virements internes et épargne exclus).
        </p>
      </div>
    </>
  )
}
