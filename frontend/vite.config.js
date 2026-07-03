import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base './' : fonctionne quel que soit le chemin où FastAPI sert le build.
// proxy : en développement, les appels /api partent vers le backend sur :8000.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    // Chunks stables : react (vendor) et recharts+d3 (charts) changent rarement
    // -> cache navigateur conservé entre déploiements. recharts ne se charge
    // qu'avec les pages à graphiques, pas sur l'écran de connexion.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          return /node_modules\/(react|react-dom|scheduler)\//.test(id)
            ? 'vendor' : 'charts'
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
})
