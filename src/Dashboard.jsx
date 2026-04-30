import { useState, useEffect, useCallback } from 'react'
import { useClerk } from '@clerk/clerk-react'
import { apiFetch } from './api'

// ─── Persona detection ────────────────────────────────────────────────────────
const PERSONAS = {
  cfo:        { label:'CFO',        color:'#1D4ED8', bg:'#EFF6FF' },
  cno:        { label:'CNO',        color:'#0D4D34', bg:'#E3F2EC' },
  ceo:        { label:'CEO',        color:'#6D28D9', bg:'#EDE9FE' },
  vp_finance: { label:'VP Finance', color:'#B45309', bg:'#FEF3C7' },
  vp_strategy:{ label:'VP Strategy',color:'#0369A1', bg:'#E0F2FE' },
  dir_ops:    { label:'Dir. Ops',   color:'#C5372A', bg:'#FCECEA' },
  default:    { label:'Contact',    color:'#6B6A65', bg:'#F0EEE9' },
}

function getPersona(title = '') {
  const t = title.toLowerCase()
  if (t.includes('cfo') || t.includes('chief financial'))       return PERSONAS.cfo
  if (t.includes('cno') || t.includes('chief nursing'))         return PERSONAS.cno
  if (t.includes('ceo') || t.includes('chief executive'))       return PERSONAS.ceo
  if (t.includes('finance') || t.includes('financial'))         return PERSONAS.vp_finance
  if (t.includes('strategy') || t.includes('president'))        return PERSONAS.vp_strategy
  if (t.includes('operat') || t.includes('director'))           return PERSONAS.dir_ops
  return PERSONAS.default
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function initials(name = '') {
  return name.split(' ').map(p => p[0]).filter(Boolean).join('').slice(0,2).toUpperCase() || '??'
}

function timeAgo(ts) {
  if (!ts) return '—'
  const diff = Date.now() - new Date(ts).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1)   return 'Just now'
  if (m < 60)  return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24)  return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30)  return `${d}d ago`
  return new Date(ts).toLocaleDateString('en-US', { month:'short', day:'numeric' })
}

function exactTs(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('en-US', {
    month:  'short',
    day:    'numeric',
    year:   'numeric',
    hour:   'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

function cleanSubject(subject) {
  if (!subject) return 'Marketing email'
  if (/^\d+$/.test(subject)) return 'Marketing email'
  return subject
}

function hsContactUrl(contactId) {
  return contactId ? `https://app.hubspot.com/contacts/default/contact/${contactId}` : null
}

// ─── UI primitives ────────────────────────────────────────────────────────────
function Badge({ label, type = 'default' }) {
  const colors = {
    hot:     { bg:'var(--red-light)',   color:'var(--red)' },
    warm:    { bg:'var(--amber-light)', color:'var(--amber)' },
    reply:   { bg:'var(--accent-light)',color:'var(--accent-text)' },
    click:   { bg:'var(--blue-light)',  color:'var(--blue)' },
    default: { bg:'var(--bg-secondary)',color:'var(--text-secondary)' },
  }
  const c = colors[type] || colors.default
  return (
    <span style={{ display:'inline-block', fontSize:11, fontWeight:500, padding:'2px 8px', borderRadius:20, background:c.bg, color:c.color }}>
      {label}
    </span>
  )
}

function PriorityDot({ level }) {
  const colors = { hot:'var(--red)', warm:'var(--amber)', normal:'var(--accent)' }
  return <div style={{ width:7, height:7, borderRadius:'50%', background:colors[level]||colors.normal, flexShrink:0, marginTop:5 }} />
}

function Avatar({ name, size = 32 }) {
  return (
    <div style={{ width:size, height:size, borderRadius:'50%', background:'var(--accent-light)', color:'var(--accent-text)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:Math.round(size*0.34), fontWeight:500, flexShrink:0 }}>
      {initials(name)}
    </div>
  )
}

function Panel({ children, style = {} }) {
  return (
    <div style={{ background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'1rem 1.25rem', ...style }}>
      {children}
    </div>
  )
}

function SectionTitle({ children }) {
  return (
    <div style={{ fontSize:11, fontWeight:500, letterSpacing:'.06em', textTransform:'uppercase', color:'var(--text-tertiary)', marginBottom:12 }}>
      {children}
    </div>
  )
}

function MetricCard({ label, value, sub, subType }) {
  const subColors = { up:'var(--accent)', warn:'var(--amber)', neutral:'var(--text-tertiary)' }
  return (
    <div style={{ background:'var(--bg-secondary)', borderRadius:'var(--radius)', padding:'12px 14px' }}>
      <div style={{ fontSize:12, color:'var(--text-tertiary)', marginBottom:4 }}>{label}</div>
      <div style={{ fontSize:22, fontWeight:500, color:'var(--text)' }}>{value}</div>
      {sub && <div style={{ fontSize:11, marginTop:3, color: subColors[subType]||subColors.neutral }}>{sub}</div>}
    </div>
  )
}

function Select({ value, onChange, options, style = {} }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      style={{ fontSize:12, color:'var(--text-secondary)', background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'5px 10px', cursor:'pointer', outline:'none', ...style }}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

// ─── Date range options ───────────────────────────────────────────────────────
const DATE_RANGE_OPTIONS = [
  { value:'24',    label:'Last 24 hours' },
  { value:'48',    label:'Last 48 hours' },
  { value:'168',   label:'Last 7 days' },
  { value:'720',   label:'Last 30 days' },
  { value:'2160',  label:'Last 3 months' },
  { value:'2880',  label:'Last 4 months' },
]

// ─── Sort options ─────────────────────────────────────────────────────────────
const SIGNAL_SORT_OPTIONS = [
  { value:'score_desc',  label:'Priority (high to low)' },
  { value:'score_asc',   label:'Priority (low to high)' },
  { value:'date_desc',   label:'Most recent first' },
  { value:'date_asc',    label:'Oldest first' },
]

const BDR_OPTIONS = [
  { value:'', label:'All BDRs' },
  { value:'Chris Knapp',  label:'Chris Knapp' },
  { value:'Chiara Pate',  label:'Chiara Pate' },
]

const TERRITORY_OPTIONS = [
  { value:'', label:'All territories' },
  { value:'Northeast', label:'Northeast' },
  { value:'Southeast', label:'Southeast' },
  { value:'Midwest',   label:'Midwest' },
  { value:'Southwest', label:'Southwest' },
  { value:'West',      label:'West' },
]

const TIER_OPTIONS = [
  { value:'', label:'All tiers' },
  { value:'GOLD 1-10',   label:'GOLD 1-10' },
  { value:'GOLD 11-20',  label:'GOLD 11-20' },
  { value:'GOLD 21-30',  label:'GOLD 21-30' },
  { value:'GOLD 31-40',  label:'GOLD 31-40' },
  { value:'GOLD 41-50',  label:'GOLD 41-50' },
  { value:'GOLD 51-60',  label:'GOLD 51-60' },
  { value:'GOLD 61-70',  label:'GOLD 61-70' },
  { value:'GOLD 71-80',  label:'GOLD 71-80' },
  { value:'GOLD 81-90',  label:'GOLD 81-90' },
  { value:'GOLD 91-100', label:'GOLD 91-100' },
]

const TARGET_OPTIONS = [
  { value:'', label:'All accounts' },
  { value:'Chris Knapp',  label:'Chris Knapp' },
  { value:'Chiara Pate',  label:'Chiara Pate' },
]

const CONTACT_SORT_OPTIONS = [
  { value:'name_asc',    label:'Name (A-Z)' },
  { value:'name_desc',   label:'Name (Z-A)' },
  { value:'company_asc', label:'Company (A-Z)' },
  { value:'recent_desc', label:'Last contacted (recent)' },
  { value:'recent_asc',  label:'Last contacted (oldest)' },
]

function sortSignals(signals, sortKey) {
  const arr = [...signals]
  switch(sortKey) {
    case 'score_asc':  return arr.sort((a,b) => a.score - b.score)
    case 'date_desc':  return arr.sort((a,b) => new Date(b.timestamp||0) - new Date(a.timestamp||0))
    case 'date_asc':   return arr.sort((a,b) => new Date(a.timestamp||0) - new Date(b.timestamp||0))
    default:           return arr.sort((a,b) => b.score - a.score) // score_desc
  }
}

function sortContacts(contacts, sortKey) {
  const arr = [...contacts]
  const name = c => `${c.properties?.firstname||''} ${c.properties?.lastname||''}`.trim().toLowerCase()
  const company = c => (c.properties?.company||'').toLowerCase()
  const lastContacted = c => parseInt(c.properties?.notes_last_contacted||'0')
  switch(sortKey) {
    case 'name_desc':    return arr.sort((a,b) => name(b).localeCompare(name(a)))
    case 'company_asc':  return arr.sort((a,b) => company(a).localeCompare(company(b)))
    case 'recent_desc':  return arr.sort((a,b) => lastContacted(b) - lastContacted(a))
    case 'recent_asc':   return arr.sort((a,b) => lastContacted(a) - lastContacted(b))
    default:             return arr.sort((a,b) => name(a).localeCompare(name(b))) // name_asc
  }
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────
export default function Dashboard({ user, theme, toggleTheme, getToken }) {
  const { signOut } = useClerk()
  const [signals, setSignals]         = useState([])
  const [botSignals, setBotSignals]   = useState([])
  const [contacts, setContacts]       = useState([])
  const [feed, setFeed]               = useState([])
  const [loading, setLoading]         = useState(true)
  const [activeTab, setActiveTab]     = useState('dashboard')
  const [selectedContact, setSelectedContact] = useState(null)

  // Controls
  const [dateRange, setDateRange]     = useState('2880')
  const [signalSort, setSignalSort]   = useState('score_desc')
  const [contactSort, setContactSort] = useState('name_asc')

  // Custom property filters
  const [filterBdr, setFilterBdr]           = useState('')
  const [filterTerritory, setFilterTerritory] = useState('')
  const [filterTier, setFilterTier]         = useState('')
  const [filterTarget, setFilterTarget]     = useState('')
  const [owners, setOwners]                 = useState([])

  const firstName = user?.firstName || user?.emailAddresses?.[0]?.emailAddress?.split('@')[0] || 'there'
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  const today = new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' })

  // Load owners once on mount
  useEffect(() => {
    apiFetch('/api/hubspot/owners', getToken)
      .then(d => setOwners(d.owners || []))
      .catch(() => {})
  }, [getToken])

  // Build filter query string
  const filterParams = [
    filterBdr       ? `assigned_bdr=${encodeURIComponent(filterBdr)}`             : '',
    filterTerritory ? `territory=${encodeURIComponent(filterTerritory)}`           : '',
    filterTier      ? `priority_tier__bdr=${encodeURIComponent(filterTier)}`       : '',
    filterTarget    ? `target_account__bdr_led_outreach=${encodeURIComponent(filterTarget)}` : '',
  ].filter(Boolean).join('&')

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const params = `hours=${dateRange}&showBots=true${filterParams ? '&' + filterParams : ''}`
      const [sigData, contactData] = await Promise.all([
        apiFetch(`/api/hubspot/signals?${params}`, getToken),
        apiFetch(`/api/hubspot/contacts${filterParams ? '?' + filterParams : ''}`, getToken),
      ])
      setSignals(sigData.signals || [])
      setBotSignals(sigData.suspectedBotSignals || [])
      setContacts(contactData.contacts || [])
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [getToken, dateRange, filterParams])

  useEffect(() => { fetchData() }, [fetchData])

  const loadContactFeed = useCallback(async (contactId) => {
    try {
      const data = await apiFetch(`/api/hubspot/feed/${contactId}`, getToken)
      setFeed(data.feed || [])
    } catch { setFeed([]) }
  }, [getToken])

  useEffect(() => {
    if (selectedContact) loadContactFeed(selectedContact.id)
  }, [selectedContact, loadContactFeed])

  // Derived data
  const sortedSignals      = sortSignals(signals, signalSort)
  const sortedContacts     = sortContacts(contacts, contactSort)
  const hotCount           = signals.filter(s => s.score >= 100).length
  const warmCount          = signals.filter(s => s.score >= 30 && s.score < 100).length
  const botCount           = botSignals.length

  const tasks = sortedSignals.slice(0, 10).map(s => ({
    name:      s.contact?.name || 'Unknown',
    company:   s.contact?.company || '',
    title:     s.contact?.title || '',
    label:     s.label,
    score:     s.score,
    ts:        s.timestamp,
    contactId: s.contactId,
    priority:  s.score >= 100 ? 'hot' : s.score >= 60 ? 'warm' : 'normal',
    badgeType: s.score >= 100 ? 'reply' : s.score >= 60 ? 'click' : 'hot',
    eventChain: s.eventChain || [],
    sentAt:     s.sentAt || null,
    openedAt:   s.openedAt || null,
    clickedAt:  s.clickedAt || null,
    repliedAt:  s.repliedAt || null,
  }))

  const contentEngagement = signals.filter(s => s.label?.toLowerCase().includes('click')).map(s => ({
    name:      s.contact?.name || 'Unknown',
    company:   s.contact?.company || '',
    title:     s.contact?.title || '',
    action:    s.label,
    subject:   cleanSubject(s.subject),
    ts:        s.timestamp,
    contactId: s.contactId,
  }))

  const openHubSpotContact = (contactId, e) => {
    if (e) e.stopPropagation()
    const url = hsContactUrl(contactId)
    if (url) window.open(url, '_blank')
  }

  return (
    <div style={{ minHeight:'100vh', background:'var(--bg)', display:'flex', flexDirection:'column' }}>

      {/* Top nav */}
      <nav style={{ background:'var(--bg-panel)', borderBottom:'1px solid var(--border)', padding:'0 1.5rem', display:'flex', alignItems:'center', height:52, gap:24, position:'sticky', top:0, zIndex:50 }}>
        <div style={{ fontSize:13, fontWeight:500, letterSpacing:'.05em', textTransform:'uppercase', color:'var(--accent)', marginRight:8 }}>CarePathIQ</div>

        {['dashboard','contacts'].map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            style={{ fontSize:13, fontWeight:activeTab===tab?500:400, color:activeTab===tab?'var(--text)':'var(--text-secondary)', padding:'0 2px', height:52, background:'none', border:'none', borderBottom:activeTab===tab?'2px solid var(--accent)':'2px solid transparent', cursor:'pointer', textTransform:'capitalize' }}>
            {tab}
          </button>
        ))}

        <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:10 }}>
          <button onClick={toggleTheme}
            style={{ width:32, height:32, borderRadius:'var(--radius)', background:'var(--bg-secondary)', display:'flex', alignItems:'center', justifyContent:'center', border:'1px solid var(--border)', cursor:'pointer' }}>
            {theme === 'light'
              ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
              : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
            }
          </button>
          <button onClick={() => signOut()} style={{ fontSize:12, color:'var(--text-tertiary)', background:'none', border:'none', cursor:'pointer' }}>Sign out</button>
        </div>
      </nav>

      <div style={{ flex:1, padding:'1.5rem', maxWidth:1280, margin:'0 auto', width:'100%' }}>

        {activeTab === 'dashboard' && (
          <>
            {/* Header */}
            <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:'1.25rem', gap:12, flexWrap:'wrap' }}>
              <div>
                <h1 style={{ fontSize:20, fontWeight:500, color:'var(--text)', marginBottom:2 }}>{greeting}, {firstName}</h1>
                <div style={{ fontSize:13, color:'var(--text-tertiary)' }}>{today} &mdash; {tasks.length} items need attention</div>
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <Select value={dateRange} onChange={v => setDateRange(v)} options={DATE_RANGE_OPTIONS} />
                <button onClick={fetchData} style={{ fontSize:12, color:'var(--text-secondary)', background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'6px 14px', cursor:'pointer' }}>
                  Refresh
                </button>
              </div>
            </div>

            {/* Metrics */}
            <div style={{ display:'grid', gridTemplateColumns:'repeat(4,minmax(0,1fr))', gap:10, marginBottom:'1.25rem' }}>
              <MetricCard label="Hot signals"        value={hotCount}          sub="Replies + clicks"    subType="up" />
              <MetricCard label="Warm signals"       value={warmCount}         sub="Opens w/ engagement" subType="neutral" />
              <MetricCard label="Active contacts"    value={contacts.length}   sub="In HubSpot"          subType="neutral" />
              <MetricCard label="Bot opens filtered" value={botCount}          sub="Not shown in feed"   subType="neutral" />
            </div>

            {/* Filter bar */}
            <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginBottom:'1.25rem', padding:'10px 14px', background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', alignItems:'center' }}>
              <div style={{ fontSize:12, fontWeight:500, color:'var(--text-tertiary)', marginRight:4 }}>Filter:</div>
              <Select value={filterBdr} onChange={v => { setFilterBdr(v) }} options={BDR_OPTIONS} />
              <Select value={filterTerritory} onChange={v => { setFilterTerritory(v) }} options={TERRITORY_OPTIONS} />
              <Select value={filterTier} onChange={v => { setFilterTier(v) }} options={TIER_OPTIONS} />
              <Select value={filterTarget} onChange={v => { setFilterTarget(v) }} options={TARGET_OPTIONS} />
              {(filterBdr || filterTerritory || filterTier || filterTarget) && (
                <button onClick={() => { setFilterBdr(''); setFilterTerritory(''); setFilterTier(''); setFilterTarget('') }}
                  style={{ fontSize:12, color:'var(--red)', background:'none', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'5px 10px', cursor:'pointer' }}>
                  Clear filters
                </button>
              )}
              {(filterBdr || filterTerritory || filterTier || filterTarget) && (
                <div style={{ marginLeft:'auto', fontSize:11, color:'var(--text-tertiary)' }}>
                  {[filterBdr, filterTerritory, filterTier, filterTarget].filter(Boolean).join(' · ')}
                </div>
              )}
            </div>

            {/* Two columns: tasks + signals */}
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:12 }}>

              {/* Task queue */}
              <Panel>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
                  <SectionTitle style={{ margin:0 }}>Task queue</SectionTitle>
                  <Select value={signalSort} onChange={setSignalSort} options={SIGNAL_SORT_OPTIONS} />
                </div>
                {loading && <div style={{ color:'var(--text-tertiary)', fontSize:13 }}>Loading...</div>}
                {!loading && tasks.length === 0 && <div style={{ color:'var(--text-tertiary)', fontSize:13 }}>No tasks in this time range.</div>}
                {tasks.map((t, i) => (
                  <div key={i} style={{ padding:'12px 0', borderBottom: i < tasks.length-1 ? '1px solid var(--border)' : 'none' }}>
                    <div style={{ display:'flex', gap:10 }}>
                      <PriorityDot level={t.priority} />
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:2 }}>
                          <span
                            onClick={t.contactId ? () => openHubSpotContact(t.contactId) : undefined}
                            style={{ fontWeight:500, fontSize:13, color: t.contactId ? 'var(--accent)' : 'var(--text)', cursor: t.contactId ? 'pointer' : 'default', textDecoration: t.contactId ? 'underline' : 'none', textDecorationColor:'var(--border-strong)' }}>
                            {t.name}
                          </span>
                          {t.contactId && (
                            <button onClick={e => openHubSpotContact(t.contactId, e)} title="Open in HubSpot"
                              style={{ flexShrink:0, background:'none', border:'none', cursor:'pointer', padding:0, color:'var(--text-tertiary)', lineHeight:1 }}>
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                            </button>
                          )}
                        </div>
                        <div style={{ fontSize:12, color:'var(--text-secondary)', marginBottom:6 }}>{t.title}{t.company ? ` · ${t.company}` : ''}</div>
                        <Badge label={t.label} type={t.badgeType} />
                        <div style={{ marginTop:6, display:'flex', flexDirection:'column', gap:3 }}>
                          {t.sentAt   && <div style={{ fontSize:11, color:'var(--text-tertiary)', display:'flex', gap:6 }}><span style={{ color:'var(--text-secondary)', fontWeight:500, minWidth:52 }}>Sent</span><span>{exactTs(t.sentAt)}</span></div>}
                          {t.openedAt && <div style={{ fontSize:11, color:'var(--text-tertiary)', display:'flex', gap:6 }}><span style={{ color:'var(--text-secondary)', fontWeight:500, minWidth:52 }}>Opened</span><span>{exactTs(t.openedAt)}</span></div>}
                          {t.clickedAt && <div style={{ fontSize:11, color:'var(--text-tertiary)', display:'flex', gap:6 }}><span style={{ color:'var(--text-secondary)', fontWeight:500, minWidth:52 }}>Clicked</span><span>{exactTs(t.clickedAt)}</span></div>}
                          {t.repliedAt && <div style={{ fontSize:11, color:'var(--text-tertiary)', display:'flex', gap:6 }}><span style={{ color:'var(--text-secondary)', fontWeight:500, minWidth:52 }}>Replied</span><span>{exactTs(t.repliedAt)}</span></div>}
                          {!t.sentAt && !t.openedAt && !t.clickedAt && !t.repliedAt && t.ts && (
                            <div style={{ fontSize:11, color:'var(--text-tertiary)' }}>{exactTs(t.ts)}</div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </Panel>

              {/* Live signals */}
              <Panel>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
                  <SectionTitle style={{ margin:0 }}>Live signals</SectionTitle>
                  <Select value={signalSort} onChange={setSignalSort} options={SIGNAL_SORT_OPTIONS} />
                </div>
                {loading && <div style={{ color:'var(--text-tertiary)', fontSize:13 }}>Loading...</div>}
                {!loading && signals.length === 0 && <div style={{ color:'var(--text-tertiary)', fontSize:13 }}>No signals in this time range.</div>}
                {sortedSignals.slice(0,50).map((s, i) => {
                  const isReply = s.score >= 100
                  const isClick = s.score >= 60 && s.score < 100
                  const iconColor = isReply ? 'var(--accent)' : isClick ? 'var(--amber)' : 'var(--blue)'
                  const iconBg    = isReply ? 'var(--accent-light)' : isClick ? 'var(--amber-light)' : 'var(--blue-light)'
                  return (
                    <div key={i} style={{ padding:'10px 0', borderBottom: i < Math.min(sortedSignals.length,50)-1 ? '1px solid var(--border)' : 'none' }}>
                      <div style={{ display:'flex', gap:10 }}>
                        <div style={{ width:28, height:28, borderRadius:'var(--radius)', background:iconBg, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, marginTop:2 }}>
                          {isReply
                            ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={iconColor} strokeWidth="2" strokeLinecap="round"><path d="M9 17H5a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v5"/><polyline points="17 11 12 16 7 11"/></svg>
                            : isClick
                            ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={iconColor} strokeWidth="2" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                            : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={iconColor} strokeWidth="2" strokeLinecap="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                          }
                        </div>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ display:'flex', alignItems:'center', gap:5, marginBottom:2 }}>
                            <span
                              onClick={s.contactId ? () => openHubSpotContact(s.contactId) : undefined}
                              style={{ fontSize:13, fontWeight:500, color: s.contactId ? 'var(--accent)' : 'var(--text)', cursor: s.contactId ? 'pointer' : 'default' }}>
                              {s.contact?.name || s.recipientEmail || 'Unknown'} &mdash; {s.label}
                            </span>
                            {s.contactId && (
                              <button onClick={e => openHubSpotContact(s.contactId, e)} title="Open in HubSpot"
                                style={{ flexShrink:0, background:'none', border:'none', cursor:'pointer', padding:0, color:'var(--text-tertiary)', lineHeight:1 }}>
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                              </button>
                            )}
                          </div>
                          <div style={{ fontSize:11, color:'var(--text-tertiary)', marginBottom:4 }}>{cleanSubject(s.subject)}</div>
                          <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
                            {s.sentAt    && <div style={{ fontSize:11, color:'var(--text-tertiary)', display:'flex', gap:6 }}><span style={{ color:'var(--text-secondary)', fontWeight:500, minWidth:52 }}>Sent</span><span>{exactTs(s.sentAt)}</span></div>}
                            {s.openedAt  && <div style={{ fontSize:11, color:'var(--text-tertiary)', display:'flex', gap:6 }}><span style={{ color:'var(--text-secondary)', fontWeight:500, minWidth:52 }}>Opened</span><span>{exactTs(s.openedAt)}</span></div>}
                            {s.clickedAt && <div style={{ fontSize:11, color:'var(--text-tertiary)', display:'flex', gap:6 }}><span style={{ color:'var(--text-secondary)', fontWeight:500, minWidth:52 }}>Clicked</span><span>{exactTs(s.clickedAt)}</span></div>}
                            {s.repliedAt && <div style={{ fontSize:11, color:'var(--text-tertiary)', display:'flex', gap:6 }}><span style={{ color:'var(--text-secondary)', fontWeight:500, minWidth:52 }}>Replied</span><span>{exactTs(s.repliedAt)}</span></div>}
                            {!s.sentAt && !s.openedAt && !s.clickedAt && !s.repliedAt && s.timestamp && (
                              <div style={{ fontSize:11, color:'var(--text-tertiary)' }}>{exactTs(s.timestamp)}</div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </Panel>
            </div>

            {/* AI Recommendations */}
            <Panel style={{ marginBottom:12 }}>
              <SectionTitle>AI recommendations &mdash; persona-aware</SectionTitle>
              {tasks.length === 0 && !loading && <div style={{ color:'var(--text-tertiary)', fontSize:13 }}>No signals to base recommendations on yet.</div>}
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                {tasks.slice(0,4).map((t, i) => {
                  const persona = getPersona(t.title)
                  const prompts = {
                    reply: `Draft a reply to ${t.name}, ${t.title} at ${t.company}, who replied to my outreach. Use strategic, value-focused framing appropriate for a ${persona.label}.`,
                    click: `Draft a LinkedIn message for ${t.name}, ${t.title} at ${t.company}, who clicked a link in my email. Keep it brief and reference value without mentioning pricing.`,
                    hot:   `Draft a follow-up email for ${t.name}, ${t.title} at ${t.company}, who opened my email. Use ${persona.label}-appropriate framing around cost avoidance and operational outcomes.`,
                  }
                  const verbs = { reply:'Draft reply', click:'Draft LinkedIn msg', hot:'Draft follow-up' }
                  const recs = {
                    reply: `${t.name} replied positively. Strike while the iron is hot -- ${persona.label} personas respond best to specific meeting proposals, not product pitches.`,
                    click: `${t.name} clicked a link -- a warm signal. A brief follow-up referencing value (not pricing) converts well for ${persona.label} personas.`,
                    hot:   `${t.name} opened your email. ${persona.label} personas at health systems respond to cost avoidance, operational outcomes, and peer case studies.`,
                  }
                  return (
                    <div key={i} style={{ background:'var(--bg-secondary)', borderRadius:'var(--radius)', padding:'12px 14px' }}>
                      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
                        <span style={{ fontSize:11, fontWeight:500, padding:'2px 8px', borderRadius:20, background:persona.bg, color:persona.color }}>{persona.label}</span>
                        <span style={{ fontSize:11, color:'var(--text-tertiary)' }}>{t.label}</span>
                        {t.contactId && (
                          <button onClick={() => openHubSpotContact(t.contactId)}
                            title="Open in HubSpot"
                            style={{ marginLeft:'auto', background:'none', border:'none', cursor:'pointer', padding:0, color:'var(--text-tertiary)', lineHeight:1 }}>
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                          </button>
                        )}
                      </div>
                      <div style={{ fontSize:13, color:'var(--text)', lineHeight:1.5, marginBottom:8 }}>{recs[t.badgeType] || recs.hot}</div>
                      <button
                        onClick={() => window.open(`https://claude.ai/new?q=${encodeURIComponent(prompts[t.badgeType] || prompts.hot)}`, '_blank')}
                        style={{ fontSize:12, color:'var(--accent)', background:'none', border:'1px solid var(--border-strong)', borderRadius:'var(--radius)', padding:'5px 12px', cursor:'pointer' }}>
                        {verbs[t.badgeType] || verbs.hot} &nearr;
                      </button>
                    </div>
                  )
                })}
              </div>
            </Panel>

            {/* Content Engagement */}
            <Panel style={{ marginBottom:12 }}>
              <SectionTitle>Content engagement &mdash; links clicked &amp; documents viewed</SectionTitle>
              {contentEngagement.length === 0 && !loading && (
                <div style={{ color:'var(--text-tertiary)', fontSize:13 }}>No link clicks or document views in this time range.</div>
              )}
              {contentEngagement.length > 0 && (
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                  <thead>
                    <tr>
                      {['Contact','Title / Company','Action','Content','Time'].map(h => (
                        <th key={h} style={{ textAlign:'left', fontSize:11, fontWeight:500, color:'var(--text-tertiary)', textTransform:'uppercase', letterSpacing:'.04em', padding:'0 8px 8px 0', borderBottom:'1px solid var(--border)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {contentEngagement.slice(0,10).map((c, i) => (
                      <tr key={i} style={{ borderBottom: i < Math.min(contentEngagement.length,10)-1 ? '1px solid var(--border)' : 'none' }}>
                        <td style={{ padding:'9px 8px 9px 0' }}>
                          <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                            <span style={{ fontWeight:500, color:'var(--text)' }}>{c.name}</span>
                            {c.contactId && (
                              <button onClick={() => openHubSpotContact(c.contactId)}
                                title="Open in HubSpot"
                                style={{ background:'none', border:'none', cursor:'pointer', padding:0, color:'var(--text-tertiary)', lineHeight:1 }}>
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                              </button>
                            )}
                          </div>
                        </td>
                        <td style={{ padding:'9px 8px 9px 0', color:'var(--text-secondary)', fontSize:12 }}>{c.title}{c.company ? ` · ${c.company}` : ''}</td>
                        <td style={{ padding:'9px 8px 9px 0' }}><Badge label={c.action} type="click" /></td>
                        <td style={{ padding:'9px 8px 9px 0', color:'var(--text-secondary)', fontSize:12, maxWidth:180, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{c.subject}</td>
                        <td style={{ padding:'9px 0', color:'var(--text-tertiary)', fontSize:12, whiteSpace:'nowrap' }}>{timeAgo(c.ts)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div style={{ marginTop:10, fontSize:11, color:'var(--text-tertiary)' }}>
                Time-on-document tracking available for links shared via HubSpot Documents only.
              </div>
            </Panel>


          </>
        )}

        {activeTab === 'contacts' && (
          <ContactsView
            contacts={sortedContacts}
            selected={selectedContact}
            onSelect={c => { setSelectedContact(c); loadContactFeed(c.id) }}
            feed={feed}
            getToken={getToken}
            openHubSpotContact={openHubSpotContact}
            contactSort={contactSort}
            setContactSort={setContactSort}
          />
        )}
      </div>
    </div>
  )
}

// ─── Contacts view ────────────────────────────────────────────────────────────
function ContactsView({ contacts, selected, onSelect, feed, getToken, openHubSpotContact, contactSort, setContactSort }) {
  const [search, setSearch]   = useState('')
  const [note, setNote]       = useState('')
  const [saving, setSaving]   = useState(false)
  const [saved, setSaved]     = useState(false)

  const filtered = contacts.filter(c => {
    const p    = c.properties || {}
    const name = `${p.firstname||''} ${p.lastname||''}`.toLowerCase()
    const co   = (p.company||'').toLowerCase()
    const s    = search.toLowerCase()
    return name.includes(s) || co.includes(s)
  })

  const logNote = async () => {
    if (!note.trim() || !selected) return
    setSaving(true)
    try {
      await apiFetch('/api/hubspot/activity', getToken, {
        method: 'POST',
        body:   JSON.stringify({ contactId: selected.id, note }),
      })
      setNote('')
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch(e) { console.error(e) }
    finally    { setSaving(false) }
  }

  const p            = selected?.properties || {}
  const selectedName = `${p.firstname||''} ${p.lastname||''}`.trim() || 'Unknown'
  const persona      = getPersona(p.jobtitle || '')
  const lastContacted = p.notes_last_contacted ? parseInt(p.notes_last_contacted) : null
  const validDate     = lastContacted && lastContacted > 0 && new Date(lastContacted).getFullYear() > 1970

  return (
    <div style={{ display:'grid', gridTemplateColumns:'300px 1fr', gap:12, height:'calc(100vh - 100px)' }}>

      {/* Contact list */}
      <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
        <div style={{ display:'flex', gap:8 }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search contacts..."
            style={{ flex:1, background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'8px 12px', fontSize:13, color:'var(--text)', outline:'none' }} />
        </div>
        <Select value={contactSort} onChange={setContactSort} options={CONTACT_SORT_OPTIONS} style={{ width:'100%' }} />
        <div style={{ overflow:'auto', flex:1 }}>
          {filtered.slice(0,100).map((c, i) => {
            const cp   = c.properties || {}
            const name = `${cp.firstname||''} ${cp.lastname||''}`.trim() || 'Unknown'
            const isSel = selected?.id === c.id
            return (
              <div key={i} onClick={() => onSelect(c)}
                style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', borderRadius:'var(--radius)', cursor:'pointer', background: isSel ? 'var(--accent-light)' : 'transparent', marginBottom:2 }}>
                <Avatar name={name} size={30} />
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:13, fontWeight:500, color: isSel ? 'var(--accent-text)' : 'var(--text)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{name}</div>
                  <div style={{ fontSize:11, color:'var(--text-tertiary)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{cp.company||'—'}</div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Contact detail */}
      {selected ? (
        <div style={{ overflow:'auto', display:'flex', flexDirection:'column', gap:12 }}>
          <Panel>
            <div style={{ display:'flex', alignItems:'center', gap:14, marginBottom:16 }}>
              <Avatar name={selectedName} size={48} />
              <div style={{ flex:1 }}>
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <h2 style={{ fontSize:17, fontWeight:500, color:'var(--text)', marginBottom:2 }}>{selectedName}</h2>
                  <button onClick={() => openHubSpotContact(selected.id)}
                    title="Open in HubSpot"
                    style={{ background:'none', border:'none', cursor:'pointer', padding:0, color:'var(--text-tertiary)', lineHeight:1 }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  </button>
                </div>
                <div style={{ fontSize:13, color:'var(--text-secondary)' }}>{p.jobtitle||'—'} &middot; {p.company||'—'}</div>
                <span style={{ display:'inline-block', marginTop:4, fontSize:11, fontWeight:500, padding:'2px 8px', borderRadius:20, background:persona.bg, color:persona.color }}>{persona.label}</span>
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:4, alignItems:'flex-end' }}>
                {p.email && <a href={`mailto:${p.email}`} style={{ fontSize:12, color:'var(--accent)' }}>{p.email}</a>}
                {p.phone && <div style={{ fontSize:12, color:'var(--text-secondary)' }}>{p.phone}</div>}
              </div>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8 }}>
              <div style={{ background:'var(--bg-secondary)', borderRadius:'var(--radius)', padding:'10px 12px' }}>
                <div style={{ fontSize:11, color:'var(--text-tertiary)', marginBottom:2 }}>Lead status</div>
                <div style={{ fontSize:13, fontWeight:500, color:'var(--text)' }}>{p.hs_lead_status||'—'}</div>
              </div>
              <div style={{ background:'var(--bg-secondary)', borderRadius:'var(--radius)', padding:'10px 12px' }}>
                <div style={{ fontSize:11, color:'var(--text-tertiary)', marginBottom:2 }}>Times contacted</div>
                <div style={{ fontSize:13, fontWeight:500, color:'var(--text)' }}>{p.num_contacted_notes||'0'}</div>
              </div>
              <div style={{ background:'var(--bg-secondary)', borderRadius:'var(--radius)', padding:'10px 12px' }}>
                <div style={{ fontSize:11, color:'var(--text-tertiary)', marginBottom:2 }}>Last contacted</div>
                <div style={{ fontSize:13, fontWeight:500, color:'var(--text)' }}>
                  {validDate ? new Date(lastContacted).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '—'}
                </div>
              </div>
              <div style={{ background:'var(--bg-secondary)', borderRadius:'var(--radius)', padding:'10px 12px' }}>
                <div style={{ fontSize:11, color:'var(--text-tertiary)', marginBottom:2 }}>Assigned BDR</div>
                <div style={{ fontSize:13, fontWeight:500, color:'var(--text)' }}>{p.assigned_bdr||'—'}</div>
              </div>
              <div style={{ background:'var(--bg-secondary)', borderRadius:'var(--radius)', padding:'10px 12px' }}>
                <div style={{ fontSize:11, color:'var(--text-tertiary)', marginBottom:2 }}>Territory</div>
                <div style={{ fontSize:13, fontWeight:500, color:'var(--text)' }}>{p.territory||'—'}</div>
              </div>
              <div style={{ background:'var(--bg-secondary)', borderRadius:'var(--radius)', padding:'10px 12px' }}>
                <div style={{ fontSize:11, color:'var(--text-tertiary)', marginBottom:2 }}>Priority tier</div>
                <div style={{ fontSize:13, fontWeight:500, color:'var(--text)' }}>{p.priority_tier__bdr||'—'}</div>
              </div>
            </div>
          </Panel>

          <Panel>
            <SectionTitle>Log activity</SectionTitle>
            <textarea value={note} onChange={e => setNote(e.target.value)}
              placeholder="Add a call note, meeting summary, or activity..." rows={3}
              style={{ width:'100%', background:'var(--bg-secondary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'10px 12px', fontSize:13, color:'var(--text)', resize:'vertical', outline:'none', fontFamily:'var(--font)' }} />
            <div style={{ display:'flex', justifyContent:'flex-end', marginTop:8 }}>
              <button onClick={logNote} disabled={saving||!note.trim()}
                style={{ fontSize:13, fontWeight:500, background:'var(--accent)', color:'#fff', border:'none', borderRadius:'var(--radius)', padding:'7px 18px', cursor:'pointer', opacity: saving||!note.trim() ? 0.5 : 1 }}>
                {saving ? 'Saving...' : saved ? 'Saved!' : 'Log to HubSpot'}
              </button>
            </div>
          </Panel>

          <Panel>
            <SectionTitle>Activity feed</SectionTitle>
            {feed.length === 0 && <div style={{ fontSize:13, color:'var(--text-tertiary)' }}>No activity recorded yet.</div>}
            {feed.map((item, i) => (
              <div key={i} style={{ display:'flex', gap:12, padding:'10px 0', borderBottom: i < feed.length-1 ? '1px solid var(--border)' : 'none' }}>
                <div style={{ width:28, height:28, borderRadius:'50%', background:'var(--bg-secondary)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                  <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--accent)' }} />
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:13, color:'var(--text)', fontWeight:500 }}>{item.type || 'Activity'}</div>
                  <div style={{ fontSize:12, color:'var(--text-secondary)', marginTop:2 }}>{item.body || item.subject || '—'}</div>
                  <div style={{ fontSize:11, color:'var(--text-tertiary)', marginTop:4 }}>{timeAgo(item.timestamp || item.createdAt)}</div>
                </div>
              </div>
            ))}
          </Panel>
        </div>
      ) : (
        <Panel style={{ display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ textAlign:'center', color:'var(--text-tertiary)', fontSize:13 }}>Select a contact to view details</div>
        </Panel>
      )}
    </div>
  )
}
