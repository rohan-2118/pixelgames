import { defineConfig } from 'vite'

// SPA History API: Vite preview/dev already falls back to index.html for
// unknown paths. Firebase Hosting serves prerendered /games/*/index.html
// files first, then rewrites the rest to /index.html.
export default defineConfig({
  appType: 'spa',
  build: {
    sourcemap: false,
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
  },
  preview: {
    port: 4173,
  },
})
