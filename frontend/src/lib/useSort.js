import { useState } from 'react'

// Tri de colonnes réutilisable (même comportement que la page Opérations) :
// clic sur un en-tête = tri sur cette colonne, re-clic = sens inverse.
// `accessors` : { cle: (ligne) => valeur } — chaîne (tri alphabétique fr)
// ou nombre (null/undefined relégués en fin de liste).
export function useSort(defaultKey, defaultDir = -1) {
  const [tri, setTri] = useState({ key: defaultKey, dir: defaultDir })
  const toggle = (key, firstDir = -1) =>
    setTri((t) => ({ key, dir: t.key === key ? -t.dir : firstDir }))
  const sortRows = (rows, accessors) => [...rows].sort((a, b) => {
    const va = accessors[tri.key](a), vb = accessors[tri.key](b)
    if (typeof va === 'string' || typeof vb === 'string')
      return String(va ?? '').localeCompare(String(vb ?? ''), 'fr') * tri.dir
    return ((va ?? -Infinity) - (vb ?? -Infinity)) * tri.dir
  })
  return { tri, toggle, sortRows }
}

// Flèche d'en-tête : ▲/▼ sur la colonne active.
export const arrow = (tri, key) =>
  tri.key === key ? (tri.dir === 1 ? ' ▲' : ' ▼') : ''
