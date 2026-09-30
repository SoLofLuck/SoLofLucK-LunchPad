import { Component, type ReactNode } from 'react'

/** Keeps one broken page from blanking the whole site. */
export class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="container empty">
        <div style={{ fontSize: 40 }}>🍀</div>
        <p>Something went wrong on this page.</p>
        <p className="small muted mono">{this.state.error.message}</p>
        <button className="btn" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    )
  }
}
