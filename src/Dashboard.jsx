import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
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

function shortDate(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })
}

function timeToOpen(sentTs, openedTs) {
  if (!sentTs || !openedTs) return null
  const diff = new Date(openedTs).getTime() - new Date(sentTs).getTime()
  if (diff < 0) return null
  const mins = Math.floor(diff / 60000)
  if (mins < 1)   return '< 1 min'
  if (mins < 60)  return `${mins} min`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)   return `${hrs}h ${mins % 60}m`
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`
}

function cleanSubject(subject, campaignId) {
  if (subject && !/^\d+$/.test(String(subject))) return subject
  if (campaignId) return `Campaign #${campaignId}`
  return 'Marketing email'
}

function hsContactUrl(contactId) {
  return contactId ? `https://app.hubspot.com/contacts/39921549/contact/${contactId}` : null
}

// ─── UI primitives ────────────────────────────────────────────────────────────
function Badge({ label, type = 'default' }) {
  const colors = {
    hot:     { bg:'var(--red-light)',   color:'var(--red)' },
    warm:    { bg:'var(--amber-light)', color:'var(--amber)' },
    reply:   { bg:'var(--accent-light)',color:'var(--accent-text)' },
    click:   { bg:'var(--blue-light)',  color:'var(--blue)' },
    gold:    { bg:'#FEF3C7',            color:'#92400E' },
    overdue: { bg:'var(--red-light)',   color:'var(--red)' },
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

function SectionTitle({ children, count, style = {} }) {
  return (
    <div style={{ fontSize:11, fontWeight:500, letterSpacing:'.06em', textTransform:'uppercase', color:'var(--text-tertiary)', marginBottom:12, display:'flex', alignItems:'center', gap:6, ...style }}>
      {children}
      {count != null && (
        <span style={{ fontSize:10, fontWeight:600, background:'var(--bg-secondary)', color:'var(--text-secondary)', borderRadius:10, padding:'1px 6px' }}>
          {count}
        </span>
      )}
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

// ─── Pager component ─────────────────────────────────────────────────────────
function Pager({ page, total, pageSize, onChange }) {
  const totalPages = Math.ceil(total / pageSize)
  if (totalPages <= 1) return null
  const start = page * pageSize + 1
  const end   = Math.min((page + 1) * pageSize, total)
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginTop:12, paddingTop:10, borderTop:'1px solid var(--border)' }}>
      <div style={{ fontSize:12, color:'var(--text-tertiary)' }}>
        {start}–{end} of {total}
      </div>
      <div style={{ display:'flex', gap:6 }}>
        <button onClick={() => onChange(page - 1)} disabled={page === 0}
          style={{ fontSize:12, padding:'4px 10px', background:'var(--bg-secondary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', cursor: page === 0 ? 'not-allowed' : 'pointer', color: page === 0 ? 'var(--text-tertiary)' : 'var(--text)', opacity: page === 0 ? 0.5 : 1 }}>
          ← Prev
        </button>
        <button onClick={() => onChange(page + 1)} disabled={page >= totalPages - 1}
          style={{ fontSize:12, padding:'4px 10px', background:'var(--bg-secondary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer', color: page >= totalPages - 1 ? 'var(--text-tertiary)' : 'var(--text)', opacity: page >= totalPages - 1 ? 0.5 : 1 }}>
          Next →
        </button>
      </div>
    </div>
  )
}

// ─── HubSpot open icon ────────────────────────────────────────────────────────
function HsIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
      <polyline points="15 3 21 3 21 9"/>
      <line x1="10" y1="14" x2="21" y2="3"/>
    </svg>
  )
}

// ─── Date range options ───────────────────────────────────────────────────────
const DATE_RANGE_OPTIONS = [
  { value:'24',    label:'Last 24 hours' },
  { value:'48',    label:'Last 48 hours' },
  { value:'168',   label:'Last 7 days' },
  { value:'336',   label:'Last 14 days' },
  { value:'672',   label:'Last 28 days' },
  { value:'720',   label:'Last 30 days' },
  { value:'1440',  label:'Last 60 days' },
  { value:'2160',  label:'Last 90 days' },
  { value:'2880',  label:'Last 4 months' },
]

const TASK_DAYS_OPTIONS = [
  { value:'7',  label:'Last 7 days' },
  { value:'14', label:'Last 14 days' },
  { value:'21', label:'Last 21 days' },
  { value:'30', label:'Last 30 days' },
]

const ACTIVITY_DAYS_OPTIONS = [
  { value:'7',  label:'Last 7 days' },
  { value:'14', label:'Last 14 days' },
  { value:'30', label:'Last 30 days' },
  { value:'90', label:'Last 90 days' },
]

const REPORT_PERIOD_OPTIONS = [
  { value:'today',    label:'Today' },
  { value:'week',     label:'Last 7 days' },
  { value:'month',    label:'Last 30 days' },
  { value:'quarter',  label:'Last 90 days' },
  { value:'6months',  label:'Last 6 months' },
  { value:'year',     label:'Last year' },
  { value:'alltime',  label:'All time' },
]

const REPORT_REP_OPTIONS = [
  { value:'all',          label:'All reps' },
  { value:'Chris Knapp',  label:'Chris Knapp' },
  { value:'Chiara Pate',  label:'Chiara Pate' },
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
  { value:'GOLD - 1-10',   label:'GOLD 1-10' },
  { value:'GOLD - 11-20',  label:'GOLD 11-20' },
  { value:'GOLD - 21-30',  label:'GOLD 21-30' },
  { value:'GOLD - 31-40',  label:'GOLD 31-40' },
  { value:'GOLD - 41-50',  label:'GOLD 41-50' },
  { value:'GOLD - 51-60',  label:'GOLD 51-60' },
  { value:'GOLD - 61-70',  label:'GOLD 61-70' },
  { value:'GOLD - 71-80',  label:'GOLD 71-80' },
  { value:'GOLD - 81-90',  label:'GOLD 81-90' },
  { value:'GOLD - 91-100', label:'GOLD 91-100' },
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

const TASK_SECTION_OPTIONS = [
  { value:'replies',   label:'Replies awaiting response' },
  { value:'sequences', label:'Upcoming sequences' },
  { value:'tasks',     label:'Due tasks' },
]

function sortSignals(signals, sortKey) {
  const arr = [...signals]
  switch(sortKey) {
    case 'score_asc':  return arr.sort((a,b) => a.score - b.score)
    case 'date_desc':  return arr.sort((a,b) => new Date(b.timestamp||0) - new Date(a.timestamp||0))
    case 'date_asc':   return arr.sort((a,b) => new Date(a.timestamp||0) - new Date(b.timestamp||0))
    default:           return arr.sort((a,b) => b.score - a.score)
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
    default:             return arr.sort((a,b) => name(a).localeCompare(name(b)))
  }
}

// ─── Signal email source pill ─────────────────────────────────────────────────
function EmailSourcePill({ source }) {
  if (!source) return null
  const isSales = source === 'sales'
  return (
    <span style={{ fontSize:10, fontWeight:500, padding:'1px 6px', borderRadius:10, background: isSales ? 'var(--blue-light)' : 'var(--bg-secondary)', color: isSales ? 'var(--blue)' : 'var(--text-tertiary)', marginLeft:4 }}>
      {isSales ? '1:1' : 'mkt'}
    </span>
  )
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────
export default function Dashboard({ user, theme, toggleTheme, getToken, onScopeError }) {
  const { signOut } = useClerk()

  // Wrap apiFetch to intercept 403 MISSING_SCOPES and trigger reconnect flow.
  // Must be useCallback so its reference is stable -- unstable safeFetch causes
  // downstream useCallbacks to re-create on every render, triggering fetch loops.
  const safeFetch = useCallback(async (url, ...args) => {
    try {
      return await apiFetch(url, getToken, ...args)
    } catch (err) {
      const msg = err?.message || ''
      if (msg.includes('403') && msg.includes('MISSING_SCOPES')) {
        onScopeError?.('This app needs additional HubSpot permissions that were added since you last connected.')
        throw err
      }
      throw err
    }
  }, [getToken, onScopeError])

  // Core data
  const [signals, setSignals]         = useState([])
  const [botSignals, setBotSignals]   = useState([])
  const [contacts, setContacts]       = useState([])
  const [feed, setFeed]               = useState([])
  const [loading, setLoading]         = useState(true)
  const [signalsHasMore, setSignalsHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  // Task queue data (three sections)
  const [taskData, setTaskData]       = useState({ repliesAwaitingResponse:[], upcomingSequences:[], dueTasks:[], meta:{} })
  const [taskDays, setTaskDays]       = useState('14')
  const [taskSection, setTaskSection] = useState('replies')
  const [taskLoading, setTaskLoading] = useState(false)

  // Gold accounts
  const [goldAccounts, setGoldAccounts]   = useState([])
  const [goldLoading, setGoldLoading]     = useState(false)
  const [goldTierFilter, setGoldTierFilter] = useState('')

  // Activity summary
  const [activityData, setActivityData]       = useState(null)
  const [activityDays, setActivityDays]       = useState('7')
  const [activityRep, setActivityRep]         = useState('all')   // 'all' or rep name
  const [activityIncludeOwned, setActivityIncludeOwned] = useState(false)
  const [activityLoading, setActivityLoading] = useState(false)

  // Real-time polling
  const [newSignalCount, setNewSignalCount]   = useState(0)
  const [lastPollTime, setLastPollTime]       = useState(null)
  const pollIntervalRef                       = useRef(null)

  // Dynamic tabs from registry
  const [dynamicTabs, setDynamicTabs]         = useState([])
  const [isAdmin, setIsAdmin]                 = useState(false)

  // UI
  const [activeTab, setActiveTab]         = useState('dashboard')
  const [selectedContact, setSelectedContact] = useState(null)
  const [dateRange, setDateRange]         = useState('168')
  const [signalSort, setSignalSort]       = useState('score_desc')
  const [contactSort, setContactSort]     = useState('name_asc')

  // Pagination
  const PAGE_SIZE = 25
  const [taskPage, setTaskPage]           = useState(0)
  const [signalPage, setSignalPage]       = useState(0)
  const [goldPage, setGoldPage]           = useState(0)

  // Filters
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
    safeFetch('/api/hubspot/owners')
      .then(d => setOwners(d.owners || []))
      .catch(() => {})
  }, [getToken])

  // Load dynamic tabs on mount
  useEffect(() => {
    safeFetch('/api/hubspot/tabs')
      .then(d => { setDynamicTabs(d.tabs || []); setIsAdmin(d.isAdmin || false) })
      .catch(() => {})
  }, [getToken])

  // Content Engagement -- contacts with recent clicks, fetched directly (not derived from signals)
  const [contentEngagement, setContentEngagement] = useState([])
  const [contentEngagementLoading, setContentEngagementLoading] = useState(false)

  const fetchContentEngagement = useCallback(async () => {
    setContentEngagementLoading(true)
    try {
      // Fetch top 50 contacts by most recent click date, filtered by active BDR
      const bdrParam = filterBdr ? `&assigned_bdr=${encodeURIComponent(filterBdr)}` : ''
      const data = await safeFetch(`/api/hubspot/contacts?click_sort=true${bdrParam}`)
      // contacts endpoint returns all contacts -- filter client-side to those with click dates
      const clicked = (data.contacts || [])
        .filter(c => c.properties?.hs_email_last_click_date || c.properties?.hs_sales_email_last_clicked)
        .sort((a, b) => {
          const tsA = Math.max(
            a.properties?.hs_email_last_click_date    ? new Date(a.properties.hs_email_last_click_date).getTime()    : 0,
            a.properties?.hs_sales_email_last_clicked ? new Date(a.properties.hs_sales_email_last_clicked).getTime() : 0,
          )
          const tsB = Math.max(
            b.properties?.hs_email_last_click_date    ? new Date(b.properties.hs_email_last_click_date).getTime()    : 0,
            b.properties?.hs_sales_email_last_clicked ? new Date(b.properties.hs_sales_email_last_clicked).getTime() : 0,
          )
          return tsB - tsA
        })
        .slice(0, 50)
        .map(c => {
          const p = c.properties || {}
          const mktClickTs  = p.hs_email_last_click_date    ? new Date(p.hs_email_last_click_date).getTime()    : 0
          const salesClickTs= p.hs_sales_email_last_clicked ? new Date(p.hs_sales_email_last_clicked).getTime() : 0
          const ts = mktClickTs >= salesClickTs ? p.hs_email_last_click_date : p.hs_sales_email_last_clicked
          return {
            name:      `${p.firstname||''} ${p.lastname||''}`.trim() || 'Unknown',
            company:   p.company || '',
            title:     p.jobtitle || '',
            action:    'Clicked link',
            subject:   p.hs_email_last_email_name || '',
            ts,
            contactId: c.id,
          }
        })
      setContentEngagement(clicked)
    } catch (e) {
      console.error('[contentEngagement]', e)
    } finally {
      setContentEngagementLoading(false)
    }
  }, [filterBdr])
  const filterParams = [
    filterBdr       ? `assigned_bdr=${encodeURIComponent(filterBdr)}`             : '',
    filterTerritory ? `territory=${encodeURIComponent(filterTerritory)}`           : '',
    filterTier      ? `priority_tier__bdr=${encodeURIComponent(filterTier)}`       : '',
    filterTarget    ? `target_account__bdr_led_outreach=${encodeURIComponent(filterTarget)}` : '',
  ].filter(Boolean).join('&')

  // ── Signals fetch with tiered pagination ─────────────────────────────────
  const fetchData = useCallback(async () => {
    setLoading(true)
    setSignals([])
    try {
      const params = `hours=${dateRange}&showBots=true&offset=0${filterParams ? '&' + filterParams : ''}`
      // Fetch signals first -- this fires 7 sequential HubSpot searches internally
      const sigData = await safeFetch(`/api/hubspot/signals?${params}`)
      const sigs = sigData.signals || []
      setSignals(sigs)
      setBotSignals(sigData.suspectedBotSignals || [])
      setSignalsHasMore(sigData.meta?.hasMore || false)
      console.log('[signals] meta:', sigData.meta)

      // Fetch contacts after signals completes to avoid rate limiting
      try {
        const contactData = await safeFetch(`/api/hubspot/contacts${filterParams ? '?' + filterParams : ''}`)
        setContacts(contactData.contacts || [])
      } catch (ce) { console.error('[contacts]', ce) }

      // Fire tier-2 background fetch if more results exist
      if (sigData.meta?.hasMore) {
        const nextOffset = sigData.meta?.nextOffset || 100
        setLoadingMore(true)
        safeFetch(`/api/hubspot/signals?hours=${dateRange}&showBots=true&offset=${nextOffset}${filterParams ? '&' + filterParams : ''}`)
          .then(more => {
            setSignals(prev => {
              const existingIds = new Set(prev.map(s => s.id))
              const newSigs = (more.signals || []).filter(s => !existingIds.has(s.id))
              return [...prev, ...newSigs]
            })
            setBotSignals(prev => {
              const existingIds = new Set(prev.map(s => s.id))
              const newBots = (more.suspectedBotSignals || []).filter(s => !existingIds.has(s.id))
              return [...prev, ...newBots]
            })
            setSignalsHasMore(more.meta?.hasMore || false)
          })
          .catch(() => {})
          .finally(() => setLoadingMore(false))
      }
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [dateRange, filterParams])

  // ── Task queue fetch ──────────────────────────────────────────────────────
  const fetchTasks = useCallback(async () => {
    setTaskLoading(true)
    try {
      const params = `days=${taskDays}${filterBdr ? `&assigned_bdr=${encodeURIComponent(filterBdr)}` : ''}`
      const data = await safeFetch(`/api/hubspot/tasks?${params}`)
      setTaskData({
        repliesAwaitingResponse: data.repliesAwaitingResponse || [],
        upcomingSequences:       data.upcomingSequences       || [],
        dueTasks:                data.dueTasks                || [],
        meta:                    data.meta                    || {},
      })
    } catch (e) {
      console.error('[tasks]', e)
    } finally {
      setTaskLoading(false)
    }
  }, [taskDays, filterBdr])

  // ── Gold accounts fetch ───────────────────────────────────────────────────
  const fetchGold = useCallback(async () => {
    setGoldLoading(true)
    try {
      const params = filterBdr ? `assigned_bdr=${encodeURIComponent(filterBdr)}` : ''
      const data = await safeFetch(`/api/hubspot/gold${params ? '?' + params : ''}`)
      setGoldAccounts(data.accounts || [])
    } catch (e) {
      console.error('[gold]', e)
    } finally {
      setGoldLoading(false)
    }
  }, [filterBdr])

  // ── Activity summary fetch ────────────────────────────────────────────────
  const fetchActivity = useCallback(async () => {
    setActivityLoading(true)
    try {
      const params = [
        `days=${activityDays}`,
        activityRep !== 'all' ? `rep=${encodeURIComponent(activityRep)}` : 'rep=all',
        activityIncludeOwned ? 'include_owned=true' : '',
      ].filter(Boolean).join('&')
      const data = await safeFetch(`/api/hubspot/activity?${params}`)
      setActivityData(data)
    } catch (e) {
      console.error('[activity]', e)
    } finally {
      setActivityLoading(false)
    }
  }, [activityDays, activityRep, activityIncludeOwned])

  // ── Real-time polling (every 3 minutes) ──────────────────────────────────
  const fetchRecentSignals = useCallback(async () => {
    try {
      const since = lastPollTime
        ? new Date(lastPollTime).toISOString()
        : new Date(Date.now() - 15 * 60 * 1000).toISOString()
      const params = `since=${encodeURIComponent(since)}${filterBdr ? `&assigned_bdr=${encodeURIComponent(filterBdr)}` : ''}`
      const data = await apiFetch(`/api/hubspot/signals/recent?${params}`, getToken)
      const incoming = data.signals || []
      if (incoming.length > 0) {
        setSignals(prev => {
          const existingIds = new Set(prev.map(s => s.id))
          const fresh = incoming.filter(s => !existingIds.has(s.id))
          if (fresh.length === 0) return prev
          setNewSignalCount(c => c + fresh.length)
          return [...fresh, ...prev] // prepend so newest is first
        })
      }
      setLastPollTime(Date.now())
    } catch { /* polling errors are silent */ }
  }, [lastPollTime, filterBdr])

  useEffect(() => { fetchData() }, [fetchData])
  useEffect(() => { fetchTasks() }, [fetchTasks])
  // Stagger gold and activity well after signals completes.
  // Signals takes ~2s (6 searches × 300ms). Gold at 2.5s, activity at 4s.
  useEffect(() => {
    const t = setTimeout(() => fetchGold(), 2500)
    return () => clearTimeout(t)
  }, [fetchGold])
  useEffect(() => {
    const t = setTimeout(() => fetchActivity(), 4000)
    return () => clearTimeout(t)
  }, [fetchActivity])

  // Start real-time polling on mount, clear on unmount
  useEffect(() => {
    setLastPollTime(Date.now())
    pollIntervalRef.current = setInterval(() => {
      fetchRecentSignals()
    }, 3 * 60 * 1000) // every 3 minutes
    return () => clearInterval(pollIntervalRef.current)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Reset pages when controls change
  useEffect(() => { setTaskPage(0); setSignalPage(0) }, [signalSort, dateRange, filterParams])
  useEffect(() => { setGoldPage(0) }, [goldTierFilter, filterBdr])

  const loadContactFeed = useCallback(async (contactId) => {
    try {
      const data = await safeFetch(`/api/hubspot/feed/${contactId}`)
      setFeed(data.feed || [])
    } catch { setFeed([]) }
  }, [getToken])

  useEffect(() => {
    if (selectedContact) loadContactFeed(selectedContact.id)
  }, [selectedContact, loadContactFeed])

  // ── Derived data ──────────────────────────────────────────────────────────
  const sortedSignals  = sortSignals(signals, signalSort)
  const sortedContacts = sortContacts(contacts, contactSort)
  const hotCount       = signals.filter(s => s.score >= 100).length
  const warmCount      = signals.filter(s => s.score >= 30 && s.score < 100).length
  const botCount       = botSignals.length

  // Total attention count across all task sections
  const attentionCount = taskData.repliesAwaitingResponse.length
    + taskData.dueTasks.filter(t => t.overdue).length

  // Gold accounts filtered by tier
  const filteredGold = goldTierFilter
    ? goldAccounts.filter(a => a.tier === goldTierFilter)
    : goldAccounts

  // Signal cards for task queue (legacy) and AI recs
  const signalCards = sortedSignals.map(s => {
    const chain = s.eventChain || []
    const chainTs = (type) => chain.find(e => e.type === type)?.timestamp || null
    const isMkt = s.source === 'marketing_email'
    return {
      name:       s.contact?.name || s.recipientEmail || 'Unknown',
      company:    s.contact?.company || '',
      title:      s.contact?.title || '',
      label:      s.label,
      score:      s.score,
      ts:         s.timestamp,
      contactId:  s.contactId,
      priority:   s.score >= 100 ? 'hot' : s.score >= 60 ? 'warm' : 'normal',
      badgeType:  s.score >= 100 ? 'reply' : s.score >= 60 ? 'click' : 'hot',
      eventChain: chain,
      source:     s.source,
      eventType:  s.eventType,
      emailSource:s.emailSource || null,
      sentAt:     s.sentAt    || chainTs('SENT')    || null,
      openedAt:   s.openedAt  || chainTs('OPENED')  || (isMkt && s.eventType === 'OPEN'  ? s.timestamp : null),
      clickedAt:  s.clickedAt || chainTs('CLICKED') || (isMkt && s.eventType === 'CLICK' ? s.timestamp : null),
      repliedAt:  s.repliedAt || chainTs('REPLIED') || null,
      subject:    s.subject   || null,
      campaignId: s.campaignId|| null,
    }
  })

  // Fetch content engagement separately -- derived from contacts with click dates, not from signals
  useEffect(() => {
    const t = setTimeout(() => fetchContentEngagement(), 3000) // stagger 3s after mount
    return () => clearTimeout(t)
  }, [fetchContentEngagement])

  const openHubSpotContact = (contactId, e) => {
    if (e) e.stopPropagation()
    const url = hsContactUrl(contactId)
    if (!url) return
    const a = document.createElement('a')
    a.href = url
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  // ── Shared signal card timestamp block ────────────────────────────────────
  const TimestampChain = ({ sentAt, openedAt, clickedAt, repliedAt, ts }) => (
    <div style={{ marginTop:4, display:'flex', flexDirection:'column', gap:3 }}>
      {sentAt    && <div style={{ fontSize:11, color:'var(--text-tertiary)', display:'flex', gap:6 }}><span style={{ color:'var(--text-secondary)', fontWeight:500, minWidth:56 }}>Sent</span><span>{exactTs(sentAt)}</span></div>}
      {openedAt  && <div style={{ fontSize:11, color:'var(--text-tertiary)', display:'flex', gap:6, alignItems:'center' }}><span style={{ color:'var(--text-secondary)', fontWeight:500, minWidth:56 }}>Opened</span><span>{exactTs(openedAt)}</span>{timeToOpen(sentAt, openedAt) && <span style={{ marginLeft:4, fontSize:10, background:'var(--accent-light)', color:'var(--accent-text)', padding:'1px 6px', borderRadius:10, whiteSpace:'nowrap' }}>{timeToOpen(sentAt, openedAt)} after send</span>}</div>}
      {clickedAt && <div style={{ fontSize:11, color:'var(--text-tertiary)', display:'flex', gap:6 }}><span style={{ color:'var(--text-secondary)', fontWeight:500, minWidth:56 }}>Clicked</span><span>{exactTs(clickedAt)}</span></div>}
      {repliedAt && <div style={{ fontSize:11, color:'var(--text-tertiary)', display:'flex', gap:6 }}><span style={{ color:'var(--text-secondary)', fontWeight:500, minWidth:56 }}>Replied</span><span>{exactTs(repliedAt)}</span></div>}
      {!sentAt && !openedAt && !clickedAt && !repliedAt && ts && (
        <div style={{ fontSize:11, color:'var(--text-tertiary)' }}>{exactTs(ts)}</div>
      )}
    </div>
  )

  return (
    <div style={{ minHeight:'100vh', background:'var(--bg)', display:'flex', flexDirection:'column' }}>

      {/* Top nav */}
      <nav style={{ background:'var(--bg-panel)', borderBottom:'1px solid var(--border)', padding:'0 1.5rem', display:'flex', alignItems:'center', height:52, gap:24, position:'sticky', top:0, zIndex:50 }}>
        <div style={{ fontSize:13, fontWeight:500, letterSpacing:'.05em', textTransform:'uppercase', color:'var(--accent)', marginRight:8 }}>CarePathIQ</div>

        {[
          { key:'dashboard', label:'Dashboard' },
          { key:'contacts',  label:'Contacts' },
          { key:'reports',   label:'Reports' },
          { key:'map-tool',  label:'Market Mapper' },
          { key:'cpiq',      label:'CPIQ' },
          { key:'fin-analysis', label:'Financial Analysis' },
          // Dynamic tabs from registry
          ...dynamicTabs.map(t => ({ key:`dyn-${t.id}`, label:t.label, badge:t.badge, url:t.url, tabType:t.type })),
          // Add App tab (admin only)
          ...(isAdmin ? [{ key:'add-app', label:'+ Add App', isAddApp:true }] : []),
        ].map(tab => (
          <button key={tab.key} onClick={() => {
            if (tab.tabType === 'link' && tab.url) {
              window.open(tab.url, '_blank', 'noopener,noreferrer')
              return
            }
            setActiveTab(tab.key)
            if (tab.key === 'dashboard') setNewSignalCount(0)
          }}
            style={{ fontSize:13, fontWeight:activeTab===tab.key?500:400, color: tab.isAddApp ? 'var(--text-tertiary)' : activeTab===tab.key?'var(--text)':'var(--text-secondary)', padding:'0 2px', height:52, background:'none', border:'none', borderBottom:activeTab===tab.key?'2px solid var(--accent)':'2px solid transparent', cursor:'pointer', display:'flex', alignItems:'center', gap:6 }}>
            {tab.label}
            {tab.key === 'dashboard' && newSignalCount > 0 && (
              <span style={{ fontSize:10, fontWeight:600, background:'var(--red)', color:'#fff', borderRadius:10, padding:'1px 6px', minWidth:16, textAlign:'center' }}>
                {newSignalCount}
              </span>
            )}
            {tab.badge && (
              <span style={{ fontSize:9, fontWeight:600, background:'var(--amber-light)', color:'var(--amber)', borderRadius:4, padding:'1px 5px', letterSpacing:'.03em' }}>
                {tab.badge}
              </span>
            )}
          </button>
        ))}

        <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:10 }}>
          {/* Live polling indicator */}
          <div style={{ display:'flex', alignItems:'center', gap:5 }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--accent)', animation:'pulse 2s infinite' }} />
            <span style={{ fontSize:11, color:'var(--text-tertiary)' }}>
              {loadingMore ? 'Loading more...' : 'Live'}
            </span>
          </div>
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
                <div style={{ fontSize:13, color:'var(--text-tertiary)' }}>{today} &mdash; {attentionCount > 0 ? `${attentionCount} items need attention` : 'All clear'}</div>
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <Select value={dateRange} onChange={v => setDateRange(v)} options={DATE_RANGE_OPTIONS} />
                <button onClick={() => { fetchData(); fetchTasks(); fetchGold(); fetchActivity() }}
                  style={{ fontSize:12, color:'var(--text-secondary)', background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'6px 14px', cursor:'pointer' }}>
                  Refresh
                </button>
              </div>
            </div>

            {/* Metrics */}
            <div style={{ display:'grid', gridTemplateColumns:'repeat(4,minmax(0,1fr))', gap:10, marginBottom:'1.25rem' }}>
              <MetricCard label="Hot signals"        value={hotCount}          sub="Replies + clicks"    subType="up" />
              <MetricCard label="Warm signals"       value={warmCount}         sub="Opens w/ engagement" subType="neutral" />
              <MetricCard label="Active contacts"    value={contacts.length}   sub={loadingMore ? 'Loading more...' : 'In HubSpot'} subType="neutral" />
              <MetricCard label="Bot opens filtered" value={botCount}          sub="Not shown in feed"   subType="neutral" />
            </div>

            {/* Filter bar */}
            <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginBottom:'1.25rem', padding:'10px 14px', background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', alignItems:'center' }}>
              <div style={{ fontSize:12, fontWeight:500, color:'var(--text-tertiary)', marginRight:4 }}>Filter:</div>
              <Select value={filterBdr} onChange={v => setFilterBdr(v)} options={BDR_OPTIONS} />
              <Select value={filterTerritory} onChange={v => setFilterTerritory(v)} options={TERRITORY_OPTIONS} />
              <Select value={filterTier} onChange={v => setFilterTier(v)} options={TIER_OPTIONS} />
              <Select value={filterTarget} onChange={v => setFilterTarget(v)} options={TARGET_OPTIONS} />
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

            {/* Two columns: task queue + signals */}
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:12 }}>

              {/* ── Smart Task Queue ── */}
              <Panel>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
                  <SectionTitle style={{ margin:0 }}>
                    Task queue
                    {taskData.meta?.counts && (
                      <span style={{ fontSize:10, color:'var(--text-tertiary)', fontWeight:400, letterSpacing:0, textTransform:'none', marginLeft:4 }}>
                        {taskData.meta.counts.repliesAwaitingResponse} replies · {taskData.meta.counts.upcomingSequences} sequences · {taskData.meta.counts.dueTasks} tasks
                      </span>
                    )}
                  </SectionTitle>
                  <Select value={taskDays} onChange={v => setTaskDays(v)} options={TASK_DAYS_OPTIONS} />
                </div>

                {/* Section tabs */}
                <div style={{ display:'flex', gap:0, marginBottom:12, background:'var(--bg-secondary)', borderRadius:'var(--radius)', padding:3 }}>
                  {[
                    { key:'replies',   label:'Replies', count: taskData.repliesAwaitingResponse.length },
                    { key:'sequences', label:'Sequences', count: taskData.upcomingSequences.length },
                    { key:'tasks',     label:'Due tasks', count: taskData.dueTasks.length },
                  ].map(({ key, label, count }) => (
                    <button key={key} onClick={() => { setTaskSection(key); setTaskPage(0) }}
                      style={{ flex:1, fontSize:12, fontWeight: taskSection===key ? 500 : 400, color: taskSection===key ? 'var(--text)' : 'var(--text-tertiary)', background: taskSection===key ? 'var(--bg-panel)' : 'transparent', border:'none', borderRadius:'var(--radius)', padding:'5px 8px', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', gap:5 }}>
                      {label}
                      {count > 0 && (
                        <span style={{ fontSize:10, fontWeight:600, background: taskSection===key ? (key==='replies' ? 'var(--red-light)' : 'var(--accent-light)') : 'var(--border)', color: taskSection===key ? (key==='replies' ? 'var(--red)' : 'var(--accent-text)') : 'var(--text-tertiary)', borderRadius:10, padding:'0 5px', minWidth:16, textAlign:'center' }}>
                          {count}
                        </span>
                      )}
                    </button>
                  ))}
                </div>

                {taskLoading && <div style={{ color:'var(--text-tertiary)', fontSize:13 }}>Loading...</div>}

                {/* Section: Replies awaiting response */}
                {!taskLoading && taskSection === 'replies' && (
                  <>
                    {taskData.repliesAwaitingResponse.length === 0 && (
                      <div style={{ color:'var(--text-tertiary)', fontSize:13 }}>No unanswered replies in this window.</div>
                    )}
                    {taskData.repliesAwaitingResponse.slice(taskPage * PAGE_SIZE, (taskPage+1) * PAGE_SIZE).map((r, i) => (
                      <div key={i} style={{ padding:'12px 0', borderBottom: i < Math.min(taskData.repliesAwaitingResponse.length, PAGE_SIZE)-1 ? '1px solid var(--border)' : 'none' }}>
                        <div style={{ display:'flex', gap:10 }}>
                          <PriorityDot level="hot" />
                          <div style={{ flex:1, minWidth:0 }}>
                            <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:2 }}>
                              <span onClick={() => openHubSpotContact(r.contactId)}
                                style={{ fontWeight:500, fontSize:13, color:'var(--accent)', cursor:'pointer', textDecoration:'underline', textDecorationColor:'var(--border-strong)' }}>
                                {r.contact?.name || 'Unknown'}
                              </span>
                              <button onClick={e => openHubSpotContact(r.contactId, e)} title="Open in HubSpot"
                                style={{ flexShrink:0, background:'none', border:'none', cursor:'pointer', padding:0, color:'var(--text-tertiary)', lineHeight:1 }}>
                                <HsIcon />
                              </button>
                              <Badge label="Needs reply" type="hot" />
                              <span style={{ marginLeft:'auto', fontSize:11, color:'var(--red)', fontWeight:500 }}>
                                {r.waitingHours < 24 ? `${r.waitingHours}h waiting` : `${Math.floor(r.waitingHours/24)}d waiting`}
                              </span>
                            </div>
                            <div style={{ fontSize:12, color:'var(--text-secondary)', marginBottom:4 }}>
                              {r.contact?.title}{r.contact?.company ? ` · ${r.contact.company}` : ''}
                            </div>
                            {r.subject && <div style={{ fontSize:11, color:'var(--text-tertiary)', marginBottom:4 }}>{r.subject}</div>}
                            <div style={{ fontSize:11, color:'var(--text-tertiary)', display:'flex', gap:6, flexWrap:'wrap' }}>
                              <span style={{ color:'var(--text-secondary)', fontWeight:500, minWidth:56 }}>Replied</span>
                              <span>{exactTs(r.replyDate)}</span>
                              <EmailSourcePill source={r.replySource} />
                              {r.contactOwner && (
                                <span style={{ color: r.isOwnedBySelected ? 'var(--accent)' : 'var(--amber)', fontWeight:500 }}>
                                  Owner: {r.contactOwner}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                    <Pager page={taskPage} total={taskData.repliesAwaitingResponse.length} pageSize={PAGE_SIZE} onChange={setTaskPage} />
                  </>
                )}

                {/* Section: Upcoming sequences */}
                {!taskLoading && taskSection === 'sequences' && (
                  <>
                    {taskData.upcomingSequences.length === 0 && (
                      <div style={{ color:'var(--text-tertiary)', fontSize:13 }}>No contacts currently enrolled in sequences.</div>
                    )}
                    {taskData.upcomingSequences.slice(taskPage * PAGE_SIZE, (taskPage+1) * PAGE_SIZE).map((s, i) => (
                      <div key={i} style={{ padding:'12px 0', borderBottom: i < Math.min(taskData.upcomingSequences.length, PAGE_SIZE)-1 ? '1px solid var(--border)' : 'none' }}>
                        <div style={{ display:'flex', gap:10 }}>
                          <PriorityDot level="normal" />
                          <div style={{ flex:1, minWidth:0 }}>
                            <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:2 }}>
                              <span onClick={() => openHubSpotContact(s.contactId)}
                                style={{ fontWeight:500, fontSize:13, color:'var(--accent)', cursor:'pointer', textDecoration:'underline', textDecorationColor:'var(--border-strong)' }}>
                                {s.contact?.name || 'Unknown'}
                              </span>
                              <button onClick={e => openHubSpotContact(s.contactId, e)} title="Open in HubSpot"
                                style={{ flexShrink:0, background:'none', border:'none', cursor:'pointer', padding:0, color:'var(--text-tertiary)', lineHeight:1 }}>
                                <HsIcon />
                              </button>
                              <Badge label={s.signal} type={s.signal === 'Replied' ? 'reply' : s.signal === 'Clicked link' ? 'click' : 'default'} />
                            </div>
                            <div style={{ fontSize:12, color:'var(--text-secondary)', marginBottom:4 }}>
                              {s.contact?.title}{s.contact?.company ? ` · ${s.contact.company}` : ''}
                            </div>
                            <div style={{ fontSize:11, color:'var(--text-tertiary)', display:'flex', flexDirection:'column', gap:2 }}>
                              <div style={{ display:'flex', gap:6 }}>
                                <span style={{ color:'var(--text-secondary)', fontWeight:500, minWidth:56 }}>Sequence</span>
                                <span>{s.sequenceLabel}</span>
                              </div>
                              {s.enrolledDate && (
                                <div style={{ display:'flex', gap:6 }}>
                                  <span style={{ color:'var(--text-secondary)', fontWeight:500, minWidth:56 }}>Enrolled</span>
                                  <span>{shortDate(s.enrolledDate)}</span>
                                </div>
                              )}
                              {s.lastEmailName && (
                                <div style={{ display:'flex', gap:6 }}>
                                  <span style={{ color:'var(--text-secondary)', fontWeight:500, minWidth:56 }}>Last email</span>
                                  <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{s.lastEmailName}</span>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                    <Pager page={taskPage} total={taskData.upcomingSequences.length} pageSize={PAGE_SIZE} onChange={setTaskPage} />
                  </>
                )}

                {/* Section: Due tasks */}
                {!taskLoading && taskSection === 'tasks' && (
                  <>
                    {taskData.dueTasks.length === 0 && (
                      <div style={{ color:'var(--text-tertiary)', fontSize:13 }}>No tasks due in this window.</div>
                    )}
                    {taskData.dueTasks.slice(taskPage * PAGE_SIZE, (taskPage+1) * PAGE_SIZE).map((t, i) => (
                      <div key={i} style={{ padding:'12px 0', borderBottom: i < Math.min(taskData.dueTasks.length, PAGE_SIZE)-1 ? '1px solid var(--border)' : 'none' }}>
                        <div style={{ display:'flex', gap:10 }}>
                          <PriorityDot level={t.priority === 'HIGH' ? 'hot' : 'normal'} />
                          <div style={{ flex:1, minWidth:0 }}>
                            <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:2, flexWrap:'wrap' }}>
                              <span style={{ fontWeight:500, fontSize:13, color:'var(--text)' }}>{t.subject}</span>
                              {t.overdue && <Badge label="Overdue" type="overdue" />}
                              {t.priority === 'HIGH' && !t.overdue && <Badge label="High priority" type="hot" />}
                            </div>
                            {t.body && <div style={{ fontSize:12, color:'var(--text-secondary)', marginBottom:4 }}>{t.body}</div>}
                            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                              <div style={{ fontSize:11, color: t.overdue ? 'var(--red)' : 'var(--text-tertiary)' }}>
                                {t.overdue ? 'Was due' : 'Due'} {shortDate(t.dueDate)}
                              </div>
                              <a href={t.url} target="_blank" rel="noopener noreferrer"
                                style={{ fontSize:11, color:'var(--text-tertiary)', display:'flex', alignItems:'center', gap:3 }}>
                                View in HubSpot <HsIcon />
                              </a>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                    <Pager page={taskPage} total={taskData.dueTasks.length} pageSize={PAGE_SIZE} onChange={setTaskPage} />
                  </>
                )}
              </Panel>

              {/* ── Live signals ── */}
              <Panel>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
                  <SectionTitle style={{ margin:0 }}>Live signals</SectionTitle>
                  <Select value={signalSort} onChange={setSignalSort} options={SIGNAL_SORT_OPTIONS} />
                </div>
                {loading && <div style={{ color:'var(--text-tertiary)', fontSize:13 }}>Loading...</div>}
                {!loading && signals.length === 0 && <div style={{ color:'var(--text-tertiary)', fontSize:13 }}>No signals in this time range.</div>}
                {sortedSignals.slice(signalPage * PAGE_SIZE, (signalPage + 1) * PAGE_SIZE).map((s, i) => {
                  const isReply = s.score >= 100
                  const isClick = s.score >= 60 && s.score < 100
                  const iconColor = isReply ? 'var(--accent)' : isClick ? 'var(--amber)' : 'var(--blue)'
                  const iconBg    = isReply ? 'var(--accent-light)' : isClick ? 'var(--amber-light)' : 'var(--blue-light)'
                  const chain = s.eventChain || []
                  const chainTs = (type) => chain.find(e => e.type === type)?.timestamp || null
                  const sentAt    = s.sentAt    || chainTs('SENT')    || null
                  const openedAt  = s.openedAt  || chainTs('OPENED')  || (s.eventType === 'OPEN'  ? s.timestamp : null)
                  const clickedAt = s.clickedAt || chainTs('CLICKED') || (s.eventType === 'CLICK' ? s.timestamp : null)
                  const repliedAt = s.repliedAt || chainTs('REPLIED') || null
                  return (
                    <div key={i} style={{ padding:'10px 0', borderBottom: i < Math.min(sortedSignals.slice(signalPage * PAGE_SIZE, (signalPage+1)*PAGE_SIZE).length, PAGE_SIZE)-1 ? '1px solid var(--border)' : 'none' }}>
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
                          <div style={{ display:'flex', alignItems:'center', gap:5, marginBottom:2, flexWrap:'wrap' }}>
                            <span onClick={s.contactId ? () => openHubSpotContact(s.contactId) : undefined}
                              style={{ fontSize:13, fontWeight:500, color: s.contactId ? 'var(--accent)' : 'var(--text)', cursor: s.contactId ? 'pointer' : 'default' }}>
                              {s.contact?.name || s.recipientEmail || 'Unknown'} &mdash; {s.label}
                            </span>
                            {s.contactId && (
                              <button onClick={e => openHubSpotContact(s.contactId, e)} title="Open in HubSpot"
                                style={{ flexShrink:0, background:'none', border:'none', cursor:'pointer', padding:0, color:'var(--text-tertiary)', lineHeight:1 }}>
                                <HsIcon />
                              </button>
                            )}
                            <EmailSourcePill source={s.emailSource} />
                          </div>
                          <div style={{ fontSize:11, color:'var(--text-tertiary)', marginBottom:4 }}>{cleanSubject(s.subject, s.campaignId)}</div>
                          <TimestampChain sentAt={sentAt} openedAt={openedAt} clickedAt={clickedAt} repliedAt={repliedAt} ts={s.timestamp} />
                        </div>
                      </div>
                    </div>
                  )
                })}
                <Pager page={signalPage} total={sortedSignals.length} pageSize={PAGE_SIZE} onChange={setSignalPage} />
              </Panel>
            </div>

            {/* ── Gold Accounts panel ── */}
            <Panel style={{ marginBottom:12 }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12, flexWrap:'wrap', gap:8 }}>
                <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                  <SectionTitle style={{ margin:0 }}>Gold accounts</SectionTitle>
                  {goldAccounts.length > 0 && (
                    <div style={{ fontSize:11, color:'var(--text-tertiary)' }}>
                      {filteredGold.length} contacts{goldTierFilter ? ` in ${goldTierFilter}` : ' across all tiers'}
                    </div>
                  )}
                </div>
                <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
                  {/* Tier quick-filter pills */}
                  <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
                    {['', 'GOLD - 1-10', 'GOLD - 11-20', 'GOLD - 21-30', 'GOLD - 31-40', 'GOLD - 41-50'].map(tier => (
                      <button key={tier} onClick={() => { setGoldTierFilter(tier); setGoldPage(0) }}
                        style={{ fontSize:11, padding:'3px 8px', borderRadius:20, border:'1px solid var(--border)', cursor:'pointer', background: goldTierFilter===tier ? '#FEF3C7' : 'var(--bg-secondary)', color: goldTierFilter===tier ? '#92400E' : 'var(--text-tertiary)', fontWeight: goldTierFilter===tier ? 500 : 400 }}>
                        {tier ? tier.replace('GOLD - ', 'GOLD ') : 'All'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {goldLoading && <div style={{ color:'var(--text-tertiary)', fontSize:13 }}>Loading...</div>}
              {!goldLoading && filteredGold.length === 0 && (
                <div style={{ color:'var(--text-tertiary)', fontSize:13 }}>No Gold accounts found{filterBdr ? ` for ${filterBdr}` : ''}.</div>
              )}

              {!goldLoading && filteredGold.length > 0 && (
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                  <thead>
                    <tr>
                      {['Company', 'Contacts', 'Tier', 'Last sent', 'Last engagement'].map(h => (
                        <th key={h} style={{ textAlign:'left', fontSize:11, fontWeight:500, color:'var(--text-tertiary)', textTransform:'uppercase', letterSpacing:'.04em', padding:'0 8px 8px 0', borderBottom:'1px solid var(--border)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredGold.slice(goldPage * PAGE_SIZE, (goldPage+1) * PAGE_SIZE).map((a, i) => (
                      <tr key={i} style={{ borderBottom: i < Math.min(filteredGold.length, PAGE_SIZE)-1 ? '1px solid var(--border)' : 'none', verticalAlign:'top' }}>
                        <td style={{ padding:'9px 8px 9px 0' }}>
                          <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                            <a href={a.url} target="_blank" rel="noopener noreferrer"
                              style={{ fontWeight:500, color:'var(--accent)', textDecoration:'none' }}>
                              {a.name || '—'}
                            </a>
                          </div>
                          {a.territory && <div style={{ fontSize:11, color:'var(--text-tertiary)' }}>{a.territory}</div>}
                        </td>
                        <td style={{ padding:'9px 8px 9px 0' }}>
                          {(a.contacts || []).length === 0 && <span style={{ color:'var(--text-tertiary)', fontSize:12 }}>None</span>}
                          {(a.contacts || []).slice(0, 3).map((c, ci) => (
                            <div key={ci} style={{ display:'flex', alignItems:'center', gap:4, marginBottom:2 }}>
                              <span onClick={() => openHubSpotContact(c.id)}
                                style={{ fontSize:12, color:'var(--accent)', cursor:'pointer' }}>
                                {c.name}
                              </span>
                              {c.title && <span style={{ fontSize:11, color:'var(--text-tertiary)' }}>{c.title}</span>}
                            </div>
                          ))}
                        </td>
                        <td style={{ padding:'9px 8px 9px 0' }}>
                          <span style={{ fontSize:11, fontWeight:500, padding:'2px 8px', borderRadius:20, background:'#FEF3C7', color:'#92400E', whiteSpace:'nowrap' }}>
                            {a.tier.replace('GOLD - ', 'GOLD ')}
                          </span>
                        </td>
                        <td style={{ padding:'9px 8px 9px 0' }}>
                          {a.lastSent ? (
                            <div>
                              <div style={{ fontSize:12, color:'var(--text)', fontWeight:500 }}>{timeAgo(a.lastSent.date)}</div>
                              {a.lastSent.subject && <div style={{ fontSize:11, color:'var(--text-tertiary)', maxWidth:160, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{a.lastSent.subject}</div>}
                              {a.lastSent.contact && <div style={{ fontSize:11, color:'var(--text-tertiary)' }}>to {a.lastSent.contact}</div>}
                            </div>
                          ) : <span style={{ color:'var(--text-tertiary)', fontSize:12 }}>—</span>}
                        </td>
                        <td style={{ padding:'9px 0' }}>
                          {a.lastEngagement ? (
                            <div>
                              <Badge
                                label={a.lastEngagement.label}
                                type={a.lastEngagement.type === 'replied' ? 'reply' : a.lastEngagement.type === 'clicked' ? 'click' : 'hot'}
                              />
                              <div style={{ fontSize:11, color:'var(--text-tertiary)', marginTop:2 }}>{timeAgo(a.lastEngagement.date)}</div>
                              <div style={{ fontSize:11, color:'var(--text-tertiary)' }}>{a.lastEngagement.contact}</div>
                            </div>
                          ) : <span style={{ color:'var(--text-tertiary)', fontSize:12 }}>No engagement yet</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <Pager page={goldPage} total={filteredGold.length} pageSize={PAGE_SIZE} onChange={setGoldPage} />
            </Panel>

            {/* ── Activity summary ── */}
            <Panel style={{ marginBottom:12 }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16, flexWrap:'wrap', gap:8 }}>
                <SectionTitle style={{ margin:0 }}>Activity summary</SectionTitle>
                <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
                  {/* Rep selector */}
                  <select value={activityRep} onChange={e => setActivityRep(e.target.value)}
                    style={{ fontSize:12, color:'var(--text-secondary)', background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'5px 10px', cursor:'pointer', outline:'none' }}>
                    <option value="all">All reps</option>
                    {owners.map(o => (
                      <option key={o.id} value={o.filterValue || o.name}>{o.name}</option>
                    ))}
                  </select>
                  {/* Include owned toggle */}
                  <label style={{ display:'flex', alignItems:'center', gap:5, fontSize:12, color:'var(--text-secondary)', cursor:'pointer' }}>
                    <input type="checkbox" checked={activityIncludeOwned} onChange={e => setActivityIncludeOwned(e.target.checked)}
                      style={{ cursor:'pointer' }} />
                    Include AE-owned
                  </label>
                  <Select value={activityDays} onChange={v => setActivityDays(v)} options={ACTIVITY_DAYS_OPTIONS} />
                </div>
              </div>

              {activityLoading && <div style={{ color:'var(--text-tertiary)', fontSize:13 }}>Loading...</div>}

              {!activityLoading && activityData && (
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>

                  {/* Outbound */}
                  <div>
                    <div style={{ fontSize:11, fontWeight:500, letterSpacing:'.06em', textTransform:'uppercase', color:'var(--text-tertiary)', marginBottom:10 }}>Outbound</div>
                    <div style={{ display:'flex', flexDirection:'column', gap:0 }}>
                      {[
                        { key:'emailsSent',       label:'Emails sent',        icon:'📧' },
                        { key:'sequencesStarted', label:'Sequences started',   icon:'🔁' },
                        { key:'callsLogged',      label:'Calls logged',        icon:'📞' },
                        { key:'meetingsLogged',   label:'Meetings logged',     icon:'📅' },
                        { key:'notesLogged',      label:'Notes logged',        icon:'📝' },
                      ].map(({ key, label, icon }, i) => {
                        const val = activityData.summary?.outbound?.[key] ?? 0
                        return (
                          <div key={key} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'9px 0', borderBottom: i < 4 ? '1px solid var(--border)' : 'none' }}>
                            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                              <span style={{ fontSize:14 }}>{icon}</span>
                              <span style={{ fontSize:13, color:'var(--text-secondary)' }}>{label}</span>
                            </div>
                            <span style={{ fontSize:15, fontWeight:500, color: val > 0 ? 'var(--text)' : 'var(--text-tertiary)' }}>{val.toLocaleString()}</span>
                          </div>
                        )
                      })}
                    </div>
                  </div>

                  {/* Inbound */}
                  <div>
                    <div style={{ fontSize:11, fontWeight:500, letterSpacing:'.06em', textTransform:'uppercase', color:'var(--text-tertiary)', marginBottom:10 }}>Inbound</div>
                    <div style={{ display:'flex', flexDirection:'column', gap:0 }}>
                      {[
                        { key:'repliesReceived', label:'Replies received', icon:'↩️' },
                        { key:'linksClicked',    label:'Links clicked',    icon:'🔗' },
                        { key:'emailsOpened',    label:'Emails opened',    icon:'👁' },
                      ].map(({ key, label, icon }, i) => {
                        const val = activityData.summary?.inbound?.[key] ?? 0
                        return (
                          <div key={key} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'9px 0', borderBottom: i < 2 ? '1px solid var(--border)' : 'none' }}>
                            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                              <span style={{ fontSize:14 }}>{icon}</span>
                              <span style={{ fontSize:13, color:'var(--text-secondary)' }}>{label}</span>
                            </div>
                            <span style={{ fontSize:15, fontWeight:500, color: val > 0 ? 'var(--text)' : 'var(--text-tertiary)' }}>{val.toLocaleString()}</span>
                          </div>
                        )
                      })}
                    </div>

                    {/* Counts note */}
                    <div style={{ marginTop:16, fontSize:11, color:'var(--text-tertiary)', lineHeight:1.5, padding:'8px 10px', background:'var(--bg-secondary)', borderRadius:'var(--radius)' }}>
                      Counts = unique contacts touched, not total send volume.
                      {activityData.meta?.since && ` Since ${shortDate(activityData.meta.since)}.`}
                    </div>

                    {/* Per-rep breakdown (when all reps selected) */}
                    {activityRep === 'all' && activityData.byRep && (
                      <div style={{ marginTop:12 }}>
                        <div style={{ fontSize:11, fontWeight:500, letterSpacing:'.06em', textTransform:'uppercase', color:'var(--text-tertiary)', marginBottom:8 }}>By rep</div>
                        {Object.entries(activityData.byRep).map(([repName, data]) => {
                          const totalOut = Object.values(data.outbound || {}).reduce((a,b) => a+b, 0)
                          const totalIn  = Object.values(data.inbound  || {}).reduce((a,b) => a+b, 0)
                          return (
                            <div key={repName} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'6px 0', borderBottom:'1px solid var(--border)', fontSize:12 }}>
                              <span style={{ color:'var(--text-secondary)' }}>{repName}</span>
                              <div style={{ display:'flex', gap:12 }}>
                                <span style={{ color:'var(--text-tertiary)' }}>↑ {totalOut}</span>
                                <span style={{ color:'var(--text-tertiary)' }}>↓ {totalIn}</span>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </Panel>

            {/* AI Recommendations */}
            <Panel style={{ marginBottom:12 }}>
              <SectionTitle>AI recommendations &mdash; persona-aware</SectionTitle>
              {signalCards.length === 0 && !loading && <div style={{ color:'var(--text-tertiary)', fontSize:13 }}>No signals to base recommendations on yet.</div>}
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                {signalCards.slice(0,4).map((t, i) => {
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
                            <HsIcon />
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
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
                <SectionTitle style={{ margin:0 }}>Content engagement &mdash; link clicks</SectionTitle>
                <button onClick={fetchContentEngagement} style={{ fontSize:11, color:'var(--text-tertiary)', background:'none', border:'none', cursor:'pointer', padding:0 }}>
                  Refresh
                </button>
              </div>
              {contentEngagementLoading && (
                <div style={{ color:'var(--text-tertiary)', fontSize:13 }}>Loading…</div>
              )}
              {!contentEngagementLoading && contentEngagement.length === 0 && (
                <div style={{ color:'var(--text-tertiary)', fontSize:13 }}>No link clicks found for the current filter.</div>
              )}
              {!contentEngagementLoading && contentEngagement.length > 0 && (
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                  <thead>
                    <tr>
                      {['Contact','Company / Title','Email clicked from','Clicked'].map(h => (
                        <th key={h} style={{ textAlign:'left', fontSize:11, fontWeight:500, color:'var(--text-tertiary)', textTransform:'uppercase', letterSpacing:'.04em', padding:'0 8px 8px 0', borderBottom:'1px solid var(--border)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {contentEngagement.slice(0,15).map((c, i) => (
                      <tr key={i} style={{ borderBottom: i < Math.min(contentEngagement.length,15)-1 ? '1px solid var(--border)' : 'none' }}>
                        <td style={{ padding:'9px 8px 9px 0' }}>
                          <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                            <span style={{ fontWeight:500, color:'var(--text)' }}>{c.name}</span>
                            {c.contactId && (
                              <button onClick={() => openHubSpotContact(c.contactId)}
                                title="Open in HubSpot"
                                style={{ background:'none', border:'none', cursor:'pointer', padding:0, color:'var(--text-tertiary)', lineHeight:1 }}>
                                <HsIcon />
                              </button>
                            )}
                          </div>
                        </td>
                        <td style={{ padding:'9px 8px 9px 0', color:'var(--text-secondary)', fontSize:12 }}>
                          {c.company || '—'}{c.title ? ` · ${c.title}` : ''}
                        </td>
                        <td style={{ padding:'9px 8px 9px 0', color:'var(--text-secondary)', fontSize:12, maxWidth:220, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                          {c.subject || <span style={{ color:'var(--text-tertiary)' }}>Unknown email</span>}
                        </td>
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

        {/* ── Market Mapper tab ── */}
        {activeTab === 'map-tool' && (
          <div style={{ height:'calc(100vh - 52px)', marginTop:'-1.5rem', marginLeft:'-1.5rem', marginRight:'-1.5rem' }}>
            <iframe
              src="https://mapping-tool-cc.netlify.app/"
              title="CarePathIQ Market Mapper"
              style={{ width:'100%', height:'100%', border:'none', display:'block' }}
              allow="fullscreen"
            />
          </div>
        )}

        {/* ── Reports tab ── */}
        {activeTab === 'reports' && (
          <ReportsTab safeFetch={safeFetch} owners={owners} />
        )}

        {/* ── Financial Analysis tab ── */}
        {activeTab === 'fin-analysis' && (
          <div style={{ height:'calc(100vh - 52px)', marginTop:'-1.5rem', marginLeft:'-1.5rem', marginRight:'-1.5rem' }}>
            <iframe
              src="https://custom-financial-analysis.netlify.app/"
              title="Custom Financial Analysis"
              style={{ width:'100%', height:'100%', border:'none', display:'block' }}
              allow="fullscreen"
            />
          </div>
        )}

        {/* ── CPIQ tab ── */}
        {activeTab === 'cpiq' && (
          <div style={{ height:'calc(100vh - 52px)', marginTop:'-1.5rem', marginLeft:'-1.5rem', marginRight:'-1.5rem' }}>
            <iframe
              src="https://cpiq-tool.netlify.app/"
              title="Custom Financial Analysis"
              style={{ width:'100%', height:'100%', border:'none', display:'block' }}
              allow="fullscreen"
            />
          </div>
        )}

        {/* ── Dynamic tabs (from registry) ── */}
        {dynamicTabs.map(tab => activeTab === `dyn-${tab.id}` && (
          <div key={tab.id} style={{ height:'calc(100vh - 52px)', marginTop:'-1.5rem', marginLeft:'-1.5rem', marginRight:'-1.5rem' }}>
            <iframe
              src={tab.url}
              title={tab.label}
              style={{ width:'100%', height:'100%', border:'none', display:'block' }}
              allow="fullscreen"
            />
          </div>
        ))}

        {/* ── Add App tab ── */}
        {activeTab === 'add-app' && isAdmin && (
          <AddAppTab
            getToken={getToken}
            safeFetch={safeFetch}
            onSaved={(newTab) => {
              setDynamicTabs(prev => {
                const existing = prev.findIndex(t => t.id === newTab.id)
                if (existing >= 0) {
                  const updated = [...prev]
                  updated[existing] = newTab
                  return updated
                }
                return [...prev, newTab]
              })
              setActiveTab(`dyn-${newTab.id}`)
            }}
            existingTabs={dynamicTabs}
            onDelete={(tabId) => {
              setDynamicTabs(prev => prev.filter(t => t.id !== tabId))
              setActiveTab('dashboard')
            }}
          />
        )}
      </div>
    </div>
  )
}

// ─── Reports Tab ─────────────────────────────────────────────────────────────
const PORTAL    = '39921549'
const HS_BASE   = 'https://app.hubspot.com'
const DASHBOARD = `${HS_BASE}/reports-dashboard/${PORTAL}/view/19874520`

function ReportsTab({ safeFetch, owners }) {
  const [section, setSection]     = useState('email_activity')
  const [period, setPeriod]       = useState('month')
  const [rep, setRep]             = useState('all')
  const [owner, setOwner]         = useState('')
  const [data, setData]           = useState(null)
  const [loading, setLoading]     = useState(false)
  const [activityPage, setActivityPage] = useState(0)
  const [dealsPage, setDealsPage]       = useState(0)
  const PAGE_SIZE = 25

  // When switching to deals, default to 1 year; switching away, reset to month
  const handleSetSection = useCallback((s) => {
    setSection(s)
    if (s === 'deals') setPeriod('year')
    else setPeriod('month')
  }, [])

  const ownerMap = useMemo(() => {
    const m = {}
    owners.forEach(o => { m[o.id] = o.name })
    return m
  }, [owners])

  const ownerOptions = useMemo(() => [
    { value: '', label: 'All owners' },
    ...owners.filter(o => o.name && o.name.trim()).map(o => ({ value: o.id, label: o.name }))
  ], [owners])

  const fetchReport = useCallback(async () => {
    setLoading(true)
    setData(null)
    setActivityPage(0)
    setDealsPage(0)
    try {
      const params = new URLSearchParams({ section, period, rep })
      if (owner) params.set('owner', owner)
      const result = await safeFetch(`/api/hubspot/reports?${params}`)
      setData(result)
    } catch (e) {
      console.error('[reports]', e)
    } finally {
      setLoading(false)
    }
  }, [section, period, rep, owner])

  useEffect(() => {
    fetchReport()
  }, [fetchReport])

  const fmt      = n => typeof n === 'number' ? n.toLocaleString() : (n ?? '—')
  const fmtMoney = n => n ? `$${Math.round(n).toLocaleString()}` : '$0'
  const fmtPct   = n => n != null ? `${n}%` : '—'
  const fmtDate  = d => d ? new Date(d).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '—'
  const openHS   = url => window.open(url, '_blank', 'noopener,noreferrer')

  const SECTIONS = [
    { key:'email_activity', label:'Email Activity' },
    { key:'marketing',      label:'Marketing' },
    { key:'sequences',      label:'Sequences' },
    { key:'deals',          label:'Deals' },
  ]

  const KpiCard = ({ label, value, sub, href, accent }) => (
    <div onClick={() => href && openHS(href)} title={href ? 'Open in HubSpot ↗' : ''}
      style={{ background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'14px 16px', cursor: href ? 'pointer' : 'default', transition:'border-color .15s' }}
      onMouseEnter={e => href && (e.currentTarget.style.borderColor='var(--accent)')}
      onMouseLeave={e => href && (e.currentTarget.style.borderColor='var(--border)')}>
      <div style={{ fontSize:12, color:'var(--text-tertiary)', marginBottom:4 }}>{label}</div>
      <div style={{ fontSize:22, fontWeight:600, color: accent ? 'var(--accent)' : 'var(--text)' }}>{value}</div>
      {sub && <div style={{ fontSize:11, color:'var(--text-tertiary)', marginTop:3 }}>{sub}{href ? ' ↗' : ''}</div>}
    </div>
  )

  const Pager = ({ page, setPage, total }) => {
    const pages = Math.ceil(total / PAGE_SIZE)
    if (pages <= 1) return null
    return (
      <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:12, justifyContent:'flex-end' }}>
        <button onClick={() => setPage(p => Math.max(0,p-1))} disabled={page===0}
          style={{ fontSize:12, padding:'4px 10px', background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)', cursor:page===0?'not-allowed':'pointer', color:page===0?'var(--text-tertiary)':'var(--text)' }}>← Prev</button>
        <span style={{ fontSize:12, color:'var(--text-tertiary)' }}>{page*PAGE_SIZE+1}–{Math.min((page+1)*PAGE_SIZE,total)} of {total}</span>
        <button onClick={() => setPage(p => Math.min(pages-1,p+1))} disabled={page>=pages-1}
          style={{ fontSize:12, padding:'4px 10px', background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)', cursor:page>=pages-1?'not-allowed':'pointer', color:page>=pages-1?'var(--text-tertiary)':'var(--text)' }}>Next →</button>
      </div>
    )
  }

  const THead = ({ cols }) => (
    <thead><tr>{cols.map(h => (
      <th key={h} style={{ textAlign:'left', fontSize:11, fontWeight:500, color:'var(--text-tertiary)', textTransform:'uppercase', letterSpacing:'.04em', padding:'0 10px 8px 0', borderBottom:'1px solid var(--border)', whiteSpace:'nowrap' }}>{h}</th>
    ))}</tr></thead>
  )

  return (
    <div>
      {/* Controls bar */}
      <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:'1.5rem', flexWrap:'wrap' }}>
        <div style={{ display:'flex', background:'var(--bg-panel)', borderRadius:'var(--radius-lg)', padding:4, border:'1px solid var(--border)', gap:2 }}>
          {SECTIONS.map(s => (
            <button key={s.key} onClick={() => handleSetSection(s.key)}
              style={{ fontSize:13, fontWeight:section===s.key?500:400, color:section===s.key?'var(--text)':'var(--text-secondary)', background:section===s.key?'var(--bg-secondary)':'transparent', border:'none', borderRadius:'var(--radius)', padding:'6px 16px', cursor:'pointer', whiteSpace:'nowrap' }}>
              {s.label}
            </button>
          ))}
        </div>
        <div style={{ marginLeft:'auto', display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
          <Select value={period} onChange={setPeriod} options={REPORT_PERIOD_OPTIONS} />
          {section !== 'deals' && (
            <Select value={rep} onChange={setRep} options={REPORT_REP_OPTIONS} />
          )}
          {section === 'deals' && (
            <Select value={owner} onChange={setOwner} options={ownerOptions} />
          )}
          <button onClick={fetchReport}
            style={{ fontSize:12, color:'var(--text-secondary)', background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'6px 14px', cursor:'pointer' }}>
            Refresh
          </button>
          <button onClick={() => openHS(DASHBOARD)}
            style={{ fontSize:12, color:'var(--accent)', background:'var(--accent-light)', border:'1px solid var(--accent)', borderRadius:'var(--radius)', padding:'6px 14px', cursor:'pointer' }}>
            Open in HubSpot ↗
          </button>
        </div>
      </div>

      {loading && (
        <div style={{ display:'flex', alignItems:'center', gap:10, color:'var(--text-tertiary)', fontSize:13, padding:'3rem', justifyContent:'center' }}>
          <div style={{ width:18, height:18, border:'2px solid var(--border)', borderTopColor:'var(--accent)', borderRadius:'50%', animation:'spin 0.8s linear infinite' }} />
          Loading report…
        </div>
      )}

      {/* ── Email Activity ── */}
      {!loading && data && section === 'email_activity' && (() => {
        const T = data.totals || {}
        const L = data.links || {}
        return (
          <div>
            {T.source === 'contact_properties' && (
              <div style={{ fontSize:11, color:'var(--text-tertiary)', marginBottom:12, padding:'8px 12px', background:'var(--bg-panel)', borderRadius:'var(--radius)', border:'1px solid var(--border)' }}>
                Counts reflect unique contacts with activity. For raw send volume totals, see HubSpot directly.
                <button onClick={() => openHS(DASHBOARD)} style={{ marginLeft:8, color:'var(--accent)', background:'none', border:'none', cursor:'pointer', padding:0, fontSize:11 }}>View in HubSpot ↗</button>
              </div>
            )}
            {/* 6 KPIs matching screenshot: Emails Sent, Opens, Open Rate, Clicks, Click Rate, Replies */}
            <div style={{ display:'grid', gridTemplateColumns:'repeat(6,minmax(0,1fr))', gap:10, marginBottom:'1.5rem' }}>
              <KpiCard label="Emails sent"   value={fmt(T.sent)}           sub="Total sent"                         href={L.contacts} />
              <KpiCard label="Email opens"   value={fmt(T.opens)}          sub={`${fmtPct(T.openRate)} open rate`}  href={L.contacts} />
              <KpiCard label="Open rate"     value={fmtPct(T.openRate)}    sub="Of emails sent"                     href={L.contacts} accent />
              <KpiCard label="Clicks"        value={fmt(T.clicks)}         sub={`${fmtPct(T.clickRate)} click rate`} href={L.contacts} />
              <KpiCard label="Click rate"    value={fmtPct(T.clickRate)}   sub="Of emails sent"                     href={L.contacts} accent />
              <KpiCard label="Replies"       value={fmt(T.replies)}        sub={`${fmtPct(T.replyRate)} reply rate`} href={L.contacts} />
            </div>

            {(data.byRep||[]).length > 1 && (
              <Panel style={{ marginBottom:12 }}>
                <SectionTitle>By rep</SectionTitle>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                  <THead cols={['Rep','Sent','Opens','Open %','Clicks','Click %','Replies','Reply %','Sequences']} />
                  <tbody>
                    {(data.byRep||[]).map((r,i) => (
                      <tr key={i} style={{ borderBottom: i<data.byRep.length-1?'1px solid var(--border)':'none' }}>
                        <td style={{ padding:'8px 10px 8px 0', fontWeight:500 }}>{r.rep}</td>
                        <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{fmt(r.sent)}</td>
                        <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{fmt(r.opens)}</td>
                        <td style={{ padding:'8px 10px 8px 0', color:'var(--accent)' }}>{fmtPct(r.openRate)}</td>
                        <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{fmt(r.clicks)}</td>
                        <td style={{ padding:'8px 10px 8px 0', color:'var(--accent)' }}>{fmtPct(r.clickRate)}</td>
                        <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{fmt(r.replies)}</td>
                        <td style={{ padding:'8px 10px 8px 0', color:'var(--accent)' }}>{fmtPct(r.replyRate)}</td>
                        <td style={{ padding:'8px 0', color:'var(--text-secondary)' }}>{fmt(r.sequences)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            )}

            <Panel>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
                <SectionTitle style={{ margin:0 }}>Recent email activity</SectionTitle>
                <span style={{ fontSize:11, color:'var(--text-tertiary)' }}>{(data.recent||[]).length} contacts</span>
              </div>
              {(data.recent||[]).length === 0
                ? <div style={{ fontSize:13, color:'var(--text-tertiary)' }}>No activity in this period.</div>
                : <>
                  <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                    <THead cols={['Contact','Company','BDR','Last email','Sent','Opened','Replied']} />
                    <tbody>
                      {(data.recent||[]).slice(activityPage*PAGE_SIZE,(activityPage+1)*PAGE_SIZE).map((c,i) => (
                        <tr key={i} style={{ borderBottom: i<PAGE_SIZE-1?'1px solid var(--border)':'none' }}>
                          <td style={{ padding:'8px 10px 8px 0' }}>
                            <a href={c.url} target="_blank" rel="noopener noreferrer" style={{ color:'var(--accent)', textDecoration:'none', fontWeight:500 }}>{c.name||'—'}</a>
                          </td>
                          <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)', fontSize:12 }}>{c.company||'—'}</td>
                          <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)', fontSize:12 }}>{c.bdr||'—'}</td>
                          <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)', fontSize:12, maxWidth:180, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{c.emailName||'—'}</td>
                          <td style={{ padding:'8px 10px 8px 0', color:'var(--text-tertiary)', fontSize:12, whiteSpace:'nowrap' }}>{fmtDate(c.sent)}</td>
                          <td style={{ padding:'8px 10px 8px 0', fontSize:12 }}>
                            {c.opened ? <span style={{ color:'var(--accent)' }}>✓ {fmtDate(c.opened)}</span> : <span style={{ color:'var(--text-tertiary)' }}>—</span>}
                          </td>
                          <td style={{ padding:'8px 0', fontSize:12 }}>
                            {c.replied ? <span style={{ color:'var(--green,#16a34a)' }}>✓ {fmtDate(c.replied)}</span> : <span style={{ color:'var(--text-tertiary)' }}>—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <Pager page={activityPage} setPage={setActivityPage} total={(data.recent||[]).length} />
                </>
              }
            </Panel>
          </div>
        )
      })()}

      {/* ── Marketing ── */}
      {!loading && data && section === 'marketing' && (() => {
        const T = data.totals || {}
        const L = data.links || {}
        const ctr = (T.totalOpened > 0 && T.totalClicked > 0)
          ? fmtPct(+((T.totalClicked / T.totalOpened) * 100).toFixed(1))
          : '—'
        return (
          <div>
            {data.usedFallback && (
              <div style={{ fontSize:11, color:'var(--amber)', marginBottom:12, padding:'8px 12px', background:'var(--bg-panel)', borderRadius:'var(--radius)', border:'1px solid var(--border)' }}>
                ⚠ Marketing emails API unavailable — showing contact-level estimates.
                <button onClick={() => openHS(L.manage)} style={{ marginLeft:8, color:'var(--accent)', background:'none', border:'none', cursor:'pointer', padding:0, fontSize:11 }}>View in HubSpot ↗</button>
              </div>
            )}
            <div style={{ display:'grid', gridTemplateColumns:'repeat(4,minmax(0,1fr))', gap:10, marginBottom:10 }}>
              <KpiCard label="Emails sent"  value={fmt(T.totalReached)}  sub="Total delivered"                    href={L.manage} />
              <KpiCard label="Opens"        value={fmt(T.totalOpened)}   sub={`${fmtPct(T.openRate)} open rate`}  href={L.manage} />
              <KpiCard label="Clicks"       value={fmt(T.totalClicked)}  sub={`${fmtPct(T.clickRate)} click rate`} href={L.manage} />
              <KpiCard label="Replies"      value={fmt(T.totalReplied)}  sub={`${fmtPct(T.replyRate)} reply rate`} href={L.manage} />
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(4,minmax(0,1fr))', gap:10, marginBottom:'1.5rem' }}>
              <KpiCard label="Open rate"       value={fmtPct(T.openRate)}  sub="Industry avg ~20%"  href={L.manage} accent />
              <KpiCard label="Click rate"      value={fmtPct(T.clickRate)} sub="Industry avg ~2-3%" href={L.manage} accent />
              <KpiCard label="Reply rate"      value={fmtPct(T.replyRate)} sub="Industry avg ~1%"   href={L.manage} accent />
              <KpiCard label="Click-through"   value={ctr}                 sub="Clicks / opens"     href={L.manage} accent />
            </div>
            {(data.byRep||[]).length > 1 && (
              <Panel style={{ marginBottom:12 }}>
                <SectionTitle>By rep</SectionTitle>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                  <THead cols={['Rep','Emails sent','Reached','Opened','Open %','Clicked','Click %','Replied','Reply %']} />
                  <tbody>
                    {(data.byRep||[]).map((r,i) => (
                      <tr key={i} style={{ borderBottom:i<data.byRep.length-1?'1px solid var(--border)':'none' }}>
                        <td style={{ padding:'8px 10px 8px 0', fontWeight:500 }}>{r.rep}</td>
                        <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{fmt(r.emailCount)}</td>
                        <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{fmt(r.reached)}</td>
                        <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{fmt(r.opened)}</td>
                        <td style={{ padding:'8px 10px 8px 0', color:'var(--accent)' }}>{fmtPct(r.openRate)}</td>
                        <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{fmt(r.clicked)}</td>
                        <td style={{ padding:'8px 10px 8px 0', color:'var(--accent)' }}>{fmtPct(r.clickRate)}</td>
                        <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{fmt(r.replied)}</td>
                        <td style={{ padding:'8px 0', color:'var(--accent)' }}>{fmtPct(r.replyRate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            )}

            <Panel>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
                <SectionTitle style={{ margin:0 }}>Marketing emails sent</SectionTitle>
                <button onClick={() => openHS(L.manage)} style={{ fontSize:11, color:'var(--accent)', background:'none', border:'none', cursor:'pointer', padding:0 }}>
                  View all in HubSpot ↗
                </button>
              </div>
              {data.usedFallback && (
                <div style={{ fontSize:11, color:'var(--amber)', marginBottom:8 }}>
                  ⚠ Marketing emails API unavailable — showing contact-level estimates. <button onClick={() => openHS(L.manage)} style={{ color:'var(--accent)', background:'none', border:'none', cursor:'pointer', padding:0, fontSize:11 }}>View in HubSpot ↗</button>
                </div>
              )}
              {(data.campaigns||[]).length === 0
                ? <div style={{ fontSize:13, color:'var(--text-tertiary)' }}>
                    No marketing emails found in this period.
                    {rep !== 'all' && <span> Try switching to "All reps" — emails may not be attributed to this rep.</span>}
                  </div>
                : <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                    <THead cols={['Email / Campaign','Sent','Opens','Open %','Clicks','Click %','Replies','Reply %','Unsub %','Bounce %','Sent by','Date']} />
                    <tbody>
                      {(data.campaigns||[]).map((c,i) => (
                        <tr key={i} onClick={() => openHS(c.url || L.manage)} style={{ borderBottom:i<data.campaigns.length-1?'1px solid var(--border)':'none', cursor:'pointer' }}
                          onMouseEnter={e => e.currentTarget.style.background='var(--bg-secondary)'}
                          onMouseLeave={e => e.currentTarget.style.background=''}>
                          <td style={{ padding:'8px 10px 8px 0', color:'var(--accent)', maxWidth:200, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{c.name}</td>
                          <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{fmt(c.sent)}</td>
                          <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{fmt(c.opened)}</td>
                          <td style={{ padding:'8px 10px 8px 0' }}>
                            <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                              <span style={{ color: c.openRate>=20?'var(--accent)':c.openRate>=10?'var(--amber)':'var(--text-secondary)', minWidth:32 }}>{fmtPct(c.openRate)}</span>
                              <div style={{ width:36, height:4, background:'var(--bg-secondary)', borderRadius:2 }}>
                                <div style={{ width:`${Math.min(c.openRate||0,100)}%`, height:'100%', background:'var(--accent)', borderRadius:2 }} />
                              </div>
                            </div>
                          </td>
                          <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{fmt(c.clicked)}</td>
                          <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{fmtPct(c.clickRate)}</td>
                          <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{fmt(c.replied)}</td>
                          <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{fmtPct(c.replyRate)}</td>
                          <td style={{ padding:'8px 10px 8px 0', color: c.unsubscribeRate>0.5?'var(--red)':'var(--text-secondary)' }}>{fmtPct(c.unsubscribeRate)}</td>
                          <td style={{ padding:'8px 10px 8px 0', color: c.bounceRate>2?'var(--red)':'var(--text-secondary)' }}>{fmtPct(c.bounceRate)}</td>
                          <td style={{ padding:'8px 10px 8px 0', color:'var(--text-tertiary)', fontSize:12 }}>{c.publishedBy || '—'}</td>
                          <td style={{ padding:'8px 0', color:'var(--text-tertiary)', fontSize:12, whiteSpace:'nowrap' }}>{fmtDate(c.publishDate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
              }
            </Panel>
          </div>
        )
      })()}

      {/* ── Sequences ── */}
      {!loading && data && section === 'sequences' && (() => {
        const T = data.totals || {}
        const L = data.links || {}
        return (
          <div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:10 }}>
              <KpiCard label="Enrolled"    value={fmt(T.enrolled)} sub="Contacts in sequences"            href={L.sequences} />
              <KpiCard label="Replies"     value={fmt(T.replied)}  sub={`${fmtPct(T.replyRate)} reply rate`}  href={L.sequences} />
              <KpiCard label="Opens"       value={fmt(T.opened)}   sub={`${fmtPct(T.openRate)} open rate`}   href={L.sequences} />
              <KpiCard label="Clicks"      value={fmt(T.clicked)}  sub={`${fmtPct(T.clickRate)} click rate`} href={L.sequences} />
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:'1.5rem' }}>
              <KpiCard label="Reply rate"  value={fmtPct(T.replyRate)}  sub="Of enrolled contacts" href={L.sequences} accent />
              <KpiCard label="Open rate"   value={fmtPct(T.openRate)}   sub="Of enrolled contacts" href={L.sequences} accent />
              <KpiCard label="Click rate"  value={fmtPct(T.clickRate)}  sub="Of enrolled contacts" href={L.sequences} accent />
            </div>

            {(data.byRep||[]).length > 1 && (
              <Panel style={{ marginBottom:12 }}>
                <SectionTitle>By rep</SectionTitle>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                  <THead cols={['Rep','Enrolled','Replies','Reply %','Opens','Open %','Clicks','Click %']} />
                  <tbody>
                    {(data.byRep||[]).map((r,i) => (
                      <tr key={i} style={{ borderBottom:i<data.byRep.length-1?'1px solid var(--border)':'none' }}>
                        <td style={{ padding:'8px 10px 8px 0', fontWeight:500 }}>{r.rep}</td>
                        <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{fmt(r.enrolled)}</td>
                        <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{fmt(r.replied)}</td>
                        <td style={{ padding:'8px 10px 8px 0', color:'var(--accent)' }}>{fmtPct(r.replyRate)}</td>
                        <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{fmt(r.opened)}</td>
                        <td style={{ padding:'8px 10px 8px 0', color:'var(--accent)' }}>{fmtPct(r.openRate)}</td>
                        <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{fmt(r.clicked)}</td>
                        <td style={{ padding:'8px 0', color:'var(--accent)' }}>{fmtPct(r.clickRate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            )}

            <Panel>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
                <SectionTitle style={{ margin:0 }}>By sequence</SectionTitle>
                <button onClick={() => openHS(L.sequences)} style={{ fontSize:11, color:'var(--accent)', background:'none', border:'none', cursor:'pointer', padding:0 }}>View all in HubSpot ↗</button>
              </div>
              <div style={{ fontSize:11, color:'var(--text-tertiary)', marginBottom:10 }}>
                Based on hs_latest_sequence_enrolled — shows most recently enrolled sequence per contact.
              </div>
              {(data.sequences||[]).length === 0
                ? <div style={{ fontSize:13, color:'var(--text-tertiary)' }}>No sequence data in this period.</div>
                : <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                    <THead cols={['Sequence','Enrolled','Replies','Reply %','Opens','Open %','Clicks','Click %']} />
                    <tbody>
                      {(data.sequences||[]).map((s,i) => (
                        <tr key={i} onClick={() => openHS(s.sequenceUrl || L.sequences)} style={{ borderBottom:i<data.sequences.length-1?'1px solid var(--border)':'none', cursor:'pointer' }}
                          onMouseEnter={e => e.currentTarget.style.background='var(--bg-secondary)'}
                          onMouseLeave={e => e.currentTarget.style.background=''}>
                          <td style={{ padding:'8px 10px 8px 0', color:'var(--accent)', maxWidth:240, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                            {s.sequenceName || s.sequenceId}
                          </td>
                          <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{fmt(s.enrolled)}</td>
                          <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{fmt(s.replied)}</td>
                          <td style={{ padding:'8px 10px 8px 0', color:'var(--accent)' }}>{fmtPct(s.replyRate)}</td>
                          <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{fmt(s.opened)}</td>
                          <td style={{ padding:'8px 10px 8px 0', color:'var(--accent)' }}>{fmtPct(s.openRate)}</td>
                          <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{fmt(s.clicked)}</td>
                          <td style={{ padding:'8px 0', color:'var(--accent)' }}>{fmtPct(s.clickRate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
              }
            </Panel>
          </div>
        )
      })()}

      {/* ── Deals ── */}
      {!loading && data && section === 'deals' && (() => {
        const T = data.totals || {}
        const L = data.links || {}
        return (
          <div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:10, marginBottom:10 }}>
              <KpiCard label="Total deals"   value={fmt(T.total)}          sub="In period"              href={L.deals} />
              <KpiCard label="Total value"   value={fmtMoney(T.totalValue)} sub="Pipeline value"         href={L.deals} />
              <KpiCard label="Weighted"      value={fmtMoney(T.totalWeighted)} sub="By probability"      href={L.deals} />
              <KpiCard label="Won"           value={`${fmt(T.wonCount)} deals`} sub={fmtMoney(T.wonValue)} href={L.deals} accent />
              <KpiCard label="Lost"          value={`${fmt(T.lostCount)} deals`} sub={fmtMoney(T.lostValue)} href={L.deals} />
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:'1.5rem' }}>
              <KpiCard label="Win rate"         value={fmtPct(T.winRate)}    sub={`${T.wonCount||0} won / ${(T.wonCount||0)+(T.lostCount||0)} closed`} href={L.deals} accent />
              <KpiCard label="Avg deal size"    value={fmtMoney(T.avgDealSize)} sub="Won deals only"    href={L.deals} />
              <KpiCard label="Avg days to close" value={T.avgVelocity != null ? `${T.avgVelocity}d` : '—'} sub="Create to close date" href={L.deals} />
            </div>

            <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:12, marginBottom:12 }}>
              <Panel>
                <SectionTitle>By pipeline</SectionTitle>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                  <THead cols={['Pipeline','Deals','Value','Weighted']} />
                  <tbody>
                    {(data.byPipeline||[]).map((p,i) => (
                      <tr key={i} onClick={() => openHS(p.url || L.deals)} style={{ borderBottom:i<data.byPipeline.length-1?'1px solid var(--border)':'none', cursor:'pointer' }}
                        onMouseEnter={e => e.currentTarget.style.background='var(--bg-secondary)'}
                        onMouseLeave={e => e.currentTarget.style.background=''}>
                        <td style={{ padding:'8px 10px 8px 0', color:'var(--accent)', fontWeight:500 }}>{p.label}</td>
                        <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{fmt(p.count)}</td>
                        <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{fmtMoney(p.value)}</td>
                        <td style={{ padding:'8px 0', color:'var(--text-secondary)' }}>{fmtMoney(p.weighted)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
              <Panel>
                <SectionTitle>Lost reasons</SectionTitle>
                {(data.lostReasons||[]).length === 0
                  ? <div style={{ fontSize:13, color:'var(--text-tertiary)' }}>No closed-lost deals in this period.</div>
                  : (data.lostReasons||[]).slice(0,8).map((r,i) => (
                    <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'6px 0', borderBottom:i<Math.min(data.lostReasons.length,8)-1?'1px solid var(--border)':'none', fontSize:12 }}>
                      <span style={{ color:'var(--text-secondary)' }}>{r.reason}</span>
                      <span style={{ color:'var(--text)', fontWeight:500 }}>{r.count}</span>
                    </div>
                  ))
                }
              </Panel>
            </div>

            <Panel style={{ marginBottom:12 }}>
              <SectionTitle>By stage</SectionTitle>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                <THead cols={['Stage','Pipeline','Count','Value','Status']} />
                <tbody>
                  {(data.byStage||[]).map((s,i) => (
                    <tr key={i} onClick={() => openHS(L.deals)} style={{ borderBottom:i<data.byStage.length-1?'1px solid var(--border)':'none', cursor:'pointer' }}
                      onMouseEnter={e => e.currentTarget.style.background='var(--bg-secondary)'}
                      onMouseLeave={e => e.currentTarget.style.background=''}>
                      <td style={{ padding:'8px 10px 8px 0', color:'var(--text)', fontWeight:500 }}>{s.label}</td>
                      <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)', fontSize:12 }}>{s.pipeline}</td>
                      <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{s.count}</td>
                      <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{fmtMoney(s.value)}</td>
                      <td style={{ padding:'8px 0' }}>
                        {s.won  && <Badge label="Won"  type="reply" />}
                        {s.lost && <Badge label="Lost" type="overdue" />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>

            <Panel>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
                <SectionTitle style={{ margin:0 }}>Recent deals</SectionTitle>
                <span style={{ fontSize:11, color:'var(--text-tertiary)' }}>{(data.recentDeals||[]).length} deals</span>
              </div>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                <THead cols={['Deal','Pipeline','Stage','Amount','Close date','Owner']} />
                <tbody>
                  {(data.recentDeals||[]).slice(dealsPage*PAGE_SIZE,(dealsPage+1)*PAGE_SIZE).map((d,i) => (
                    <tr key={i} style={{ borderBottom:i<PAGE_SIZE-1?'1px solid var(--border)':'none' }}>
                      <td style={{ padding:'8px 10px 8px 0' }}>
                        <a href={d.url} target="_blank" rel="noopener noreferrer" style={{ color:'var(--accent)', textDecoration:'none', fontWeight:500 }}>{d.name||'—'}</a>
                        {d.isWon  && <Badge label="Won"  type="reply"   style={{ marginLeft:6 }} />}
                        {d.isLost && <Badge label="Lost" type="overdue" style={{ marginLeft:6 }} />}
                      </td>
                      <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)', fontSize:12 }}>{d.pipeline}</td>
                      <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)', fontSize:12 }}>{d.stage}</td>
                      <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)', fontSize:12 }}>{fmtMoney(d.amount)}</td>
                      <td style={{ padding:'8px 10px 8px 0', color:'var(--text-tertiary)', fontSize:12, whiteSpace:'nowrap' }}>{fmtDate(d.closeDate)}</td>
                      <td style={{ padding:'8px 0', color:'var(--text-tertiary)', fontSize:12 }}>{ownerMap[d.ownerId]||'—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pager page={dealsPage} setPage={setDealsPage} total={(data.recentDeals||[]).length} />
            </Panel>
          </div>
        )
      })()}
    </div>
  )
}

// ─── Add App tab ──────────────────────────────────────────────────────────────
function AddAppTab({ safeFetch, onSaved, existingTabs, onDelete }) {
  const [url, setUrl]               = useState('')
  const [label, setLabel]           = useState('')
  const [badge, setBadge]           = useState('')
  const [tabType, setTabType]       = useState('iframe') // 'iframe' | 'link'
  const [previewing, setPreviewing] = useState(false)
  const [saving, setSaving]         = useState(false)
  const [message, setMessage]       = useState(null)
  const [deleteConfirm, setDeleteConfirm] = useState(null)

  const handleUrlBlur = async () => {
    if (!url.trim() || label) return
    setPreviewing(true)
    // Auto-detect type based on URL patterns that are known to block iframes
    const lower = url.toLowerCase()
    if (
      lower.includes('sharepoint.com') ||
      lower.includes('onedrive.live.com') ||
      lower.includes('docs.google.com') ||
      lower.includes('sheets.google.com') ||
      lower.includes('.xlsx') || lower.includes('.xls') ||
      lower.includes('.pdf') || lower.includes('.docx')
    ) {
      setTabType('link')
    }
    try {
      const data = await safeFetch(`/api/hubspot/tabs/preview?url=${encodeURIComponent(url.trim())}`)
      if (data.suggestedLabel) setLabel(data.suggestedLabel)
    } catch { /* silent */ }
    finally { setPreviewing(false) }
  }

  const handleSave = async () => {
    if (!url.trim() || !label.trim()) {
      setMessage({ type:'error', text:'URL and name are both required.' })
      return
    }
    setSaving(true)
    setMessage(null)
    try {
      const data = await safeFetch('/api/hubspot/tabs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), label: label.trim(), badge: badge.trim() || null, type: tabType }),
      })
      onSaved(data.tab)
      setUrl('')
      setLabel('')
      setBadge('')
      setTabType('iframe')
      const action = tabType === 'link' ? 'Added as an external link — clicking the tab will open it in a new window.' : 'Taking you there now.'
      setMessage({ type:'success', text:`"${data.tab.label}" added. ${action}` })
    } catch (err) {
      setMessage({ type:'error', text: err.message || 'Something went wrong.' })
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (tabId, tabLabel) => {
    if (deleteConfirm !== tabId) { setDeleteConfirm(tabId); return; }
    try {
      await safeFetch(`/api/hubspot/tabs/${tabId}`, { method: 'DELETE' })
      onDelete(tabId)
      setDeleteConfirm(null)
    } catch (err) {
      setMessage({ type:'error', text: err.message || 'Delete failed.' })
      setDeleteConfirm(null)
    }
  }

  return (
    <div style={{ maxWidth:560, margin:'0 auto', paddingTop:'2rem' }}>
      <div style={{ marginBottom:'2rem' }}>
        <h2 style={{ fontSize:18, fontWeight:500, color:'var(--text)', marginBottom:6 }}>Add an app</h2>
        <p style={{ fontSize:13, color:'var(--text-secondary)', lineHeight:1.6 }}>
          Paste any URL and it'll appear as a tab. The name is auto-detected from the page — just confirm or change it.
        </p>
      </div>

      <Panel>
        <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
          <div>
            <label style={{ fontSize:12, fontWeight:500, color:'var(--text-secondary)', display:'block', marginBottom:5 }}>App URL</label>
            <input
              value={url}
              onChange={e => setUrl(e.target.value)}
              onBlur={handleUrlBlur}
              placeholder="https://your-app.netlify.app/"
              style={{ width:'100%', background:'var(--bg-secondary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'9px 12px', fontSize:13, color:'var(--text)', outline:'none', boxSizing:'border-box' }}
            />
          </div>

          <div>
            <label style={{ fontSize:12, fontWeight:500, color:'var(--text-secondary)', display:'block', marginBottom:5 }}>
              Tab name {previewing && <span style={{ color:'var(--text-tertiary)', fontWeight:400 }}>— detecting…</span>}
            </label>
            <input
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="Auto-detected from the page, or type your own"
              style={{ width:'100%', background:'var(--bg-secondary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'9px 12px', fontSize:13, color:'var(--text)', outline:'none', boxSizing:'border-box' }}
            />
          </div>

          <div>
            <label style={{ fontSize:12, fontWeight:500, color:'var(--text-secondary)', display:'block', marginBottom:5 }}>
              Badge <span style={{ fontWeight:400, color:'var(--text-tertiary)' }}>(optional — e.g. BETA, NEW, SOON)</span>
            </label>
            <input
              value={badge}
              onChange={e => setBadge(e.target.value.toUpperCase().slice(0,8))}
              placeholder="BETA"
              style={{ width:120, background:'var(--bg-secondary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'9px 12px', fontSize:13, color:'var(--text)', outline:'none' }}
            />
          </div>

          <div>
            <label style={{ fontSize:12, fontWeight:500, color:'var(--text-secondary)', display:'block', marginBottom:8 }}>How to open</label>
            <div style={{ display:'flex', gap:8 }}>
              {[
                { value:'iframe', label:'Embed in dashboard', desc:'Works for web apps, HTML files, most public sites' },
                { value:'link',   label:'Open in new tab',    desc:'Better for SharePoint, Office docs, Google Docs, PDFs' },
              ].map(opt => (
                <div key={opt.value} onClick={() => setTabType(opt.value)}
                  style={{ flex:1, padding:'10px 12px', borderRadius:'var(--radius)', border:`1px solid ${tabType === opt.value ? 'var(--accent)' : 'var(--border)'}`, background: tabType === opt.value ? 'var(--accent-light)' : 'var(--bg-secondary)', cursor:'pointer' }}>
                  <div style={{ fontSize:12, fontWeight:500, color: tabType === opt.value ? 'var(--accent-text)' : 'var(--text)', marginBottom:3 }}>{opt.label}</div>
                  <div style={{ fontSize:11, color:'var(--text-tertiary)', lineHeight:1.4 }}>{opt.desc}</div>
                </div>
              ))}
            </div>
            {tabType === 'link' && (
              <div style={{ marginTop:6, fontSize:11, color:'var(--text-tertiary)' }}>
                The tab will appear in the nav — clicking it opens the URL in a new browser window instead of embedding it.
              </div>
            )}
          </div>

          {message && (
            <div style={{ fontSize:12, padding:'8px 12px', borderRadius:'var(--radius)', background: message.type === 'error' ? 'var(--red-light)' : 'var(--accent-light)', color: message.type === 'error' ? 'var(--red)' : 'var(--accent-text)' }}>
              {message.text}
            </div>
          )}

          <button onClick={handleSave} disabled={saving || !url.trim() || !label.trim()}
            style={{ background:'var(--accent)', color:'#fff', border:'none', borderRadius:'var(--radius)', padding:'10px 20px', fontSize:13, fontWeight:500, cursor: saving || !url.trim() || !label.trim() ? 'not-allowed' : 'pointer', opacity: saving || !url.trim() || !label.trim() ? 0.6 : 1, alignSelf:'flex-start' }}>
            {saving ? 'Saving…' : 'Add tab'}
          </button>
        </div>
      </Panel>

      {existingTabs.length > 0 && (
        <div style={{ marginTop:'2rem' }}>
          <SectionTitle>Existing custom tabs</SectionTitle>
          <Panel>
            {existingTabs.map((tab, i) => (
              <div key={tab.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 0', borderBottom: i < existingTabs.length - 1 ? '1px solid var(--border)' : 'none' }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:13, fontWeight:500, color:'var(--text)', display:'flex', alignItems:'center', gap:6 }}>
                    {tab.label}
                    {tab.badge && <span style={{ fontSize:9, fontWeight:600, background:'var(--amber-light)', color:'var(--amber)', borderRadius:4, padding:'1px 5px' }}>{tab.badge}</span>}
                  </div>
                  <div style={{ fontSize:11, color:'var(--text-tertiary)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{tab.url}</div>
                </div>
                <button
                  onClick={() => handleDelete(tab.id, tab.label)}
                  style={{ fontSize:12, color: deleteConfirm === tab.id ? 'var(--red)' : 'var(--text-tertiary)', background:'none', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'4px 10px', cursor:'pointer', whiteSpace:'nowrap', flexShrink:0 }}>
                  {deleteConfirm === tab.id ? 'Confirm remove' : 'Remove'}
                </button>
              </div>
            ))}
          </Panel>
        </div>
      )}
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
              {[
                { label:'Lead status',     value: p.hs_lead_status||'—' },
                { label:'Times contacted', value: p.num_contacted_notes||'0' },
                { label:'Last contacted',  value: validDate ? new Date(lastContacted).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '—' },
                { label:'Assigned BDR',    value: p.assigned_bdr||'—' },
                { label:'Territory',       value: p.territory||'—' },
                { label:'Priority tier',   value: p.priority_tier__bdr||'—' },
              ].map(({ label, value }) => (
                <div key={label} style={{ background:'var(--bg-secondary)', borderRadius:'var(--radius)', padding:'10px 12px' }}>
                  <div style={{ fontSize:11, color:'var(--text-tertiary)', marginBottom:2 }}>{label}</div>
                  <div style={{ fontSize:13, fontWeight:500, color:'var(--text)' }}>{value}</div>
                </div>
              ))}
            </div>

            {/* Email activity row */}
            <div style={{ marginTop:10, display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8 }}>
              {[
                { label:'Last mkt email', value: p.hs_email_last_email_name||'—', sub: p.hs_email_last_send_date ? shortDate(p.hs_email_last_send_date) : null },
                { label:'Sales last opened', value: p.hs_sales_email_last_opened ? timeAgo(p.hs_sales_email_last_opened) : '—' },
                { label:'Sales last replied', value: p.hs_sales_email_last_replied ? timeAgo(p.hs_sales_email_last_replied) : '—' },
              ].map(({ label, value, sub }) => (
                <div key={label} style={{ background:'var(--bg-secondary)', borderRadius:'var(--radius)', padding:'10px 12px' }}>
                  <div style={{ fontSize:11, color:'var(--text-tertiary)', marginBottom:2 }}>{label}</div>
                  <div style={{ fontSize:12, fontWeight:500, color:'var(--text)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{value}</div>
                  {sub && <div style={{ fontSize:11, color:'var(--text-tertiary)' }}>{sub}</div>}
                </div>
              ))}
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
