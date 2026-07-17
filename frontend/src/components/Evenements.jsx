import React, { useEffect, useMemo, useState } from 'react'
import { api, eur, dateFr } from '../lib/api.js'

const blank = { nom: '', debut: '', fin: '' }

// « 12 juil. → 26 juil. 2026 »
const plage = (ev) => {
  const f = (s) => new Date(s).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
  return `${f(ev.debut)} → ${f(ev.fin)} ${ev.fin.slice(0, 4)}`
}

export default function Evenements() {
  const [events, setEvents] = useState(null)
  const [form, setForm] = useState(blank)
  const [editId, setEditId] = useState(null)   // évènement en cours d'édition
  const [sel, setSel] = useState(null)         // évènement ouvert (détail)
  const [detail, setDetail] = useState(null)
  const [tx, setTx] = useState(null)           // pour « ajouter une opération »
  const [addOpen, setAddOpen] = useState(false)
  const [qAdd, setQAdd] = useState('')
  const [msg, setMsg] = useState(null)

  const load = () => api.evenements().then(setEvents).catch((e) => setMsg(e.message))
  useEffect(() => { load() }, [])

  const openDetail = async (id) => {
    if (sel === id) { setSel(null); setDetail(null); return }
    setSel(id); setDetail(null); setAddOpen(false); setQAdd('')
    setDetail(await api.evenementDetail(id))
  }
  const refresh = async () => {
    if (sel) setDetail(await api.evenementDetail(sel))
    await load()
  }

  const save = async () => {
    try {
      if (editId) await api.evenementPatch(editId, form.nom, form.debut, form.fin)
      else await api.evenementCreate(form.nom, form.debut, form.fin)
      setForm(blank); setEditId(null); await refresh()
    } catch (e) { setMsg(e.message) }
  }
  const edit = (ev) => { setEditId(ev.id); setForm({ nom: ev.nom, debut: ev.debut, fin: ev.fin }) }
  const remove = async (ev) => {
    try {
      await api.evenementDelete(ev.id)
      if (sel === ev.id) { setSel(null); setDetail(null) }
      if (editId === ev.id) { setEditId(null); setForm(blank) }
      await load()
    } catch (e) { setMsg(e.message) }
  }
  const override = async (op_id, mode) => {
    try { await api.evenementOverride(sel, op_id, mode); await refresh() }
    catch (e) { setMsg(e.message) }
  }

  // « Ajouter une opération » : cherche dans toutes les opérations du profil
  // (hors celles déjà listées), par libellé — hors période comprise.
  const openAdd = async () => {
    setAddOpen((v) => !v)
    if (!tx) setTx(await api.transactions(10000))
  }
  const dejaListees = useMemo(
    () => new Set((detail?.ops || []).map((o) => o.op_id)), [detail])
  // Sans recherche : suggère l'argent reçu pendant la période qui n'est pas
  // compté automatiquement (salaire, virements familiaux en « Revenus »…).
  const candidats = useMemo(() => {
    if (!addOpen || !tx || !detail) return []
    if (qAdd.length < 2)
      return tx.filter((t) => !dejaListees.has(t.op_id) && t.montant > 0 &&
        t.date.slice(0, 10) >= detail.debut && t.date.slice(0, 10) <= detail.fin)
        .slice(0, 8)
    return tx.filter((t) => !dejaListees.has(t.op_id) &&
      t.libelle.toLowerCase().includes(qAdd.toLowerCase())).slice(0, 10)
  }, [addOpen, tx, qAdd, dejaListees, detail])

  if (!events) return <div className="row" style={{ padding: 40 }}><span className="spinner" /></div>

  return (
    <>
      <div className="page-head">
        <h1>Évènements</h1>
        <p>Vacances, fêtes, week-ends… Dépenses et argent reçu de la période
          rattachés automatiquement (hors salaire, épargne, virements internes).</p>
      </div>

      {msg && <div className="banner" style={{ marginBottom: 16 }}>{msg}</div>}

      {/* Créer / éditer */}
      <div className="card" style={{ marginBottom: 18 }}>
        <h3>{editId ? 'Modifier l\'évènement' : 'Nouvel évènement'}</h3>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <input placeholder="ex : Vacances à Lisbonne" value={form.nom}
            style={{ flex: 2, minWidth: 200 }}
            onChange={(e) => setForm({ ...form, nom: e.target.value })} />
          <label className="row" style={{ gap: 6 }}>
            <span className="muted" style={{ fontSize: 12 }}>du</span>
            <input type="date" value={form.debut}
              onChange={(e) => setForm({ ...form, debut: e.target.value })} />
          </label>
          <label className="row" style={{ gap: 6 }}>
            <span className="muted" style={{ fontSize: 12 }}>au</span>
            <input type="date" value={form.fin}
              onChange={(e) => setForm({ ...form, fin: e.target.value })} />
          </label>
          <button className="btn primary" onClick={save}
            disabled={!form.nom.trim() || !form.debut || !form.fin}>
            {editId ? 'Enregistrer' : 'Créer'}</button>
          {editId && <button className="btn"
            onClick={() => { setEditId(null); setForm(blank) }}>Annuler</button>}
        </div>
      </div>

      {events.length === 0 && (
        <div className="empty card">
          <div className="big">Aucun évènement</div>
        </div>
      )}

      {events.map((ev) => (
        <div className="card" key={ev.id} style={{ marginBottom: 14 }}>
          <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
            <div>
              <h3 style={{ marginBottom: 2 }}>{ev.nom}</h3>
              <span className="muted" style={{ fontSize: 12.5 }}>
                {plage(ev)} · {ev.nb} dépense{ev.nb > 1 ? 's' : ''}</span>
            </div>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <span style={{ textAlign: 'right' }}>
                <span className={'num ' + (ev.total >= 0 ? 'neg' : 'pos')}
                  style={{ fontSize: 20, fontWeight: 600 }}>
                  {ev.total >= 0 ? '−' : '+'}{eur(Math.abs(ev.total))}</span>
                {ev.recu > 0 && (
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    dépensé −{eur(ev.depense)} · reçu +{eur(ev.recu)}</div>
                )}
              </span>
              <button className="btn" onClick={() => openDetail(ev.id)}>
                {sel === ev.id ? 'Fermer' : 'Détail'}</button>
              <button className="btn ghost" onClick={() => edit(ev)}>Éditer</button>
              <button className="btn ghost" style={{ color: 'var(--clay)' }}
                onClick={() => remove(ev)}>Suppr.</button>
            </div>
          </div>
          {ev.par_categorie?.length > 0 && (
            <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              {ev.par_categorie.map((c) => (
                <span key={c.categorie} className="cat-pill">
                  {c.categorie} · {eur(c.montant)}</span>
              ))}
            </div>
          )}

          {/* Détail : opérations rattachées, exclues, ajout manuel */}
          {sel === ev.id && (
            <div style={{ marginTop: 12, borderTop: '1px solid var(--surface-2)',
              paddingTop: 10 }}>
              {!detail ? <span className="spinner" /> : <>
                <table>
                  <tbody>
                    {detail.ops.map((o) => (
                      <tr key={o.op_id}
                        style={o.statut === 'exclu' ? { opacity: .45 } : undefined}>
                        <td className="num muted" style={{ textAlign: 'left', width: 90 }}>
                          {dateFr(o.date)}</td>
                        <td className="lib">{o.libelle}
                          {o.statut === 'inclus' &&
                            <span className="due-pill" title="Ajoutée manuellement">ajoutée</span>}
                          {o.statut === 'exclu' &&
                            <span className="due-pill">exclue</span>}</td>
                        <td><span className="cat-pill">{o.categorie}</span></td>
                        <td className={'num ' + (o.montant >= 0 ? 'pos' : 'neg')}>
                          {o.montant >= 0 ? '+' : '−'}{eur(Math.abs(o.montant))}</td>
                        <td className="num" style={{ width: 1, whiteSpace: 'nowrap' }}>
                          {o.statut === 'auto' &&
                            <button className="btn ghost" title="Cette dépense n'a rien à voir avec l'évènement"
                              onClick={() => override(o.op_id, 'exclure')}>Exclure</button>}
                          {o.statut === 'exclu' &&
                            <button className="btn ghost"
                              onClick={() => override(o.op_id, 'auto')}>Réintégrer</button>}
                          {o.statut === 'inclus' &&
                            <button className="btn ghost"
                              onClick={() => override(o.op_id, 'auto')}>Retirer</button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {detail.ops.length === 0 &&
                  <p className="muted" style={{ padding: '10px 0' }}>
                    Aucune dépense sur cette période pour l'instant.</p>}

                <div style={{ marginTop: 10 }}>
                  <button className="btn" onClick={openAdd}>
                    {addOpen ? 'Fermer l\'ajout' : '+ Ajouter une opération'}</button>
                  {addOpen && (
                    <div style={{ marginTop: 8 }}>
                      <input autoFocus placeholder="Rechercher un libellé (hors période aussi)…"
                        value={qAdd} onChange={(e) => setQAdd(e.target.value)}
                        style={{ width: '100%' }} />
                      {qAdd.length < 2 && candidats.length > 0 && (
                        <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
                          Argent reçu pendant la période, non compté automatiquement
                          (salaire, virements familiaux…) — cliquer pour le déduire :</p>
                      )}
                      <table>
                        <tbody>
                          {candidats.map((t) => (
                            <tr key={t.op_id} style={{ cursor: 'pointer' }}
                              onClick={() => override(t.op_id, 'inclure')}
                              title="Ajouter à l'évènement">
                              <td className="num muted" style={{ textAlign: 'left', width: 90 }}>
                                {dateFr(t.date)}</td>
                              <td className="lib">{t.libelle}</td>
                              <td className={'num ' + (t.montant >= 0 ? 'pos' : 'neg')}>
                                {t.montant >= 0 ? '+' : '−'}{eur(Math.abs(t.montant))}</td>
                              <td style={{ width: 1 }}><button className="btn">Ajouter</button></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {qAdd.length >= 2 && candidats.length === 0 &&
                        <p className="muted" style={{ padding: '8px 0' }}>Rien trouvé.</p>}
                    </div>
                  )}
                </div>
              </>}
            </div>
          )}
        </div>
      ))}
    </>
  )
}
