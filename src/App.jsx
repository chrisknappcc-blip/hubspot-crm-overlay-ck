import { useState, useEffect } from 'react'
import { useAuth, useUser, SignIn } from '@clerk/clerk-react'
import { apiFetch } from './api'
import Dashboard from './Dashboard'

export default function App() {
  const { isLoaded, isSignedIn, getToken } = useAuth()
  const { user } = useUser()
  const [theme, setTheme] = useState(() => localStorage.getItem('crm-theme') || 'light')
  const [hsConnected, setHsConnected] = useState(false)
  const [checkingConnection, setCheckingConnection] = useState(true)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('crm-theme', theme)
  }, [theme])

  const toggleTheme = () => setTheme(t => t === 'light' ? 'dark' : 'light')

  useEffect(() => {
    if (!isSignedIn) return
    apiFetch('/api/hubspot/status', getToken)
      .then(d => setHsConnected(d.hubspot))
      .catch(() => setHsConnected(false))
      .finally(() => setCheckingConnection(false))
  }, [isSignedIn, getToken])

  if (!isLoaded) return <LoadingScreen />

  if (!isSignedIn) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', minHeight:'100vh', background:'var(--bg)' }}>
      <div>
        <div style={{ textAlign:'center', marginBottom:'2rem' }}>
          <div style={{ fontSize:13, fontWeight:500, letterSpacing:'.06em', textTransform:'uppercase', color:'var(--text-tertiary)', marginBottom:8 }}>CarePathIQ</div>
          <h1 style={{ fontSize:26, fontWeight:500, color:'var(--text)' }}>Sales Command Center</h1>
        </div>
        <SignIn afterSignInUrl="/" />
      </div>
    </div>
  )

  if (checkingConnection) return <LoadingScreen />

  if (!hsConnected) return (
    <ConnectHubSpot
      getToken={getToken}
      onConnected={() => setHsConnected(true)}
    />
  )

  return (
    <Dashboard
      user={user}
      theme={theme}
      toggleTheme={toggleTheme}
      getToken={getToken}
    />
  )
}

function LoadingScreen() {
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', minHeight:'100vh', background:'var(--bg)' }}>
      <div style={{ textAlign:'center' }}>
        <div style={{ width:32, height:32, border:'2px solid rgba(0,0,0,0.1)', borderTopColor:'var(--accent)', borderRadius:'50%', animation:'spin 0.8s linear infinite', margin:'0 auto 12px' }} />
        <div style={{ fontSize:13, color:'var(--text-tertiary)' }}>Loading...</div>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}

function ConnectHubSpot({ getToken, onConnected }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const handleConnect = async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch('/api/hubspot/auth/connect', getToken)
      if (data.authUrl) {
        window.location.href = data.authUrl
      } else {
        setError('Could not get HubSpot authorization URL. Please try again.')
      }
    } catch (err) {
      console.error('HubSpot connect error:', err)
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', minHeight:'100vh', background:'var(--bg)' }}>
      <div style={{ background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'2.5rem', maxWidth:400, width:'100%', textAlign:'center' }}>
        <div style={{ width:48, height:48, background:'var(--accent-light)', borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 1.5rem' }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>
          </svg>
        </div>
        <h2 style={{ fontSize:18, fontWeight:500, marginBottom:8, color:'var(--text)' }}>Connect HubSpot</h2>
        <p style={{ fontSize:13, color:'var(--text-secondary)', marginBottom:'1.5rem', lineHeight:1.6 }}>
          Authorize CarePathIQ to read your contacts, signals, and activity feed from HubSpot.
        </p>
        {error && (
          <div style={{ fontSize:12, color:'var(--red)', background:'var(--red-light)', borderRadius:'var(--radius)', padding:'8px 12px', marginBottom:'1rem' }}>
            {error}
          </div>
        )}
        <button
          onClick={handleConnect}
          disabled={loading}
          style={{ background:'var(--accent)', color:'#fff', border:'none', borderRadius:'var(--radius)', padding:'10px 24px', fontSize:14, fontWeight:500, cursor: loading ? 'not-allowed' : 'pointer', width:'100%', opacity: loading ? 0.7 : 1 }}>
          {loading ? 'Connecting...' : 'Connect HubSpot'}
        </button>
      </div>
    </div>
  )
}
