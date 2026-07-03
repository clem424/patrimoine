// Client API — toutes les requêtes vers le backend FastAPI (/api/*).
// La session (profil connecté) est un jeton stocké en localStorage, envoyé
// dans l'en-tête Authorization. Un 401 déclenche l'événement 'auth-expired'
// (App.jsx réaffiche alors l'écran de connexion).

let TOKEN = localStorage.getItem('patrimoine_token') || null
export const setToken = (t) => {
  TOKEN = t
  if (t) localStorage.setItem('patrimoine_token', t)
  else localStorage.removeItem('patrimoine_token')
}
export const hasToken = () => !!TOKEN

const q = (url, opts = {}) => {
  const headers = { ...(opts.headers || {}) }
  if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN
  if (opts.body && !(opts.body instanceof FormData))
    headers['Content-Type'] = 'application/json'
  return fetch(url, { ...opts, headers }).then(async (r) => {
    if (r.status === 401 && !url.startsWith('/api/auth/log')) {
      setToken(null)
      window.dispatchEvent(new Event('auth-expired'))
      throw new Error('Session expirée')
    }
    if (!r.ok) {
      let detail = 'HTTP ' + r.status
      try { detail = (await r.json()).detail || detail } catch { /* corps non JSON */ }
      throw new Error(detail)
    }
    return r.json()
  })
}
const POST  = (body) => ({ method: 'POST',  body: JSON.stringify(body) })
const PATCH = (body) => ({ method: 'PATCH', body: JSON.stringify(body) })

export const api = {
  // ---- profils ----
  register: (pseudo, password) => q('/api/auth/register', POST({ pseudo, password })),
  login:    (pseudo, password) => q('/api/auth/login',    POST({ pseudo, password })),
  logout:   () => q('/api/auth/logout', { method: 'POST' }),
  me:       () => q('/api/auth/me'),
  changePassword: (ancien, nouveau) => q('/api/auth/password', POST({ ancien, nouveau })),

  dashboard:    () => q('/api/dashboard'),
  transactions: (limit = 2000) => q(`/api/transactions?limit=${limit}`),
  categories:   () => q('/api/categories'),
  assets:       () => q('/api/assets'),

  importFile: (file) => {
    const fd = new FormData(); fd.append('file', file);
    return q('/api/import', { method: 'POST', body: fd });
  },
  categorize: (useOllama = true) =>
    q(`/api/categorize?use_ollama=${useOllama}`, { method: 'POST' }),
  recategorize: () => q('/api/recategorize', { method: 'POST' }),
  setCategory: (opId, categorie) =>
    q(`/api/transactions/${opId}/category`, PATCH({ categorie })),
  confirmTx: (opId, confirme) =>
    q(`/api/transactions/${opId}/confirm`, POST({ confirme })),
  setDue: (opId, du) =>
    q(`/api/transactions/${opId}/rembourser`, POST({ du })),
  lierOps:  (op_ids) => q('/api/transactions/lier', POST({ op_ids })),
  delierOp: (opId) => q(`/api/transactions/${opId}/delier`, { method: 'POST' }),

  saveAsset:   (a) => q('/api/assets', POST(a)),
  deleteAsset: (id) => q(`/api/assets/${id}`, { method: 'DELETE' }),
  cryptoSearch:(s) => q(`/api/crypto/search?q=${encodeURIComponent(s)}`),
  stockSearch: (s) => q(`/api/stocks/search?q=${encodeURIComponent(s)}`),
  pricesRefresh:() => q('/api/prices/refresh', { method: 'POST' }),
  binanceStatus:() => q('/api/binance/status'),
  binanceSync: () => q('/api/binance/sync', { method: 'POST' }),
  binanceKeysSet: (api_key, api_secret) =>
    q('/api/settings/binance', POST({ api_key, api_secret })),

  categoriesFull: () => q('/api/categories/full'),
  addCategory:    (nom, description = '') => q('/api/categories', POST({ nom, description })),
  patchCategory:  (nom, changes) =>
    q(`/api/categories/${encodeURIComponent(nom)}`, PATCH(changes)),
  deleteCategory: (nom) => q(`/api/categories/${encodeURIComponent(nom)}`,
    { method: 'DELETE' }),

  objectifGet: () => q('/api/settings/objectif'),
  objectifSet: (montant) => q('/api/settings/objectif', POST({ montant })),
  exportCsv: async () => {
    const r = await fetch('/api/export/transactions.csv',
      { headers: TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {} })
    if (!r.ok) throw new Error('Export impossible (HTTP ' + r.status + ')')
    const url = URL.createObjectURL(await r.blob())
    const a = Object.assign(document.createElement('a'),
      { href: url, download: 'operations.csv' })
    a.click(); URL.revokeObjectURL(url)
  },

  assetTypes:      () => q('/api/asset-types'),
  addAssetType:    (label) => q('/api/asset-types', POST({ label })),
  renameAssetType: (slug, label) => q(`/api/asset-types/${slug}`, PATCH({ label })),
  deleteAssetType: (slug) => q(`/api/asset-types/${slug}`, { method: 'DELETE' }),
  toggleMask:      (id) => q(`/api/assets/${id}/masque`, { method: 'PATCH' }),
  depenses:        (periode, decalage = 0) =>
    q(`/api/depenses?periode=${periode}&decalage=${decalage}`),
  depensesMarchands: (categorie, periode, decalage = 0) =>
    q(`/api/depenses/marchands?categorie=${encodeURIComponent(categorie)}`
      + `&periode=${periode}&decalage=${decalage}`),
  projection:      (annees = 10, extra = 0, courants = false) =>
    q(`/api/projection?annees=${annees}&extra=${extra}&courants=${courants}`),
  patrimoinePays:  () => q('/api/patrimoine/pays'),
  croissanceClasses: () => q('/api/croissance-classes'),
  setCroissanceClasse: (slug, pct) => q('/api/croissance-classes',
    { method: 'PUT', body: JSON.stringify({ slug, pct }) }),
  budgetGet:       (mois) => q('/api/budget' + (mois ? `?mois=${mois}` : '')),
  budgetSet:       (categorie, montant) => q('/api/budget',
    { method: 'PUT', body: JSON.stringify({ categorie, montant }) }),
}

// ---- mode confidentialité : masque tous les montants de l'app ----
let HIDE = localStorage.getItem('patrimoine_hide') === '1'
export const isHidden = () => HIDE
export const setHidden = (v) => { HIDE = v; localStorage.setItem('patrimoine_hide', v ? '1' : '0') }
const MASK = '•••• €'

// ---- formatage ----
export const eur = (n) => HIDE ? MASK : (n ?? 0).toLocaleString('fr-FR',
  { style: 'currency', currency: 'EUR' });
export const eur0 = (n) => HIDE ? MASK : (n ?? 0).toLocaleString('fr-FR',
  { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
// montant d'un actif : masqué individuellement (a.masque) ou globalement
export const eurAsset = (a) => (a.masque ? MASK : eur(a.valeur));

// Types personnalisés : injecte leur couleur en variable CSS (--c-<slug>)
// pour que classColor() fonctionne partout (dashboard, pyramide, listes).
export const applyTypeColors = (types) => {
  for (const t of types) if (t.couleur)
    document.documentElement.style.setProperty('--c-' + t.slug, t.couleur)
}
export const dateFr = (s) => new Date(s).toLocaleDateString('fr-FR',
  { day: '2-digit', month: 'short', year: '2-digit' });
export const mois = (s) => {
  const [y, m] = s.split('-');
  return new Date(y, m - 1).toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });
}
export const classColor = (type) =>
  getComputedStyle(document.documentElement).getPropertyValue('--c-' + type).trim() || '#8A93A6';

// Lit une variable CSS du thème courant (pour les couleurs des graphiques).
export const cssVar = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---- thème clair / sombre ----
// Persisté en localStorage ; par défaut, suit la préférence du système.
const THEME_KEY = 'patrimoine_theme'
export const getTheme = () => localStorage.getItem(THEME_KEY)
  || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
export const applyTheme = (t) => {
  document.documentElement.dataset.theme = t
  localStorage.setItem(THEME_KEY, t)
  // Barre système (PWA/mobile) assortie au fond.
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', t === 'dark' ? '#0F1420' : '#17223A')
}
