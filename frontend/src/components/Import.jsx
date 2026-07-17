import React, { useState } from 'react'
import { api, eur } from '../lib/api.js'

export default function Import({ onChange }) {
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [reports, setReports] = useState([])

  const handleFiles = async (files) => {
    setBusy(true)
    for (const file of files) {
      try {
        const r = await api.importFile(file)
        setReports((prev) => [{ name: file.name, ok: true, ...r }, ...prev])
      } catch (e) {
        setReports((prev) => [{ name: file.name, ok: false, err: e.message }, ...prev])
      }
    }
    setBusy(false)
  }

  const onDrop = (e) => {
    e.preventDefault(); setOver(false)
    handleFiles([...e.dataTransfer.files])
  }

  return (
    <>
      <div className="page-head">
        <h1>Importer un relevé</h1>
        <p>BoursoBank (CSV) ou Crédit Agricole (XLSX) — le format est détecté tout seul.</p>
      </div>

      <div className={'dropzone' + (over ? ' over' : '')}
        onDragOver={(e) => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)} onDrop={onDrop}
        onClick={() => document.getElementById('fileinput').click()}>
        <div className="big">{busy ? 'Import en cours…' : 'Déposer les fichiers ici'}</div>
        <div className="small">ou cliquer pour parcourir · plusieurs fichiers acceptés</div>
        <input id="fileinput" type="file" multiple hidden
          accept=".csv,.xlsx,.xls"
          onChange={(e) => handleFiles([...e.target.files])} />
      </div>

      <div className="banner" style={{ marginTop: 16 }}>
        Ré-importer une période qui se chevauche est sans risque : les doublons sont
        ignorés (empreinte date + libellé + montant).
      </div>

      {reports.length > 0 && (
        <div className="card" style={{ marginTop: 18 }}>
          <h3>Imports récents</h3>
          <table>
            <thead><tr><th>Fichier</th><th>Résultat</th>
              <th style={{ textAlign: 'right' }}>Ajoutées</th>
              <th style={{ textAlign: 'right' }}>Doublons</th></tr></thead>
            <tbody>
              {reports.map((r, i) => (
                <tr key={i}>
                  <td className="lib">{r.name}</td>
                  <td>{r.ok
                    ? <span className="cat-pill" style={{ color: 'var(--emerald)' }}>importé</span>
                    : <span className="cat-pill empty">erreur : {r.err}</span>}</td>
                  <td className="num">{r.ok ? r.ajoutees : '—'}</td>
                  <td className="num muted">{r.ok ? r.doublons_ignores : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {reports.some((r) => r.ok && r.soldes_maj?.length > 0) && (
            <p className="muted" style={{ fontSize: 12.5, marginTop: 12, marginBottom: 0 }}>
              Soldes de comptes mis à jour automatiquement :{' '}
              {reports.flatMap((r) => r.soldes_maj || [])
                .map((s) => `${s.compte} → ${eur(s.solde)}`).join(' · ')}
            </p>
          )}
        </div>
      )}
    </>
  )
}
