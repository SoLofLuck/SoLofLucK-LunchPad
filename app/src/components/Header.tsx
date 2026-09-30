import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { NETWORK } from '../lib/config'
import { href, type Route } from '../router'

export function Header({ route }: { route: Route }) {
  const link = (to: string, label: string, active: boolean) => (
    <a href={to} className={active ? 'active' : ''}>
      {label}
    </a>
  )
  return (
    <header className="header">
      <div className="container header-inner">
        <a className="brand" href={href.home}>
          <span className="clover">🍀</span>
          <span className="word">
            SoLofLuck <span className="gold">LaunchPad</span>
          </span>
        </a>
        <nav className="nav">
          {link(href.home, 'Board', route.page === 'home')}
          {link(href.create, 'Create', route.page === 'create')}
          {link(href.creator, 'Creator', route.page === 'creator')}
          {link(href.how, 'How it works', route.page === 'how')}
        </nav>
        <span className="net-badge">{NETWORK === 'devnet' ? 'Devnet' : 'Mainnet'}</span>
        <WalletMultiButton />
      </div>
    </header>
  )
}
