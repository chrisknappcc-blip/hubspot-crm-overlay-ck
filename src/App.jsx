import { useState, useEffect, useRef } from 'react'
import { apiFetch } from './api'
import Dashboard from './Dashboard'

// ── Read URL tokens at module load (before anything can clear the hash) ──────
// Read from __INITIAL_HASH__ which is set before the identity widget loads and clears it
const _loadHash   = typeof window !== 'undefined' ? (window.__INITIAL_HASH__ || window.location.hash) : ''
const _loadParams = new URLSearchParams(_loadHash.slice(1))
const _inviteToken     = _loadParams.get('invite_token')     || null
const _recoveryToken   = _loadParams.get('recovery_token')   || null
const _confirmToken    = _loadParams.get('confirmation_token') || null
const _emailChgToken   = _loadParams.get('email_change_token') || null
const _hasAnyToken     = !!(_inviteToken || _recoveryToken || _confirmToken || _emailChgToken)

const netlifyIdentity = window.netlifyIdentity

// GoTrue base URL
const GOTRUE = '/.netlify/identity'

// Store a GoTrue auth response into localStorage so the widget picks it up on init()
function storeSession(resp) {
  const user  = resp.user || resp
  const token = {
    access_token:  resp.access_token,
    token_type:    resp.token_type    || 'bearer',
    expires_in:    resp.expires_in    || 3600,
    refresh_token: resp.refresh_token || '',
    expires_at:    Math.round(Date.now() / 1000) + (resp.expires_in || 3600),
  }
  localStorage.setItem('gotrue.user', JSON.stringify({ ...user, url: GOTRUE, token }))
}

// ── Token-processing screen shown before the widget inits ─────────────────────
// Handles confirmation, recovery, and email-change tokens via direct GoTrue API
// so we never depend on the widget's modal for these flows.
function TokenProcessScreen({ onDone }) {
  const [status, setStatus]   = useState('processing') // processing | needsPassword | done | error
  const [error, setError]     = useState(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm]   = useState('')
  const [saving, setSaving]     = useState(false)
  const sessionRef = useRef(null)

  useEffect(() => {
    ;(async () => {
      try {
        if (_confirmToken) {
          // Email confirmation — just verify and log in
          const r = await fetch(`${GOTRUE}/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: _confirmToken, type: 'signup' }),
          })
          if (!r.ok) throw new Error(`Confirmation failed (${r.status}). The link may have expired — request a new one.`)
          const data = await r.json()
          storeSession(data)
          setStatus('done')
          setTimeout(() => onDone(), 1200)
        }

        if (_recoveryToken) {
          // Recovery — exchange token for session, then show set-password form
          const r = await fetch(`${GOTRUE}/recover`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: _recoveryToken }),
          })
          if (!r.ok) throw new Error(`Reset link invalid or expired (${r.status}). Request a new one.`)
          const data = await r.json()
          storeSession(data)
          sessionRef.current = data
          setStatus('needsPassword')
        }

        if (_emailChgToken) {
          // Email change confirmation
          const r = await fetch(`${GOTRUE}/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: _emailChgToken, type: 'email_change' }),
          })
          if (!r.ok) throw new Error(`Email change failed (${r.status}).`)
          const data = await r.json()
          storeSession(data)
          setStatus('done')
          setTimeout(() => onDone(), 1200)
        }
      } catch (e) {
        setError(e.message)
        setStatus('error')
      }
    })()
  }, [])

  const handleSetPassword = async () => {
    if (!password || password.length < 6) return
    if (password !== confirm) return
    setSaving(true)
    try {
      const stored = JSON.parse(localStorage.getItem('gotrue.user') || '{}')
      const accessToken = stored?.token?.access_token
      if (!accessToken) throw new Error('Session lost — please request a new reset link.')
      const r = await fetch(`${GOTRUE}/user`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ password }),
      })
      if (!r.ok) throw new Error(`Could not update password (${r.status}).`)
      await r.json()
      setStatus('done')
      setTimeout(() => onDone(), 1200)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const box = { background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'2.5rem', maxWidth:420, width:'100%', textAlign:'center' }
  const input = { width:'100%', padding:'10px 12px', marginBottom:10, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--bg)', color:'var(--text)', fontSize:14, boxSizing:'border-box' }

  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', minHeight:'100vh', background:'var(--bg)' }}>
      <div style={box}>
        <div style={{ fontSize:13, fontWeight:500, letterSpacing:'.06em', textTransform:'uppercase', color:'var(--text-tertiary)', marginBottom:8 }}>CarePathIQ</div>

        {status === 'processing' && (
          <>
            <h2 style={{ fontSize:18, fontWeight:500, color:'var(--text)', marginBottom:8 }}>Verifying…</h2>
            <p style={{ fontSize:13, color:'var(--text-secondary)' }}>Hang tight while we process your link.</p>
          </>
        )}

        {status === 'done' && (
          <>
            <div style={{ fontSize:32, marginBottom:8 }}>✓</div>
            <h2 style={{ fontSize:18, fontWeight:500, color:'var(--text)', marginBottom:8 }}>
              {_recoveryToken ? 'Password updated!' : 'Email confirmed!'}
            </h2>
            <p style={{ fontSize:13, color:'var(--text-secondary)' }}>Signing you in…</p>
          </>
        )}

        {status === 'error' && (
          <>
            <div style={{ fontSize:32, marginBottom:8 }}>⚠️</div>
            <h2 style={{ fontSize:18, fontWeight:500, color:'var(--text)', marginBottom:8 }}>Link problem</h2>
            <p style={{ fontSize:13, color:'var(--red)', marginBottom:16 }}>{error}</p>
            <button onClick={() => { window.location.href = '/' }} style={{ padding:'10px 24px', background:'var(--accent)', color:'#fff', border:'none', borderRadius:'var(--radius)', fontSize:14, cursor:'pointer' }}>
              Back to sign in
            </button>
          </>
        )}

        {status === 'needsPassword' && (
          <>
            <h2 style={{ fontSize:18, fontWeight:500, color:'var(--text)', marginBottom:4 }}>Set your password</h2>
            <p style={{ fontSize:13, color:'var(--text-secondary)', marginBottom:'1.2rem' }}>Choose a new password to complete your reset.</p>
            <form onSubmit={e => { e.preventDefault(); handleSetPassword() }} style={{ width:'100%' }}>
              <input type="password" placeholder="New password" value={password} onChange={e => setPassword(e.target.value)} style={input} autoComplete="new-password" />
              <input type="password" placeholder="Confirm password" value={confirm} onChange={e => setConfirm(e.target.value)} style={{ ...input, marginBottom:16 }} autoComplete="new-password" />
              {error && <div style={{ fontSize:12, color:'var(--red)', marginBottom:12 }}>{error}</div>}
              {password && confirm && password !== confirm && (
                <div style={{ fontSize:12, color:'var(--red)', marginBottom:12 }}>Passwords don't match</div>
              )}
              <button type="submit"
                disabled={saving || !password || password.length < 6 || password !== confirm}
                style={{ width:'100%', padding:'10px 24px', background:'var(--accent)', color:'#fff', border:'none', borderRadius:'var(--radius)', fontSize:14, fontWeight:500, cursor:'pointer', opacity: (saving || !password || password.length < 6 || password !== confirm) ? 0.5 : 1 }}>
                {saving ? 'Saving…' : 'Set Password'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}

function InviteScreen({ inviteToken, onLogin }) {
  const [name, setName]       = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm]   = useState('')
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState(null)

  const handleSubmit = async () => {
    if (!name.trim())              { setError('Enter your full name.'); return }
    if (password.length < 6)       { setError('Password must be at least 6 characters.'); return }
    if (password !== confirm)      { setError('Passwords don\'t match.'); return }
    setLoading(true); setError(null)
    try {
      const user = await netlifyIdentity.gotrue.acceptInvite(inviteToken, password, { data: { full_name: name.trim() } })
      onLogin(user)
    } catch (e) {
      setError(e.message || 'Invite link invalid or expired — ask for a new one.')
    } finally { setLoading(false) }
  }

  const box   = { background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'2.5rem', maxWidth:420, width:'100%', textAlign:'center' }
  const input = { width:'100%', padding:'10px 12px', marginBottom:10, border:'1px solid var(--border)', borderRadius:'var(--radius)', background:'var(--bg)', color:'var(--text)', fontSize:14, boxSizing:'border-box' }

  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', minHeight:'100vh', background:'var(--bg)' }}>
      <div style={box}>
        <div style={{ fontSize:13, fontWeight:500, letterSpacing:'.06em', textTransform:'uppercase', color:'var(--text-tertiary)', marginBottom:8 }}>CarePathIQ</div>
        <h2 style={{ fontSize:20, fontWeight:500, color:'var(--text)', marginBottom:4 }}>Accept Invitation</h2>
        <p style={{ fontSize:13, color:'var(--text-secondary)', marginBottom:'1.5rem' }}>Create your Cipher account to get started.</p>
        <form onSubmit={e => { e.preventDefault(); handleSubmit() }} style={{ width:'100%' }}>
          <input type="text" placeholder="Full name" value={name} onChange={e => setName(e.target.value)} style={input} autoComplete="name" />
          <input type="password" placeholder="Choose a password" value={password} onChange={e => setPassword(e.target.value)} style={input} autoComplete="new-password" />
          <input type="password" placeholder="Confirm password" value={confirm} onChange={e => setConfirm(e.target.value)} style={{ ...input, marginBottom:16 }} autoComplete="new-password" />
          {error && <div style={{ fontSize:12, color:'var(--red)', marginBottom:12 }}>{error}</div>}
          <button type="submit" disabled={loading || !name || !password || !confirm}
            style={{ width:'100%', padding:'10px 24px', background:'var(--accent)', color:'#fff', border:'none', borderRadius:'var(--radius)', fontSize:14, fontWeight:500, cursor:'pointer', opacity: (loading || !name || !password || !confirm) ? 0.6 : 1 }}>
            {loading ? 'Setting up…' : 'Accept Invitation'}
          </button>
        </form>
      </div>
    </div>
  )
}

export default function App() {
  const [user,       setUser]       = useState(null)
  const [isLoaded,   setIsLoaded]   = useState(false)
  const [hsConnected, setHsConnected] = useState(false)
  const [needsReconnect, setNeedsReconnect] = useState(false)
  const [checkingConnection, setCheckingConnection] = useState(true)
  const [tokenDone,  setTokenDone]  = useState(false)

  // ── Phase 1: Handle token URLs directly (before widget init) ─────────────
  // If there's any token in the URL, show TokenProcessScreen first.
  // It calls GoTrue directly, stores the session, then calls onDone().
  // onDone() clears the hash and triggers widget init to pick up the session.
  const [tokenPhase, setTokenPhase] = useState(
    _hasAnyToken && !_inviteToken ? 'token' : 'init'
  )

  const finishTokenPhase = () => {
    // Clear the hash so the widget doesn't also try to process it
    history.replaceState(null, '', window.location.pathname)
    setTokenPhase('init')
  }

  // ── Phase 2: Normal widget init ───────────────────────────────────────────
  useEffect(() => {
    if (tokenPhase !== 'init') return

    netlifyIdentity.on('init', (u) => {
      setUser(u || null)
      setIsLoaded(true)
    })

    netlifyIdentity.on('login', (u) => {
      setUser(u)
      netlifyIdentity.close()
    })

    netlifyIdentity.on('logout', () => setUser(null))
    netlifyIdentity.on('error', (e) => console.error('[identity]', e))

    netlifyIdentity.init()
  }, [tokenPhase])

  // ── HubSpot connection check ───────────────────────────────────────────────
  useEffect(() => {
    if (!user) { setCheckingConnection(false); return }
    setCheckingConnection(true)
    apiFetch('/api/hubspot/status', () => user.jwt())
      .then(d => { setHsConnected(!!d.hubspot); setNeedsReconnect(!d.hubspot) })
      .catch(() => { setHsConnected(false); setNeedsReconnect(true) })
      .finally(() => setCheckingConnection(false))
  }, [user?.id])

  // ── Render ─────────────────────────────────────────────────────────────────

  // Token flows that bypass the widget
  if (tokenPhase === 'token') {
    return <TokenProcessScreen onDone={finishTokenPhase} />
  }

  // Invite flow — shown before sign-in (user not yet logged in)
  if (isLoaded && !user && _inviteToken) {
    return (
      <InviteScreen
        inviteToken={_inviteToken}
        onLogin={(u) => { setUser(u); setCheckingConnection(true) }}
      />
    )
  }

  // Loading
  if (!isLoaded || checkingConnection) {
    return (
      <div style={{ display:'flex', alignItems:'center', justifyContent:'center', minHeight:'100vh', background:'var(--bg)' }}>
        <div style={{ width:24, height:24, border:'2px solid var(--border)', borderTopColor:'var(--accent)', borderRadius:'50%', animation:'spin 0.8s linear infinite' }} />
      </div>
    )
  }

  // Not logged in
  if (!user) {
    return (
      <div style={{ display:'flex', alignItems:'center', justifyContent:'center', minHeight:'100vh', background:'var(--bg)' }}>
        <div style={{ textAlign:'center' }}>
          <div style={{ fontSize:13, fontWeight:500, letterSpacing:'.06em', textTransform:'uppercase', color:'var(--text-tertiary)', marginBottom:8 }}>CarePathIQ</div>
          <h1 style={{ fontSize:22, fontWeight:500, color:'var(--text)', marginBottom:'1.5rem' }}>Sales Command Center</h1>
          <button onClick={() => netlifyIdentity.open()}
            style={{ padding:'10px 28px', background:'var(--accent)', color:'#fff', border:'none', borderRadius:'var(--radius)', fontSize:15, fontWeight:500, cursor:'pointer' }}>
            Sign in
          </button>
        </div>
      </div>
    )
  }

  // Connect HubSpot
  if (!hsConnected || needsReconnect) {
    return <ConnectHubSpot user={user} onConnect={() => { setHsConnected(true); setNeedsReconnect(false) }} />
  }

  // Main app
  return <Dashboard user={user} onSignOut={() => { netlifyIdentity.logout(); setUser(null) }} onNeedsReconnect={(msg) => { setHsConnected(false); setNeedsReconnect(true) }} />
}

function ConnectHubSpot({ user, onConnect }) {
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)

  const startOAuth = async () => {
    setLoading(true); setError(null)
    try {
      const r = await fetch('/api/hubspot/auth', {
        headers: { Authorization: `Bearer ${await user.jwt()}` }
      })
      const d = await r.json()
      if (d.url) window.location.href = d.url
      else throw new Error(d.error || 'Could not start OAuth')
    } catch (e) { setError(e.message); setLoading(false) }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('code')) {
      setLoading(true)
      ;(async () => {
        try {
          const jwt = await user.jwt()
          const r = await fetch(`/api/hubspot/callback${window.location.search}`, {
            headers: { Authorization: `Bearer ${jwt}` }
          })
          const d = await r.json()
          if (d.ok) { history.replaceState(null, '', '/'); onConnect() }
          else throw new Error(d.error)
        } catch (e) { setError(e.message); setLoading(false) }
      })()
    }
  }, [])

  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', minHeight:'100vh', background:'var(--bg)' }}>
      <div style={{ background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'2.5rem', maxWidth:420, textAlign:'center' }}>
        <div style={{ fontSize:13, fontWeight:500, letterSpacing:'.06em', textTransform:'uppercase', color:'var(--text-tertiary)', marginBottom:8 }}>CarePathIQ</div>
        <h2 style={{ fontSize:20, fontWeight:500, color:'var(--text)', marginBottom:4 }}>Connect HubSpot</h2>
        <p style={{ fontSize:13, color:'var(--text-secondary)', marginBottom:'1.5rem' }}>Link your HubSpot account to get started.</p>
        {error && <div style={{ fontSize:12, color:'var(--red)', marginBottom:12 }}>{error}</div>}
        {loading
          ? <div style={{ fontSize:13, color:'var(--text-secondary)' }}>Connecting…</div>
          : <button onClick={startOAuth}
              style={{ padding:'10px 28px', background:'var(--accent)', color:'#fff', border:'none', borderRadius:'var(--radius)', fontSize:14, fontWeight:500, cursor:'pointer' }}>
              Connect HubSpot
            </button>
        }
        <div style={{ marginTop:16 }}>
          <button onClick={() => netlifyIdentity.logout()} style={{ fontSize:12, color:'var(--text-tertiary)', background:'none', border:'none', cursor:'pointer' }}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  )
}
