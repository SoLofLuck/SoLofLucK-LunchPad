import { useEffect, useState } from 'react'

// Hash routing: works on any static host (GitHub Pages included) with no
// server-side rewrites.
export type Route =
  | { page: 'home' }
  | { page: 'create' }
  | { page: 'creator' }
  | { page: 'token'; mint: string }
  | { page: 'how' }

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '')
  const [head, arg] = path.split('/')
  if (head === 'create') return { page: 'create' }
  if (head === 'creator') return { page: 'creator' }
  if (head === 'how') return { page: 'how' }
  if (head === 'token' && arg) return { page: 'token', mint: arg }
  return { page: 'home' }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash))
  useEffect(() => {
    const on = () => {
      setRoute(parseRoute(window.location.hash))
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route
}

export const href = {
  home: '#/',
  create: '#/create',
  creator: '#/creator',
  how: '#/how',
  token: (mint: string) => `#/token/${mint}`,
}

export const navigate = (to: string) => {
  window.location.hash = to.replace(/^#/, '')
}
