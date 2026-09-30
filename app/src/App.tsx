import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import '@solana/wallet-adapter-react-ui/styles.css'
import { Header } from './components/Header'
import { Ticker } from './components/Ticker'
import { NETWORK, PROGRAM_ID, RPC_URL } from './lib/config'
import { AddrLink } from './components/ui'
import { lazy, Suspense } from 'react'
import { Boundary } from './components/Boundary'
import { Home } from './pages/Home'
import { useRoute } from './router'

// The board loads eagerly; everything else (the chart library in particular)
// is fetched on first visit.
const Create = lazy(() => import('./pages/Create').then((m) => ({ default: m.Create })))
const Creator = lazy(() => import('./pages/Creator').then((m) => ({ default: m.Creator })))
const How = lazy(() => import('./pages/How').then((m) => ({ default: m.How })))
const TokenPage = lazy(() => import('./pages/Token').then((m) => ({ default: m.TokenPage })))

// Wallets that implement the Wallet Standard (Phantom, Solflare, Backpack, …)
// are detected automatically; no per-wallet adapters are bundled.
const wallets: never[] = []

function Page() {
  const route = useRoute()
  return (
    <>
      <Header route={route} />
      <Ticker />
      <main>
        <Boundary key={route.page === 'token' ? route.mint : route.page}>
          <Suspense fallback={<div className="container"><div className="skeleton" style={{ height: 320 }} /></div>}>
            {route.page === 'home' && <Home />}
            {route.page === 'create' && <Create />}
            {route.page === 'creator' && <Creator />}
            {route.page === 'how' && <How />}
            {route.page === 'token' && <TokenPage key={route.mint} mintStr={route.mint} />}
          </Suspense>
        </Boundary>
      </main>
      <footer>
        <div className="container row wrap">
          <span>🍀 SoLofLuck LaunchPad · {NETWORK === 'devnet' ? 'Devnet' : 'Mainnet'}</span>
          <span className="spacer" />
          <span>
            Program <AddrLink addr={PROGRAM_ID.toBase58()} />
          </span>
        </div>
      </footer>
    </>
  )
}

export default function App() {
  return (
    <ConnectionProvider endpoint={RPC_URL} config={{ commitment: 'confirmed' }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <Page />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}
