import React from 'react'
import ReactDOM from 'react-dom/client'
import { ClerkProvider } from '@clerk/clerk-react'
import App from './App'
import './index.css'

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

if (!PUBLISHABLE_KEY) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env')
}

// Clerk v5 has a circular reference bug that fires a TDZ during cold init
// when there is no existing session. If we catch it and reload, Clerk finds
// the session cookie on the second load and takes a different code path.
// sessionStorage guard prevents an infinite reload loop.
window.addEventListener('error', (e) => {
  if (e?.message?.includes('Cannot access') && e?.message?.includes('before initialization')) {
    const key = 'clerk_init_reload'
    const last = parseInt(sessionStorage.getItem(key) || '0')
    if (Date.now() - last > 15000) {
      sessionStorage.setItem(key, String(Date.now()))
      window.location.reload()
    }
  }
})

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ClerkProvider publishableKey={PUBLISHABLE_KEY}>
      <App />
    </ClerkProvider>
  </React.StrictMode>
)
