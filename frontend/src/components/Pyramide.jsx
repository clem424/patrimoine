import React from 'react'
import { eur0 } from '../lib/api.js'

// Pyramide patrimoniale — 4 étages (inspirée de « La finance sans migraine »).
// La HAUTEUR de chaque étage est proportionnelle au montant qu'il contient
// (avec un minimum pour rester lisible) ; la silhouette reste un vrai triangle.
const NIVEAUX = [ // du sommet vers la base
  {
    id: 'optimisation', titre: 'Optimisation',
    desc: 'Transmission, fiscalité, stratégies avancées',
    types: [], color: '#7CBE8C',
  },
  {
    id: 'diversification', titre: 'Diversification',
    desc: 'Immobilier avancé, placements alternatifs, collections…',
    types: ['crypto', 'pokemon', 'autre'], catchAll: true, color: '#2F7B4E',
  },
  {
    id: 'croissance', titre: 'Croissance',
    desc: 'Investissements simples (ETF, PEA, assurance-vie…), DCA, intérêts composés',
    types: ['pea'], color: '#1B5638',
  },
  {
    id: 'securite', titre: 'Sécurité financière',
    desc: 'Budget clair, épargne de précaution, zéro dette conso',
    types: ['compte_courant', 'livret_a', 'livret_jeune'], color: '#123B2A',
  },
]

const H_MIN = 42        // hauteur plancher d'un étage (lisibilité)
const H_SCALE = 300     // hauteur répartie au prorata des montants
const W_APEX = 10       // largeur (%) au sommet du triangle

export default function Pyramide({ assets }) {
  const total = assets.reduce((s, a) => s + (a.valeur || 0), 0)

  // Les types personnalisés (inconnus des autres étages) vont en Diversification.
  const connus = NIVEAUX.flatMap((n) => n.types)
  const niveaux = NIVEAUX.map((n) => {
    const items = assets
      .filter((a) => (n.types.includes(a.type)
        || (n.catchAll && !connus.includes(a.type))) && (a.valeur || 0) > 0)
      .sort((x, y) => (y.valeur || 0) - (x.valeur || 0))
    return { ...n, items, total: items.reduce((s, a) => s + (a.valeur || 0), 0) }
  })

  const somme = niveaux.reduce((s, n) => s + n.total, 0)
  const heights = niveaux.map((n) =>
    H_MIN + (somme > 0 ? (n.total / somme) * H_SCALE : H_SCALE / 4))
  const H = heights.reduce((a, b) => a + b, 0)
  // Largeur du triangle à la profondeur y (0 = sommet) -> % du conteneur.
  const wAt = (y) => W_APEX + (100 - W_APEX) * (y / H)

  let y = 0
  return (
    <div className="pyramide">
      {niveaux.map((n, i) => {
        const h = heights[i]
        const wTop = wAt(y), wBas = wAt(y + h)
        y += h
        const clip = `polygon(${(100 - wTop) / 2}% 0, ${(100 + wTop) / 2}% 0,
                              ${(100 + wBas) / 2}% 100%, ${(100 - wBas) / 2}% 100%)`
        const pct = somme > 0 ? Math.round((n.total / somme) * 100) : 0
        const noms = n.items.map((a) => a.nom)
        const detail = noms.length > 3
          ? `${noms.slice(0, 3).join(' · ')} +${noms.length - 3}`
          : noms.join(' · ')
        // Assez de place pour écrire dedans ? Sinon l'étiquette sort à droite.
        const inside = h >= 76 && (wTop + wBas) / 2 >= 45

        return (
          <div key={n.id} className="pyr-row" style={{ height: h }}>
            <div className={'pyr-level' + (n.total === 0 ? ' vide' : '')}
              style={{ background: n.color, clipPath: clip }}>
              {inside && (
                <>
                  <div className="pyr-titre">{n.titre}</div>
                  {n.total > 0 && (
                    <div className="pyr-montant">
                      {eur0(n.total)}<span className="pyr-pct"> · {pct}%</span>
                    </div>
                  )}
                  <div className="pyr-desc">{detail || n.desc}</div>
                </>
              )}
            </div>
            {!inside && (
              <div className="pyr-label"
                style={{ left: `${(100 + Math.max(wTop, wBas)) / 2}%` }}>
                <span className="pyr-titre">{n.titre}</span>
                {n.total > 0
                  ? <span className="pyr-montant"> {eur0(n.total)}
                      <span className="pyr-pct"> · {pct}%</span></span>
                  : <span className="pyr-pct"> {n.desc}</span>}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
