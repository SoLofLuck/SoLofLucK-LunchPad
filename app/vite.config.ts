import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// Relative base: the site works at a domain root and under a GitHub Pages
// project path alike. Routing is hash-based for the same reason.
export default defineConfig({
  base: './',
  plugins: [
    react(),
    // The Solana libraries expect Node's Buffer/process in the browser.
    nodePolyfills({
      include: ['buffer', 'process', 'crypto', 'stream', 'util'],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  build: { chunkSizeWarningLimit: 2500 },
})
