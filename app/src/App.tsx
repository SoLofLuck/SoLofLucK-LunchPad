import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import '@solana/wallet-adapter-react-ui/styles.css'
import { Header } from './components/Header'
import { Ticker } from './components/Ticker'
import { NETWORK, PROGRAM_ID, RPC_URL } from './lib/config'
import { AddrLink } from './components/ui'
import { Creator } from './pages/Creator'
import { Create } from './pages/Create'
import { Home } from './pages/Home'
import { How } from './pages/How'
import { TokenPage } from './pages/Token'
import { useRoute } from './router'

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
        {route.page === 'home' && <Home />}
        {route.page === 'create' && <Create />}
        {route.page === 'creator' && <Creator />}
        {route.page === 'how' && <How />}
        {route.page === 'token' && <TokenPage key={route.mint} mintStr={route.mint} />}
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
