import React, { useEffect, useState } from 'react'
import { api, eur, eur0, mois as moisLabel } from '../lib/api.js'
import { Sparkles, Download } from './icons.jsx'

// pourcentage signé, 1 décimale : +12,3 % / −4 %
const pct = (v) => v == null ? '—'
  : (v >= 0 ? '+' : '−') + Math.abs(v).toLocaleString('fr-FR',
    { maximumFractionDigits: 1 }) + ' %'

export default function Analyse() {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  useEffect(() => { api.analyse().then(setData).catch((e) => setMsg(e.message)) }, [])

  // Export : copie le rapport Markdown dans le presse-papier (à coller dans Claude),
  // avec repli sur un téléchargement .md si le presse-papier est indisponible.
  const copyForClaude = async () => {
    setBusy(true); setMsg(null)
    try {
      const md = await api.analyseMarkdown()
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(md)
        setMsg('Rapport copié — coller dans Claude pour l\'analyse.')
      } else {
        download(md); setMsg('Presse-papier indisponible : rapport téléchargé (.md).')
      }
    } catch (e) { setMsg(`Échec de l'export : ${e.message}`) } finally { setBusy(false) }
  }
  const download = (md) => {
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }))
    Object.assign(document.createElement('a'),
      { href: url, download: 'analyse-patrimoine.md' }).click()
    URL.revokeObjectURL(url)
  }
  const downloadMd = async () => {
    setBusy(true); setMsg(null)
    try { download(await api.analyseMarkdown()) }
    catch (e) { setMsg(`Échec : ${e.message}`) } finally { setBusy(false) }
  }

  if (msg && !data) return <div className="banner" style={{ margin: 24 }}>{msg}</div>
  if (!data) return <div className="row" style={{ padding: 40 }}><span className="spinner" /></div>

  const k = data.kpis
  const objPct = data.objectif ? Math.min(100, 100 * data.patrimoine / data.objectif) : null
  const serie = data.epargne_series || []
  const maxTaux = Math.max(10, ...serie.map((s) => Math.abs(s.taux_epargne || 0)))
  const abosTotal = (data.abonnements || []).reduce((s, a) => s + a.montant, 0)

  return (
    <>
      <div className="page-head row between">
        <div>
          <h1>Analyse</h1>
          <p>Tendances, anomalies et récurrents — calculés localement.</p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn primary" onClick={copyForClaude} disabled={busy}
            title="Copier un rapport structuré dans le presse-papier, à coller dans Claude">
            <Sparkles size={14} /> {busy ? '…' : 'Copier pour Claude'}</button>
          <button className="btn" onClick={downloadMd} disabled={busy}
            title="Télécharger le rapport au format Markdown">
            <Download size={14} /> .md</button>
        </div>
      </div>

      {msg && <div className="banner" style={{ marginBottom: 16 }}>{msg}</div>}

      {/* Conseils d'investissement (règles connues appliquées aux chiffres) */}
      {data.conseils?.length > 0 && (
        <div className="card" style={{ marginBottom: 18 }}>
          <h3>Conseils d'investissement</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
            {data.conseils.map((c, i) => {
              const col = c.niveau === 'alerte' ? 'var(--clay)'
                : c.niveau === 'ok' ? 'var(--emerald)' : 'var(--indigo)'
              const mark = c.niveau === 'alerte' ? '⚠' : c.niveau === 'ok' ? '✓' : '→'
              return (
                <div key={i} style={{ display: 'flex', gap: 10, padding: '8px 12px',
                  borderLeft: `3px solid ${col}`, background: 'var(--surface-2)',
                  borderRadius: 6 }}>
                  <span style={{ color: col, fontWeight: 700, flexShrink: 0 }}>{mark}</span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>{c.titre}</div>
                    <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                      {c.texte}</div>
                  </div>
                </div>
              )
            })}
          </div>
          <p className="muted" style={{ fontSize: 11.5, margin: '10px 0 0' }}>
            Repères généraux fondés sur des règles répandues, pas un conseil
            financier personnalisé.
          </p>
        </div>
      )}

      {/* Synthèse */}
      <div className="grid cols-2" style={{ marginBottom: 18 }}>
        <div className="card">
          <h3>Épargne</h3>
          {k ? (
            <>
              <div className="total" style={{ fontSize: 32 }}>
                <span className={k.epargne_mensuelle >= 0 ? 'pos' : 'neg'}>
                  {eur0(k.epargne_mensuelle)}</span>
                <span className="cts"> / mois</span>
              </div>
              <p className="muted" style={{ margin: '4px 0 0' }}>
                Taux d'épargne moyen : <b>{k.taux_epargne != null ? k.taux_epargne + ' %' : '—'}</b>
                {' '}(sur {k.nb_mois} mois) · projection patrimoine à 1 an :{' '}
                <b>{eur0(k.projection_1an)}</b>
              </p>
            </>
          ) : <p className="muted">Pas encore assez d'historique.</p>}
        </div>
        <div className="card">
          <h3>Patrimoine</h3>
          <div className="total" style={{ fontSize: 32 }}>{eur0(data.patrimoine)}</div>
          {objPct != null ? (
            <>
              <div className="track" style={{ marginTop: 8 }}>
                <span className="fill" style={{ width: `${objPct}%` }} /></div>
              <p className="muted" style={{ margin: '6px 0 0' }}>
                {objPct.toFixed(0)} % de l'objectif ({eur0(data.objectif)})</p>
            </>
          ) : <p className="muted" style={{ margin: '6px 0 0' }}>
            Aucun objectif défini (page Réglages / Patrimoine).</p>}
        </div>
      </div>

      {/* Taux d'épargne mois par mois */}
      {serie.length > 0 && (
        <div className="card" style={{ marginBottom: 18 }}>
          <h3>Taux d'épargne mois par mois</h3>
          <div className="row" style={{ gap: 6, alignItems: 'flex-end',
            marginTop: 8, overflowX: 'auto' }}>
            {serie.map((s) => {
              // Hauteur en pixels (les % d'un parent flex sans hauteur définie
              // s'écrasent) : barre proportionnelle au taux, sur ~110 px utiles.
              const t = s.taux_epargne
              const h = Math.round((Math.abs(t || 0) / maxTaux) * 110)
              const pos = (t || 0) >= 0
              return (
                <div key={s.mois} title={`${s.mois} · taux ${pct(t)} · net ${eur0(s.net)}`}
                  style={{ flex: '1 0 36px', display: 'flex', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
                  <span className="muted" style={{ fontSize: 10 }}>
                    {t == null ? '—' : Math.round(t) + '%'}</span>
                  <div style={{ height: h, width: '70%', minHeight: 4, borderRadius: 4,
                    background: pos ? 'var(--emerald)' : 'var(--clay)' }} />
                  <span className="muted" style={{ fontSize: 10, whiteSpace: 'nowrap' }}>
                    {moisLabel(s.mois + '-01').replace('.', '')}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Tendances par catégorie */}
      {data.tendances?.length > 0 && (
        <div className="card" style={{ marginBottom: 18 }}>
          <h3>Tendances par catégorie</h3>
          <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
            {data.mois_reference} comparé à la moyenne des 3 mois précédents.
          </p>
          <table>
            <thead><tr>
              <th>Catégorie</th>
              <th style={{ textAlign: 'right' }}>Mois réf.</th>
              <th style={{ textAlign: 'right' }}>Moyenne</th>
              <th style={{ textAlign: 'right' }}>Écart</th></tr></thead>
            <tbody>
              {data.tendances.filter((r) => r.mois > 0 || r.moyenne > 0).map((r) => (
                <tr key={r.categorie}>
                  <td>{r.categorie}</td>
                  <td className="num">{eur(r.mois)}</td>
                  <td className="num muted">{eur(r.moyenne)}</td>
                  <td className={'num ' + (r.delta > 0 ? 'neg' : r.delta < 0 ? 'pos' : 'muted')}>
                    {r.delta > 0 ? '▲' : r.delta < 0 ? '▼' : '='}{' '}
                    {eur(Math.abs(r.delta))} {r.delta_pct != null && `(${pct(r.delta_pct)})`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: 11.5, marginBottom: 0 }}>
            Sur une dépense, ▲ = hausse (défavorable), ▼ = baisse.
          </p>
        </div>
      )}

      {/* Anomalies */}
      <div className="card" style={{ marginBottom: 18 }}>
        <h3>Anomalies du mois</h3>
        {data.anomalies?.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {data.anomalies.map((a) => (
              <li key={a.categorie} style={{ marginBottom: 4 }}>
                <b>{a.categorie}</b> : {eur(a.mois)} ce mois contre {eur(a.moyenne)} en
                moyenne <span className="neg">({pct(a.delta_pct)})</span>
              </li>
            ))}
          </ul>
        ) : <p className="muted" style={{ margin: 0 }}>
          Aucune dépense anormale sur le dernier mois complet.</p>}
      </div>

      <div className="grid cols-2">
        {/* Dépenses récurrentes */}
        <div className="card">
          <h3>Dépenses récurrentes</h3>
          {data.abonnements?.length > 0 ? (
            <>
              <table>
                <thead><tr><th>Libellé</th>
                  <th style={{ textAlign: 'right' }}>Montant</th>
                  <th style={{ textAlign: 'right' }}>Occur.</th></tr></thead>
                <tbody>
                  {data.abonnements.map((s, i) => (
                    <tr key={i}>
                      <td>{s.libelle}<div className="muted" style={{ fontSize: 11 }}>
                        {s.categorie}</div></td>
                      <td className="num">{eur(s.montant)}</td>
                      <td className="num muted">{s.occurrences}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
                Total récurrent estimé : <b>{eur(abosTotal)}/mois</b>.</p>
            </>
          ) : <p className="muted" style={{ margin: 0 }}>Aucune récurrence détectée.</p>}
        </div>

        {/* Plus grosses dépenses */}
        <div className="card">
          <h3>Plus grosses dépenses (90 j)</h3>
          {data.grosses_depenses?.length > 0 ? (
            <table>
              <thead><tr><th>Date</th><th>Libellé</th>
                <th style={{ textAlign: 'right' }}>Montant</th></tr></thead>
              <tbody>
                {data.grosses_depenses.map((g, i) => (
                  <tr key={i}>
                    <td className="muted" style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
                      {g.date.slice(5)}</td>
                    <td>{g.libelle}<div className="muted" style={{ fontSize: 11 }}>
                      {g.categorie}</div></td>
                    <td className="num">{eur(g.montant)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="muted" style={{ margin: 0 }}>Aucune dépense récente.</p>}
        </div>
      </div>
    </>
  )
}
