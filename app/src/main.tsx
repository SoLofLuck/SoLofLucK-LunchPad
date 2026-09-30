import { Buffer } from 'buffer'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

// Some Solana libraries read the global Buffer at import time.
;(globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
