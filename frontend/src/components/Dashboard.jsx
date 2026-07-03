import React, { useEffect, useState } from 'react'
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, Cell, FunnelChart, Funnel, LabelList, ReferenceLine,
} from 'recharts'
import { api, eur, eur0, mois, classColor, isHidden, cssVar } from '../lib/api.js'
import { Eye, EyeOff } from './icons.jsx'

// Couleurs des graphiques lues sur le thème courant (clair/sombre).
const chartColors = () => ({
  grid: cssVar('--chart-grid'), muted: cssVar('--muted'), ink: cssVar('--ink'),
  indigo: cssVar('--indigo'), emerald: cssVar('--emerald'), clay: cssVar('--clay'),
  tip: { fontSize: 12, borderRadius: 10, border: `1px solid ${cssVar('--line')}`,
    background: cssVar('--surface'), color: cssVar('--ink'),
    fontFamily: 'Spline Sans Mono, monospace' },
})

const PERIODES = [
  { id: 'semaine', label: 'Semaine' },
  { id: 'mois', label: 'Mois' },
  { id: 'annee', label: 'Année' },
  { id: 'toujours', label: 'Toujours' },
]

// Libellé humain de la fenêtre renvoyée par /api/depenses.
function periodeLabel(d) {
  if (!d.debut) return 'Depuis le début'
  const f = (s) => new Date(s).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })
  if (d.periode === 'annee') return d.debut.slice(0, 4)
  if (d.periode === 'mois') return new Date(d.debut).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })
  return `${f(d.debut)} → ${f(d.fin)}`
}

const CAT_COLORS = ['#3A55C4', '#16887A', '#BE862C', '#BC4A33', '#6A7BE6',
  '#54A89B', '#8A93A6', '#9B6BD0']

export default function Dashboard({ goImport }) {
  const [d, setD] = useState(null)
  const [err, setErr] = useState(null)
  const [periode, setPeriode] = useState('mois')
  const [decalage, setDecalage] = useState(0)
  const [dep, setDep] = useState(null)
  // drill-down : catégorie cliquée -> dépenses par marchand sur la même fenêtre
  const [selCat, setSelCat] = useState(null)
  const [marchands, setMarchands] = useState(null)
  // patrimoine projeté (+ scénario « si j'investissais X €/mois de plus »).
  // Comptes courants exclus par défaut : solde fluctuant à 0 % qui dilue
  // le taux moyen sans rien projeter.
  const [horizon, setHorizon] = useState(10)
  const [extra, setExtra] = useState(0)
  const [ccInclus, setCcInclus] = useState(false)
  const [proj, setProj] = useState(null)
  // masquage individuel (persistant) : total et classes d'actifs
  const [maskTotal, setMaskTotal] = useState(localStorage.getItem('mask_total') === '1')
  const [maskCls, setMaskCls] = useState(
    () => new Set(JSON.parse(localStorage.getItem('mask_classes') || '[]')))

  const toggleTotal = () => {
    const v = !maskTotal
    setMaskTotal(v); localStorage.setItem('mask_total', v ? '1' : '0')
  }
  const toggleCls = (type) => {
    setMaskCls((prev) => {
      const next = new Set(prev)
      next.has(type) ? next.delete(type) : next.add(type)
      localStorage.setItem('mask_classes', JSON.stringify([...next]))
      return next
    })
  }

  useEffect(() => {
    api.dashboard().then(setD).catch((e) => setErr(e.message))
  }, [])
  useEffect(() => {
    api.depenses(periode, decalage).then(setDep).catch(() => {})
  }, [periode, decalage])
  useEffect(() => {
    if (!selCat) { setMarchands(null); return }
    api.depensesMarchands(selCat, periode, decalage).then(setMarchands).catch(() => {})
  }, [selCat, periode, decalage])
  useEffect(() => {
    api.projection(horizon, extra, ccInclus).then(setProj).catch(() => {})
  }, [horizon, extra, ccInclus])

  if (err) return <Banner err={err} />
  if (!d) return <Loading />
  const C = chartColors()

  if (d.nb_transactions === 0 && d.patrimoine === 0)
    return (
      <div className="empty card">
        <div className="big">Rien à afficher pour l'instant</div>
        <p>Importe un relevé BoursoBank ou Crédit Agricole, ou ajoute un actif.</p>
        <button className="btn primary" onClick={goImport}>Importer un relevé</button>
      </div>
    )

  const ints = Math.trunc(d.patrimoine)
  const cts = Math.abs(Math.round((d.patrimoine - ints) * 100)).toString().padStart(2, '0')

  return (
    <>
      <div className="page-head">
        <h1>Tableau de bord</h1>
        <p>{d.nb_transactions} opérations · {d.non_categorise} encore à classer</p>
      </div>

      {/* HERO + barre d'allocation (signature) */}
      <div className="card hero" style={{ marginBottom: 18 }}>
        <div className="eyebrow">Patrimoine net</div>
        <div className="row" style={{ gap: 10 }}>
          <div className="total">
            {isHidden() || maskTotal
              ? <>••••••<span className="cts"> €</span></>
              : <>{ints.toLocaleString('fr-FR')}<span className="cts"> ,{cts} €</span></>}
          </div>
          <button className="mask-btn" onClick={toggleTotal}
            title={maskTotal ? 'Afficher le total' : 'Masquer le total'}>
            {maskTotal ? <EyeOff /> : <Eye />}</button>
        </div>
        <div className="sub">Réparti sur {d.repartition.length} classes d'actifs</div>

        {/* Objectif de patrimoine (fixé dans Réglages) */}
        {d.objectif > 0 && (
          <div style={{ marginTop: 14 }}>
            <div className="goal-bar">
              <span className={d.patrimoine >= d.objectif ? 'done' : ''}
                style={{ width: `${Math.min(100, (d.patrimoine / d.objectif) * 100)}%` }} />
            </div>
            <div className="sub">
              {d.patrimoine >= d.objectif
                ? <>🎉 Objectif de {eur0(d.objectif)} atteint !</>
                : <>Objectif : <b>{eur0(d.objectif)}</b> · {Math.round((d.patrimoine / d.objectif) * 100)}%
                    atteint, reste {eur0(d.objectif - d.patrimoine)}</>}
            </div>
          </div>
        )}

        <div className="allocbar">
          {d.repartition.map((r) => (
            <span key={r.type}
              title={maskCls.has(r.type) ? r.classe : `${r.classe} · ${eur(r.valeur)}`}
              style={{ width: `${(r.valeur / d.patrimoine) * 100}%`,
                       background: classColor(r.type) }} />
          ))}
        </div>
        <div className="alloc-legend">
          {d.repartition.map((r) => (
            <div className="item" key={r.type}>
              <span className="swatch" style={{ background: classColor(r.type) }} />
              <span>{r.classe}</span>
              {maskCls.has(r.type)
                ? <span className="val muted">••••</span>
                : <>
                    <span className="val">{eur0(r.valeur)}</span>
                    <span className="pct">{Math.round((r.valeur / d.patrimoine) * 100)}%</span>
                  </>}
              <button className="mask-btn sm" onClick={() => toggleCls(r.type)}
                title={maskCls.has(r.type) ? 'Afficher' : 'Masquer'}>
                {maskCls.has(r.type) ? <EyeOff size={12} /> : <Eye size={12} />}</button>
            </div>
          ))}
        </div>
      </div>

      {/* Indicateurs d'épargne (moyennes sur les derniers mois complets) */}
      {d.kpis && (
        <div className="card" style={{ marginBottom: 18 }}>
          <h3>Rythme d'épargne <span style={{ textTransform: 'none', letterSpacing: 0 }}>
            (moyenne des {d.kpis.nb_mois} derniers mois complets)</span></h3>
          <div className="statline">
            {d.kpis.taux_epargne != null && (
              <div className="stat">
                <div className={'k ' + (d.kpis.taux_epargne >= 0 ? 'pos' : 'neg')}>
                  {d.kpis.taux_epargne}%</div>
                <div className="l">taux d'épargne (part des revenus non dépensée)</div>
              </div>
            )}
            <div className="stat">
              <div className={'k ' + (d.kpis.epargne_mensuelle >= 0 ? 'pos' : 'neg')}>
                {d.kpis.epargne_mensuelle >= 0 ? '+' : ''}{eur0(d.kpis.epargne_mensuelle)}</div>
              <div className="l">épargne par mois</div>
            </div>
            <div className="stat">
              <div className="k">{eur0(d.kpis.revenus_moyens)}</div>
              <div className="l">revenus mensuels moyens</div>
            </div>
            <div className="stat">
              <div className="k">{eur0(d.kpis.depenses_moyennes)}</div>
              <div className="l">dépenses mensuelles moyennes</div>
            </div>
            <div className="stat">
              <div className="k">{eur0(d.kpis.projection_1an)}</div>
              <div className="l">patrimoine projeté dans 1 an, à ce rythme</div>
            </div>
          </div>
        </div>
      )}

      {/* Historique du patrimoine total (relevés quotidiens automatiques) */}
      {d.historique?.length >= 2 && (
        <div className="card" style={{ marginBottom: 18 }}>
          <h3>Évolution du patrimoine total</h3>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={d.historique} margin={{ left: -8, right: 8, top: 4 }}>
              <defs>
                <linearGradient id="gh" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={C.emerald} stopOpacity={0.25} />
                  <stop offset="100%" stopColor={C.emerald} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={C.grid} vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: C.muted }}
                tickFormatter={(s) => mois(s)} minTickGap={40} />
              <YAxis tick={{ fontSize: 11, fill: C.muted }} domain={['auto', 'auto']}
                tickFormatter={(v) => eur0(v)} width={70} />
              <Tooltip formatter={(v) => eur(v)} labelFormatter={(s) => s}
                contentStyle={C.tip} />
              <Area type="monotone" dataKey="total" stroke={C.emerald} strokeWidth={2}
                fill="url(#gh)" />
            </AreaChart>
          </ResponsiveContainer>
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
            Relevé automatique à chaque visite (1 point par jour) — l'historique
            s'enrichit avec le temps.
          </p>
        </div>
      )}

      {/* Patrimoine projeté : croissance visée des actifs + épargne mensuelle */}
      {proj?.serie?.length > 1 && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="row between" style={{ flexWrap: 'wrap', gap: 10 }}>
            <h3 style={{ marginBottom: 0 }}>Patrimoine projeté</h3>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <div className="seg" title="Et si j'investissais X €/mois de plus ?">
                {[0, 50, 100, 250, 500].map((n) => (
                  <button key={n} className={extra === n ? 'on' : ''}
                    onClick={() => setExtra(n)}>{n === 0 ? '+0 €' : `+${n} €/m`}</button>
                ))}
              </div>
              <div className="seg">
                {[1, 5, 10, 20].map((n) => (
                  <button key={n} className={horizon === n ? 'on' : ''}
                    onClick={() => setHorizon(n)}>{n} an{n > 1 ? 's' : ''}</button>
                ))}
              </div>
            </div>
          </div>
          <p className="muted" style={{ fontSize: 12.5, margin: '10px 0 4px' }}>
            Croissance visée moyenne : <b>{proj.taux_moyen}%/an</b>
            {' '}· épargne comptée : <b>{eur0(proj.epargne_mensuelle)}/mois</b>
            {' '}· dans {horizon} an{horizon > 1 ? 's' : ''} :{' '}
            <b>{eur0(proj.serie[proj.serie.length - 1].programme)}</b>
            {extra > 0 && proj.serie[proj.serie.length - 1].programme_plus != null && (
              <> · en investissant <b>+{extra} €/mois</b> :{' '}
                <b className="pos">{eur0(proj.serie[proj.serie.length - 1].programme_plus)}</b>
                {' '}(soit +{eur0(proj.serie[proj.serie.length - 1].programme_plus
                  - proj.serie[proj.serie.length - 1].programme)} de mieux)</>
            )}
            {' '}· <label style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}
              title="Le solde des comptes courants fluctue et ne « croît » pas : il est exclu par défaut pour ne pas diluer le taux moyen">
              <input type="checkbox" checked={ccInclus}
                onChange={(e) => setCcInclus(e.target.checked)}
                style={{ verticalAlign: '-2px', marginRight: 4 }} />
              inclure les comptes courants</label>
          </p>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={proj.serie} margin={{ left: -8, right: 8, top: 4 }}>
              <defs>
                <linearGradient id="gp" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={C.indigo} stopOpacity={0.25} />
                  <stop offset="100%" stopColor={C.indigo} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={C.grid} vertical={false} />
              <XAxis dataKey="mois" tick={{ fontSize: 11, fill: C.muted }}
                tickFormatter={(s) => mois(s)} minTickGap={40} />
              <YAxis tick={{ fontSize: 11, fill: C.muted }} domain={['auto', 'auto']}
                tickFormatter={(v) => eur0(v)} width={74} />
              <Tooltip contentStyle={C.tip} labelFormatter={(s) => mois(s)}
                formatter={(v, name) => [eur(v),
                  name === 'programme' ? 'avec croissance visée'
                    : name === 'programme_plus' ? `en investissant +${extra} €/mois`
                    : 'épargne seule']} />
              {d.objectif > 0 && (
                <ReferenceLine y={d.objectif} stroke={C.emerald} strokeDasharray="4 4"
                  label={{ value: `objectif ${eur0(d.objectif)}`, position: 'insideTopRight',
                    fontSize: 11, fill: C.emerald }} />
              )}
              <Area type="monotone" dataKey="programme" stroke={C.indigo}
                strokeWidth={2} fill="url(#gp)" />
              {extra > 0 && (
                <Area type="monotone" dataKey="programme_plus" stroke={C.emerald}
                  strokeWidth={2} fill="none" />
              )}
              <Area type="monotone" dataKey="epargne_seule" stroke={C.muted}
                strokeWidth={1.5} strokeDasharray="5 4" fill="none" />
            </AreaChart>
          </ResponsiveContainer>
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
            Intérêts composés : chaque actif compose à sa croissance visée (page
            Patrimoine) et ton épargne mensuelle est réputée investie au taux visé
            moyen. Pointillés : la même épargne laissée à 0 % — l'écart entre les
            deux courbes, ce sont les intérêts composés.
            {extra > 0 && <> Trait vert : pareil, en investissant {extra} €/mois de plus.</>}
            {!ccInclus && <> Comptes courants exclus{d.objectif > 0
              && ' (l\'objectif, lui, porte sur le patrimoine total)'}.</>}
            {' '}C'est une projection, pas une promesse.
          </p>
          {proj.taux_moyen === 0 && (
            <p className="banner warn" style={{ fontSize: 12.5, marginTop: 10, marginBottom: 0 }}>
              Taux visé moyen : 0 %/an — la courbe restera une droite tant qu'aucun
              actif n'a de « croissance visée ». Renseigne-la sur ton PEA, tes livrets…
              (Patrimoine → Éditer → Suivi de croissance & pays, ex : PEA 7, Livret A 1,7).
            </p>
          )}
        </div>
      )}

      {/* Courbe d'évolution du solde liquide */}
      <div className="card" style={{ marginBottom: 18 }}>
        <h3>Évolution du solde liquide</h3>
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={d.courbe_patrimoine} margin={{ left: -8, right: 8, top: 4 }}>
            <defs>
              <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={C.indigo} stopOpacity={0.25} />
                <stop offset="100%" stopColor={C.indigo} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={C.grid} vertical={false} />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: C.muted }}
              tickFormatter={(s) => mois(s)} minTickGap={40} />
            <YAxis tick={{ fontSize: 11, fill: C.muted }}
              tickFormatter={(v) => eur0(v)} width={70} />
            <Tooltip formatter={(v) => eur(v)} labelFormatter={(s) => s}
              contentStyle={C.tip} />
            <Area type="monotone" dataKey="solde" stroke={C.indigo} strokeWidth={2}
              fill="url(#g)" />
          </AreaChart>
        </ResponsiveContainer>
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          Reconstruit à partir du solde actuel et de tes flux importés.
        </p>
      </div>

      <div className="grid cols-2" style={{ marginBottom: 18 }}>
        {/* Flux mensuels */}
        <div className="card">
          <h3>Flux mensuels (entrées / sorties, hors virements internes)</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={d.flux_mensuel.slice(-12)} margin={{ left: -8, right: 4 }}>
              <CartesianGrid stroke={C.grid} vertical={false} />
              <XAxis dataKey="mois" tick={{ fontSize: 11, fill: C.muted }}
                tickFormatter={(s) => mois(s)} minTickGap={10} />
              <YAxis tick={{ fontSize: 11, fill: C.muted }}
                tickFormatter={(v) => eur0(v)} width={64} />
              <Tooltip formatter={(v) => eur(v)} contentStyle={C.tip} />
              <Bar dataKey="entrees" fill={C.emerald} radius={[3, 3, 0, 0]} />
              <Bar dataKey="sorties" fill={C.clay} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Pyramide du patrimoine — classes d'actifs, le plus gros en bas */}
        <div className="card">
          <h3>Pyramide du patrimoine</h3>
          {d.repartition.length === 0
            ? <p className="muted">Ajoute des actifs pour voir la pyramide.</p>
            : (
              <ResponsiveContainer width="100%" height={260}>
                <FunnelChart>
                  <Tooltip formatter={(v) => eur(v)} contentStyle={C.tip} />
                  <Funnel dataKey="valeur" isAnimationActive
                    data={[...d.repartition].sort((a, b) => a.valeur - b.valeur)}>
                    <LabelList position="right" dataKey="classe" stroke="none"
                      fill={C.ink} style={{ fontSize: 12 }} />
                    <LabelList position="left" dataKey="valeur" stroke="none"
                      fill={C.muted}
                      style={{ fontSize: 11, fontFamily: 'Spline Sans Mono, monospace' }}
                      formatter={(v) => eur0(v)} />
                    {[...d.repartition].sort((a, b) => a.valeur - b.valeur).map((r) =>
                      <Cell key={r.type} fill={classColor(r.type)} />)}
                  </Funnel>
                </FunnelChart>
              </ResponsiveContainer>
            )}
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
            Base large = classe la plus lourde ; sommet = la plus légère.
          </p>
        </div>
      </div>

      {/* Budget du mois (si un budget prévisionnel est défini) */}
      {d.budget?.lignes?.length > 0 && (
        <div className="card" style={{ marginBottom: 18 }}>
          <h3>Budget de {new Date(d.budget.mois + '-01')
            .toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })}</h3>
          <div className="row" style={{ gap: 20, flexWrap: 'wrap', marginBottom: 12 }}>
            <div className="stat">
              <div className={'k ' + (d.budget.depense_total <= d.budget.budget_total ? 'pos' : 'neg')}>
                {eur0(d.budget.depense_total)} / {eur0(d.budget.budget_total)}</div>
              <div className="l">{d.budget.depense_total <= d.budget.budget_total
                ? '✓ budget respecté pour l\'instant' : '⚠ budget global dépassé'}</div>
            </div>
            {d.budget.hors_budget > 0 && (
              <div className="stat">
                <div className="k muted">{eur0(d.budget.hors_budget)}</div>
                <div className="l">dépensés hors catégories budgétées</div>
              </div>
            )}
          </div>
          <div className="budget-mini">
            {d.budget.lignes.map((l) => {
              const pct = l.budget ? Math.min(100, (l.depense / l.budget) * 100) : 0
              const over = l.depense > l.budget
              return (
                <div key={l.categorie} className="budget-mini-line">
                  <span className="lab">{l.categorie}</span>
                  <div className="track"><span className={over ? 'fill over' : 'fill'}
                    style={{ width: `${pct}%` }} /></div>
                  <span className={'num ' + (over ? 'neg' : '')} style={{ fontSize: 12 }}>
                    {eur0(l.depense)} / {eur0(l.budget)}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Dépenses par catégorie — période au choix */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="row between" style={{ flexWrap: 'wrap', gap: 10 }}>
          <h3 style={{ marginBottom: 0 }}>Dépenses par catégorie</h3>
          <div className="row" style={{ gap: 8 }}>
            <div className="seg">
              {PERIODES.map((p) => (
                <button key={p.id} className={periode === p.id ? 'on' : ''}
                  onClick={() => { setPeriode(p.id); setDecalage(0) }}>{p.label}</button>
              ))}
            </div>
            {periode !== 'toujours' && (
              <div className="seg">
                <button onClick={() => setDecalage((x) => x - 1)} title="Période précédente">‹</button>
                <button onClick={() => setDecalage((x) => Math.min(0, x + 1))}
                  disabled={decalage === 0} title="Période suivante">›</button>
              </div>
            )}
          </div>
        </div>
        {dep && (
          <p className="muted" style={{ fontSize: 12.5, margin: '10px 0 4px' }}>
            {periodeLabel(dep)} · total : <b>{eur(dep.total)}</b>
            {' '}· clique une barre pour voir <b>où</b> l'argent est parti
          </p>
        )}
        {!dep || dep.categories.length === 0
          ? <p className="muted" style={{ padding: '24px 0' }}>
              Aucune dépense sur cette période.</p>
          : (
            <ResponsiveContainer width="100%" height={Math.max(160, dep.categories.length * 32)}>
              <BarChart layout="vertical" data={dep.categories}
                margin={{ left: 8, right: 20 }}>
                <XAxis type="number" tickFormatter={(v) => eur0(v)}
                  tick={{ fontSize: 11, fill: C.muted }} />
                <YAxis type="category" dataKey="categorie" width={170}
                  tick={{ fontSize: 11.5, fill: C.ink }} />
                <Tooltip formatter={(v) => eur(v)} contentStyle={C.tip} />
                <Bar dataKey="montant" radius={[0, 4, 4, 0]} style={{ cursor: 'pointer' }}
                  onClick={(e) => e && setSelCat(e.categorie === selCat ? null : e.categorie)}>
                  {dep.categories.map((c, i) =>
                    <Cell key={i} fill={CAT_COLORS[i % CAT_COLORS.length]}
                      fillOpacity={selCat && selCat !== c.categorie ? 0.35 : 1} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}

        {/* Drill-down : dépenses par marchand dans la catégorie cliquée */}
        {selCat && (
          <div style={{ marginTop: 14, borderTop: '1px solid var(--surface-2)',
            paddingTop: 12 }}>
            <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
              <h3 style={{ marginBottom: 0 }}>Où ? · {selCat}</h3>
              <button className="btn ghost" onClick={() => setSelCat(null)}>Fermer</button>
            </div>
            {!marchands
              ? <p className="muted" style={{ padding: '12px 0' }}>Chargement…</p>
              : marchands.marchands.length === 0
                ? <p className="muted" style={{ padding: '12px 0' }}>
                    Aucune dépense « {selCat} » sur cette période.</p>
                : (
                  <table style={{ marginTop: 8 }}>
                    <thead><tr><th>Marchand</th>
                      <th style={{ textAlign: 'right' }}>Fois</th>
                      <th style={{ textAlign: 'right' }}>Total</th>
                      <th style={{ textAlign: 'right' }}>Part</th></tr></thead>
                    <tbody>
                      {marchands.marchands.map((m, i) => (
                        <tr key={i}>
                          <td className="lib">{m.marchand}</td>
                          <td className="num">{m.nb}×</td>
                          <td className="num neg">−{eur(m.montant)}</td>
                          <td className="num muted">
                            {marchands.total ? Math.round((m.montant / marchands.total) * 100) : 0}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
          </div>
        )}
      </div>

      {/* Abonnements détectés */}
      <div className="card">
        <h3>Abonnements & prélèvements récurrents détectés</h3>
        {d.abonnements.length === 0
          ? <p className="muted">Aucun récurrent identifié pour l'instant.</p>
          : (
            <table>
              <thead><tr><th>Libellé</th><th>Catégorie</th>
                <th style={{ textAlign: 'right' }}>Montant moyen</th>
                <th style={{ textAlign: 'right' }}>Occurrences</th></tr></thead>
              <tbody>
                {d.abonnements.map((a, i) => (
                  <tr key={i}>
                    <td className="lib">{a.libelle}</td>
                    <td><span className="cat-pill">{a.categorie}</span></td>
                    <td className="num neg">−{eur(a.montant)}</td>
                    <td className="num">{a.occurrences}×</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </>
  )
}

const Loading = () => (
  <div className="row muted" style={{ gap: 10, padding: 40 }}>
    <span className="spinner" /> Chargement du tableau de bord…
  </div>
)
const Banner = ({ err }) => (
  <div className="banner warn">Impossible de joindre le backend ({err}).
    Vérifie qu'il tourne sur le port 8000.</div>
)
