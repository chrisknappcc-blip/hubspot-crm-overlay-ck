import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
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
  // Support optgroups: if any option has a `group` field, render with optgroup headers
  const hasGroups = options.some(o => o.group)
  const selectEl = (
    <select value={value} onChange={e => onChange(e.target.value)}
      style={{ fontSize:12, color:'var(--text-secondary)', background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'5px 10px', cursor:'pointer', outline:'none', ...style }}>
      {hasGroups ? (() => {
        const groups = {}
        const ungrouped = []
        options.forEach(o => {
          if (o.group) { (groups[o.group] = groups[o.group] || []).push(o) }
          else ungrouped.push(o)
        })
        return [
          ...ungrouped.map(o => <option key={o.value} value={o.value}>{o.label}</option>),
          ...Object.entries(groups).map(([g, opts]) => (
            <optgroup key={g} label={g}>
              {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </optgroup>
          ))
        ]
      })() : options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
  return selectEl
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
  { value:'custom',   label:'Custom range…' },
]

// ─── Shared formatting helpers ────────────────────────────────────────────────
const fmt      = n => typeof n === 'number' ? n.toLocaleString() : (n ?? '—')
const fmtMoney = n => n ? `$${Math.round(n).toLocaleString()}` : '$0'
const fmtPct   = n => n != null ? `${n}%` : '—'
const fmtDate  = d => d ? new Date(d).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '—'
const openHS   = url => window.open(url, '_blank', 'noopener,noreferrer')

function KpiCard({ label, value, sub, href, accent }) {
  return (
    <div onClick={() => href && openHS(href)} title={href ? 'Open in HubSpot ↗' : ''}
      style={{ background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'14px 16px', cursor: href ? 'pointer' : 'default', transition:'border-color .15s' }}
      onMouseEnter={e => href && (e.currentTarget.style.borderColor='var(--accent)')}
      onMouseLeave={e => href && (e.currentTarget.style.borderColor='var(--border)')}>
      <div style={{ fontSize:12, color:'var(--text-tertiary)', marginBottom:4 }}>{label}</div>
      <div style={{ fontSize:22, fontWeight:600, color: accent ? 'var(--accent)' : 'var(--text)' }}>{value}</div>
      {sub && <div style={{ fontSize:11, color:'var(--text-tertiary)', marginTop:3 }}>{sub}{href ? ' ↗' : ''}</div>}
    </div>
  )
}

function THead({ cols }) {
  return (
    <thead><tr>{cols.map(h => (
      <th key={h} style={{ textAlign:'left', fontSize:11, fontWeight:500, color:'var(--text-tertiary)', textTransform:'uppercase', letterSpacing:'.04em', padding:'0 10px 8px 0', borderBottom:'1px solid var(--border)', whiteSpace:'nowrap' }}>{h}</th>
    ))}</tr></thead>
  )
}
const TEAM_MEMBERS = [
  { name: 'Chris Knapp',  ownerId: '78304576',  group: 'bdr',      email: 'cknapp@carecontinuity.com' },
  { name: 'Chris Knapp',  ownerId: '78304576',  group: 'bdr',      email: 'chrisknappcc@gmail.com' },
  { name: 'Chiara Pate',  ownerId: '87806380',  group: 'bdr',      email: 'cpate@carecontinuity.com'  },
  { name: 'Matt Valin',   ownerId: '76104455',  group: 'vp'       },
  { name: 'Joe Haine',    ownerId: '55217954',  group: 'vp',  hubspotName: 'Joseph Haine' },
  { name: 'Tim Grisham',  ownerId: '83862037',  group: 'vp'       },
  { name: 'Irene Wong',   ownerId: '289209454', group: 'strategy' },
  { name: 'Cole Hooper',  ownerId: '85819247',  group: 'strategy' },
  { name: 'John Hansel',  ownerId: '743772047', group: 'strategy' },
]

const TEAM_BY_GROUP = {
  bdr:      TEAM_MEMBERS.filter(m => m.group === 'bdr'),
  vp:       TEAM_MEMBERS.filter(m => m.group === 'vp'),
  strategy: TEAM_MEMBERS.filter(m => m.group === 'strategy'),
  all:      TEAM_MEMBERS,
}

// Returns HubSpot-side name (hubspotName if set, otherwise name)
const hsName = (m) => m.hubspotName || m.name

// Group filter options -- value is a group key or individual name
const REPORT_REP_OPTIONS = [
  { value: 'all',       label: 'Everyone' },
  { value: 'bdr',       label: 'All BDR' },
  { value: 'vp',        label: 'All VP' },
  { value: 'strategy',  label: 'All Strategy' },
  ...TEAM_MEMBERS.filter(m => m.group === 'bdr').map(m      => ({ value: m.name, label: m.name, group: 'BDR' })),
  ...TEAM_MEMBERS.filter(m => m.group === 'vp').map(m       => ({ value: m.name, label: m.name, group: 'VP' })),
  ...TEAM_MEMBERS.filter(m => m.group === 'strategy').map(m => ({ value: m.name, label: m.name, group: 'Strategy' })),
]

const BDR_OPTIONS = [
  { value: '',          label: 'Everyone' },
  { value: 'bdr',       label: 'All BDR' },
  { value: 'vp',        label: 'All VP' },
  { value: 'strategy',  label: 'All Strategy' },
  ...TEAM_MEMBERS.filter(m => m.group === 'bdr').map(m      => ({ value: m.name, label: m.name, group: 'BDR' })),
  ...TEAM_MEMBERS.filter(m => m.group === 'vp').map(m       => ({ value: m.name, label: m.name, group: 'VP' })),
  ...TEAM_MEMBERS.filter(m => m.group === 'strategy').map(m => ({ value: m.name, label: m.name, group: 'Strategy' })),
]

const TARGET_OPTIONS = [
  { value: '',          label: 'All accounts' },
  { value: 'bdr',       label: 'All BDR' },
  { value: 'vp',        label: 'All VP' },
  { value: 'strategy',  label: 'All Strategy' },
  ...TEAM_MEMBERS.filter(m => m.group === 'bdr').map(m      => ({ value: m.name, label: m.name, group: 'BDR' })),
  ...TEAM_MEMBERS.filter(m => m.group === 'vp').map(m       => ({ value: m.name, label: m.name, group: 'VP' })),
  ...TEAM_MEMBERS.filter(m => m.group === 'strategy').map(m => ({ value: m.name, label: m.name, group: 'Strategy' })),
]

// Expands a filter value to { bdrNames, ownerIds } for backend
// BDR members filter by assigned_bdr name; non-BDR members filter by hubspot_owner_id
const expandFilter = (val) => {
  if (!val || val === 'all') return { bdrNames: [], ownerIds: [] }
  const members = TEAM_BY_GROUP[val] ? TEAM_BY_GROUP[val] : [TEAM_MEMBERS.find(m => m.name === val)].filter(Boolean)
  const bdrNames = members.filter(m => m.group === 'bdr').map(hsName)
  const ownerIds = members.filter(m => m.group !== 'bdr' && m.ownerId).map(m => m.ownerId)
  return { bdrNames, ownerIds }
}
// ─── Sort options ─────────────────────────────────────────────────────────────
const SIGNAL_SORT_OPTIONS = [
  { value:'score_desc',  label:'Priority (high to low)' },
  { value:'score_asc',   label:'Priority (low to high)' },
  { value:'date_desc',   label:'Most recent first' },
  { value:'date_asc',    label:'Oldest first' },
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
// ─── Contact Intelligence Panel ───────────────────────────────────────────────
// Persona hierarchy map groups — matches Gold Account visual layout
const CI_MAP_GROUPS = [
  { label: 'EXECUTIVE',              personas: ['Executive/Leadership','Operating Officer','Chief Clinical Officer'] },
  { label: 'OFFICERS & VPS',         personas: ['Medical Officer','Nursing Officer','Physician Executive','Finance'] },
  { label: 'STRATEGY & OPERATIONS',  personas: ['Strategy','Innovation','Business Development','Population Health','Value Based Care','Quality Officer'] },
  { label: 'CLINICAL & SERVICE',     personas: ['Clinical Operations','Medical Group','Medical','Service Line','Emergency Department','Ambulatory/Urgent Care'] },
  { label: 'PATIENT-FACING & ACCESS',personas: ['Access/Patient Access','Patient Experience','Case Management'] },
]
const CI_ALL_PERSONAS = CI_MAP_GROUPS.flatMap(g => g.personas)
const CI_PERSONA_GROUPS = {
  'C-Suite':    ['Executive/Leadership','Operating Officer','Medical Officer','Chief Clinical Officer','Finance','Strategy','Innovation','Business Development'],
  'Clinical':   ['Medical','Nursing Officer','Quality Officer','Emergency Department','Clinical Operations','Physician Executive','Medical Group','Ambulatory/Urgent Care'],
  'Operations': ['Operating Officer','Clinical Operations','Case Management','Patient Experience','Access/Patient Access'],
  'Strategy':   ['Strategy','Business Development','Innovation','Value Based Care','Population Health'],
}
const CI_CONTENT_ICONS = { press_release:'📰', article:'📄', award:'🏆', podcast:'🎙️', presentation:'📊', other:'🔗' }

function ContactIntelPanel({ user, safeFetch }) {
  const [ciTab, setCiTab]             = useState('individual')

  // ── Individual Research ─────────────────────────────────────────────────────
  const [indName, setIndName]         = useState('')
  const [indTitle, setIndTitle]       = useState('')
  const [indOrg, setIndOrg]           = useState('')
  const [indLoading, setIndLoading]   = useState(false)
  const [indResult, setIndResult]     = useState(null)
  const [indError, setIndError]       = useState(null)

  // ── Org Intelligence ────────────────────────────────────────────────────────
  const [orgName, setOrgName]         = useState('')
  const [orgDomain, setOrgDomain]     = useState('')
  const [selPersonas, setSelPersonas] = useState(new Set(CI_ALL_PERSONAS))
  const [orgLoading, setOrgLoading]   = useState(false)
  const [orgResults, setOrgResults]   = useState(null)
  const [orgError, setOrgError]       = useState(null)
  const [orgProgress, setOrgProgress] = useState('')

  // ── Detail panel (right side) ───────────────────────────────────────────────
  const [selCard, setSelCard]             = useState(null)   // { persona, name, title, source }
  const [detailData, setDetailData]       = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError]     = useState(null)

  // ── History ─────────────────────────────────────────────────────────────────
  const [history, setHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem('cipher_ci_history') || '[]') } catch { return [] }
  })
  function saveHistory(entry) {
    setHistory(prev => {
      const next = [entry, ...prev.filter(h => h.id !== entry.id)].slice(0, 20)
      try { localStorage.setItem('cipher_ci_history', JSON.stringify(next)) } catch {}
      return next
    })
  }

  // ── Individual Research fetch ───────────────────────────────────────────────
  async function runIndividualResearch(name, title, org) {
    const n = (name || indName).trim()
    const t = (title || indTitle).trim()
    const o = (org  || indOrg).trim()
    if ((!n && !t) || !o) return
    if (!name) { setIndLoading(true); setIndError(null); setIndResult(null) }
    try {
      const data = await safeFetch('/api/contact-intel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: n, title: t, org: o }),
      })
      if (data?.error) throw new Error(data.error)
      if (!name) { setIndResult(data) }
      saveHistory({ id:`ind-${n}-${o}`, type:'individual', name:n, title:t, org:o, ts:Date.now(), result:data })
      return data
    } catch(e) {
      if (!name) setIndError(e.message)
      throw e
    } finally {
      if (!name) setIndLoading(false)
    }
  }

  // ── Card click → detail panel ───────────────────────────────────────────────
  async function openDetail(persona, person) {
    if (!person?.name) return
    setSelCard({ persona, ...person })
    setDetailData(null); setDetailError(null); setDetailLoading(true)
    try {
      const data = await safeFetch('/api/contact-intel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: person.name, title: person.title || '', org: orgResults?.orgName || '' }),
      })
      if (data?.error) throw new Error(data.error)
      setDetailData(data)
    } catch(e) {
      setDetailError(e.message)
    } finally {
      setDetailLoading(false)
    }
  }

  // ── Org Intel fetch ─────────────────────────────────────────────────────────
  function togglePersona(p) {
    setSelPersonas(prev => { const n=new Set(prev); n.has(p)?n.delete(p):n.add(p); return n })
  }
  function setGroup(g) {
    const group = CI_PERSONA_GROUPS[g] || []
    setSelPersonas(prev => {
      const n = new Set(prev)
      group.every(p=>n.has(p)) ? group.forEach(p=>n.delete(p)) : group.forEach(p=>n.add(p))
      return n
    })
  }

  async function runOrgIntel() {
    if (!orgName.trim()) return
    const personas = [...selPersonas]
    if (!personas.length) return
    setOrgLoading(true); setOrgError(null); setOrgResults(null); setOrgProgress('Looking up in HubSpot…')
    setSelCard(null); setDetailData(null)
    try {
      let existingContacts = []
      try {
        const d = await safeFetch(`/api/hubspot/org-intel-contacts?orgName=${encodeURIComponent(orgName.trim())}&domain=${encodeURIComponent(orgDomain.trim())}`)
        existingContacts = d?.contacts || []
        setOrgProgress(`Found ${existingContacts.length} CRM contacts — gap searching…`)
      } catch { setOrgProgress('Searching personas…') }

      const found = {}
      let rem = [...personas]
      while (rem.length > 0) {
        const batch = rem.splice(0, 3)
        setOrgProgress(`Searching: ${batch.join(', ')}…`)
        const r = await safeFetch('/api/hubspot-gap-search', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ companyName:orgName.trim(), domain:orgDomain.trim()||null, existingContacts, missingPersonas:batch, batchSize:batch.length }),
        })
        for (const f of (r?.found||[])) found[f.persona] = f
        if (rem.length > 0) await new Promise(r=>setTimeout(r,500))
      }

      const result = { personas:found, existingContacts, orgName:orgName.trim(), ts:Date.now() }
      setOrgResults(result)
      setOrgProgress('')
      saveHistory({ id:`org-${orgName}`, type:'org', org:orgName.trim(), personaCount:personas.length, ts:Date.now(), result })
    } catch(e) {
      setOrgError(e.message); setOrgProgress('')
    } finally {
      setOrgLoading(false)
    }
  }

  // ── Shared profile renderer (used in Org Intel detail panel) ─────────────────
  function ProfileView({ data }) {
    if (!data?.profile) return null
    const p = data.profile
    return (
      <div style={{ display:'flex', flexDirection:'column', gap:18 }}>
        {p.outreachIntel && (
          <div>
            <div style={{ fontSize:10, fontWeight:700, letterSpacing:'.1em', color:'var(--text-tertiary)', marginBottom:8 }}>OUTREACH INTEL</div>
            <div style={{ background:'rgba(59,130,246,.06)', border:'1px solid rgba(59,130,246,.15)', borderRadius:8, padding:12 }}>
              <div style={{ fontSize:13, color:'var(--text-secondary)', lineHeight:1.65 }}>{p.outreachIntel}</div>
            </div>
          </div>
        )}
        {p.careerHistory?.length > 0 && (
          <div>
            <div style={{ fontSize:10, fontWeight:700, letterSpacing:'.1em', color:'var(--text-tertiary)', marginBottom:10 }}>CAREER HISTORY</div>
            {p.careerHistory.map((c,i) => (
              <div key={i} style={{ display:'flex', gap:0, marginBottom:12 }}>
                <div style={{ width:3, background:i===0?'var(--accent)':'var(--border)', borderRadius:2, flexShrink:0, marginRight:12, marginTop:2 }} />
                <div>
                  <div style={{ fontSize:13, fontWeight:700, color:'var(--text)' }}>{c.title}</div>
                  <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:2 }}>
                    <span style={{ fontSize:12, color:'var(--accent)', fontWeight:500 }}>{c.org}</span>
                    {c.years && <span style={{ fontSize:10, color:'var(--text-tertiary)', background:'var(--bg-secondary)', borderRadius:20, padding:'1px 6px' }}>{c.years}</span>}
                  </div>
                  {c.summary && <div style={{ fontSize:12, color:'var(--text-tertiary)', lineHeight:1.5, marginTop:3 }}>{c.summary}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
        {p.orgContext && (
          <div>
            <div style={{ fontSize:10, fontWeight:700, letterSpacing:'.1em', color:'var(--text-tertiary)', marginBottom:8 }}>ORG CONTEXT</div>
            <div style={{ fontSize:13, color:'var(--text-secondary)', lineHeight:1.6 }}>{p.orgContext}</div>
          </div>
        )}
        {p.recentContent?.length > 0 && (
          <div>
            <div style={{ fontSize:10, fontWeight:700, letterSpacing:'.1em', color:'var(--text-tertiary)', marginBottom:8 }}>RECENT CONTENT</div>
            {p.recentContent.map((c,i) => (
              <div key={i} style={{ marginBottom:10, paddingBottom:10, borderBottom:i<p.recentContent.length-1?'1px solid var(--border)':'none' }}>
                <div style={{ display:'flex', alignItems:'center', gap:5, marginBottom:3 }}>
                  <span style={{ fontSize:12 }}>{CI_CONTENT_ICONS[c.type]||'🔗'}</span>
                  <span style={{ fontSize:10, color:'var(--text-tertiary)', textTransform:'uppercase' }}>{c.type?.replace(/_/g,' ')}{c.date?` · ${c.date}`:''}</span>
                </div>
                {c.url
                  ? <a href={c.url} target="_blank" rel="noopener noreferrer" style={{ fontSize:12, color:'var(--accent)', textDecoration:'none', fontWeight:600 }}>{c.title}</a>
                  : <div style={{ fontSize:12, color:'var(--text)', fontWeight:600 }}>{c.title}</div>}
                {c.summary && <div style={{ fontSize:11, color:'var(--text-tertiary)', marginTop:2 }}>{c.summary}</div>}
              </div>
            ))}
          </div>
        )}
        <div style={{ fontSize:10, color:'var(--text-tertiary)', display:'flex', gap:8 }}>
          <span>Confidence: <b style={{ color:p.confidence==='high'?'#16a34a':p.confidence==='medium'?'#D97706':'var(--red)' }}>{p.confidence}</b></span>
          {data.fromCache && <span>· Cached</span>}
        </div>
      </div>
    )
  }

  // ── Persona map card ─────────────────────────────────────────────────────────
  function PersonaCard({ persona, crmContact, gapResult }) {
    const person   = crmContact || gapResult
    const status   = crmContact ? 'crm' : gapResult?.name ? 'gap' : 'empty'
    const isActive = selCard?.persona === persona
    const canClick = !!person?.name

    const colors = {
      crm:   { border:'#22c55e', bg:'rgba(34,197,94,.08)',  label:'#16a34a' },
      gap:   { border:'var(--accent)', bg:'rgba(59,130,246,.06)', label:'var(--accent)' },
      empty: { border:'rgba(239,68,68,.4)', bg:'rgba(239,68,68,.04)', label:'#ef4444' },
    }
    const c = colors[status]

    return (
      <div onClick={() => canClick && openDetail(persona, person)}
        style={{ border:`1px solid ${isActive ? 'var(--accent)' : c.border}`,
          background: isActive ? 'rgba(59,130,246,.12)' : c.bg,
          borderRadius:'var(--radius)', padding:'10px 12px', cursor:canClick?'pointer':'default',
          transition:'background .15s', minWidth:0,
          boxShadow: isActive ? '0 0 0 2px rgba(59,130,246,.3)' : 'none' }}
        onMouseEnter={e => { if(canClick && !isActive) e.currentTarget.style.background = status==='crm'?'rgba(34,197,94,.14)':status==='gap'?'rgba(59,130,246,.1)':c.bg }}
        onMouseLeave={e => { if(!isActive) e.currentTarget.style.background = c.bg }}>
        <div style={{ fontSize:10, color:'var(--text-tertiary)', letterSpacing:'.04em', marginBottom:4, fontWeight:500, textTransform:'uppercase' }}>
          {persona}
        </div>
        {status !== 'empty' ? (
          <>
            <div style={{ fontSize:13, fontWeight:700, color:'var(--text)', lineHeight:1.3, marginBottom:2 }}>{person.name}</div>
            {person.title && <div style={{ fontSize:11, color:'var(--text-secondary)', lineHeight:1.4 }}>{person.title}</div>}
            <div style={{ display:'flex', gap:4, marginTop:5, flexWrap:'wrap' }}>
              {status==='crm' && <span style={{ fontSize:9, background:'rgba(34,197,94,.15)', color:'#16a34a', borderRadius:8, padding:'1px 5px', fontWeight:600 }}>IN CRM</span>}
              {status==='gap' && <span style={{ fontSize:9, background:'rgba(59,130,246,.12)', color:'var(--accent)', borderRadius:8, padding:'1px 5px', fontWeight:600 }}>GAP SEARCH</span>}
              {gapResult?.confidence && status==='gap' && <span style={{ fontSize:9, color:'var(--text-tertiary)', borderRadius:8, padding:'1px 5px', border:'1px solid var(--border)' }}>{gapResult.confidence}</span>}
              {person.linkedinUrl && <span style={{ fontSize:9, color:'var(--accent)' }}>↗ LI</span>}
            </div>
          </>
        ) : (
          <div style={{ fontSize:11, color:'#ef4444', marginTop:2 }}>∅ No match</div>
        )}
      </div>
    )
  }

  // ─────────────────────────────────────────────────────────────────────────────
  const hpCount = history.length

  return (
    <div style={{ maxWidth:1200, margin:'0 auto', padding:'0 4px' }}>
      {/* Header */}
      <div style={{ marginBottom:18 }}>
        <div style={{ fontSize:22, fontWeight:700, color:'var(--text)', marginBottom:4 }}>Contact Intelligence</div>
        <div style={{ fontSize:13, color:'var(--text-tertiary)' }}>Research any prospect or health system — real web data, no guesswork.</div>
      </div>

      {/* Tab bar */}
      <div style={{ display:'flex', borderBottom:'1px solid var(--border)', marginBottom:20 }}>
        {[{key:'individual',label:'Individual Research'},{key:'org',label:'Org Intelligence'},{key:'history',label:`History${hpCount>0?` (${hpCount})`:''}` }].map(t => (
          <button key={t.key} onClick={()=>setCiTab(t.key)}
            style={{ padding:'9px 18px', fontSize:13, fontWeight:ciTab===t.key?600:400,
              color:ciTab===t.key?'var(--accent)':'var(--text-tertiary)', background:'none', border:'none',
              borderBottom:ciTab===t.key?'2px solid var(--accent)':'2px solid transparent', cursor:'pointer' }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── INDIVIDUAL RESEARCH ── */}
      {ciTab === 'individual' && (
        <div>
          {/* Hero section — matches original app aesthetic */}
          {!indResult && !indLoading && (
            <div style={{ marginBottom:32, paddingTop:8 }}>
              <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:16 }}>
                <div style={{ width:32, height:2, background:'var(--accent)' }} />
                <span style={{ fontSize:11, letterSpacing:'.1em', color:'var(--accent)', fontWeight:600 }}>
                  🎯 INDIVIDUAL PROSPECT INTELLIGENCE
                </span>
              </div>
              <div style={{ fontSize:36, fontWeight:800, color:'var(--text)', lineHeight:1.15, marginBottom:12 }}>
                Research any{' '}
                <em style={{ color:'var(--accent)', fontStyle:'italic', fontWeight:800 }}>prospect</em>
                <br />in seconds.
              </div>
              <div style={{ fontSize:14, color:'var(--text-tertiary)', maxWidth:560, lineHeight:1.65 }}>
                Pull press releases, articles, awards, podcasts, presentations, and full background profiles for any healthcare executive.
              </div>
            </div>
          )}

          {/* Search card */}
          <div style={{ background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:16, padding:24, marginBottom:24, maxWidth: indResult ? '100%' : 700 }}>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12, marginBottom:14 }}>
              {[['FULL NAME','e.g. Dr. Jane Smith',indName,setIndName],
                ['TITLE / ROLE','e.g. Chief Medical Officer',indTitle,setIndTitle],
                ['HEALTH SYSTEM','e.g. Mayo Clinic',indOrg,setIndOrg],
              ].map(([label,ph,val,set]) => (
                <div key={label}>
                  <div style={{ fontSize:10, color:'var(--text-tertiary)', marginBottom:6, fontWeight:600, letterSpacing:'.06em' }}>{label}</div>
                  <input value={val} onChange={e=>set(e.target.value)} placeholder={ph}
                    onKeyDown={e=>e.key==='Enter' && runIndividualResearch()}
                    style={{ width:'100%', padding:'10px 12px', background:'var(--bg-secondary)', border:'1px solid var(--border)',
                      borderRadius:8, fontSize:13, color:'var(--text)', boxSizing:'border-box',
                      outline:'none' }} />
                </div>
              ))}
            </div>
            <button onClick={()=>runIndividualResearch()} disabled={indLoading||(!indName.trim()&&!indTitle.trim())||!indOrg.trim()}
              style={{ width:'100%', padding:'12px 0', display:'flex', alignItems:'center', justifyContent:'center', gap:8,
                background: indLoading || !indName.trim() || !indOrg.trim() ? 'var(--bg-secondary)' : 'var(--accent)',
                color: indLoading || !indName.trim() || !indOrg.trim() ? 'var(--text-tertiary)' : '#000',
                border:'none', borderRadius:8, fontSize:14, fontWeight:700,
                cursor: indLoading || !indName.trim() || !indOrg.trim() ? 'not-allowed' : 'pointer',
                transition:'background .15s' }}>
              {indLoading
                ? <><span style={{ animation:'spin 1s linear infinite', display:'inline-block' }}>⟳</span> Researching…</>
                : <><span>🔍</span> Research this person</>
              }
            </button>
          </div>

          {indError && (
            <div style={{ padding:14, background:'rgba(239,68,68,.08)', border:'1px solid rgba(239,68,68,.3)', borderRadius:10, color:'#ef4444', fontSize:13, marginBottom:20 }}>
              {indError}
            </div>
          )}

          {indResult?.profile && (() => {
            const p = indResult.profile
            const contentTypes = p.recentContent?.reduce((acc,c) => {
              acc[c.type] = (acc[c.type]||0)+1; return acc
            }, {}) || {}
            const total = p.recentContent?.length || 0
            const [activeFilter, setActiveFilter] = React.useState('all')

            return (
              <div>
                {/* Person header */}
                <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:24, paddingBottom:20, borderBottom:'1px solid var(--border)' }}>
                  <div>
                    <div style={{ fontSize:28, fontWeight:800, color:'var(--text)', marginBottom:4 }}>{p.name}</div>
                    <div style={{ fontSize:14, color:'var(--text-secondary)' }}>
                      {p.title}{p.org ? <> · <span style={{ color:'var(--accent)' }}>{p.org}</span></> : ''}
                    </div>
                  </div>
                  <div style={{ display:'flex', gap:6, flexShrink:0 }}>
                    {p.verifiedRole && <span style={{ fontSize:11, background:'rgba(34,197,94,.12)', color:'#16a34a', borderRadius:20, padding:'3px 10px', fontWeight:600 }}>✓ Verified</span>}
                    <span style={{ fontSize:11, background:'var(--bg-secondary)', border:'1px solid var(--border)', borderRadius:20, padding:'3px 10px', color:'var(--text-tertiary)' }}>
                      {p.confidence} confidence
                    </span>
                    <button onClick={()=>{setIndResult(null)}}
                      style={{ fontSize:11, background:'none', border:'1px solid var(--border)', borderRadius:20, padding:'3px 10px', color:'var(--text-tertiary)', cursor:'pointer' }}>
                      New search
                    </button>
                  </div>
                </div>

                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:24 }}>
                  {/* Left col: career + content */}
                  <div>
                    {/* Career history */}
                    {p.careerHistory?.length > 0 && (
                      <div style={{ marginBottom:28 }}>
                        <div style={{ fontSize:11, fontWeight:700, letterSpacing:'.1em', color:'var(--text-tertiary)', marginBottom:16 }}>CAREER HISTORY</div>
                        {p.careerHistory.map((c,i) => (
                          <div key={i} style={{ display:'flex', gap:0, marginBottom:16 }}>
                            <div style={{ width:3, background: i===0 ? 'var(--accent)' : 'var(--border)', borderRadius:2, flexShrink:0, marginRight:14, marginTop:2 }} />
                            <div>
                              <div style={{ fontSize:14, fontWeight:700, color:'var(--text)' }}>{c.title}</div>
                              <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:2, marginBottom:4 }}>
                                <span style={{ fontSize:13, color:'var(--accent)', fontWeight:500 }}>{c.org}</span>
                                {c.years && <span style={{ fontSize:11, color:'var(--text-tertiary)', background:'var(--bg-secondary)', borderRadius:20, padding:'1px 8px' }}>{c.years}</span>}
                              </div>
                              {c.summary && <div style={{ fontSize:13, color:'var(--text-tertiary)', lineHeight:1.55 }}>{c.summary}</div>}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Recent content with filter pills */}
                    {total > 0 && (
                      <div>
                        <div style={{ fontSize:11, fontWeight:700, letterSpacing:'.1em', color:'var(--text-tertiary)', marginBottom:12 }}>RECENT CONTENT</div>
                        <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:14 }}>
                          {[['all', `All ${total}`], ...Object.entries(contentTypes).map(([k,v]) => [k, `${k.replace(/_/g,' ')} ${v}`])].map(([type, label]) => (
                            <button key={type} onClick={()=>setActiveFilter(type)}
                              style={{ padding:'3px 10px', fontSize:11, borderRadius:20, border:'1px solid var(--border)', cursor:'pointer', fontWeight:500,
                                background: activeFilter===type ? 'var(--accent)' : 'var(--bg-secondary)',
                                color: activeFilter===type ? '#000' : 'var(--text-secondary)' }}>
                              {label}
                            </button>
                          ))}
                        </div>
                        {p.recentContent.filter(c => activeFilter==='all' || c.type===activeFilter).map((c,i) => (
                          <div key={i} style={{ marginBottom:12, paddingBottom:12, borderBottom:'1px solid var(--border)' }}>
                            <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:4 }}>
                              <span style={{ fontSize:13 }}>{CI_CONTENT_ICONS[c.type]||'🔗'}</span>
                              <span style={{ fontSize:10, color:'var(--text-tertiary)', textTransform:'uppercase', letterSpacing:'.05em' }}>
                                {c.type?.replace(/_/g,' ')}{c.date ? ` · ${c.date}` : ''}
                              </span>
                            </div>
                            {c.url
                              ? <a href={c.url} target="_blank" rel="noopener noreferrer" style={{ fontSize:13, color:'var(--accent)', textDecoration:'none', fontWeight:600, lineHeight:1.4, display:'block' }}>{c.title}</a>
                              : <div style={{ fontSize:13, color:'var(--text)', fontWeight:600 }}>{c.title}</div>}
                            {c.summary && <div style={{ fontSize:12, color:'var(--text-tertiary)', marginTop:3, lineHeight:1.5 }}>{c.summary}</div>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Right col: outreach intel + org context */}
                  <div>
                    {p.outreachIntel && (
                      <div style={{ marginBottom:24 }}>
                        <div style={{ fontSize:11, fontWeight:700, letterSpacing:'.1em', color:'var(--text-tertiary)', marginBottom:12 }}>OUTREACH INTEL</div>
                        <div style={{ background:'rgba(59,130,246,.06)', border:'1px solid rgba(59,130,246,.15)', borderRadius:10, padding:16 }}>
                          <div style={{ fontSize:13, color:'var(--text-secondary)', lineHeight:1.7 }}>{p.outreachIntel}</div>
                        </div>
                      </div>
                    )}
                    {p.orgContext && (
                      <div>
                        <div style={{ fontSize:11, fontWeight:700, letterSpacing:'.1em', color:'var(--text-tertiary)', marginBottom:12 }}>HEALTH SYSTEM INTEL</div>
                        <div style={{ background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:10, padding:16 }}>
                          <div style={{ fontSize:13, color:'var(--text-secondary)', lineHeight:1.7 }}>{p.orgContext}</div>
                        </div>
                      </div>
                    )}
                    {p.sources?.length > 0 && (
                      <div style={{ marginTop:16 }}>
                        <div style={{ fontSize:11, fontWeight:700, letterSpacing:'.1em', color:'var(--text-tertiary)', marginBottom:8 }}>SOURCES</div>
                        {p.sources.slice(0,3).map((s,i) => (
                          <a key={i} href={s} target="_blank" rel="noopener noreferrer"
                            style={{ display:'block', fontSize:11, color:'var(--accent)', marginBottom:4, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', textDecoration:'none', opacity:.75 }}>
                            {s}
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })()}
        </div>
      )}

      {/* ── ORG INTELLIGENCE ── */}
      {ciTab === 'org' && (
        <div>
          {/* Form */}
          <div style={{ background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', padding:20, marginBottom:16 }}>
            <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr', gap:10, marginBottom:14 }}>
              <div>
                <div style={{ fontSize:11, color:'var(--text-tertiary)', marginBottom:4, fontWeight:500 }}>HEALTH SYSTEM NAME</div>
                <input value={orgName} onChange={e=>setOrgName(e.target.value)}
                  onKeyDown={e=>e.key==='Enter' && runOrgIntel()}
                  placeholder="e.g. Atrium Health"
                  style={{ width:'100%', padding:'8px 10px', background:'var(--bg-secondary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:13, color:'var(--text)', boxSizing:'border-box' }} />
              </div>
              <div>
                <div style={{ fontSize:11, color:'var(--text-tertiary)', marginBottom:4, fontWeight:500 }}>DOMAIN (OPTIONAL)</div>
                <input value={orgDomain} onChange={e=>setOrgDomain(e.target.value)} placeholder="e.g. atriumhealth.org"
                  style={{ width:'100%', padding:'8px 10px', background:'var(--bg-secondary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:13, color:'var(--text)', boxSizing:'border-box' }} />
              </div>
            </div>

            {/* Persona selector */}
            <div style={{ marginBottom:12 }}>
              <div style={{ fontSize:11, color:'var(--text-tertiary)', marginBottom:6, fontWeight:500, display:'flex', alignItems:'center', gap:8 }}>
                PERSONAS TO SEARCH <span style={{ color:'var(--accent)' }}>{selPersonas.size} selected</span>
              </div>
              <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:8 }}>
                <button onClick={()=>setSelPersonas(new Set(CI_ALL_PERSONAS))}
                  style={{ padding:'3px 10px', fontSize:11, background:'var(--bg-secondary)', border:'1px solid var(--border)', borderRadius:20, cursor:'pointer', color:'var(--text-secondary)', fontWeight:500 }}>
                  All 22
                </button>
                {Object.keys(CI_PERSONA_GROUPS).map(g => {
                  const allIn = CI_PERSONA_GROUPS[g].every(p=>selPersonas.has(p))
                  return (
                    <button key={g} onClick={()=>setGroup(g)}
                      style={{ padding:'3px 10px', fontSize:11, cursor:'pointer', fontWeight:500, borderRadius:20,
                        background:allIn?'var(--accent)':'var(--bg-secondary)', color:allIn?'#fff':'var(--text-secondary)',
                        border:`1px solid ${allIn?'var(--accent)':'var(--border)'}` }}>
                      {g}
                    </button>
                  )
                })}
                <button onClick={()=>setSelPersonas(new Set())}
                  style={{ padding:'3px 10px', fontSize:11, background:'none', border:'1px solid var(--border)', borderRadius:20, cursor:'pointer', color:'var(--text-tertiary)' }}>
                  Clear
                </button>
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:'3px 8px' }}>
                {CI_ALL_PERSONAS.map(p => (
                  <label key={p} style={{ display:'flex', alignItems:'center', gap:5, fontSize:11, color:selPersonas.has(p)?'var(--text)':'var(--text-tertiary)', cursor:'pointer' }}>
                    <input type="checkbox" checked={selPersonas.has(p)} onChange={()=>togglePersona(p)} style={{ accentColor:'var(--accent)', width:12, height:12 }} />
                    {p}
                  </label>
                ))}
              </div>
            </div>

            <button onClick={runOrgIntel} disabled={orgLoading||!orgName.trim()||!selPersonas.size}
              style={{ padding:'9px 24px', background:orgLoading?'var(--bg-secondary)':'var(--accent)',
                color:orgLoading?'var(--text-tertiary)':'#fff', border:'none', borderRadius:'var(--radius)',
                fontSize:13, fontWeight:600, cursor:orgLoading?'not-allowed':'pointer' }}>
              {orgLoading ? `⟳ ${orgProgress||'Running…'}` : `Research ${selPersonas.size} personas`}
            </button>
          </div>

          {orgError && <div style={{ padding:12, background:'rgba(239,68,68,.08)', border:'1px solid rgba(239,68,68,.3)', borderRadius:'var(--radius)', color:'#ef4444', fontSize:13, marginBottom:16 }}>{orgError}</div>}

          {/* ── Results ── */}
          {orgResults && (() => {
            const coveredCount = CI_ALL_PERSONAS.filter(p => {
              const crm = orgResults.existingContacts.find(c => c.target_persona?.toLowerCase().includes(p.toLowerCase()))
              return !!(crm || orgResults.personas[p]?.name)
            }).length

            return (
              <div style={{ display:'flex', gap:16, alignItems:'flex-start' }}>
                {/* Persona map (left, shrinks when detail open) */}
                <div style={{ flex: selCard ? '0 0 58%' : '1 1 100%', transition:'flex .2s' }}>
                  {/* Company header */}
                  <div style={{ background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'14px 18px', marginBottom:14, display:'flex', alignItems:'center', gap:14 }}>
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:18, fontWeight:700, color:'var(--text)' }}>{orgResults.orgName}</div>
                      <div style={{ fontSize:12, color:'var(--text-tertiary)', marginTop:2 }}>
                        {coveredCount}/{CI_ALL_PERSONAS.length} personas covered · {orgResults.existingContacts.length} CRM contacts
                      </div>
                    </div>
                    <div style={{ display:'flex', gap:6 }}>
                      <span style={{ fontSize:12, background:'rgba(34,197,94,.1)', color:'#16a34a', borderRadius:8, padding:'3px 10px', fontWeight:500 }}>{coveredCount} covered</span>
                      <span style={{ fontSize:12, background:'rgba(239,68,68,.08)', color:'#ef4444', borderRadius:8, padding:'3px 10px', fontWeight:500 }}>{CI_ALL_PERSONAS.length - coveredCount} gaps</span>
                    </div>
                  </div>

                  {/* Persona map by group */}
                  <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
                    {CI_MAP_GROUPS.map(group => {
                      const groupPersonas = group.personas.filter(p => selPersonas.has(p))
                      if (!groupPersonas.length) return null
                      return (
                        <div key={group.label}>
                          <div style={{ fontSize:10, fontWeight:600, color:'var(--text-tertiary)', letterSpacing:'.08em', marginBottom:8 }}>{group.label}</div>
                          <div style={{ display:'grid', gridTemplateColumns:`repeat(${Math.min(groupPersonas.length, 4)},1fr)`, gap:8 }}>
                            {groupPersonas.map(persona => {
                                    const crmContact = orgResults.existingContacts.find(c => {
                              if (!c.target_persona?.trim()) return false
                              const tp = c.target_persona.toLowerCase().trim()
                              const p  = persona.toLowerCase()
                              return tp.includes(p) || p.includes(tp)
                            })
                              const gapResult = orgResults.personas[persona]
                              return <PersonaCard key={persona} persona={persona} crmContact={crmContact} gapResult={gapResult} />
                            })}
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  {selCard && (
                    <div style={{ marginTop:12, fontSize:11, color:'var(--text-tertiary)', textAlign:'center' }}>
                      Click any card to research that contact
                    </div>
                  )}
                </div>

                {/* Detail panel (right) */}
                {selCard && (
                  <div style={{ flex:'0 0 40%', background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', padding:18, position:'sticky', top:60, maxHeight:'calc(100vh - 80px)', overflowY:'auto' }}>
                    <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:14 }}>
                      <div>
                        <div style={{ fontSize:10, color:'var(--text-tertiary)', letterSpacing:'.05em', marginBottom:3 }}>{selCard.persona}</div>
                        <div style={{ fontSize:16, fontWeight:700, color:'var(--text)' }}>{selCard.name}</div>
                        {selCard.title && <div style={{ fontSize:12, color:'var(--text-secondary)', marginTop:2 }}>{selCard.title}</div>}
                        <div style={{ display:'flex', gap:5, marginTop:6 }}>
                          {selCard.source === 'crm' && <span style={{ fontSize:10, background:'rgba(34,197,94,.12)', color:'#16a34a', borderRadius:8, padding:'1px 6px', fontWeight:600 }}>IN CRM</span>}
                          {selCard.alreadyInCRM && <span style={{ fontSize:10, background:'rgba(34,197,94,.12)', color:'#16a34a', borderRadius:8, padding:'1px 6px', fontWeight:600 }}>IN CRM</span>}
                          {selCard.linkedinUrl && <a href={selCard.linkedinUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize:10, color:'var(--accent)' }}>LinkedIn →</a>}
                        </div>
                      </div>
                      <button onClick={()=>{setSelCard(null);setDetailData(null)}}
                        style={{ background:'none', border:'none', color:'var(--text-tertiary)', cursor:'pointer', fontSize:16, padding:'0 4px' }}>✕</button>
                    </div>

                    {detailLoading && (
                      <div style={{ textAlign:'center', padding:'30px 0', color:'var(--text-tertiary)', fontSize:13 }}>
                        ⟳ Researching {selCard.name}…
                      </div>
                    )}
                    {detailError && <div style={{ color:'#ef4444', fontSize:12, padding:'8px 0' }}>{detailError}</div>}
                    {detailData && <ProfileView data={detailData} />}
                  </div>
                )}
              </div>
            )
          })()}
        </div>
      )}

      {/* ── HISTORY ── */}
      {ciTab === 'history' && (
        <div>
          {!history.length ? (
            <div style={{ textAlign:'center', padding:'40px 0', color:'var(--text-tertiary)', fontSize:13 }}>
              No searches yet. Run Individual Research or Org Intelligence to see history here.
            </div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
              {history.map((h,i) => (
                <div key={i} onClick={() => {
                  if (h.type==='individual') { setCiTab('individual'); setIndName(h.name); setIndTitle(h.title||''); setIndOrg(h.org); setIndResult(h.result) }
                  else { setCiTab('org'); setOrgName(h.org); setOrgResults(h.result) }
                }}
                  style={{ padding:'12px 14px', background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)', cursor:'pointer', display:'flex', justifyContent:'space-between', alignItems:'center' }}
                  onMouseEnter={e=>e.currentTarget.style.background='var(--bg-secondary)'}
                  onMouseLeave={e=>e.currentTarget.style.background='var(--bg-panel)'}>
                  <div>
                    <div style={{ fontSize:12, fontWeight:600, color:'var(--text)' }}>
                      {h.type==='individual' ? `${h.name} · ${h.org}` : `${h.org} (${h.personaCount} personas)`}
                    </div>
                    <div style={{ fontSize:11, color:'var(--text-tertiary)', marginTop:2 }}>
                      {h.type==='individual'?'Individual Research':'Org Intelligence'} · {timeAgo(h.ts)}
                    </div>
                  </div>
                  <span style={{ fontSize:11, color:'var(--text-tertiary)' }}>Restore →</span>
                </div>
              ))}
              <button onClick={()=>{setHistory([]);localStorage.removeItem('cipher_ci_history')}}
                style={{ marginTop:4, padding:'6px 12px', background:'none', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:11, color:'var(--text-tertiary)', cursor:'pointer' }}>
                Clear history
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}


export default function Dashboard({ user, theme, toggleTheme, getToken, onScopeError, signOut }) {

  // ── User identity helpers (Netlify Identity + Clerk compatible) ──────────
  // Netlify Identity: user.email, user.user_metadata?.full_name
  // Clerk: user.firstName, user.lastName, user.emailAddresses
  const _userEmail    = user?.email || user?.emailAddresses?.[0]?.emailAddress || null
  const _userFullName = user?.user_metadata?.full_name ||
    (user?.firstName && user?.lastName ? `${user.firstName} ${user.lastName}` : null) ||
    TEAM_MEMBERS.find(m => m.email && m.email === _userEmail)?.name || null
  const _userFirstName = _userFullName?.split(' ')[0] || _userEmail?.split('@')[0] || null

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
  const [contacts, setContacts]           = useState([])
  const [contactsTotal, setContactsTotal] = useState(0)
  const [repSyncState, setRepSyncState]   = useState(() => {
    try {
      const saved = sessionStorage.getItem('repSyncState')
      if (saved) { const s = JSON.parse(saved); return { ...s, running:false, progress:'' } }
    } catch {}
    return { running:false, done:false, updated:0, skipped:0, total:0, progress:'' }
  })
  const [adminOpen, setAdminOpen]           = useState(false)
  const [previewData, setPreviewData]       = useState(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [hpOverrides, setHpOverrides] = useState(() => {
    try { return JSON.parse(localStorage.getItem('cipher_hp_overrides') || '{}') }
    catch { return {} }
  })
  const [outlookData, setOutlookData]       = useState({ connected: false, emails: {} })
  const [outlookLoading, setOutlookLoading] = useState(false)
  const saveRepSyncState = (s) => {
    setRepSyncState(s)
    try { sessionStorage.setItem('repSyncState', JSON.stringify(s)) } catch {}
  }
  const runRepSync = async (fullCrm = false, forceRefresh = false) => {
    saveSyncMode(fullCrm ? 'fullcrm' : 'gold')
    saveRepSyncState({ running:true, done:false, updated:0, skipped:0, total:0, progress:'Starting…' })
    let totalUpdated = 0, totalSkipped = 0, grandTotal = 0, batchStart = 0, crmCursor = null
    try {
      while (true) {
        saveRepSyncState({ running:true, done:false, updated:totalUpdated, skipped:totalSkipped,
          total:grandTotal, progress: grandTotal > 0
            ? `Processing ${(totalUpdated+totalSkipped).toLocaleString()} of ${grandTotal.toLocaleString()} contacts…`
            : fullCrm ? 'Fetching CRM contacts…' : 'Fetching Gold contacts…'
        })
        const res = await safeFetch(`/api/hubspot/sync-primary-rep`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ batchStart, batchSize: 100, fullCrm, forceRefresh, crmCursor }),
        })
        totalUpdated += res.updated || 0
        totalSkipped += res.skipped || 0
        grandTotal    = res.total   || grandTotal
        if (res.done || !res.hasMore) break
        // For full CRM: use cursor for next contact page; batchStart resets to 0 each page
        if (fullCrm && res.nextCrmCursor) {
          crmCursor  = res.nextCrmCursor
          batchStart = 0
        } else {
          batchStart = res.nextBatch
        }
        await new Promise(r => setTimeout(r, 300))
      }
      saveRepSyncState({ running:false, done:true, updated:totalUpdated, skipped:totalSkipped, total:grandTotal, progress:'' })
    } catch(e) {
      saveRepSyncState({ running:false, done:false, updated:totalUpdated, skipped:totalSkipped, total:grandTotal, progress:`Error: ${e.message}` })
    }
  }
  const runDryRun = async () => {
    setPreviewLoading(true)
    setPreviewData(null)
    try {
      const res = await safeFetch(`/api/hubspot/sync-primary-rep`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchStart: 0, batchSize: 50, fullCrm: false, dryRun: true }),
      })
      setPreviewData(res)
    } catch(e) {
      setPreviewData({ error: e.message })
    } finally {
      setPreviewLoading(false)
    }
  }

  // Run preview/sync for the logged-in user's contacts only
  const myRepName = _userFullName
    ? (TEAM_MEMBERS.find(m => m.name.toLowerCase() === _userFullName.toLowerCase() ||
        (_userFirstName && m.name.toLowerCase().startsWith(_userFirstName.toLowerCase())))?.name || null)
    : null

  const runDryRunMine = async () => {
    if (!myRepName) return
    setPreviewLoading(true)
    setPreviewData(null)
    try {
      const res = await safeFetch(`/api/hubspot/sync-primary-rep`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchStart: 0, batchSize: 50, fullCrm: false, dryRun: true, repFilter: myRepName }),
      })
      setPreviewData(res)
    } catch(e) {
      setPreviewData({ error: e.message })
    } finally {
      setPreviewLoading(false)
    }
  }

  const runRepSyncMine = async () => {
    if (!myRepName) return
    saveRepSyncState({ running: true, done: false, updated: 0, skipped: 0, total: 0, progress: `Starting sync for ${myRepName}…` })
    let totalUpdated = 0, totalSkipped = 0, grandTotal = 0, batchStart = 0
    try {
      while (true) {
        // batchSize 50: engagement API runs per contact (limit:3, 10 parallel) — ~2.5s per batch
        const res = await safeFetch(`/api/hubspot/sync-primary-rep`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ batchStart, batchSize: 50, fullCrm: false, dryRun: false, repFilter: myRepName }),
        })
        totalUpdated += res.updated  || 0
        totalSkipped += res.skipped  || 0
        if (!grandTotal && res.total) grandTotal = res.total
        const processed = batchStart + (res.batchEnd - res.batchStart || 25)
        saveRepSyncState({
          running:  true,
          done:     false,
          updated:  totalUpdated,
          skipped:  totalSkipped,
          total:    grandTotal,
          progress: `Batch ${Math.ceil(batchStart/50)+1} — ${Math.min(batchStart+50,grandTotal||batchStart+50).toLocaleString()} of ${grandTotal ? grandTotal.toLocaleString() : '…'} contacts processed · ${totalUpdated} updated`,
        })
        if (res.done || !res.hasMore) break
        batchStart = res.nextBatch ?? (batchStart + 25)
      }
      saveRepSyncState({ running: false, done: true, updated: totalUpdated, skipped: totalSkipped, total: grandTotal,
        progress: `Done — ${totalUpdated.toLocaleString()} updated, ${totalSkipped.toLocaleString()} unchanged out of ${grandTotal.toLocaleString()} contacts` })
    } catch(e) {
      saveRepSyncState({ running: false, done: false, updated: totalUpdated, skipped: totalSkipped, total: grandTotal,
        progress: `Error after ${totalUpdated} updates: ${e.message}` })
    }
  }

  const [syncMode, setSyncMode]             = useState(() => {
    try { return sessionStorage.getItem('syncMode') || 'gold' } catch { return 'gold' }
  })
  const saveSyncMode = (m) => {
    setSyncMode(m)
    try { sessionStorage.setItem('syncMode', m) } catch {}
  }
  const [feed, setFeed]               = useState([])
  const [loading, setLoading]         = useState(true)
  const [signalsHasMore, setSignalsHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  // Task queue data (three sections)
  const [taskData, setTaskData]       = useState({ repliesAwaitingResponse:[], upcomingSequences:[], dueTasks:[], meta:{} })

  // ── To-Do list state ────────────────────────────────────────────────────────
  const [todoItems, setTodoItems]     = useState([])
  const [donePage, setDonePage]       = useState(0)
  const [activityMeetPage, setActivityMeetPage] = useState(0)
  const todoItemsRef = useRef([])
  useEffect(() => { todoItemsRef.current = todoItems }, [todoItems])
  const [todoPage, setTodoPage]       = useState(0)
  const [todoTab, setTodoTab]         = useState('high-priority')
  const TODO_PAGE_SIZE = 5
  const [todoLoading, setTodoLoading] = useState(false)
  const [todoInput, setTodoInput]     = useState('')
  const [todoDueDate, setTodoDueDate] = useState('')
  const [todoSyncing, setTodoSyncing] = useState(false)

  const fetchTodos = useCallback(async () => {
    setTodoLoading(true)
    try {
      const data = await safeFetch('/api/hubspot/todo')
      setTodoItems(dedupTodoItems(data.items))
    } catch (e) { console.error('[todo]', e) }
    finally { setTodoLoading(false) }
  }, [])

  const syncTodos = useCallback(async () => {
    setTodoSyncing(true)
    try {
      const data = await safeFetch('/api/hubspot/todo/sync', { method:'POST' })
      setTodoItems(dedupTodoItems(data.items))
    } catch (e) { console.error('[todo/sync]', e) }
    finally { setTodoSyncing(false) }
  }, [])


  const dedupTodoItems = (items) => {
    const seen = new Set()
    return (items || []).filter(i => {
      if (!i.contactId) return true
      if (seen.has(i.contactId)) return false
      seen.add(i.contactId)
      return true
    })
  }
  const addTodoItem = useCallback(async (text, extraFields = {}) => {
    if (!text?.trim()) return
    // Prevent duplicate contactId entries — check current state via ref to avoid race conditions
    if (extraFields.contactId) {
      const alreadyTracked = todoItemsRef.current.some(
        t => !t.completed && t.contactId === extraFields.contactId && !t.autoDetected
      )
      if (alreadyTracked) return
    }
    try {
      const data = await safeFetch('/api/hubspot/todo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text.trim(), type: 'manual',
          dueDate: todoDueDate || null,
          ...extraFields,
        }),
      })
      setTodoItems(prev => {
        if (extraFields.contactId && prev.some(t => !t.completed && t.contactId === extraFields.contactId && !t.autoDetected)) return prev
        if (extraFields.sourceId && prev.some(t => t.sourceId === extraFields.sourceId)) return prev
        // Prepend to top, before other manual items (newest first)
        const firstAutoIdx = prev.findIndex(t => t.autoDetected)
        if (firstAutoIdx === 0) return [data.item, ...prev]
        if (firstAutoIdx > 0) return [...prev.slice(0, firstAutoIdx), data.item, ...prev.slice(firstAutoIdx)]
        return [data.item, ...prev]
      })
      setTodoInput('')
      setTodoDueDate('')
    } catch (e) { console.error('[todo/add]', e) }
  }, [todoDueDate])

  const toggleTodo = useCallback(async (id, completed) => {
    // Optimistic update
    setTodoItems(prev => prev.map(t => t.id === id ? { ...t, completed, completedAt: completed ? new Date().toISOString() : null } : t))
    try {
      await safeFetch(`/api/hubspot/todo/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed }),
      })
    } catch (e) { console.error('[todo/toggle]', e) }
  }, [])

  const deleteTodoItem = useCallback(async (id) => {
    setTodoItems(prev => prev.filter(t => t.id !== id))
    try {
      await safeFetch(`/api/hubspot/todo/${id}`, { method: 'DELETE' })
    } catch (e) { console.error('[todo/delete]', e) }
  }, [])

  const exportTodos = useCallback((format) => {
    const today   = new Date().toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' })
    const done    = todoItems.filter(t => t.completed)
    const pending = todoItems.filter(t => !t.completed)
    if (format === 'text') {
      const lines = [
        `Daily Recap — ${today}`,
        '',
        `COMPLETED (${done.length})`,
        ...done.map(t => `✓ ${t.text}${t.subtext ? ` — ${t.subtext}` : ''}`),
        '',
        `PENDING (${pending.length})`,
        ...pending.map(t => `○ ${t.text}${t.subtext ? ` — ${t.subtext}` : ''}`),
      ]
      navigator.clipboard.writeText(lines.join('\n')).then(() => alert('Copied to clipboard!'))
    } else {
      const rows = [
        ['Status','Type','Task','Context','Created','Completed'],
        ...todoItems.map(t => [
          t.completed ? 'Done' : 'Pending',
          t.type,
          t.text,
          t.subtext || '',
          t.createdAt ? new Date(t.createdAt).toLocaleString() : '',
          t.completedAt ? new Date(t.completedAt).toLocaleString() : '',
        ])
      ]
      const csv  = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n')
      const blob = new Blob([csv], { type:'text/csv' })
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = `todo-${new Date().toISOString().slice(0,10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
    }
  }, [todoItems])
  const [taskDays, setTaskDays]       = useState('14')
  const [taskSection, setTaskSection] = useState('replies')
  const [taskLoading, setTaskLoading] = useState(false)

  // Gold accounts
  const [goldAccounts, setGoldAccounts]   = useState([])
  const [goldMeta, setGoldMeta]           = useState({})
  const [goldLoading, setGoldLoading]     = useState(false)
  const [goldTierFilter, setGoldTierFilter] = useState('')
  // Gold tab-specific filters (independent of main filter bar)
  const [goldTabBdr, setGoldTabBdr]       = useState('')
  const [goldTabTier, setGoldTabTier]     = useState('')
  const [gapResults, setGapResults]       = useState({}) // keyed by companyId
  const [gapSearching, setGapSearching]   = useState({}) // keyed by companyId
  const [gapBatchRunning, setGapBatchRunning] = useState(false)
  const [gapBatchProgress, setGapBatchProgress] = useState('')
  const [expandedGaps, setExpandedGaps]   = useState({}) // keyed by companyId
  const [goldSelectedAccount, setGoldSelectedAccount] = useState(null)

  // ── Gold Target / High Priority helpers ──────────────────────────────────────
  const goldCompanyIds = useMemo(
    () => new Set((goldAccounts || []).map(a => a.id).filter(Boolean)),
    [goldAccounts]
  )
  const HP_EXCLUDE = ['assistant','coordinator','secretary','administrative','receptionist','scheduler']
  const autoIsHP = useCallback((signal) => {
    if (!signal?.contactId) return false
    if (!signal.contact?.target_persona) return false
    if (!goldCompanyIds.has(signal.contact?.associatedcompanyid)) return false
    const title = (signal.contact?.title || '').toLowerCase()
    if (HP_EXCLUDE.some(t => title.includes(t))) return false
    return true
  }, [goldCompanyIds])
  const isHighPriority = useCallback((signal) => {
    if (!signal?.contactId) return false
    const override = hpOverrides[signal.contactId]
    if (override !== undefined) return override
    return autoIsHP(signal)
  }, [hpOverrides, autoIsHP])
  const toggleHpOverride = useCallback((contactId, currentValue) => {
    setHpOverrides(prev => {
      const next = { ...prev }
      if (prev[contactId] !== undefined) { delete next[contactId] }
      else { next[contactId] = !currentValue }
      try { localStorage.setItem('cipher_hp_overrides', JSON.stringify(next)) } catch {}
      return next
    })
  }, [])

  // ── Persisted report filter state ─────────────────────────────────────────
  // Lifted up to Dashboard so state survives tab switches (ReportsTab unmounts/remounts)
  const [reportSection, setReportSection] = useState('email_activity')
  const [reportPeriod,  setReportPeriod]  = useState('week')   // default 7 days
  const [reportRep,     setReportRep]     = useState(() => {
    if (!user) return 'all'
    const full = _userFullName || ''
    const match = TEAM_MEMBERS.find(m =>
      (m.email && m.email === _userEmail) ||
      (full && m.name.toLowerCase() === full.toLowerCase()) ||
      (_userFirstName && m.name.toLowerCase().startsWith(_userFirstName.toLowerCase()))
    )
    return match?.name || 'all'
  })
  const [reportOwner, setReportOwner]     = useState('')
  const [reportCustomFrom, setReportCustomFrom] = useState('')
  const [reportCustomTo,   setReportCustomTo]   = useState('')

  // Activity summary
  const [activityData, setActivityData]       = useState(null)
  const [activityDays, setActivityDays]       = useState('7')
  const [activityRep, setActivityRep]         = useState(() => {
    if (!_userFullName && !_userEmail) return 'all'
    const match = TEAM_MEMBERS.find(m =>
      (m.email && m.email === _userEmail) ||
      (_userFullName && m.name.toLowerCase() === _userFullName.toLowerCase()) ||
      (_userFirstName && m.name.toLowerCase().startsWith(_userFirstName.toLowerCase()))
    )
    return match?.name || 'all'
  })
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
  const [signalSearch, setSignalSearch]   = useState('')
  const [contactSort, setContactSort]     = useState('name_asc')

  // Pagination
  const PAGE_SIZE = 25
  const [taskPage, setTaskPage]           = useState(0)
  const [signalPage, setSignalPage]       = useState(0)
  const [goldPage, setGoldPage]           = useState(0)

  // Filters
  // Default filter to current user -- match Clerk name against TEAM_MEMBERS
  const currentUserName = useMemo(() => {
    if (!_userFullName && !_userEmail) return ''
    const match = TEAM_MEMBERS.find(m =>
      (m.email && m.email === _userEmail) ||
      (_userFullName && m.name.toLowerCase() === _userFullName.toLowerCase()) ||
      (_userFirstName && m.name.toLowerCase().startsWith(_userFirstName.toLowerCase()))
    )
    return match?.name || ''
  }, [user, _userFullName, _userEmail, _userFirstName])

  const [filterBdr, setFilterBdr] = useState(() => {
    // Restore last-used filter from session
    try { const s = sessionStorage.getItem('cipher_filterBdr'); if (s !== null) return s } catch {}
    // Auto-detect from logged-in user (Netlify Identity + Clerk compatible)
    if (!_userFullName && !_userEmail) return ''
    const match = TEAM_MEMBERS.find(m =>
      (m.email && m.email === _userEmail) ||
      (_userFullName && m.name.toLowerCase() === _userFullName.toLowerCase()) ||
      (_userFirstName && m.name.toLowerCase().startsWith(_userFirstName.toLowerCase()))
    )
    return match?.name || ''
  })
  const [filterTerritory, setFilterTerritory] = useState('')
  // Persist filter selection across page reloads
  useEffect(() => {
    try { sessionStorage.setItem('cipher_filterBdr', filterBdr) } catch {}
  }, [filterBdr])
  const [filterTier, setFilterTier]         = useState('')
  const [filterTarget, setFilterTarget]     = useState('')
  const [owners, setOwners]                 = useState([])

  const firstName = _userFirstName || 'there'
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

  // Expand filterBdr to bdrNames (assigned_bdr filter) and ownerIds (hubspot_owner_id filter)
  const { bdrNames: expandedBdrs, ownerIds: expandedOwnerIds } = useMemo(() => expandFilter(filterBdr), [filterBdr])

  const fetchContentEngagement = useCallback(async () => {
    setContentEngagementLoading(true)
    try {
      const bdrPart   = expandedBdrs.length     ? `&assigned_bdr=${expandedBdrs.map(encodeURIComponent).join(',')}` : ''
      const ownerPart = expandedOwnerIds.length ? `&owner_id=${expandedOwnerIds.join(',')}` : ''
      const data = await safeFetch(`/api/hubspot/contacts?click_sort=true${bdrPart}${ownerPart}`)
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
  }, [expandedBdrs, expandedOwnerIds])

  const filterParams = useMemo(() => [
    expandedBdrs.length     ? `assigned_bdr=${expandedBdrs.map(encodeURIComponent).join(',')}` : '',
    expandedOwnerIds.length ? `owner_id=${expandedOwnerIds.join(',')}` : '',
    filterTerritory ? `territory=${encodeURIComponent(filterTerritory)}`           : '',
    filterTier      ? `priority_tier__bdr=${encodeURIComponent(filterTier)}`       : '',
    filterTarget    ? `target_account__bdr_led_outreach=${encodeURIComponent(filterTarget)}` : '',
  ].filter(Boolean).join('&'), [expandedBdrs, expandedOwnerIds, filterTerritory, filterTier, filterTarget])

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
        setContactsTotal(contactData.total || 0)
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
      const bdrPart   = expandedBdrs.length     ? `&assigned_bdr=${expandedBdrs.map(encodeURIComponent).join(',')}` : ''
      const ownerPart = expandedOwnerIds.length ? `&owner_id=${expandedOwnerIds.join(',')}` : ''
      const params = `days=${taskDays}${bdrPart}${ownerPart}`
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
  }, [taskDays, expandedBdrs, expandedOwnerIds])

  // ── Gold accounts fetch ───────────────────────────────────────────────────
  const fetchGold = useCallback(async () => {
    setGoldLoading(true)
    try {
      const bdrPart   = expandedBdrs.length     ? `assigned_bdr=${expandedBdrs.map(encodeURIComponent).join(',')}` : ''
      const ownerPart = expandedOwnerIds.length ? `owner_id=${expandedOwnerIds.join(',')}` : ''
      const tierPart  = goldTabTier ? `tier=${encodeURIComponent(goldTabTier)}` : ''
      const params = [bdrPart, ownerPart, tierPart].filter(Boolean).join('&')
      const data = await safeFetch(`/api/hubspot/gold${params ? '?' + params : ''}`)
      setGoldAccounts(data.accounts || [])
      setGoldMeta(data.meta || {})
    } catch (e) {
      console.error('[gold]', e)
    } finally {
      setGoldLoading(false)
    }
  }, [expandedBdrs, expandedOwnerIds, goldTabTier])

  // ── Gap analysis functions ────────────────────────────────────────────────
  const fetchGapsForAccount = async (companyId, companyName, domain) => {
    setGapSearching(s => ({ ...s, [companyId]: 'loading' }))
    try {
      const gapData = await safeFetch(`/api/hubspot/gold-gaps?companyId=${companyId}`)
      const result  = gapData.results?.[0]
      if (!result) { setGapSearching(s => ({ ...s, [companyId]: null })); return }
      // Store gap data without search results yet
      setGapResults(r => ({ ...r, [companyId]: { ...result, searchResults: [], searchDone: false } }))
      setGapSearching(s => ({ ...s, [companyId]: 'searching' }))
      setExpandedGaps(e => ({ ...e, [companyId]: true }))
      // Now search for missing personas in batches of 3
      const missing = result.missingPersonas || []
      let allFound = []
      for (let i = 0; i < missing.length; i += 3) {
        const batch = missing.slice(i, i + 3)
        try {
          const searchData = await safeFetch('/api/hubspot-gap-search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ companyName, domain, missingPersonas: batch, batchSize: 3 }),
          })
          allFound = [...allFound, ...(searchData.found || [])]
          setGapResults(r => ({ ...r, [companyId]: { ...r[companyId], searchResults: allFound } }))
        } catch { /* continue with other batches */ }
        await new Promise(r => setTimeout(r, 500))
      }
      setGapResults(r => ({ ...r, [companyId]: { ...r[companyId], searchDone: true } }))
      setGapSearching(s => ({ ...s, [companyId]: null }))
    } catch (e) {
      setGapSearching(s => ({ ...s, [companyId]: null }))
    }
  }

  const runGapBatchScan = async () => {
    setGapBatchRunning(true)
    setGapBatchProgress('Fetching Gold account gaps...')
    try {
      const gapData = await safeFetch('/api/hubspot/gold-gaps?batch=true')
      const results = gapData.results || []
      setGapBatchProgress(`Found ${results.length} accounts — searching for missing contacts...`)
      for (let i = 0; i < results.length; i++) {
        const r = results[i]
        setGapBatchProgress(`Searching ${r.companyName} (${i+1}/${results.length})...`)
        setGapResults(g => ({ ...g, [r.companyId]: { ...r, searchResults: [], searchDone: false } }))
        // Quick gap-only scan without AI search for batch — just coverage data
        setGapResults(g => ({ ...g, [r.companyId]: { ...r, searchDone: true, searchResults: [] } }))
        await new Promise(r => setTimeout(r, 100))
      }
      setGapBatchProgress(`Complete — ${results.length} accounts scanned`)
    } catch (e) {
      setGapBatchProgress(`Error: ${e.message}`)
    }
    setGapBatchRunning(false)
  }

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
  useEffect(() => { fetchTodos(); syncTodos() }, [fetchTodos, syncTodos])

  // ── ownRepName: capture logged-in user's rep name once on load ───────────────
  const ownRepName = useRef(null)
  useEffect(() => {
    if (filterBdr && !ownRepName.current) ownRepName.current = filterBdr
  }, [filterBdr])

  // ── Load Outlook sent emails for sentAt resolution ────────────────────────
  useEffect(() => {
    if (!user?.id) return
    setOutlookLoading(true)
    safeFetch(`/api/outlook-emails?userId=${user.id}&days=30`)
      .then(data => { if (data) setOutlookData(data) })
      .catch(e => console.error('[outlook] load failed:', e.message))
      .finally(() => setOutlookLoading(false))
    const params = new URLSearchParams(window.location.search)
    if (params.has('outlook_connected') || params.has('outlook_error')) {
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [user?.id])

  // ── Auto-create High Priority To-Dos from Gold Target signals ────────────────
  const hpProcessed = useRef(new Set())
  useEffect(() => {
    if (!signals.length) return
    if (ownRepName.current && filterBdr && filterBdr !== ownRepName.current) return
    signals.forEach(signal => {
      if (!signal.contactId || !isHighPriority(signal)) return
      if (hpProcessed.current.has(signal.contactId)) return
      hpProcessed.current.add(signal.contactId)
      const signalType = signal.score >= 100 ? 'replied' : signal.score >= 60 ? 'clicked' : 'opened'
      const name       = signal.contact?.name || signal.recipientEmail || 'Contact'
      const taskText   = signalType === 'replied'
        ? `Reply to ${name} — responded to your email`
        : signalType === 'clicked'
        ? `Follow up — ${name} clicked your email, no reply yet`
        : `Follow up — ${name} opened your email, no reply yet`
      const subtext    = [signal.contact?.company, signal.contact?.title].filter(Boolean).join(' · ')
      const existing   = todoItemsRef.current.find(t =>
        t.contactId === signal.contactId && (t.priority === 'HIGH' || t.type === 'high-priority') && !t.completed
      )
      if (!existing) {
        addTodoItem(taskText, { priority:'HIGH', contactId:signal.contactId, type:'high-priority', subtext })
      }
    })
  }, [signals, isHighPriority, filterBdr])
  // Stagger all fetches to avoid rate limit storm on filter change or mount.
  // Signals (fetchData) fires immediately ~2s, tasks at 1s, gold at 3s, activity at 5s, content at 4s.
  useEffect(() => {
    const t = setTimeout(() => fetchTasks(), 2500)
    return () => clearTimeout(t)
  }, [fetchTasks])
  useEffect(() => {
    const t = setTimeout(() => fetchGold(), 6000)
    return () => clearTimeout(t)
  }, [fetchGold])
  useEffect(() => {
    const t = setTimeout(() => fetchActivity(), 9500)
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
  const sortedSignals  = useMemo(() => {
    let s = sortSignals(signals, signalSort)
    if (signalSearch.trim()) {
      const q = signalSearch.trim().toLowerCase()
      s = s.filter(sig =>
        (sig.subject || '').toLowerCase().includes(q) ||
        (sig.contact?.name || '').toLowerCase().includes(q) ||
        (sig.contact?.company || '').toLowerCase().includes(q) ||
        (sig.label || '').toLowerCase().includes(q)
      )
    }
    return s
  }, [signals, signalSort, signalSearch])
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
    const t = setTimeout(() => fetchContentEngagement(), 12000)
    return () => clearTimeout(t)
  }, [fetchContentEngagement])

  const exportSignalsCSV = useCallback(() => {
    const rows = sortedSignals.filter(s => !s.isBot)
    if (!rows.length) return
    const headers = ['Name','Company','Title','Email','Signal','Email / Sequence','Sent','Opened','Clicked','Replied','HubSpot URL']
    const escape  = v => `"${String(v ?? '').replace(/"/g, '""')}"`
    const lines   = [
      headers.join(','),
      ...rows.map(s => {
        const chain  = s.eventChain || []
        const chainTs = (type) => chain.find(e => e.type === type)?.timestamp || ''
        return [
          escape(s.contact?.name || s.recipientEmail || ''),
          escape(s.contact?.company || ''),
          escape(s.contact?.title || ''),
          escape(s.contact?.email || s.recipientEmail || ''),
          escape(s.label || ''),
          escape(s.subject || ''),
          escape(s.sentAt    || chainTs('SENT')    || ''),
          escape(s.openedAt  || chainTs('OPENED')  || ''),
          escape(s.clickedAt || chainTs('CLICKED') || ''),
          escape(s.repliedAt || chainTs('REPLIED') || ''),
          escape(s.contactId ? `https://app.hubspot.com/contacts/39921549/record/0-1/${s.contactId}` : ''),
        ].join(',')
      })
    ]
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `signals-export-${new Date().toISOString().slice(0,10)}${signalSearch ? `-${signalSearch.replace(/\s+/g,'-')}` : ''}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }, [sortedSignals, signalSearch])

  const openHubSpotContact = (contactId, e) => {
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
        <div style={{ fontSize:13, fontWeight:500, letterSpacing:'.05em', textTransform:'uppercase', color:'var(--accent)', marginRight:8 }}>Cipher</div>

        {[
          { key:'dashboard',     label:'Dashboard' },
          { key:'gold-command',  label:'Gold Accounts' },
          { key:'gold-overview', label:'Gold Overview' },
          { key:'reports',       label:'Reports' },
          { key:'contacts',      label:'Contacts' },
          { key:'map-tool',      label:'Market Mapper' },
          { key:'contact-intel', label:'Contact Intelligence' },
          { key:'cpiq',          label:'CPIQ' },
          { key:'fin-analysis',  label:'Financial Analysis' },
          // Dynamic tabs from registry
          ...dynamicTabs.map(t => ({ key:`dyn-${t.id}`, label:t.label, badge:t.badge, url:t.url, tabType:t.type })),
          // Add App tab (visible to all users)
          { key:'add-app', label:'+ Add App', isAddApp:true },
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
              <MetricCard label="Active contacts"    value={contactsTotal || contacts.length}   sub={loadingMore ? 'Loading more...' : 'In HubSpot'} subType="neutral" />
              <MetricCard label="Bot opens filtered" value={botCount}          sub="Not shown in feed"   subType="neutral" />
            </div>

            {/* Admin panel — only visible to Chris Knapp */}
            {currentUserName === 'Chris Knapp' && (
              <div style={{ marginBottom:'1.25rem' }}>
                <button onClick={() => setAdminOpen(o => !o)}
                  style={{ fontSize:11, color:'var(--text-tertiary)', background:'none', border:'none',
                    cursor:'pointer', padding:'2px 0', display:'flex', alignItems:'center', gap:5 }}>
                  <span style={{ fontSize:10 }}>{adminOpen ? '▼' : '▶'}</span>
                  Admin tools
                </button>
                {adminOpen && (
                    <div style={{ marginTop:8, padding:'10px 14px', background:'var(--bg-panel)',
                      border:'1px solid var(--border)', borderRadius:'var(--radius-lg)',
                      display:'flex', alignItems:'center', gap:14, flexWrap:'wrap' }}>
                      <div style={{ flex:1, minWidth:200 }}>
                        <div style={{ fontSize:12, fontWeight:600, color:'var(--text)', marginBottom:2 }}>
                          Primary Outreach Rep Sync
                        </div>
                        <div style={{ fontSize:11, color:'var(--text-tertiary)' }}>
                          {repSyncState.done
                            ? `✓ Complete — ${repSyncState.updated.toLocaleString()} updated · ${repSyncState.skipped.toLocaleString()} unchanged · ${repSyncState.total.toLocaleString()} ${syncMode === 'fullcrm' ? 'CRM' : 'Gold'} contacts`
                            : repSyncState.running
                            ? repSyncState.progress
                            : 'Sets primary_outreach_rep based on most recent engagement owner. AE activity overrides BDR. Existing customers and Do Not Contact skipped.'}
                        </div>
                      </div>
                      {repSyncState.running && (
                        <div style={{ fontSize:11, color:'var(--accent)' }}>
                          {repSyncState.total > 0 ? `${Math.round(((repSyncState.updated+repSyncState.skipped)/repSyncState.total)*100)}%` : '…'}
                        </div>
                      )}
                      <div style={{ display:'flex', gap:6, flexShrink:0, flexWrap:'wrap' }}>
                        <button onClick={runDryRunMine} disabled={repSyncState.running || previewLoading || !myRepName}
                          style={{ padding:'6px 10px', background:'none',
                            border:'1px solid var(--accent)',
                            color: (repSyncState.running || previewLoading || !myRepName) ? 'var(--text-tertiary)' : 'var(--accent)',
                            borderRadius:'var(--radius)', fontSize:11,
                            cursor: (repSyncState.running || previewLoading || !myRepName) ? 'not-allowed' : 'pointer' }}>
                          {previewLoading ? '⟳ Previewing…' : `Preview Mine${myRepName ? ` (${myRepName.split(' ')[0]})` : ''}`}
                        </button>
                        <button onClick={runRepSyncMine} disabled={repSyncState.running || !myRepName}
                          style={{ padding:'6px 10px', background:'none',
                            border:'1px solid var(--accent)',
                            color: (repSyncState.running || !myRepName) ? 'var(--text-tertiary)' : 'var(--accent)',
                            borderRadius:'var(--radius)', fontSize:11, fontWeight:600,
                            cursor: (repSyncState.running || !myRepName) ? 'not-allowed' : 'pointer' }}>
                          {repSyncState.running ? '⟳ Running…' : `Run Mine`}
                        </button>
                        <button onClick={runDryRun} disabled={repSyncState.running || previewLoading}
                          style={{ padding:'6px 10px', background:'none',
                            border:'1px solid var(--amber, #D97706)',
                            color: (repSyncState.running || previewLoading) ? 'var(--text-tertiary)' : '#D97706',
                            borderRadius:'var(--radius)', fontSize:11,
                            cursor: (repSyncState.running || previewLoading) ? 'not-allowed' : 'pointer' }}>
                          {previewLoading ? '⟳ Previewing…' : 'Preview (Gold)'}
                        </button>
                        <button onClick={() => runRepSync(false)} disabled={repSyncState.running}
                          style={{ padding:'6px 10px', background:'none', border:'1px solid var(--border)',
                            color: repSyncState.running ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                            borderRadius:'var(--radius)', fontSize:11,
                            cursor: repSyncState.running ? 'not-allowed' : 'pointer' }}>
                          {repSyncState.running && syncMode === 'gold' ? '⟳ Gold…' : 'Run Gold'}
                        </button>
                        <button onClick={() => runRepSync(true, false)} disabled={repSyncState.running}
                          style={{ padding:'6px 14px', background: repSyncState.running ? 'var(--bg)' : 'var(--accent)',
                            color: repSyncState.running ? 'var(--text-tertiary)' : '#fff',
                            border:'none', borderRadius:'var(--radius)', fontSize:12,
                            fontWeight:600, cursor: repSyncState.running ? 'not-allowed' : 'pointer' }}>
                          {repSyncState.running && syncMode === 'fullcrm'
                            ? `⟳ Full CRM ${repSyncState.total > 0 ? Math.round(((repSyncState.updated+repSyncState.skipped)/repSyncState.total)*100)+'%' : '…'}`
                            : 'Run Full CRM'}
                        </button>
                      </div>

                    {/* ── Dry run preview results ── */}
                    {previewData && !previewData.error && (
                      <div style={{ marginTop:12, border:'1px solid var(--border)', borderRadius:'var(--radius)',
                        overflow:'hidden', fontSize:11 }}>
                        {/* Summary bar */}
                        <div style={{ padding:'8px 12px', background:'var(--bg-secondary)',
                          display:'flex', gap:16, flexWrap:'wrap', alignItems:'center',
                          borderBottom:'1px solid var(--border)' }}>
                          <span style={{ fontWeight:600 }}>Preview — first 50 Gold contacts</span>
                          <span style={{ color: previewData.engagementHitRate > 50 ? 'var(--green, #22c55e)' : 'var(--red)' }}>
                            Engagement data found: {previewData.engagementHitRate}%
                          </span>
                          <span style={{ color:'var(--accent)' }}>
                            Would update: {previewData.wouldChange}
                          </span>
                          <span style={{ color:'var(--text-tertiary)' }}>
                            Unchanged / skipped: {(previewData.preview?.length || 0) - previewData.wouldChange}
                          </span>
                          <button onClick={() => setPreviewData(null)}
                            style={{ marginLeft:'auto', background:'none', border:'none',
                              color:'var(--text-tertiary)', cursor:'pointer', fontSize:11 }}>
                            ✕ Close
                          </button>
                        </div>
                        {/* Table */}
                        <div style={{ overflowX:'auto', maxHeight:340, overflowY:'auto' }}>
                          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
                            <thead>
                              <tr style={{ background:'var(--bg-secondary)', position:'sticky', top:0 }}>
                                {['Contact','Company','Assigned BDR','Contact Owner','Current Rep','Proposed Rep','Source','Last Engagement','Eng. Owner'].map(h => (
                                  <th key={h} style={{ padding:'6px 10px', textAlign:'left',
                                    color:'var(--text-tertiary)', fontWeight:500,
                                    borderBottom:'1px solid var(--border)' }}>{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {(previewData.preview || []).map((row, i) => (
                                <tr key={row.contactId}
                                  style={{ background: row.skippedDnc ? 'rgba(239,68,68,.05)'
                                    : row.wouldChange ? 'rgba(59,130,246,.05)' : 'transparent',
                                    borderBottom:'1px solid var(--border)' }}>
                                  <td style={{ padding:'5px 10px', color:'var(--text)' }}>{row.name}</td>
                                  <td style={{ padding:'5px 10px', color:'var(--text-secondary)' }}>{row.company}</td>
                                  <td style={{ padding:'5px 10px', color:'var(--text-tertiary)' }}>{row.assignedBdr || '—'}</td>
                                  <td style={{ padding:'5px 10px', color:'var(--text-tertiary)' }}>{row.contactOwner || '—'}</td>
                                  <td style={{ padding:'5px 10px', color:'var(--text-tertiary)' }}>{row.currentRep || '—'}</td>
                                  <td style={{ padding:'5px 10px',
                                    color: row.wouldChange ? 'var(--accent)' : 'var(--text-tertiary)',
                                    fontWeight: row.wouldChange ? 600 : 400 }}>
                                    {row.proposedRep || '—'}
                                    {row.wouldChange && <span style={{ marginLeft:4, fontSize:9, opacity:.6 }}>↑ change</span>}
                                  </td>
                                  <td style={{ padding:'5px 10px', fontSize:10,
                                    color: row.repSource==='engagement' ? 'var(--accent)' : row.repSource==='contact_owner' ? '#D97706' : 'var(--text-tertiary)' }}>
                                    {row.repSource === 'engagement' ? '⚡ engagement'
                                      : row.repSource === 'assigned_bdr' ? '👤 BDR assigned'
                                      : row.repSource === 'contact_owner' ? '🏠 owner'
                                      : '—'}
                                  </td>
                                  <td style={{ padding:'5px 10px', color:'var(--text-tertiary)' }}>
                                    {row.lastEngagementTs || (row.skippedDnc ? 'DNC/skip' : 'none')}
                                  </td>
                                  <td style={{ padding:'5px 10px',
                                    color: row.lastEngagementExcluded ? 'var(--text-tertiary)' : 'var(--text-secondary)' }}>
                                    {row.lastEngagementOwner
                                      ? `${row.lastEngagementOwner}${row.lastEngagementExcluded ? ' (excl.)' : ''}`
                                      : '—'}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                    {previewData?.error && (
                      <div style={{ marginTop:8, fontSize:11, color:'var(--red)' }}>
                        Preview error: {previewData.error}
                      </div>
                    )}
                    </div>
                )}
              </div>
            )}

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

            {/* ── To-Do Section ── */}
            <Panel style={{ marginBottom:12 }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
                <SectionTitle style={{ margin:0 }}>
                  To-Do
                  {todoItems.filter(t=>!t.completed).length > 0 && (
                    <span style={{ marginLeft:8, background:'var(--accent)', color:'#fff', borderRadius:10, padding:'1px 7px', fontSize:10, fontWeight:600 }}>
                      {todoItems.filter(t=>!t.completed).length}
                    </span>
                  )}
                </SectionTitle>
                <div style={{ display:'flex', gap:6, alignItems:'center' }}>
                  <button onClick={() => exportTodos('text')} title="Copy recap to clipboard"
                    style={{ fontSize:11, color:'var(--text-tertiary)', background:'none', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'4px 8px', cursor:'pointer' }}>
                    Copy recap
                  </button>
                  <button onClick={() => exportTodos('csv')} title="Download CSV"
                    style={{ fontSize:11, color:'var(--text-tertiary)', background:'none', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'4px 8px', cursor:'pointer' }}>
                    CSV
                  </button>
                  <button onClick={syncTodos} disabled={todoSyncing}
                    style={{ fontSize:11, color:'var(--accent)', background:'none', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'4px 8px', cursor:'pointer', opacity: todoSyncing ? 0.5 : 1 }}>
                    {todoSyncing ? 'Syncing…' : '↻ Refresh'}
                  </button>
                </div>
              </div>
              {/* High Priority | All tabs */}
              {(() => {
                const hpCount  = todoItems.filter(t => (t.priority === 'HIGH' || t.type === 'high-priority') && !t.completed).length
                const allCount = todoItems.filter(t => !t.completed).length
                return (
                  <div style={{ display:'flex', borderBottom:'1px solid var(--border)', marginBottom:10 }}>
                    {[
                      { key:'high-priority', label:'High Priority', count:hpCount,  color:'#D97706' },
                      { key:'all',           label:'All',           count:allCount, color:'var(--accent)' },
                    ].map(tab => (
                      <button key={tab.key} onClick={() => { setTodoTab(tab.key); setTodoPage(0) }}
                        style={{ padding:'6px 14px', fontSize:12, fontWeight:todoTab===tab.key?600:400,
                          color:todoTab===tab.key?tab.color:'var(--text-tertiary)',
                          background:'none', border:'none',
                          borderBottom:todoTab===tab.key?`2px solid ${tab.color}`:'2px solid transparent',
                          cursor:'pointer', display:'flex', alignItems:'center', gap:5 }}>
                        {tab.label}
                        {tab.count > 0 && (
                          <span style={{ background:todoTab===tab.key?tab.color:'var(--bg-secondary)',
                            color:todoTab===tab.key?'#fff':'var(--text-tertiary)',
                            borderRadius:10, padding:'1px 6px', fontSize:9, fontWeight:700 }}>
                            {tab.count}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )
              })()}
              <div style={{ fontSize:11, color:'var(--text-tertiary)', marginBottom:10 }}>
                {todoTab === 'high-priority'
                  ? '🔴 Gold Account contacts flagged for immediate follow-up. Red outline = 48 hrs overdue.'
                  : '⭐ Gold Account contacts surface first. Meetings show HubSpot-logged only — full calendar sync available once Outlook is connected.'}
              </div>

              {/* Add item input */}
              <div style={{ display:'flex', gap:8, marginBottom:12, flexWrap:'wrap' }}>
                <input
                  type="text"
                  value={todoInput}
                  onChange={e => setTodoInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addTodoItem(todoInput)}
                  placeholder="Add a to-do… (press Enter)"
                  style={{ flex:1, minWidth:160, padding:'7px 10px', background:'var(--bg-secondary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:12, color:'var(--text)', outline:'none' }}
                />
                <input
                  type="datetime-local"
                  value={todoDueDate}
                  onChange={e => setTodoDueDate(e.target.value)}
                  style={{ padding:'7px 8px', background:'var(--bg-secondary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:11, color:'var(--text)', outline:'none' }}
                />
                <button onClick={() => addTodoItem(todoInput)}
                  style={{ padding:'7px 14px', background:'var(--accent)', color:'#fff', border:'none', borderRadius:'var(--radius)', fontSize:12, fontWeight:500, cursor:'pointer' }}>
                  Add
                </button>
              </div>

              {todoLoading && <div style={{ fontSize:12, color:'var(--text-tertiary)' }}>Loading…</div>}

              {!todoLoading && todoItems.length === 0 && (
                <div style={{ fontSize:12, color:'var(--text-tertiary)', textAlign:'center', padding:'12px 0' }}>
                  No tasks today. Add one above or sync from HubSpot.
                </div>
              )}

              {!todoLoading && todoItems.length > 0 && (() => {
                const allActive = todoItems.filter(t => !t.completed)
                const active    = todoTab === 'high-priority'
                  ? allActive.filter(t => t.priority === 'HIGH' || t.type === 'high-priority').sort((a,b) => new Date(a.createdAt||0) - new Date(b.createdAt||0))
                  : allActive
                const done      = todoItems.filter(t => t.completed)
                const pageActive = active.slice(todoPage * TODO_PAGE_SIZE, (todoPage + 1) * TODO_PAGE_SIZE)
                return (
                <div style={{ display:'flex', flexDirection:'column', gap:2 }}>
                  {/* Active items */}
                  {active.length === 0 && <div style={{ fontSize:12, color:'var(--text-tertiary)', padding:'8px 0' }}>All caught up!</div>}
                  {pageActive.map(item => (
                    <div key={item.id}
                      onClick={() => item.hubspotUrl && window.open(item.hubspotUrl, '_blank', 'noopener,noreferrer')}
                      style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 4px', borderRadius:'var(--radius)', background:'transparent', cursor: item.hubspotUrl ? 'pointer' : 'default' }}
                      onMouseEnter={e => { e.currentTarget.style.background='var(--bg-secondary)' }}
                      onMouseLeave={e => { e.currentTarget.style.background='transparent' }}>
                      <input type="checkbox" checked={false} onChange={e => { e.stopPropagation(); toggleTodo(item.id, true) }}
                        style={{ flexShrink:0, cursor:'pointer', accentColor:'var(--accent)', width:15, height:15 }} />
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:13, color:'var(--text)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                          {item.text}
                        </div>
                        {item.subtext && (
                          <div style={{ fontSize:11, color:'var(--text-tertiary)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                            {item.subtext}
                          </div>
                        )}
                        <div style={{ display:'flex', gap:8, marginTop:2, flexWrap:'wrap' }}>
                          {item.createdAt && (
                            <span style={{ fontSize:10, color:'var(--text-tertiary)' }}>
                              Added {new Date(item.createdAt).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })}
                            </span>
                          )}
                          {item.dueDate && (
                            <span style={{ fontSize:10, fontWeight:600, color: new Date(item.dueDate) < new Date() ? 'var(--red)' : 'var(--amber)' }}>
                              Due {new Date(item.dueDate).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })}
                            </span>
                          )}
                        </div>
                      </div>
                      <div style={{ display:'flex', gap:4, flexShrink:0 }}>
                        {['reply','meeting','task','sequence'].includes(item.type) && (
                          <span style={{ fontSize:9, fontWeight:600, textTransform:'uppercase', letterSpacing:'.04em',
                            color: item.type==='reply'?'var(--accent)':item.type==='meeting'?'var(--amber)':'var(--text-tertiary)',
                            background:'var(--bg-secondary)', borderRadius:4, padding:'2px 5px' }}>
                            {item.type}
                          </span>
                        )}
                        {item.hubspotUrl && (
                          <span style={{ fontSize:9, color:'var(--text-tertiary)', padding:'2px 4px' }}>↗</span>
                        )}
                        {!item.autoDetected && (
                          <button onClick={e => { e.stopPropagation(); deleteTodoItem(item.id) }}
                            style={{ background:'none', border:'none', cursor:'pointer', padding:'0 2px', color:'var(--text-tertiary)', fontSize:14, lineHeight:1 }}>
                            ×
                          </button>
                        )}
                      </div>
                    </div>
                  ))}

                  {/* Pager for active items */}
                  {active.length > TODO_PAGE_SIZE && (
                    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'8px 4px 4px', borderTop:'1px solid var(--border)', marginTop:4 }}>
                      <button onClick={() => setTodoPage(p => Math.max(0, p-1))} disabled={todoPage === 0}
                        style={{ fontSize:11, color: todoPage===0?'var(--text-tertiary)':'var(--accent)', background:'none', border:'none', cursor: todoPage===0?'default':'pointer', padding:0 }}>
                        ← Prev
                      </button>
                      <span style={{ fontSize:11, color:'var(--text-tertiary)' }}>
                        {todoPage * TODO_PAGE_SIZE + 1}–{Math.min((todoPage+1) * TODO_PAGE_SIZE, active.length)} of {active.length}
                      </span>
                      <button onClick={() => setTodoPage(p => p+1)} disabled={(todoPage+1)*TODO_PAGE_SIZE >= active.length}
                        style={{ fontSize:11, color:(todoPage+1)*TODO_PAGE_SIZE>=active.length?'var(--text-tertiary)':'var(--accent)', background:'none', border:'none', cursor:(todoPage+1)*TODO_PAGE_SIZE>=active.length?'default':'pointer', padding:0 }}>
                        Next →
                      </button>
                    </div>
                  )}

                  {/* Completed items with strikethrough */}
                  {done.length > 0 && (
                    <>
                      <div style={{ fontSize:10, fontWeight:600, textTransform:'uppercase', letterSpacing:'.05em', color:'var(--text-tertiary)', padding:'8px 4px 4px', marginTop:4, borderTop:'1px solid var(--border)', display:'flex', justifyContent:'space-between' }}>
                        <span>Completed ({done.length})</span>
                        {done.length > 10 && (
                          <span style={{ fontWeight:400, cursor:'pointer', color:'var(--accent)' }}>
                            <span onClick={() => setDonePage(p => Math.max(0,p-1))} style={{ marginRight:8, opacity: donePage===0?0.3:1 }}>‹</span>
                            {donePage+1}/{Math.ceil(done.length/10)}
                            <span onClick={() => setDonePage(p => Math.min(Math.ceil(done.length/10)-1,p+1))} style={{ marginLeft:8, opacity: (donePage+1)>=Math.ceil(done.length/10)?0.3:1 }}>›</span>
                          </span>
                        )}
                      </div>
                      {done.slice(donePage*10,(donePage+1)*10).map(item => (
                        <div key={item.id} style={{ display:'flex', alignItems:'center', gap:8, padding:'5px 4px', opacity:0.55 }}>
                          <input type="checkbox" checked={true} onChange={() => toggleTodo(item.id, false)}
                            style={{ flexShrink:0, cursor:'pointer', accentColor:'var(--accent)', width:15, height:15 }} />
                          <div style={{ flex:1, minWidth:0 }}>
                            <div style={{ fontSize:13, color:'var(--text-tertiary)', textDecoration:'line-through', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                              {item.text}
                            </div>
                          </div>
                          {item.completedAt && (
                            <div style={{ fontSize:10, color:'var(--text-tertiary)', flexShrink:0, marginLeft:4, whiteSpace:'nowrap' }}>
                              ✓ {new Date(item.completedAt).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })}
                            </div>
                          )}
                        </div>
                      ))}
                    </>
                  )}
                </div>
                )
              })()}
            </Panel>

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
                    { key:'high-priority', label:'High Priority', count: todoItems.filter(t=>(t.priority==='HIGH'||t.type==='high-priority')&&!t.completed).length, amber:true },
                    { key:'replies',       label:'Replies',       count: taskData.repliesAwaitingResponse.length },
                    { key:'sequences',     label:'Sequences',     count: taskData.upcomingSequences.length },
                    { key:'tasks',         label:'Due tasks',     count: taskData.dueTasks.length },
                  ].map(({ key, label, count, amber }) => (
                    <button key={key} onClick={() => { setTaskSection(key); setTaskPage(0) }}
                      style={{ flex:1, fontSize:12, fontWeight: taskSection===key ? 500 : 400,
                        color: taskSection===key ? (amber?'#D97706':'var(--text)') : 'var(--text-tertiary)',
                        background: taskSection===key ? 'var(--bg-panel)' : 'transparent',
                        border:'none', borderRadius:'var(--radius)', padding:'5px 8px', cursor:'pointer',
                        display:'flex', alignItems:'center', justifyContent:'center', gap:5 }}>
                      {label}
                      {count > 0 && (
                        <span style={{ fontSize:10, fontWeight:600,
                          background: taskSection===key ? (amber?'rgba(217,119,6,.15)':key==='replies'?'var(--red-light)':'var(--accent-light)') : 'var(--border)',
                          color: taskSection===key ? (amber?'#D97706':key==='replies'?'var(--red)':'var(--accent-text)') : 'var(--text-tertiary)',
                          borderRadius:10, padding:'0 5px', minWidth:16, textAlign:'center' }}>
                          {count}
                        </span>
                      )}
                    </button>
                  ))}
                </div>

                {taskLoading && <div style={{ color:'var(--text-tertiary)', fontSize:13 }}>Loading...</div>}

                {/* Section: High Priority */}
                {!taskLoading && taskSection === 'high-priority' && (() => {
                  const hpItems = todoItems.filter(t => (t.priority === 'HIGH' || t.type === 'high-priority') && !t.completed)
                  return (
                    <div>
                      {hpItems.length === 0 && (
                        <div style={{ color:'var(--text-tertiary)', fontSize:13, textAlign:'center', padding:'20px 0' }}>
                          No high priority items right now.
                        </div>
                      )}
                      {hpItems.map((item, i) => {
                        const overdue = item.createdAt && (Date.now() - new Date(item.createdAt).getTime() > 48*60*60*1000)
                        return (
                          <div key={item.id} style={{ padding:'10px 12px', marginBottom:6, borderRadius:'var(--radius)',
                            background:'rgba(217,119,6,.06)', border:`1px solid ${overdue?'rgba(239,68,68,.5)':'rgba(217,119,6,.3)'}` }}>
                            <div style={{ fontSize:13, fontWeight:500, color:'var(--text)', marginBottom:2 }}>{item.text}</div>
                            {item.subtext && <div style={{ fontSize:11, color:'var(--text-tertiary)' }}>{item.subtext}</div>}
                            <div style={{ display:'flex', gap:8, marginTop:4, alignItems:'center' }}>
                              {overdue && <span style={{ fontSize:10, color:'var(--red)', fontWeight:600 }}>⚠ 48h overdue</span>}
                              {item.createdAt && <span style={{ fontSize:10, color:'var(--text-tertiary)' }}>Added {timeAgo(item.createdAt)}</span>}
                              <button onClick={() => toggleTodo(item.id, true)}
                                style={{ marginLeft:'auto', fontSize:11, background:'none', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'2px 8px', color:'var(--text-tertiary)', cursor:'pointer' }}>
                                Done
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )
                })()}

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
                              <button
                                onClick={() => addTodoItem(`Reply to ${r.contact?.name || 'contact'}`, {
                                  type: 'reply', subtext: r.contact?.company || '', contactId: r.contactId,
                                  hubspotUrl: r.url, sourceId: `reply-${r.contactId}`
                                })}
                                title="Add to To-Do"
                                style={{ flexShrink:0, background:'none', border:'1px solid var(--border)', borderRadius:4, cursor:'pointer', padding:'1px 6px', fontSize:11, color:'var(--accent)', lineHeight:1.4 }}>
                                + To-Do
                              </button>
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
                              <button
                                onClick={() => addTodoItem(`Follow up: ${s.contact?.name || 'contact'}`, {
                                  type: 'sequence', subtext: s.contact?.company || s.sequenceLabel || '',
                                  contactId: s.contactId, hubspotUrl: s.url, sourceId: `seq-${s.contactId}`
                                })}
                                title="Add to To-Do"
                                style={{ marginLeft:'auto', flexShrink:0, background:'none', border:'1px solid var(--border)', borderRadius:4, cursor:'pointer', padding:'1px 6px', fontSize:11, color:'var(--accent)', lineHeight:1.4 }}>
                                + To-Do
                              </button>
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
                              <button
                                onClick={() => addTodoItem(t.subject || 'HubSpot task', {
                                  type: 'task', subtext: t.overdue ? 'Overdue' : `Due ${t.dueDate || ''}`,
                                  hubspotUrl: t.url, sourceId: `task-${t.id || i}`
                                })}
                                title="Add to To-Do"
                                style={{ marginLeft:'auto', flexShrink:0, background:'none', border:'1px solid var(--border)', borderRadius:4, cursor:'pointer', padding:'1px 6px', fontSize:11, color:'var(--accent)', lineHeight:1.4 }}>
                                + To-Do
                              </button>
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
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8, gap:8 }}>
                  <SectionTitle style={{ margin:0, flexShrink:0 }}>Live signals</SectionTitle>
                  <div style={{ display:'flex', alignItems:'center', gap:6, flex:1, justifyContent:'flex-end' }}>
                    <Select value={signalSort} onChange={setSignalSort} options={SIGNAL_SORT_OPTIONS} />
                    {/* Outlook connection indicator */}
                    {!outlookLoading && (
                      outlookData.connected
                        ? <span style={{ fontSize:10, color:'var(--text-tertiary)', display:'flex', alignItems:'center', gap:4, flexShrink:0 }}>
                            <span style={{ width:6, height:6, borderRadius:'50%', background:'#22c55e', display:'inline-block' }}/>
                            Outlook
                          </span>
                        : <button onClick={() => user?.id && (window.location.href = `/api/outlook-auth?userId=${user.id}`)}
                            title="Connect Outlook to get accurate email send timestamps"
                            style={{ flexShrink:0, display:'flex', alignItems:'center', gap:5,
                              background:'var(--bg-secondary)', border:'1px solid var(--border)',
                              borderRadius:'var(--radius)', padding:'5px 10px', fontSize:11,
                              fontWeight:500, color:'var(--accent)', cursor:'pointer' }}>
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 8l10 6 10-6"/></svg>
                            Connect Outlook
                          </button>
                    )}
                    <button onClick={exportSignalsCSV} title="Export to CSV (bot opens excluded)"
                      style={{ flexShrink:0, display:'flex', alignItems:'center', gap:5, background:'var(--bg-secondary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'5px 10px', fontSize:11, fontWeight:500, color:'var(--text-secondary)', cursor:'pointer' }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                      CSV
                    </button>
                  </div>
                </div>
                {/* Search bar */}
                <div style={{ position:'relative', marginBottom:10 }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2" strokeLinecap="round" style={{ position:'absolute', left:9, top:'50%', transform:'translateY(-50%)', pointerEvents:'none' }}>
                    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                  </svg>
                  <input
                    type="text"
                    value={signalSearch}
                    onChange={e => { setSignalSearch(e.target.value); setSignalPage(0) }}
                    placeholder="Search by email name, sequence, contact or company…"
                    style={{ width:'100%', padding:'7px 28px 7px 28px', background:'var(--bg-secondary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:12, color:'var(--text)', outline:'none', boxSizing:'border-box' }}
                  />
                  {signalSearch && (
                    <button onClick={() => { setSignalSearch(''); setSignalPage(0) }}
                      style={{ position:'absolute', right:8, top:'50%', transform:'translateY(-50%)', background:'none', border:'none', cursor:'pointer', color:'var(--text-tertiary)', fontSize:14, lineHeight:1, padding:0 }}>×</button>
                  )}
                </div>
                {signalSearch && (
                  <div style={{ fontSize:11, color:'var(--text-tertiary)', marginBottom:8 }}>
                    {sortedSignals.length} result{sortedSignals.length !== 1 ? 's' : ''} for "{signalSearch}"
                    {sortedSignals.length > 0 && (
                      <button onClick={exportSignalsCSV} style={{ marginLeft:8, color:'var(--accent)', background:'none', border:'none', cursor:'pointer', padding:0, fontSize:11 }}>
                        Export these {sortedSignals.length} →
                      </button>
                    )}
                  </div>
                )}
                {loading && <div style={{ color:'var(--text-tertiary)', fontSize:13 }}>Loading...</div>}
                {!loading && signals.length === 0 && <div style={{ color:'var(--text-tertiary)', fontSize:13 }}>No signals in this time range.</div>}
                {sortedSignals.slice(signalPage * PAGE_SIZE, (signalPage + 1) * PAGE_SIZE).map((s, i) => {
                  const isReply   = s.score >= 100
                  const isClick   = s.score >= 60 && s.score < 100
                  const accentCol = isReply ? 'var(--accent)' : isClick ? 'var(--amber)' : 'var(--blue)'
                  const accentBg  = isReply ? 'var(--accent-light)' : isClick ? 'var(--amber-light)' : 'var(--blue-light)'
                  const actionLabel = isReply ? 'Replied' : isClick ? 'Clicked' : 'Opened'

                  const chain     = s.eventChain || []
                  const chainTs   = (type) => chain.find(e => e.type === type)?.timestamp || null
                  const _outlookSentAt = (() => {
                    if (!outlookData.connected) return null
                    const email = s.contact?.email?.toLowerCase()
                    if (!email) return null
                    const sent = outlookData.emails[email]
                    if (!sent?.length) return null
                    // Use PRIMARY event timestamp as anchor — find the email sent before THIS event
                    const primaryTs =
                      s.eventType === 'REPLIED' ? (s.repliedAt || chainTs('REPLIED'))
                      : s.eventType === 'CLICK'  ? (s.clickedAt || chainTs('CLICKED'))
                      : (s.openedAt  || chainTs('OPENED') || s.timestamp)
                    if (!primaryTs) return sent[0]?.sentAt || null
                    const anchor = new Date(primaryTs).getTime()
                    return sent.find(e => new Date(e.sentAt).getTime() < anchor)?.sentAt || null
                  })()
                  const sentAt    = s.sentAt || chainTs('SENT') || _outlookSentAt || null
                  const openedAt  = s.openedAt  || chainTs('OPENED')  || (s.eventType === 'OPEN'  ? s.timestamp : null)
                  const clickedAt = s.clickedAt || chainTs('CLICKED') || (s.eventType === 'CLICK' ? s.timestamp : null)
                  const repliedAt = s.repliedAt || chainTs('REPLIED') || null
                  const emailName = cleanSubject(s.subject, s.campaignId)
                  const isLast    = i >= Math.min(sortedSignals.slice(signalPage * PAGE_SIZE, (signalPage+1)*PAGE_SIZE).length, PAGE_SIZE) - 1

                  // Timestamp row helper: date + time lapse from send
                  const TsRow = ({ label, ts, base }) => {
                    if (!ts) return null
                    const lapse = base && ts !== base ? timeToOpen(base, ts) : null
                    return (
                      <div style={{ display:'flex', gap:6, alignItems:'center' }}>
                        <span style={{ fontSize:11, fontWeight:600, color:'var(--text)', minWidth:52 }}>{label}</span>
                        <span style={{ fontSize:11, color:'var(--text-secondary)' }}>{exactTs(ts)}</span>
                        {lapse && (
                          <span style={{ fontSize:10, padding:'1px 6px', borderRadius:10,
                            background:accentBg, color:accentCol, fontWeight:500, whiteSpace:'nowrap' }}>
                            {lapse} after send
                          </span>
                        )}
                      </div>
                    )
                  }

                  const isHP   = isHighPriority(s)
                  const autoHP = autoIsHP(s)

                  return (
                    <div key={i} style={{ padding:'11px 10px', marginBottom: isHP ? 4 : 0,
                      borderRadius: isHP ? 'var(--radius)' : 0,
                      background: isHP ? 'rgba(217,119,6,.07)' : 'transparent',
                      border: isHP ? '1px solid rgba(217,119,6,.35)' : (!isLast ? '1px solid var(--border)' : 'none') }}>
                      <div style={{ display:'flex', gap:10 }}>

                        {/* Icon */}
                        <div style={{ width:28, height:28, borderRadius:'var(--radius)', background:accentBg,
                          display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, marginTop:2 }}>
                          {isReply
                            ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={accentCol} strokeWidth="2.5" strokeLinecap="round"><path d="M9 17H5a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v5"/><polyline points="17 11 12 16 7 11"/></svg>
                            : isClick
                            ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={accentCol} strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                            : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={accentCol} strokeWidth="2.5" strokeLinecap="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                          }
                        </div>

                        <div style={{ flex:1, minWidth:0 }}>

                          {/* Action label — color coded */}
                          <div style={{ fontSize:11, fontWeight:700, color:accentCol,
                            textTransform:'uppercase', letterSpacing:'.05em', marginBottom:3,
                            display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                            <span>
                              {actionLabel}
                              <span style={{ fontSize:10, fontWeight:500, marginLeft:6, textTransform:'none',
                                letterSpacing:0, color: s.emailSource === 'sales' ? 'var(--blue)' : 'var(--text-tertiary)' }}>
                                {s.emailSource === 'sales' ? '1:1' : 'Sequence'}
                              </span>
                            </span>
                            {s.contactId && (
                              <button onClick={e => { e.stopPropagation(); toggleHpOverride(s.contactId, isHP) }}
                                title={isHP ? 'High Priority — click to remove' : 'Mark as High Priority'}
                                style={{ background:'none', border:'none', cursor:'pointer', padding:'0 2px',
                                  fontSize:13, lineHeight:1, color: isHP ? '#D97706' : 'var(--text-tertiary)',
                                  display:'flex', alignItems:'center', gap:4 }}>
                                {isHP ? '★' : '☆'}
                                <span style={{ fontSize:9, fontWeight:600, letterSpacing:'.04em',
                                  color: isHP ? '#D97706' : 'var(--text-tertiary)' }}>
                                  GOLD TARGET{isHP ? ' · HIGH PRIORITY' : ''}
                                </span>
                              </button>
                            )}
                          </div>

                          {/* Name */}
                          <div style={{ display:'flex', alignItems:'center', gap:5, marginBottom:2 }}>
                            <span onClick={s.contactId ? () => openHubSpotContact(s.contactId) : undefined}
                              style={{ fontSize:13, fontWeight:700, color: s.contactId ? 'var(--accent)' : '#fff',
                                cursor: s.contactId ? 'pointer' : 'default' }}>
                              {s.contact?.name || s.recipientEmail || 'Unknown'}
                            </span>
                            {s.contactId && (
                              <button onClick={e => openHubSpotContact(s.contactId, e)} title="Open in HubSpot"
                                style={{ background:'none', border:'none', cursor:'pointer', padding:0,
                                  color:'var(--text-tertiary)', lineHeight:1 }}>
                                <HsIcon />
                              </button>
                            )}
                          </div>

                          {/* Title · Org */}
                          {(s.contact?.title || s.contact?.company) && (
                            <div style={{ fontSize:11, fontWeight:500, color:'rgba(255,255,255,.75)', marginBottom:4 }}>
                              {[s.contact?.title, s.contact?.company].filter(Boolean).join(' · ')}
                            </div>
                          )}

                          {/* Email/Sequence name */}
                          {emailName && (
                            <div style={{ fontSize:11, color:'var(--text-tertiary)', marginBottom:5,
                              overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', maxWidth:320 }}>
                              {emailName}
                            </div>
                          )}

                          {/* Timestamps — only show the primary event's timestamp.
                               HubSpot tracks opened/replied across ALL emails independently,
                               so mixing them creates impossible orderings (replied before opened). */}
                          <div style={{ display:'flex', flexDirection:'column', gap:2 }}>
                            <TsRow label="Sent"    ts={sentAt}   base={null} />
                            {isReply && <TsRow label="Replied"  ts={repliedAt} base={sentAt} />}
                            {isClick && <TsRow label="Clicked"  ts={clickedAt} base={sentAt} />}
                            {!isReply && !isClick && <TsRow label="Opened"  ts={openedAt}  base={sentAt} />}
                          </div>

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

              {/* Gap batch scan */}
              <div style={{ marginBottom:12, display:'flex', alignItems:'center', gap:10 }}>
                <button onClick={runGapBatchScan} disabled={gapBatchRunning}
                  style={{ fontSize:11, padding:'5px 12px', background: gapBatchRunning ? 'var(--bg)' : 'var(--accent)',
                    color: gapBatchRunning ? 'var(--text-tertiary)' : '#fff', border:'none',
                    borderRadius:'var(--radius)', cursor: gapBatchRunning ? 'not-allowed' : 'pointer', fontWeight:600 }}>
                  {gapBatchRunning ? '⟳ Scanning...' : '⬡ Scan All for Persona Gaps'}
                </button>
                {gapBatchProgress && (
                  <span style={{ fontSize:11, color:'var(--text-tertiary)' }}>{gapBatchProgress}</span>
                )}
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
                            {/* Gap analysis button */}
                            {gapSearching[a.companyId] ? (
                              <span style={{ fontSize:10, color:'var(--accent)', opacity:.7 }}>
                                {gapSearching[a.companyId] === 'loading' ? '⟳ loading...' : '⟳ searching...'}
                              </span>
                            ) : (
                              <button onClick={() => fetchGapsForAccount(a.companyId, a.name, a.domain)}
                                title="Find missing persona contacts"
                                style={{ fontSize:10, padding:'2px 6px', background:'none',
                                  border:'1px solid var(--border)', borderRadius:4,
                                  color:'var(--text-tertiary)', cursor:'pointer' }}>
                                {gapResults[a.companyId] ? `${gapResults[a.companyId].missingPersonas?.length || 0} gaps` : '⬡ gaps'}
                              </button>
                            )}
                          </div>
                          {a.territory && <div style={{ fontSize:11, color:'var(--text-tertiary)' }}>{a.territory}</div>}
                          {/* Gap results inline */}
                          {gapResults[a.companyId] && expandedGaps[a.companyId] && (() => {
                            const gap = gapResults[a.companyId]
                            const pct = gap.coveragePercent || 0
                            return (
                              <div style={{ marginTop:8, padding:'8px 10px', background:'var(--bg)',
                                border:'1px solid var(--border)', borderRadius:6, fontSize:11 }}>
                                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:6 }}>
                                  <span style={{ fontWeight:600, color: pct >= 75 ? '#4ade80' : pct >= 50 ? '#fbbf24' : '#f87171' }}>
                                    {pct}% covered ({gap.coveredPersonas?.length || 0}/22 personas)
                                  </span>
                                  <button onClick={() => setExpandedGaps(e => ({ ...e, [a.companyId]: false }))}
                                    style={{ fontSize:10, background:'none', border:'none', cursor:'pointer', color:'var(--text-tertiary)' }}>✕</button>
                                </div>
                                {gap.missingPersonas?.length > 0 && (
                                  <div style={{ marginBottom:6 }}>
                                    <div style={{ color:'var(--text-tertiary)', marginBottom:4, fontWeight:500 }}>Missing personas:</div>
                                    <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
                                      {gap.missingPersonas.map(p => {
                                        const found = (gap.searchResults || []).find(r => r.persona === p)
                                        return (
                                          <div key={p} style={{ padding:'2px 8px', borderRadius:10, fontSize:10,
                                            background: found?.name ? '#dcfce7' : '#fee2e2',
                                            color:      found?.name ? '#166534' : '#991b1b',
                                            border:     `1px solid ${found?.name ? '#86efac' : '#fca5a5'}` }}>
                                            {p}
                                            {found?.name && ` → ${found.name}`}
                                          </div>
                                        )
                                      })}
                                    </div>
                                  </div>
                                )}
                                {gap.searchResults?.filter(r => r.name).length > 0 && (
                                  <div style={{ marginTop:8, borderTop:'1px solid var(--border)', paddingTop:6 }}>
                                    <div style={{ color:'var(--text-tertiary)', marginBottom:4, fontWeight:500 }}>Found candidates:</div>
                                    {gap.searchResults.filter(r => r.name).map((r, ri) => (
                                      <div key={ri} style={{ marginBottom:4, display:'flex', alignItems:'center', gap:6 }}>
                                        <span style={{ fontSize:10, padding:'1px 6px', borderRadius:8,
                                          background: r.confidence === 'high' ? '#dcfce7' : r.confidence === 'medium' ? '#fef3c7' : '#f3f4f6',
                                          color:      r.confidence === 'high' ? '#166534' : r.confidence === 'medium' ? '#92400e' : '#6b7280' }}>
                                          {r.confidence}
                                        </span>
                                        <span style={{ fontWeight:500, color:'var(--text)' }}>{r.name}</span>
                                        <span style={{ color:'var(--text-tertiary)' }}>{r.title}</span>
                                        {r.linkedinUrl && (
                                          <a href={r.linkedinUrl} target="_blank" rel="noopener noreferrer"
                                            style={{ color:'var(--accent)', fontSize:10 }}>LinkedIn ↗</a>
                                        )}
                                        <span style={{ color:'var(--text-tertiary)', fontSize:10 }}>({r.persona})</span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {!gap.searchDone && gap.missingPersonas?.length > 0 && (
                                  <div style={{ marginTop:6, color:'var(--accent)', fontSize:10 }}>
                                    ⟳ Searching for missing contacts... Click "⬡ gaps" to trigger AI search
                                  </div>
                                )}
                              </div>
                            )
                          })()}
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

                  {/* Meeting details — expanded list below outbound metrics */}
                  {activityData.meetingDetails?.length > 0 && (() => {
                    const MEET_PAGE = 5
                    const totalPages = Math.ceil(activityData.meetingDetails.length / MEET_PAGE)
                    const pageMeets = activityData.meetingDetails.slice(activityMeetPage * MEET_PAGE, (activityMeetPage + 1) * MEET_PAGE)
                    return (
                    <div style={{ marginTop:12, padding:'10px 12px', background:'var(--bg-secondary)', borderRadius:'var(--radius)', border:'1px solid var(--border)' }}>
                      <div style={{ fontSize:11, fontWeight:600, letterSpacing:'.06em', textTransform:'uppercase', color:'var(--text-tertiary)', marginBottom:8, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                        <span>📅 Meetings this period ({activityData.meetingDetails.length})</span>
                        {totalPages > 1 && (
                          <span style={{ fontWeight:400, fontSize:11 }}>
                            <span onClick={() => setActivityMeetPage(p => Math.max(0,p-1))} style={{ cursor:'pointer', marginRight:6, opacity: activityMeetPage===0?0.3:1 }}>‹</span>
                            {activityMeetPage+1}/{totalPages}
                            <span onClick={() => setActivityMeetPage(p => Math.min(totalPages-1,p+1))} style={{ cursor:'pointer', marginLeft:6, opacity: activityMeetPage+1>=totalPages?0.3:1 }}>›</span>
                          </span>
                        )}
                      </div>
                      {pageMeets.map((m, i) => {
                        const dt = m.startTime ? new Date(m.startTime) : null
                        const dateStr = dt ? dt.toLocaleDateString('en-US', { timeZone:'America/New_York', weekday:'short', month:'short', day:'numeric' }) + ' at ' + dt.toLocaleTimeString('en-US', { timeZone:'America/New_York', hour:'numeric', minute:'2-digit' }) : ''
                        const attendees = (m.contacts||[]).map(c => c.company ? `${c.name} (${c.company})` : c.name).filter(Boolean).join(', ')
                        return (
                          <div key={m.id} style={{ paddingBottom: i < pageMeets.length-1 ? 8 : 0, marginBottom: i < pageMeets.length-1 ? 8 : 0, borderBottom: i < pageMeets.length-1 ? '1px solid var(--border)' : 'none' }}>
                            <div style={{ fontSize:13, fontWeight:500, color:'var(--text)', marginBottom:2 }}>{m.title}</div>
                            <div style={{ fontSize:11, color:'var(--text-tertiary)' }}>
                              {dateStr}
                              {attendees && <span style={{ color:'var(--text-secondary)' }}> · {attendees}</span>}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                    )
                  })()}

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
              title="Cipher Market Mapper"
              style={{ width:'100%', height:'100%', border:'none', display:'block' }}
              allow="fullscreen"
            />
          </div>
        )}

        {/* ── Reports tab ── */}
        {activeTab === 'reports' && (
          <ReportsTab
            safeFetch={safeFetch}
            owners={owners}
            currentUserName={currentUserName}
            section={reportSection}     setSection={setReportSection}
            period={reportPeriod}       setPeriod={setReportPeriod}
            rep={reportRep}             setRep={setReportRep}
            owner={reportOwner}         setOwner={setReportOwner}
            customFrom={reportCustomFrom} setCustomFrom={setReportCustomFrom}
            customTo={reportCustomTo}   setCustomTo={setReportCustomTo}
          />
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

        {/* ── Gold Overview tab ── */}
        {activeTab === 'gold-overview' && (
          <GoldOverviewTab
            accounts={goldAccounts}
            meta={goldMeta}
            loading={goldLoading}
            onRefresh={fetchGold}
            filterBdr={filterBdr}
            setFilterBdr={setFilterBdr}
            BDR_OPTIONS={BDR_OPTIONS}
            goldTabTier={goldTabTier}
            setGoldTabTier={setGoldTabTier}
          />
        )}

        {/* ── Gold Command Center tab ── */}
        {activeTab === 'gold-command' && (
          <GoldCommandTab
            accounts={goldAccounts}
            loading={goldLoading}
            onRefresh={fetchGold}
            safeFetch={safeFetch}
            filterBdr={filterBdr}
            setFilterBdr={setFilterBdr}
            BDR_OPTIONS={BDR_OPTIONS}
            goldTabTier={goldTabTier}
            setGoldTabTier={setGoldTabTier}
          />
        )}

        {/* ── Contact Intelligence tab ── */}
        {activeTab === 'contact-intel' && (
          <ContactIntelPanel user={user} safeFetch={safeFetch} />
        )}

        {/* ── CPIQ tab ── */}
        {activeTab === 'cpiq' && (
          <div style={{ height:'calc(100vh - 52px)', marginTop:'-1.5rem', marginLeft:'-1.5rem', marginRight:'-1.5rem' }}>
            <iframe
              src="https://cpiq-tool.netlify.app/"
              title="CPIQ Tool"
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
        {activeTab === 'add-app' && (
          <AddAppTab
            getToken={getToken}
            safeFetch={safeFetch}
            isAdmin={isAdmin}
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

function ReportsTab({ safeFetch, owners, currentUserName,
  section, setSection, period, setPeriod, rep, setRep,
  owner, setOwner, customFrom, setCustomFrom, customTo, setCustomTo }) {

  const [data, setData]           = useState(null)
  const [loading, setLoading]     = useState(false)
  const [activityPage, setActivityPage] = useState(0)
  const [dealsPage, setDealsPage]       = useState(0)
  const PAGE_SIZE = 25

  // Result cache: key → data. Survives tab switches, cleared on explicit refresh.
  const reportCache = useRef({})

  // Manual activity log
  const [logInput, setLogInput]       = useState('')
  const [logType, setLogType]         = useState('other')
  const [logCompany, setLogCompany]   = useState('')
  const [logSaving, setLogSaving]     = useState(false)

  const LOG_TYPES = ['call','email','linkedin','meeting','note','other']

  const fetchReport = useCallback(async (forceRefresh = false) => {
    const { bdrNames, ownerIds } = expandFilter(rep)
    const params = new URLSearchParams({ section, period })
    if (bdrNames.length)  params.set('rep', bdrNames.join(','))
    if (ownerIds.length)  params.set('owner_id', ownerIds.join(','))
    if (owner)            params.set('owner', owner)
    if (period === 'custom' && customFrom) params.set('customFrom', customFrom)
    if (period === 'custom' && customTo)   params.set('customTo',   customTo)
    const cacheKey = params.toString()

    if (!forceRefresh && reportCache.current[cacheKey]) {
      setData(reportCache.current[cacheKey])
      return
    }

    setLoading(true)
    setData(null)
    setActivityPage(0)
    setDealsPage(0)
    try {
      const result = await safeFetch(`/api/hubspot/reports?${params}`)
      reportCache.current[cacheKey] = result
      setData(result)
    } catch (e) {
      console.error('[reports]', e)
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [section, period, rep, owner, customFrom, customTo])

  useEffect(() => {
    // Debounce: wait 400ms after last filter change before fetching
    // Prevents stacking requests when user rapidly changes filters
    const t = setTimeout(() => fetchReport(), 400)
    return () => clearTimeout(t)
  }, [fetchReport])

  const addLogEntry = useCallback(async () => {
    if (!logInput.trim()) return
    setLogSaving(true)
    try {
      await safeFetch('/api/hubspot/activity-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: logInput.trim(), type: logType, company: logCompany.trim() }),
      })
      setLogInput('')
      setLogCompany('')
      reportCache.current = {} // bust cache so activity log refreshes
      fetchReport(true)
    } catch (e) { console.error('[activity-log]', e) }
    finally { setLogSaving(false) }
  }, [logInput, logType, logCompany, fetchReport])

  const removeLogEntry = useCallback(async (id) => {
    try {
      await safeFetch(`/api/hubspot/activity-log/${id}`, { method: 'DELETE' })
      reportCache.current = {}
      fetchReport(true)
    } catch (e) { console.error('[activity-log delete]', e) }
  }, [fetchReport])

  // When switching sections
  const handleSetSection = useCallback((s) => {
    setSection(s)
    if (s === 'deals') setPeriod('year')
    else setPeriod('week')
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

  const SECTIONS = [
    { key:'email_activity',  label:'Email Activity' },
    { key:'marketing',       label:'Marketing' },
    { key:'sequences',       label:'Sequences' },
    { key:'deals',           label:'Deals' },
    { key:'team_activity',   label:'Team Activity' },
    { key:'gold_activity',   label:'Gold Activity' },
    { key:'gold_work_log',   label:'Gold Work Log' },
    { key:'weekly_recap',    label:'Weekly Recap' },
  ]

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
          {period === 'custom' && (
            <div style={{ display:'flex', alignItems:'center', gap:6 }}>
              <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
                style={{ fontSize:12, padding:'5px 8px', background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text)', outline:'none' }} />
              <span style={{ fontSize:12, color:'var(--text-tertiary)' }}>to</span>
              <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
                style={{ fontSize:12, padding:'5px 8px', background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text)', outline:'none' }} />
            </div>
          )}
          {section !== 'deals' && (
            <Select value={rep} onChange={setRep} options={REPORT_REP_OPTIONS} />
          )}
          {section === 'deals' && (
            <Select value={owner} onChange={setOwner} options={ownerOptions} />
          )}
          <button onClick={() => { reportCache.current = {}; fetchReport(true) }}
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
        const C = data.compliance || {}
        const sequences = data.sequences || []
        const topByReply = [...sequences].filter(s => s.enrolled >= 3).sort((a,b) => b.replyRate - a.replyRate).slice(0, 10)
        const topByEnroll = [...sequences].sort((a,b) => b.enrolled - a.enrolled).slice(0, 10)

        // Mini bar component
        const Bar = ({ value, max, color = 'var(--accent)' }) => (
          <div style={{ display:'flex', alignItems:'center', gap:6 }}>
            <div style={{ flex:1, height:6, background:'var(--bg-secondary)', borderRadius:3, overflow:'hidden' }}>
              <div style={{ width:`${max > 0 ? Math.min((value/max)*100,100) : 0}%`, height:'100%', background:color, borderRadius:3, transition:'width .3s' }} />
            </div>
          </div>
        )

        return (
          <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
            {/* KPI strip */}
            <div style={{ display:'grid', gridTemplateColumns:'repeat(8,1fr)', gap:10 }}>
              <KpiCard label="Enrolled"    value={fmt(T.enrolled)}   sub="Contacts in sequences"  href={L.sequences} />
              <KpiCard label="Opens"       value={fmt(T.opened)}     sub="Unique opens"            href={L.sequences} />
              <KpiCard label="Open Rate"   value={fmtPct(T.openRate)} sub="Of enrolled"            href={L.sequences} accent />
              <KpiCard label="Clicks"      value={fmt(T.clicked)}    sub="Link clicks"             href={L.sequences} />
              <KpiCard label="Meetings"    value={fmt(T.meetings||0)} sub="Logged this period"     accent />
              <KpiCard label="Click Rate"  value={fmtPct(T.clickRate)} sub="Of enrolled"           href={L.sequences} accent />
              <KpiCard label="Replies"     value={fmt(T.replied)}    sub="Responses received"      href={L.sequences} />
              <KpiCard label="Reply Rate"  value={fmtPct(T.replyRate)} sub="Of enrolled"           href={L.sequences} accent />
            </div>

            {/* Compliance row */}
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10 }}>
              <div style={{ background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'12px 14px', display:'flex', alignItems:'center', gap:10 }}>
                <div style={{ width:8, height:8, borderRadius:'50%', background: C.optedOut > 0 ? 'var(--amber)' : 'var(--green)', flexShrink:0 }} />
                <div>
                  <div style={{ fontSize:11, color:'var(--text-tertiary)', marginBottom:2 }}>Opted out contacts</div>
                  <div style={{ fontSize:16, fontWeight:600, color:'var(--text)' }}>{fmt(C.optedOut || 0)}</div>
                  <div style={{ fontSize:10, color:'var(--text-tertiary)' }}>{C.optedOut === 0 ? '✓ None enrolled in sequences' : 'Suppressed from sequences'}</div>
                </div>
              </div>
              <div style={{ background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'12px 14px', display:'flex', alignItems:'center', gap:10 }}>
                <div style={{ width:8, height:8, borderRadius:'50%', background: C.bounced > 0 ? 'var(--amber)' : 'var(--green)', flexShrink:0 }} />
                <div>
                  <div style={{ fontSize:11, color:'var(--text-tertiary)', marginBottom:2 }}>Email bounces</div>
                  <div style={{ fontSize:16, fontWeight:600, color:'var(--text)' }}>{fmt(C.bounced || 0)}</div>
                  <div style={{ fontSize:10, color:'var(--text-tertiary)' }}>Hard bounce suppression active</div>
                </div>
              </div>
              <div style={{ background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'12px 14px', display:'flex', alignItems:'center', gap:10 }}>
                <div style={{ width:8, height:8, borderRadius:'50%', background: C.badAddress > 0 ? 'var(--red)' : 'var(--green)', flexShrink:0 }} />
                <div>
                  <div style={{ fontSize:11, color:'var(--text-tertiary)', marginBottom:2 }}>Invalid addresses</div>
                  <div style={{ fontSize:16, fontWeight:600, color:'var(--text)' }}>{fmt(C.badAddress || 0)}</div>
                  <div style={{ fontSize:10, color:'var(--text-tertiary)' }}>{C.badAddress > 0 ? 'Flag for Data Quality cleanup' : '✓ No invalid addresses'}</div>
                </div>
              </div>
            </div>

            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
              {/* Top sequences by reply rate */}
              <Panel>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
                  <SectionTitle style={{ margin:0 }}>Top sequences by reply rate</SectionTitle>
                  <span style={{ fontSize:10, color:'var(--text-tertiary)' }}>min. 3 enrolled</span>
                </div>
                {topByReply.length === 0
                  ? <div style={{ fontSize:12, color:'var(--text-tertiary)' }}>No sequence data for this period.</div>
                  : topByReply.map((s,i) => (
                    <div key={i} style={{ marginBottom:10, cursor:'pointer' }} onClick={() => openHS(s.sequenceUrl || L.sequences)}>
                      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3 }}>
                        <span style={{ fontSize:12, color:'var(--text)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', maxWidth:'75%' }}>{s.sequenceName}</span>
                        <span style={{ fontSize:12, fontWeight:600, color:'var(--accent)', flexShrink:0 }}>{fmtPct(s.replyRate)}</span>
                      </div>
                      <Bar value={s.replyRate} max={topByReply[0]?.replyRate || 1} color="var(--accent)" />
                      <div style={{ fontSize:10, color:'var(--text-tertiary)', marginTop:2 }}>{fmt(s.enrolled)} enrolled · {fmt(s.replied)} replies</div>
                    </div>
                  ))
                }
              </Panel>

              {/* Top sequences by enrollment */}
              <Panel>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
                  <SectionTitle style={{ margin:0 }}>Top sequences by enrollment</SectionTitle>
                  <button onClick={() => openHS(L.sequences)} style={{ fontSize:11, color:'var(--accent)', background:'none', border:'none', cursor:'pointer', padding:0 }}>View all ↗</button>
                </div>
                {topByEnroll.length === 0
                  ? <div style={{ fontSize:12, color:'var(--text-tertiary)' }}>No sequence data for this period.</div>
                  : topByEnroll.map((s,i) => (
                    <div key={i} style={{ marginBottom:10, cursor:'pointer' }} onClick={() => openHS(s.sequenceUrl || L.sequences)}>
                      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3 }}>
                        <span style={{ fontSize:12, color:'var(--text)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', maxWidth:'75%' }}>{s.sequenceName}</span>
                        <span style={{ fontSize:12, fontWeight:500, color:'var(--text-secondary)', flexShrink:0 }}>{fmt(s.enrolled)}</span>
                      </div>
                      <Bar value={s.enrolled} max={topByEnroll[0]?.enrolled || 1} color="var(--text-tertiary)" />
                      <div style={{ fontSize:10, color:'var(--text-tertiary)', marginTop:2 }}>
                        {fmtPct(s.openRate)} open · {fmtPct(s.replyRate)} reply · {fmtPct(s.clickRate)} click
                      </div>
                    </div>
                  ))
                }
              </Panel>
            </div>

            {/* byRep breakdown */}
            {(data.byRep||[]).length > 1 && (
              <Panel>
                <SectionTitle>By rep</SectionTitle>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                  <THead cols={['Rep','Enrolled','Opens','Open %','Replies','Reply %','Clicks','Click %']} />
                  <tbody>
                    {(data.byRep||[]).map((r,i) => (
                      <tr key={i} style={{ borderBottom:'1px solid var(--border)' }}>
                        <td style={{ padding:'8px 10px 8px 0', fontWeight:500 }}>{r.rep}</td>
                        <td style={{ padding:'8px 10px 8px 0' }}>{fmt(r.enrolled)}</td>
                        <td style={{ padding:'8px 10px 8px 0' }}>{fmt(r.opened)}</td>
                        <td style={{ padding:'8px 10px 8px 0', color:'var(--accent)' }}>{fmtPct(r.openRate)}</td>
                        <td style={{ padding:'8px 10px 8px 0' }}>{fmt(r.replied)}</td>
                        <td style={{ padding:'8px 10px 8px 0', color:'var(--accent)' }}>{fmtPct(r.replyRate)}</td>
                        <td style={{ padding:'8px 10px 8px 0' }}>{fmt(r.clicked)}</td>
                        <td style={{ padding:'8px 0', color:'var(--accent)' }}>{fmtPct(r.clickRate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            )}

            {/* Full sequence table */}
            <Panel>
              <SectionTitle>All sequences ({sequences.length})</SectionTitle>
              <div style={{ fontSize:11, color:'var(--text-tertiary)', marginBottom:10 }}>
                Ranked by enrollment. Click any row to open in HubSpot.
              </div>
              {sequences.length === 0
                ? <div style={{ fontSize:13, color:'var(--text-tertiary)' }}>No sequence data in this period.</div>
                : <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                    <THead cols={['Sequence','Enrolled','Opens','Open %','Replies','Reply %','Clicks','Click %']} />
                    <tbody>
                      {sequences.map((s,i) => (
                        <tr key={i} onClick={() => openHS(s.sequenceUrl || L.sequences)}
                          style={{ borderBottom:'1px solid var(--border)', cursor:'pointer' }}
                          onMouseEnter={e => e.currentTarget.style.background='var(--bg-secondary)'}
                          onMouseLeave={e => e.currentTarget.style.background=''}>
                          <td style={{ padding:'7px 10px 7px 0', color:'var(--accent)', maxWidth:220, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                            {s.sequenceName || s.sequenceId}
                          </td>
                          <td style={{ padding:'7px 10px 7px 0' }}>{fmt(s.enrolled)}</td>
                          <td style={{ padding:'7px 10px 7px 0' }}>{fmt(s.opened)}</td>
                          <td style={{ padding:'7px 10px 7px 0', color:'var(--accent)' }}>{fmtPct(s.openRate)}</td>
                          <td style={{ padding:'7px 10px 7px 0' }}>{fmt(s.replied)}</td>
                          <td style={{ padding:'7px 10px 7px 0', color:'var(--accent)' }}>{fmtPct(s.replyRate)}</td>
                          <td style={{ padding:'7px 10px 7px 0' }}>{fmt(s.clicked)}</td>
                          <td style={{ padding:'7px 0', color:'var(--accent)' }}>{fmtPct(s.clickRate)}</td>
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
      {!loading && data && section === 'sequences' && (data.meetingDetails||[]).length > 0 && (
        <Panel>
          <SectionTitle>Meetings This Period ({(data.meetingDetails||[]).length})</SectionTitle>
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {(data.meetingDetails||[]).map((m,i) => (
              <div key={i} style={{ display:'flex', gap:10, alignItems:'flex-start', paddingBottom:6, borderBottom: i < data.meetingDetails.length-1 ? '1px solid var(--border)' : 'none' }}>
                <span style={{ fontSize:14, flexShrink:0 }}>📅</span>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:12, fontWeight:500, color:'var(--text)' }}>{m.title || 'Meeting'}</div>
                  {m.contactName && <div style={{ fontSize:11, color:'var(--text-secondary)' }}>{m.contactName}{m.company ? ` · ${m.company}` : ''}</div>}
                </div>
                <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', flexShrink:0 }}>
                  {m.date && <div style={{ fontSize:11, color:'var(--text-tertiary)' }}>{new Date(m.date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</div>}
                  {m.ownerName && <div style={{ fontSize:10, color:'var(--accent)', marginTop:1 }}>{m.ownerName}</div>}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}

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

      {/* ── Team Activity ── */}
      {!loading && data && section === 'team_activity' && (() => {
        const t = data.totals || {}
        const byRep = data.byRep || []
        return (
          <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
            {/* Section header */}
            <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between' }}>
              <div>
                <div style={{ fontSize:16, fontWeight:600, color:'var(--text)' }}>Team Activity</div>
                <div style={{ fontSize:12, color:'var(--text-tertiary)', marginTop:2 }}>Live view of all outreach activity. Log manual entries below — they appear across all reports.</div>
              </div>
            </div>
            {/* KPI strip — two rows: Email stats + Sequence stats */}
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              {/* Row 1: Email outreach */}
              <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr 1fr 1fr 1fr', gap:10 }}>
                <div style={{ padding:'14px 16px', background:'var(--surface)', border:'2px solid var(--accent)', borderRadius:'var(--radius)', display:'flex', flexDirection:'column', gap:2 }}>
                  <div style={{ fontSize:11, fontWeight:600, textTransform:'uppercase', letterSpacing:'.06em', color:'var(--accent)', opacity:.8 }}>Total Outreach</div>
                  <div style={{ fontSize:28, fontWeight:700, color:'var(--accent)', lineHeight:1 }}>{fmt(t.sent || 0)}</div>
                  <div style={{ fontSize:11, color:'var(--text-secondary)', marginTop:2 }}>
                    {fmt(t.seqEmails||0)} sequence · {fmt(t.indivEmails||0)} individual
                  </div>
                </div>
                <KpiCard label="Opens"   value={fmt(t.opens)}   sub={`${t.openRate||0}% open rate`} />
                <KpiCard label="Clicks"  value={fmt(t.clicks)}  sub={`${t.clickRate||0}% click rate`} />
                <KpiCard label="Replies" value={fmt(t.replies)} sub={`${t.replyRate||0}% reply rate`} />
                <KpiCard label="To-Do Done" value={fmt(t.completedTodos)} accent />
                <KpiCard label="Meetings" value={fmt(t.meetings || 0)} />
              </div>
              {/* Meeting details in recap */}
              {data.meetingDetails?.length > 0 && (
                <div style={{ marginTop:10, padding:'10px 12px', background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)' }}>
                  <div style={{ fontSize:11, fontWeight:600, textTransform:'uppercase', letterSpacing:'.06em', color:'var(--text-tertiary)', marginBottom:6 }}>📅 Meetings</div>
                  {data.meetingDetails.map((m, i) => {
                    const dt = m.date ? new Date(m.date) : null
                    const dateStr = dt ? dt.toLocaleDateString('en-US', { timeZone:'America/New_York', weekday:'short', month:'short', day:'numeric' }) : ''
                    return (
                      <div key={i} style={{ fontSize:12, padding:'3px 0', borderBottom: i < data.meetingDetails.length-1 ? '1px solid var(--border)' : 'none', display:'flex', gap:8 }}>
                        <span style={{ color:'var(--text-tertiary)', minWidth:80 }}>{dateStr}</span>
                        <span style={{ color:'var(--text)' }}>{m.title}</span>
                      </div>
                    )
                  })}
                </div>
              )}
              {/* Row 2: Sequence stats */}
              <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr 1fr 1fr 1fr', gap:10 }}>
                <div style={{ padding:'14px 16px', background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', display:'flex', flexDirection:'column', gap:2 }}>
                  <div style={{ fontSize:11, fontWeight:600, textTransform:'uppercase', letterSpacing:'.06em', color:'var(--text-tertiary)' }}>Sequences</div>
                  <div style={{ fontSize:28, fontWeight:700, color:'var(--text)', lineHeight:1 }}>{fmt(t.sequences||0)}</div>
                  <div style={{ fontSize:11, color:'var(--text-secondary)', marginTop:2 }}>Enrollments this period</div>
                </div>
                <KpiCard label="Seq Opens"   value={fmt(t.opens)}   sub={`${t.seqOpenRate||0}% of enrolled`} />
                <KpiCard label="Seq Clicks"  value={fmt(t.clicks)}  sub={`${t.clickRate||0}% click rate`} />
                <KpiCard label="Seq Replies" value={fmt(t.replies)} sub={`${t.seqReplyRate||0}% of enrolled`} />
                <div />
              </div>
            </div>

            {/* byRep table */}
            <Panel>
              <SectionTitle>By Rep</SectionTitle>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                <THead cols={['Rep','Sent','Opens','Open%','Clicks','Click%','Replies','Reply%','Sequences','Meetings']} />
                <tbody>
                  {byRep.map((r,i) => (
                    <tr key={i} style={{ borderBottom:'1px solid var(--border)' }}>
                      <td style={{ padding:'8px 10px 8px 0', fontWeight:500 }}>{r.rep}</td>
                      <td style={{ padding:'8px 10px 8px 0' }}>{fmt(r.sent)}</td>
                      <td style={{ padding:'8px 10px 8px 0' }}>{fmt(r.opens)}</td>
                      <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{r.openRate}%</td>
                      <td style={{ padding:'8px 10px 8px 0' }}>{fmt(r.clicks)}</td>
                      <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{r.clickRate}%</td>
                      <td style={{ padding:'8px 10px 8px 0' }}>{fmt(r.replies)}</td>
                      <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{r.replyRate}%</td>
                      <td style={{ padding:'8px 0' }}>{fmt(r.sequences)}</td>
                      <td style={{ padding:'8px 0', color: r.meetings > 0 ? 'var(--green)' : 'var(--text-secondary)' }}>{fmt(r.meetings||0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>

            {/* Completed To-Do items */}
            {(data.completedTodos||[]).length > 0 && (
              <Panel>
                <SectionTitle>Completed To-Do Items ({data.completedTodos.length})</SectionTitle>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                  <THead cols={['Task','Type','Completed']} />
                  <tbody>
                    {data.completedTodos.slice(0,50).map((t,i) => (
                      <tr key={i} style={{ borderBottom:'1px solid var(--border)' }}>
                        <td style={{ padding:'7px 10px 7px 0' }}>{t.text}{t.subtext ? <span style={{ color:'var(--text-tertiary)', marginLeft:6 }}>{t.subtext}</span> : null}</td>
                        <td style={{ padding:'7px 10px 7px 0', color:'var(--text-secondary)' }}>{t.type}</td>
                        <td style={{ padding:'7px 0', color:'var(--text-tertiary)', whiteSpace:'nowrap' }}>{t.completedAt ? new Date(t.completedAt).toLocaleString() : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            )}

            {/* Manual activity log */}
            <Panel>
              <SectionTitle>Activity Log ({(data.activityLog||[]).length})</SectionTitle>
              {/* Add entry */}
              <div style={{ display:'flex', gap:8, marginBottom:14, flexWrap:'wrap' }}>
                <select value={logType} onChange={e => setLogType(e.target.value)}
                  style={{ fontSize:12, padding:'7px 10px', background:'var(--bg-secondary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text)', outline:'none' }}>
                  {LOG_TYPES.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase()+t.slice(1)}</option>)}
                </select>
                <input type="text" value={logCompany} onChange={e => setLogCompany(e.target.value)}
                  placeholder="Company (optional)"
                  style={{ width:160, padding:'7px 10px', background:'var(--bg-secondary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:12, color:'var(--text)', outline:'none' }} />
                <input type="text" value={logInput} onChange={e => setLogInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addLogEntry()}
                  placeholder="Describe the activity… (Enter to add)"
                  style={{ flex:1, minWidth:200, padding:'7px 10px', background:'var(--bg-secondary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:12, color:'var(--text)', outline:'none' }} />
                <button onClick={addLogEntry} disabled={logSaving || !logInput.trim()}
                  style={{ padding:'7px 16px', background:'var(--accent)', color:'#fff', border:'none', borderRadius:'var(--radius)', fontSize:12, fontWeight:500, cursor:'pointer', opacity: logSaving||!logInput.trim() ? 0.6 : 1 }}>
                  {logSaving ? 'Adding…' : 'Add'}
                </button>
              </div>
              {(data.activityLog||[]).length === 0 && (
                <div style={{ fontSize:12, color:'var(--text-tertiary)', padding:'8px 0' }}>No manual entries for this period. Add one above.</div>
              )}
              {(data.activityLog||[]).length > 0 && (
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                  <THead cols={['Activity','Type','Company','Rep','Date','']} />
                  <tbody>
                    {data.activityLog.slice(0,100).map((e,i) => (
                      <tr key={i} style={{ borderBottom:'1px solid var(--border)' }}>
                        <td style={{ padding:'7px 10px 7px 0' }}>{e.text}</td>
                        <td style={{ padding:'7px 10px 7px 0', color:'var(--text-secondary)' }}>{e.type}</td>
                        <td style={{ padding:'7px 10px 7px 0', color:'var(--text-tertiary)' }}>{e.company||'—'}</td>
                        <td style={{ padding:'7px 10px 7px 0', color:'var(--text-tertiary)' }}>{e.rep||'—'}</td>
                        <td style={{ padding:'7px 10px 7px 0', color:'var(--text-tertiary)', whiteSpace:'nowrap' }}>{e.date}</td>
                        <td style={{ padding:'7px 0' }}>
                          <button onClick={() => removeLogEntry(e.id)}
                            style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-tertiary)', fontSize:14, padding:0 }}>×</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
          </div>
        )
      })()}

      {/* ── Gold Activity ── */}
      {!loading && data && section === 'gold_activity' && (() => {
        const t = data.totals || {}
        const byRep = data.byRep || []
        const byAccount = data.byAccount || []

        const exportCSV = () => {
          const rows = [
            ['Account','Tier','BDR','Last Activity','Last Call','Last Meeting','Last Email','Notes'],
            ...byAccount.map(a => [a.name, a.tier, a.assignedBdr,
              a.lastActivity ? new Date(a.lastActivity).toLocaleDateString() : '—',
              a.lastCall     ? new Date(a.lastCall).toLocaleDateString()     : '—',
              a.lastMeeting  ? new Date(a.lastMeeting).toLocaleDateString()  : '—',
              a.lastEmail    ? new Date(a.lastEmail).toLocaleDateString()    : '—',
              a.noteCount || 0,
            ])
          ]
          const csv = rows.map(r => r.map(v => `"${String(v||'').replace(/"/g,'""')}"`).join(',')).join('\n')
          const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'}))
          link.download = `gold-activity-${new Date().toISOString().slice(0,10)}.csv`; link.click()
        }

        return (
          <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
            {/* KPI strip */}
            <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:10 }}>
              <KpiCard label="Gold Accounts"    value={fmt(t.totalAccounts||0)} />
              <KpiCard label="Active This Period" value={fmt(t.accountsTouched||0)} accent />
              <KpiCard label="Calls Logged"     value={fmt(t.totalCalls||0)} />
              <KpiCard label="Meetings Booked"  value={fmt(t.totalMeetings||0)} />
              <KpiCard label="Emails Logged"    value={fmt(t.totalEmails||0)} />
              <KpiCard label="Total Notes"      value={fmt(t.totalNotes||0)} />
            </div>

            <div style={{ display:'grid', gridTemplateColumns:'1fr 2fr', gap:16 }}>
              {/* byRep */}
              <Panel>
                <SectionTitle>By Rep</SectionTitle>
                {byRep.length === 0
                  ? <div style={{ fontSize:12, color:'var(--text-tertiary)' }}>No Gold activity logged this period.</div>
                  : <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                    <THead cols={['Rep','Accounts','Calls','Meetings','Emails','Notes']} />
                    <tbody>
                      {byRep.map((r,i) => (
                        <tr key={i} style={{ borderBottom:'1px solid var(--border)' }}>
                          <td style={{ padding:'7px 10px 7px 0', fontWeight:500 }}>{r.rep}</td>
                          <td style={{ padding:'7px 10px 7px 0' }}>{r.accounts}</td>
                          <td style={{ padding:'7px 10px 7px 0', color:r.calls>0?'var(--accent)':'var(--text-tertiary)' }}>{r.calls}</td>
                          <td style={{ padding:'7px 10px 7px 0', color:r.meetings>0?'var(--green)':'var(--text-tertiary)' }}>{r.meetings}</td>
                          <td style={{ padding:'7px 10px 7px 0' }}>{r.emails}</td>
                          <td style={{ padding:'7px 0' }}>{r.notes}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                }
              </Panel>

              {/* byAccount — sorted most recent activity first */}
              <Panel>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
                  <SectionTitle style={{ margin:0 }}>Activity by Account ({byAccount.length})</SectionTitle>
                  <button onClick={exportCSV}
                    style={{ padding:'5px 10px', background:'none', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:11, color:'var(--text-secondary)', cursor:'pointer' }}>
                    Export CSV
                  </button>
                </div>
                {byAccount.length === 0
                  ? <div style={{ fontSize:12, color:'var(--text-tertiary)' }}>No Gold accounts had activity this period.</div>
                  : <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                    <THead cols={['Account','Tier','BDR','Last Activity','Call','Meeting','Email','Notes']} />
                    <tbody>
                      {byAccount.map((a,i) => (
                        <tr key={i} style={{ borderBottom:'1px solid var(--border)', cursor:'pointer' }}
                          onClick={() => window.open(a.url,'_blank','noopener,noreferrer')}
                          onMouseEnter={e => e.currentTarget.style.background='var(--bg-secondary)'}
                          onMouseLeave={e => e.currentTarget.style.background=''}>
                          <td style={{ padding:'7px 10px 7px 0', fontWeight:500, color:'var(--accent)' }}>{a.name}</td>
                          <td style={{ padding:'7px 10px 7px 0', fontSize:10, color:'var(--text-tertiary)' }}>{(a.tier||'').replace('GOLD - ','')}</td>
                          <td style={{ padding:'7px 10px 7px 0', color:'var(--text-secondary)' }}>{a.assignedBdr||'—'}</td>
                          <td style={{ padding:'7px 10px 7px 0', color:'var(--text-secondary)', whiteSpace:'nowrap' }}>
                            {a.lastActivity ? new Date(a.lastActivity).toLocaleDateString() : '—'}
                          </td>
                          <td style={{ padding:'7px 10px 7px 0', color:a.lastCall?'var(--accent)':'var(--text-tertiary)' }}>
                            {a.lastCall ? new Date(a.lastCall).toLocaleDateString() : '—'}
                          </td>
                          <td style={{ padding:'7px 10px 7px 0', color:a.lastMeeting?'var(--green)':'var(--text-tertiary)' }}>
                            {a.lastMeeting ? new Date(a.lastMeeting).toLocaleDateString() : '—'}
                          </td>
                          <td style={{ padding:'7px 10px 7px 0', color:a.lastEmail?'var(--text-secondary)':'var(--text-tertiary)' }}>
                            {a.lastEmail ? new Date(a.lastEmail).toLocaleDateString() : '—'}
                          </td>
                          <td style={{ padding:'7px 0' }}>{a.noteCount||0}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                }
              </Panel>
            </div>

            {/* Meeting Details */}
            {(data.meetingDetails||[]).length > 0 && (
              <Panel>
                <SectionTitle>Meetings This Period ({(data.meetingDetails||[]).length})</SectionTitle>
                <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                  {(data.meetingDetails||[]).map((m,i) => (
                    <div key={i} style={{ display:'flex', gap:10, alignItems:'flex-start', paddingBottom:6, borderBottom: i < data.meetingDetails.length-1 ? '1px solid var(--border)' : 'none' }}>
                      <span style={{ fontSize:14, flexShrink:0 }}>📅</span>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:12, fontWeight:500, color:'var(--text)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                          {m.title || 'Meeting'}
                        </div>
                        {m.contactName && (
                          <div style={{ fontSize:11, color:'var(--text-secondary)', marginTop:1 }}>
                            {m.contactName}{m.company ? ` · ${m.company}` : ''}
                          </div>
                        )}
                      </div>
                      <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', flexShrink:0 }}>
                        {m.date && (
                          <div style={{ fontSize:11, color:'var(--text-tertiary)' }}>
                            {new Date(m.date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}
                          </div>
                        )}
                        {m.ownerName && (
                          <div style={{ fontSize:10, color:'var(--accent)', marginTop:1 }}>{m.ownerName}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </Panel>
            )}
          </div>
        )
      })()}

      {/* ── Gold Work Log ── */}
{!loading && data && section === 'gold_work_log' && (() => {
        const S  = data.summary || {}
        const accounts  = data.accounts  || []
        const notWorked = data.notWorked  || []
        const byRep     = data.byRep      || []

        const exportCSV = () => {
          const rows = [
            ['Account','Tier','Rep','Last Activity','Last Call','Last Meeting','Last Email','Notes','Contacts','Buying Roles','Deals','Activities This Period'],
            ...accounts.map(a => [
              a.name, a.tier, a.rep,
              a.lastActivity  ? new Date(a.lastActivity).toLocaleDateString()  : '—',
              a.lastCall      ? new Date(a.lastCall).toLocaleDateString()      : '—',
              a.lastMeeting   ? new Date(a.lastMeeting).toLocaleDateString()   : '—',
              a.lastEmail     ? new Date(a.lastEmail).toLocaleDateString()     : '—',
              a.noteCount     || 0,
              a.contactCount  || 0,
              a.buyingRoles   || 0,
              a.deals         || 0,
              (a.activities||[]).map(ac => ac.type).join('; '),
            ]),
            [''],
            ['NOT WORKED THIS PERIOD'],
            ['Account','Tier','Rep','Last Activity'],
            ...notWorked.map(a => [
              a.name, a.tier, a.rep,
              a.lastActivity ? new Date(a.lastActivity).toLocaleDateString() : 'Never',
            ]),
          ]
          const csv = rows.map(r => r.map(v => `"${String(v||'').replace(/"/g,'""')}"`).join(',')).join('\n')
          const link = document.createElement('a')
          link.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'}))
          link.download = `gold-work-log-${new Date().toISOString().slice(0,10)}.csv`
          link.click()
        }

        const copyRecap = () => {
          const lines = [
            `Gold Account Work Log — ${data.periodLabel || data.period}`,
            `Generated: ${new Date().toLocaleString()}`,
            ``,
            `SUMMARY`,
            `Total Gold Accounts:   ${S.totalAccounts}`,
            `Worked This Period:    ${S.workedThisPeriod}`,
            `Not Touched:           ${S.notWorked}`,
            `Calls Logged:          ${S.totalCalls}`,
            `Meetings Booked:       ${S.totalMeetings}`,
            `Emails Logged:         ${S.totalEmails}`,
            ``,
            `BY REP`,
            ...byRep.map(r => `${r.rep.padEnd(18)} Accts:${String(r.accounts).padStart(3)}  Calls:${String(r.calls).padStart(3)}  Meetings:${String(r.meetings).padStart(3)}  Emails:${String(r.emails).padStart(3)}`),
            ``,
            `ACCOUNTS WORKED (${accounts.length})`,
            ...accounts.map(a => `${a.tier.replace('GOLD - ','').padEnd(8)} ${a.name.padEnd(35)} ${a.rep.padEnd(14)} ${a.activities.map(ac => ac.type).join(', ') || 'Updated'}`),
            ``,
            `NOT WORKED THIS PERIOD (${notWorked.length})`,
            ...notWorked.map(a => `${a.tier.replace('GOLD - ','').padEnd(8)} ${a.name}`),
          ]
          navigator.clipboard.writeText(lines.join('\n')).then(() => alert('Copied to clipboard!'))
        }

        return (
          <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
            {/* Header + export */}
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
              <div>
                <div style={{ fontSize:18, fontWeight:600, color:'var(--text)' }}>Gold Account Work Log</div>
                <div style={{ fontSize:12, color:'var(--text-tertiary)', marginTop:2 }}>{data.periodLabel} — what got done on Gold accounts</div>
              </div>
              <div style={{ display:'flex', gap:8 }}>
                <button onClick={copyRecap}
                  style={{ padding:'8px 16px', background:'none', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:12, color:'var(--text-secondary)', cursor:'pointer' }}>
                  Copy recap
                </button>
                <button onClick={exportCSV}
                  style={{ padding:'8px 16px', background:'var(--accent)', color:'#fff', border:'none', borderRadius:'var(--radius)', fontSize:12, fontWeight:500, cursor:'pointer' }}>
                  Export CSV
                </button>
              </div>
            </div>

            {/* KPI strip */}
            <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:10 }}>
              <KpiCard label="Total Gold Accts"  value={fmt(S.totalAccounts||0)} />
              <KpiCard label="Worked This Period" value={fmt(S.workedThisPeriod||0)} accent />
              <KpiCard label="Not Touched"        value={fmt(S.notWorked||0)} />
              <KpiCard label="Calls Logged"       value={fmt(S.totalCalls||0)} />
              <KpiCard label="Meetings Booked"    value={fmt(S.totalMeetings||0)} />
              <KpiCard label="Emails Logged"      value={fmt(S.totalEmails||0)} />
            </div>

            {/* By rep */}
            {byRep.length > 0 && (
              <Panel>
                <SectionTitle>Work by Rep</SectionTitle>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                  <THead cols={['Rep','Accounts Touched','Calls','Meetings','Emails','Notes']} />
                  <tbody>
                    {byRep.map((r,i) => (
                      <tr key={i} style={{ borderBottom:'1px solid var(--border)' }}>
                        <td style={{ padding:'7px 10px 7px 0', fontWeight:500 }}>{r.rep}</td>
                        <td style={{ padding:'7px 10px 7px 0' }}>{r.accounts}</td>
                        <td style={{ padding:'7px 10px 7px 0', color:r.calls>0?'var(--accent)':'var(--text-tertiary)' }}>{r.calls}</td>
                        <td style={{ padding:'7px 10px 7px 0', color:r.meetings>0?'var(--green)':'var(--text-tertiary)' }}>{r.meetings}</td>
                        <td style={{ padding:'7px 10px 7px 0' }}>{r.emails}</td>
                        <td style={{ padding:'7px 0' }}>{r.notes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            )}

            {/* Accounts worked */}
            <Panel>
              <SectionTitle>Accounts Worked This Period ({accounts.length})</SectionTitle>
              {accounts.length === 0
                ? <div style={{ fontSize:12, color:'var(--text-tertiary)' }}>No Gold account activity recorded this period.</div>
                : <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                  <THead cols={['Account','Tier','Rep','Last Activity','Activities','Call','Meeting','Email','Notes','Contacts','Roles','Deals']} />
                  <tbody>
                    {accounts.map((a,i) => (
                      <tr key={i} style={{ borderBottom:'1px solid var(--border)', cursor:'pointer' }}
                        onClick={() => window.open(a.url,'_blank','noopener,noreferrer')}
                        onMouseEnter={e => e.currentTarget.style.background='var(--bg-secondary)'}
                        onMouseLeave={e => e.currentTarget.style.background=''}>
                        <td style={{ padding:'7px 10px 7px 0', fontWeight:500, color:'var(--accent)', maxWidth:160, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{a.name}</td>
                        <td style={{ padding:'7px 10px 7px 0', fontSize:10, color:'var(--text-tertiary)' }}>{(a.tier||'').replace('GOLD - ','')}</td>
                        <td style={{ padding:'7px 10px 7px 0', color:'var(--text-secondary)', whiteSpace:'nowrap' }}>{a.rep||'—'}</td>
                        <td style={{ padding:'7px 10px 7px 0', color:'var(--text-secondary)', whiteSpace:'nowrap' }}>
                          {a.lastActivity ? new Date(a.lastActivity).toLocaleDateString() : '—'}
                        </td>
                        <td style={{ padding:'7px 10px 7px 0' }}>
                          <div style={{ display:'flex', gap:3, flexWrap:'wrap' }}>
                            {(a.activities||[]).slice(0,3).map((ac,j) => (
                              <span key={j} style={{ fontSize:9, fontWeight:600, textTransform:'uppercase', padding:'1px 5px', borderRadius:3,
                                background: ac.type==='Call'?'rgba(79,142,247,.12)':ac.type==='Meeting'?'rgba(52,201,122,.12)':'var(--bg-secondary)',
                                color: ac.type==='Call'?'var(--accent)':ac.type==='Meeting'?'var(--green)':'var(--text-tertiary)' }}>
                                {ac.type}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td style={{ padding:'7px 10px 7px 0', color:a.lastCall?'var(--accent)':'var(--text-tertiary)', fontSize:11 }}>{a.lastCall?new Date(a.lastCall).toLocaleDateString():'—'}</td>
                        <td style={{ padding:'7px 10px 7px 0', color:a.lastMeeting?'var(--green)':'var(--text-tertiary)', fontSize:11 }}>{a.lastMeeting?new Date(a.lastMeeting).toLocaleDateString():'—'}</td>
                        <td style={{ padding:'7px 10px 7px 0', fontSize:11, color:'var(--text-secondary)' }}>{a.lastEmail?new Date(a.lastEmail).toLocaleDateString():'—'}</td>
                        <td style={{ padding:'7px 10px 7px 0' }}>{a.noteCount||0}</td>
                        <td style={{ padding:'7px 10px 7px 0' }}>{a.contactCount||0}</td>
                        <td style={{ padding:'7px 10px 7px 0', color:(a.buyingRoles||0)>0?'var(--text-secondary)':'var(--text-tertiary)' }}>{a.buyingRoles||0}</td>
                        <td style={{ padding:'7px 0', color:(a.deals||0)>0?'var(--green)':'var(--text-tertiary)' }}>{a.deals||0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              }
            </Panel>

            {/* Not worked */}
            {notWorked.length > 0 && (
              <Panel>
                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
                  <SectionTitle style={{ margin:0 }}>Not Touched This Period ({S.notWorked})</SectionTitle>
                  <span style={{ fontSize:10, fontWeight:700, color:'var(--red)', background:'rgba(240,82,82,.1)', borderRadius:4, padding:'2px 8px' }}>Needs attention</span>
                </div>
                <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
                  {notWorked.map((a,i) => (
                    <a key={i} href={a.url} target="_blank" rel="noopener noreferrer"
                      style={{ fontSize:11, padding:'4px 10px', borderRadius:'var(--radius)', display:'inline-flex', gap:8, alignItems:'center',
                        background:'rgba(240,82,82,.05)', border:'1px solid rgba(240,82,82,.2)', color:'var(--text)', textDecoration:'none' }}>
                      <span>{a.name}</span>
                      <span style={{ fontSize:9, color:'var(--text-tertiary)' }}>{(a.tier||'').replace('GOLD - ','')}</span>
                      {a.lastActivity && <span style={{ fontSize:10, color:'var(--red)' }}>{Math.floor((Date.now() - new Date(a.lastActivity)) / 86400000)}d ago</span>}
                    </a>
                  ))}
                </div>
              </Panel>
            )}
          </div>
        )
      })()}
      {!loading && data && section === 'weekly_recap' && (() => {
        const t = data.totals || {}
        const byRep = data.byRep || []

        const exportText = () => {
          const lines = [
            `Cipher Weekly Activity Recap`,
            `Period: ${data.periodLabel || period}`,
            `Generated: ${new Date().toLocaleString()}`,
            ``,
            `── OUTREACH TOTALS ──`,
            `Total Outreach:    ${t.sent} (${t.seqEmails||0} sequence, ${t.indivEmails||0} individual)`,
            `Opens:             ${t.opens} (${t.openRate}%)`,
            `Clicks:            ${t.clicks}`,
            `Replies:           ${t.replies} (${t.replyRate}%)`,
            `Sequences Started: ${t.sequences}`,
            `Meetings Logged:   ${t.meetings||0}`,
            `To-Do Completed:   ${t.completedTodos}`,
            `Manual Logged:     ${t.manualEntries}`,
            ``,
            `── BY REP ──`,
            ...byRep.map(r => `${r.rep.padEnd(20)} Sent: ${String(r.sent).padStart(4)}  Opens: ${String(r.opens).padStart(4)}  Replies: ${String(r.replies).padStart(4)}  Sequences: ${String(r.sequences).padStart(3)}`),
            ``,
            `── COMPLETED TO-DO ITEMS (${(data.completedTodos||[]).length}) ──`,
            ...(data.completedTodos||[]).map(t => `✓ [${t.type}] ${t.text}${t.subtext ? ` — ${t.subtext}` : ''}${t.completedAt ? ` (${new Date(t.completedAt).toLocaleString()})` : ''}`),
            ``,
            `── ACTIVITY LOG (${(data.activityLog||[]).length}) ──`,
            ...(data.activityLog||[]).map(e => `• [${e.type}] ${e.text}${e.company ? ` — ${e.company}` : ''}${e.rep ? ` (${e.rep})` : ''} ${e.date}`),
          ]
          navigator.clipboard.writeText(lines.join('\n')).then(() => alert('Recap copied to clipboard!'))
        }

        const exportCSV = () => {
          const rows = [
            ['Type','Rep','Metric','Value','Date'],
            // HubSpot activity
            ...byRep.flatMap(r => [
              ['HubSpot',r.rep,'Total Sent',r.sent,''],
              ['HubSpot',r.rep,'Sequence Emails',r.seqEmails||0,''],
              ['HubSpot',r.rep,'Individual Emails',r.indivEmails||0,''],
              ['HubSpot',r.rep,'Opens',r.opens,''],
              ['HubSpot',r.rep,'Clicks',r.clicks,''],
              ['HubSpot',r.rep,'Replies',r.replies,''],
              ['HubSpot',r.rep,'Sequences',r.sequences,''],
              ['HubSpot',r.rep,'Meetings',r.meetings||0,''],
            ]),
            // Completed To-Do
            ...(data.completedTodos||[]).map(t => ['To-Do','',t.text,t.type,t.completedAt||'']),
            // Activity log
            ...(data.activityLog||[]).map(e => ['Manual Log',e.rep||'',e.text,e.type,e.date||'']),
          ]
          const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n')
          const a = document.createElement('a')
          a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'}))
          a.download = `weekly-recap-${new Date().toISOString().slice(0,10)}.csv`
          a.click()
        }

        return (
          <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
            {/* Header + export */}
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
              <div>
                <div style={{ fontSize:18, fontWeight:600, color:'var(--text)' }}>Weekly Activity Recap</div>
                <div style={{ fontSize:12, color:'var(--text-tertiary)', marginTop:2 }}>
                  {data.periodLabel} — shareable summary for leadership. To log manual activities, use Team Activity.
                </div>
              </div>
              <div style={{ display:'flex', gap:8 }}>
                <button onClick={exportText}
                  style={{ padding:'8px 16px', background:'none', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:12, color:'var(--text-secondary)', cursor:'pointer' }}>
                  Copy recap
                </button>
                <button onClick={exportCSV}
                  style={{ padding:'8px 16px', background:'var(--accent)', color:'#fff', border:'none', borderRadius:'var(--radius)', fontSize:12, fontWeight:500, cursor:'pointer' }}>
                  Export CSV
                </button>
              </div>
            </div>

            {/* KPI strip — Total Outreach + breakdown + engagement metrics */}
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              {/* Row 1: Email breakdown */}
              <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr 1fr 1fr 1fr 1fr 1fr', gap:10 }}>
                {/* Total Outreach — spans wider, prominent */}
                <div style={{ padding:'14px 16px', background:'var(--surface)', border:'2px solid var(--accent)', borderRadius:'var(--radius)', display:'flex', flexDirection:'column', gap:2 }}>
                  <div style={{ fontSize:11, fontWeight:600, textTransform:'uppercase', letterSpacing:'.06em', color:'var(--accent)', opacity:.8 }}>Total Outreach</div>
                  <div style={{ fontSize:28, fontWeight:700, color:'var(--accent)', lineHeight:1 }}>{fmt(t.sent)}</div>
                  <div style={{ fontSize:11, color:'var(--text-secondary)', marginTop:2 }}>
                    {fmt(t.seqEmails||0)} sequence · {fmt(t.indivEmails||0)} individual
                  </div>
                </div>
                <KpiCard label="Sequence Emails"   value={fmt(t.seqEmails||0)}   sub="Via sequences" />
                <KpiCard label="Individual Emails" value={fmt(t.indivEmails||0)} sub="1:1 direct" />
                <KpiCard label="Opens"             value={fmt(t.opens)}          sub={`${t.openRate||0}% open rate`} />
                <KpiCard label="Replies"           value={fmt(t.replies)}        sub={`${t.replyRate||0}% reply rate`} />
                <KpiCard label="Meetings"          value={fmt(t.meetings||0)}    sub="Logged this period" accent />
                <KpiCard label="To-Do Done"        value={fmt(t.completedTodos)} accent />
              </div>
            </div>

            {/* byRep table */}
            <Panel>
              <SectionTitle>Activity by Rep</SectionTitle>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                <THead cols={['Rep','Total Sent','Seq Emails','Indiv Emails','Opens','Open%','Replies','Reply%','Sequences','Meetings']} />
                <tbody>
                  {byRep.map((r,i) => (
                    <tr key={i} style={{ borderBottom:'1px solid var(--border)' }}>
                      <td style={{ padding:'8px 10px 8px 0', fontWeight:500 }}>{r.rep}</td>
                      <td style={{ padding:'8px 10px 8px 0', fontWeight:600 }}>{fmt(r.sent)}</td>
                      <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{fmt(r.seqEmails||0)}</td>
                      <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>{fmt(r.indivEmails||0)}</td>
                      <td style={{ padding:'8px 10px 8px 0' }}>{fmt(r.opens)}</td>
                      <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>
                        {r.sent > 0 ? ((r.opens/r.sent)*100).toFixed(1) : 0}%
                      </td>
                      <td style={{ padding:'8px 10px 8px 0' }}>{fmt(r.replies)}</td>
                      <td style={{ padding:'8px 10px 8px 0', color:'var(--text-secondary)' }}>
                        {r.sent > 0 ? ((r.replies/r.sent)*100).toFixed(1) : 0}%
                      </td>
                      <td style={{ padding:'8px 0' }}>{fmt(r.sequences)}</td>
                      <td style={{ padding:'8px 0', color: (r.meetings||0) > 0 ? 'var(--green)' : 'var(--text-secondary)' }}>{fmt(r.meetings||0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>

            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
              {/* Completed To-Do */}
              <Panel>
                <SectionTitle>Completed To-Do ({(data.completedTodos||[]).length})</SectionTitle>
                {(data.completedTodos||[]).length === 0
                  ? <div style={{ fontSize:12, color:'var(--text-tertiary)' }}>None completed this period.</div>
                  : <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                    {(data.completedTodos||[]).map((t,i) => (
                      <div key={i} style={{ display:'flex', gap:8, alignItems:'flex-start', paddingBottom:6, borderBottom:'1px solid var(--border)' }}>
                        <span style={{ fontSize:12, color:'var(--accent)', flexShrink:0 }}>✓</span>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontSize:12, color:'var(--text)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{t.text}</div>
                          {t.subtext && <div style={{ fontSize:11, color:'var(--text-tertiary)' }}>{t.subtext}</div>}
                        </div>
                        {t.completedAt && (
                          <div style={{ fontSize:10, color:'var(--text-tertiary)', flexShrink:0 }}>
                            {new Date(t.completedAt).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                }
              </Panel>

              {/* Activity Log */}
              <Panel>
                <SectionTitle>Activity Log ({(data.activityLog||[]).length})</SectionTitle>
                {(data.activityLog||[]).length === 0
                  ? <div style={{ fontSize:12, color:'var(--text-tertiary)' }}>No manual entries this period. Add them in Team Activity.</div>
                  : <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                    {(data.activityLog||[]).map((e,i) => (
                      <div key={i} style={{ display:'flex', gap:8, alignItems:'flex-start', paddingBottom:6, borderBottom:'1px solid var(--border)' }}>
                        <span style={{ fontSize:9, fontWeight:600, textTransform:'uppercase', color:'var(--text-tertiary)', background:'var(--bg-secondary)', borderRadius:4, padding:'2px 5px', flexShrink:0, marginTop:2 }}>{e.type}</span>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontSize:12, color:'var(--text)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{e.text}</div>
                          {e.company && <div style={{ fontSize:11, color:'var(--text-tertiary)' }}>{e.company}</div>}
                        </div>
                        <div style={{ fontSize:10, color:'var(--text-tertiary)', flexShrink:0, textAlign:'right' }}>
                          <div>{e.rep}</div>
                          <div>{e.date}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                }
              </Panel>
            </div>
          </div>
        )
      })()}

    </div>
  )
}

// ─── Gold shared constants ────────────────────────────────────────────────────
const TARGET_PERSONAS = [
  { value:"Access/Patient Access",  label:"Access/Patient Access",  priority:"high" },
  { value:"Ambulatory/Urgent Care", label:"Ambulatory/Urgent Care", priority:"medium" },
  { value:"Business Development",   label:"Business Development",   priority:"medium" },
  { value:"Case Management",        label:"Case Management",        priority:"high" },
  { value:"Chief Clinical Officer", label:"Chief Clinical Officer", priority:"critical" },
  { value:"Clinical Operations",    label:"Clinical Operations",    priority:"high" },
  { value:"Emergency Department",   label:"Emergency Department",   priority:"medium" },
  { value:"Executive/Leadership",   label:"Executive/Leadership",   priority:"critical" },
  { value:"Finance",                label:"Finance",                priority:"high" },
  { value:"Innovation",             label:"Innovation",             priority:"medium" },
  { value:"Medical Group",          label:"Medical Group",          priority:"medium" },
  { value:"Medical",                label:"Medical Information",    priority:"medium" },
  { value:"Medical Officer",        label:"Medical Officer",        priority:"critical" },
  { value:"Nursing Officer",        label:"Nursing Officer",        priority:"critical" },
  { value:"Operating Officer",      label:"Operating Officer",      priority:"critical" },
  { value:"Patient Experience",     label:"Patient Experience",     priority:"high" },
  { value:"Physician Executive",    label:"Physician Executive",    priority:"critical" },
  { value:"Population Health",      label:"Population Health",      priority:"high" },
  { value:"Quality Officer",        label:"Quality Officer",        priority:"high" },
  { value:"Service Line",           label:"Service Line",           priority:"medium" },
  { value:"Strategy",               label:"Strategy",               priority:"high" },
  { value:"Value Based Care",       label:"Value Based Care",       priority:"high" },
]

const GOLD_TIER_OPTIONS = [
  { value:'',               label:'All Tiers' },
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

const GOLD_OWNER_MAP = {
  '76104455':'Matt Valin','55217954':'Joe Haine','83862037':'Tim Grisham',
  '289209454':'Irene Wong','85819247':'Cole Hooper','743772047':'John Hansel',
}

const hcColor = s => s==='active'?'var(--green)':s==='attention'?'var(--amber)':s==='risk'?'var(--red)':'var(--text-tertiary)'
const hcBg    = s => s==='active'?'rgba(52,201,122,.12)':s==='attention'?'rgba(245,166,35,.12)':s==='risk'?'rgba(240,82,82,.12)':'var(--bg-secondary)'
const hcBorder= s => s==='active'?'rgba(52,201,122,.4)':s==='attention'?'rgba(245,166,35,.4)':s==='risk'?'rgba(240,82,82,.4)':'var(--border)'

const prioColor = p => p==='critical'?'var(--red)':p==='high'?'var(--amber)':'var(--text-tertiary)'

function useGoldSort(accounts, search, sortBy) {
  return useMemo(() => {
    let list = [...accounts]
    if (search) list = list.filter(a => a.name.toLowerCase().includes(search.toLowerCase()))
    if (sortBy === 'health')   list.sort((a,b) => (b.health||0)-(a.health||0))
    if (sortBy === 'activity') list.sort((a,b) => {
      const da = a.lastActivityDate ? new Date(a.lastActivityDate).getTime() : 0
      const db = b.lastActivityDate ? new Date(b.lastActivityDate).getTime() : 0
      return db - da
    })
    if (sortBy === 'gaps')    list.sort((a,b) => (b.criticalGaps||0)-(a.criticalGaps||0))
    if (sortBy === 'tier')    list.sort((a,b) => (a.tierRank||0)-(b.tierRank||0))
    if (sortBy === 'coverage')list.sort((a,b) => (a.coveredPersonaCount||0)-(b.coveredPersonaCount||0))
    return list
  }, [accounts, search, sortBy])
}

// Org chart tree structure for persona hierarchy
// Grouped by reporting level: C-Suite → Officers → Directors/Managers → Operational
const PERSONA_TREE = [
  {
    level: 0, label: 'Executive', color: 'var(--red)',
    nodes: [
      { value: 'Executive/Leadership',   label: 'Executive / Leadership' },
      { value: 'Operating Officer',      label: 'Operating Officer' },
      { value: 'Chief Clinical Officer', label: 'Chief Clinical Officer' },
    ]
  },
  {
    level: 1, label: 'Officers & VPs', color: 'var(--amber)',
    nodes: [
      { value: 'Medical Officer',        label: 'Medical Officer' },
      { value: 'Nursing Officer',        label: 'Nursing Officer' },
      { value: 'Physician Executive',    label: 'Physician Executive' },
      { value: 'Finance',                label: 'Finance' },
    ]
  },
  {
    level: 2, label: 'Strategy & Operations', color: 'var(--accent)',
    nodes: [
      { value: 'Strategy',               label: 'Strategy' },
      { value: 'Innovation',             label: 'Innovation' },
      { value: 'Business Development',   label: 'Business Development' },
      { value: 'Population Health',      label: 'Population Health' },
      { value: 'Value Based Care',       label: 'Value Based Care' },
      { value: 'Quality Officer',        label: 'Quality Officer' },
    ]
  },
  {
    level: 3, label: 'Clinical & Service', color: 'var(--green)',
    nodes: [
      { value: 'Clinical Operations',    label: 'Clinical Operations' },
      { value: 'Medical Group',          label: 'Medical Group' },
      { value: 'Medical',                label: 'Medical Information' },
      { value: 'Service Line',           label: 'Service Line' },
      { value: 'Emergency Department',   label: 'Emergency Department' },
      { value: 'Ambulatory/Urgent Care', label: 'Ambulatory / Urgent Care' },
    ]
  },
  {
    level: 4, label: 'Patient-Facing & Access', color: 'var(--purple)',
    nodes: [
      { value: 'Access/Patient Access',  label: 'Access / Patient Access' },
      { value: 'Patient Experience',     label: 'Patient Experience' },
      { value: 'Case Management',        label: 'Case Management' },
    ]
  },
]

function OrgChart({ account, gapState = {}, searchGap }) {
  const [tooltip, setTooltip] = useState(null)
  if (!account?.personaCoverage) return null

  const coverageMap = {}
  account.personaCoverage.forEach(p => { coverageMap[p.persona] = p })

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:0 }}>
      {PERSONA_TREE.map((tier, ti) => (
        <div key={ti} style={{ display:'flex', flexDirection:'column', alignItems:'center', position:'relative', marginBottom:4 }}>
          {/* Tier label */}
          <div style={{ fontSize:9, fontWeight:600, textTransform:'uppercase', letterSpacing:'.06em', color:'var(--text-tertiary)', marginBottom:4 }}>{tier.label}</div>
          {/* Nodes row */}
          <div style={{ display:'flex', gap:6, flexWrap:'wrap', justifyContent:'center' }}>
            {tier.nodes.map((node, ni) => {
              const p = coverageMap[node.value]
              const covered   = p?.covered || false
              const status    = p?.engagement || 'none'
              const contacts  = p?.contacts || []
              const bg    = status==='replied'   ? 'rgba(52,201,122,.18)'
                          : status==='contacted' ? 'rgba(52,201,122,.08)'
                          : status==='mapped'    ? 'rgba(79,142,247,.12)'
                          : 'rgba(240,82,82,.08)'
              const border= status==='replied'   ? '2px solid var(--green)'
                          : status==='contacted' ? '2px solid rgba(52,201,122,.4)'
                          : status==='mapped'    ? '2px solid var(--accent)'
                          : '2px solid var(--red)'
              const textCol = status==='replied' ? 'var(--green)'
                            : status==='contacted'?'var(--text)'
                            : status==='mapped'   ?'var(--accent)'
                            : 'var(--red)'
              return (
                <div key={ni}
                  onMouseEnter={() => setTooltip({ node, p, contacts })}
                  onMouseLeave={() => setTooltip(null)}
                  style={{ position:'relative', padding:'5px 10px', borderRadius:6, border, background:bg,
                    cursor:'default', minWidth:90, textAlign:'center', transition:'all .12s' }}>
                  <div style={{ fontSize:10, fontWeight:600, color:textCol, lineHeight:1.3 }}>{node.label}</div>
                  {covered && contacts.length > 0 && (
                    <div style={{ fontSize:9, color:'var(--text-tertiary)', marginTop:2 }}>
                      {contacts[0].name.split(' ')[0]}{contacts.length > 1 ? ` +${contacts.length-1}` : ''}
                    </div>
                  )}
                  {!covered && (() => {
                    const key = `${account.id}:${node.value}`
                    const gs  = gapState[key]
                    return (
                      <div style={{ marginTop:2 }}>
                        {gs?.status === 'searching' && (
                          <div style={{ fontSize:9, color:'var(--accent)' }}>⟳ searching...</div>
                        )}
                        {gs?.status === 'done' && gs.result?.name && (
                          <div style={{ fontSize:9, color:'var(--green)', lineHeight:1.3 }}>
                            ✓ {gs.result.name}
                            {gs.result.linkedinUrl && (
                              <a href={gs.result.linkedinUrl} target="_blank" rel="noopener noreferrer"
                                style={{ marginLeft:3, color:'var(--accent)' }}>↗</a>
                            )}
                          </div>
                        )}
                        {gs?.status === 'done' && !gs.result?.name && (
                          <div style={{ fontSize:9, color:'var(--red)' }}>⚠ Not found</div>
                        )}
                        {!gs && (
                          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:2 }}>
                            <div style={{ fontSize:9, color:'var(--red)' }}>⚠ No contact</div>
                            {searchGap && (
                              <button
                                onClick={e => { e.stopPropagation(); searchGap(account.id, account.name, account.domain, node.value, account.contacts || []) }}
                                style={{ fontSize:8, padding:'1px 5px', background:'var(--accent)', color:'#fff',
                                  border:'none', borderRadius:3, cursor:'pointer', marginTop:1 }}>
                                Find
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })()}
                  {/* Tooltip */}
                  {tooltip?.node?.value === node.value && (
                    <div style={{ position:'absolute', top:'calc(100% + 6px)', left:'50%', transform:'translateX(-50%)',
                      background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)',
                      padding:'8px 10px', zIndex:100, minWidth:160, boxShadow:'0 4px 16px rgba(0,0,0,.3)', pointerEvents:'none' }}>
                      <div style={{ fontSize:11, fontWeight:600, color:'var(--text)', marginBottom:4 }}>{node.label}</div>
                      {!covered
                        ? <div style={{ fontSize:10, color:'var(--red)' }}>No contact assigned to this persona</div>
                        : contacts.map((c,i) => (
                          <div key={i} style={{ fontSize:10, color:'var(--text-secondary)', marginBottom:2 }}>
                            <span style={{ fontWeight:500, color:'var(--text)' }}>{c.name}</span>
                            {c.title && <span style={{ color:'var(--text-tertiary)' }}> — {c.title}</span>}
                            <div style={{ fontSize:9, color: c.replied?'var(--green)':c.sent?'var(--text-tertiary)':'var(--text-tertiary)' }}>
                              {c.replied ? '✓ Replied' : c.sent ? 'Contacted' : 'Mapped only'}
                            </div>
                          </div>
                        ))
                      }
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          {/* Connector line to next tier */}
          {ti < PERSONA_TREE.length - 1 && (
            <div style={{ width:2, height:12, background:'var(--border)', margin:'2px auto 0' }} />
          )}
        </div>
      ))}
      {/* Legend */}
      <div style={{ display:'flex', gap:12, fontSize:9, color:'var(--text-tertiary)', justifyContent:'center', marginTop:8, flexWrap:'wrap' }}>
        <span><span style={{ display:'inline-block', width:10, height:10, borderRadius:2, background:'rgba(52,201,122,.18)', border:'2px solid var(--green)', verticalAlign:'middle', marginRight:4 }} />Replied</span>
        <span><span style={{ display:'inline-block', width:10, height:10, borderRadius:2, background:'rgba(52,201,122,.08)', border:'2px solid rgba(52,201,122,.4)', verticalAlign:'middle', marginRight:4 }} />Contacted</span>
        <span><span style={{ display:'inline-block', width:10, height:10, borderRadius:2, background:'rgba(79,142,247,.12)', border:'2px solid var(--accent)', verticalAlign:'middle', marginRight:4 }} />Mapped</span>
        <span><span style={{ display:'inline-block', width:10, height:10, borderRadius:2, background:'rgba(240,82,82,.08)', border:'2px solid var(--red)', verticalAlign:'middle', marginRight:4 }} />Gap</span>
      </div>
    </div>
  )
}

// Gap Summary — at-a-glance breakdown of all gap factors
function GapSummary({ account }) {
  if (!account) return null
  const coverage = account.personaCoverage || []
  const missing  = account.missingPersonas  || []

  const personaGap    = missing.length
  const criticalGaps  = (account.criticalGaps || 0)
  const highGaps      = (account.highGaps || 0)
  const mappedNoEmail = coverage.filter(p => p.covered && p.engagement === 'mapped').length
  const engagedCount  = coverage.filter(p => p.engagement === 'replied' || p.engagement === 'contacted').length
  const repliedCount  = coverage.filter(p => p.engagement === 'replied').length
  const hasReply      = account.lastEngagement?.type === 'replied'
  const hasMeeting    = !!account.lastBooked
  const daysSince     = account.daysSinceActivity
  const activityGap   = daysSince == null || daysSince > 30

  const factors = [
    {
      label: 'Persona Coverage',
      value: `${account.coveredPersonaCount || 0} / 22`,
      status: personaGap === 0 ? 'green' : criticalGaps > 0 ? 'red' : 'amber',
      detail: personaGap === 0 ? 'All personas mapped' : `${criticalGaps} critical, ${highGaps} high priority gaps`,
    },
    {
      label: 'Critical Gaps',
      value: criticalGaps,
      status: criticalGaps === 0 ? 'green' : 'red',
      detail: criticalGaps === 0 ? 'No critical gaps' : `${criticalGaps} C-suite / officer personas unmapped`,
    },
    {
      label: 'Engagement',
      value: `${engagedCount} contacted`,
      status: repliedCount > 0 ? 'green' : engagedCount > 0 ? 'amber' : 'red',
      detail: repliedCount > 0 ? `${repliedCount} personas have replied` : engagedCount > 0 ? `${mappedNoEmail} mapped with no email sent` : 'No engagement on any persona',
    },
    {
      label: 'Recent Activity',
      value: daysSince != null ? `${daysSince}d ago` : 'Never',
      status: !activityGap ? 'green' : daysSince != null && daysSince <= 60 ? 'amber' : 'red',
      detail: !activityGap ? 'Active within 30 days' : daysSince != null ? `Last activity ${daysSince} days ago` : 'No activity logged',
    },
    {
      label: 'Reply Received',
      value: hasReply ? 'Yes' : 'None',
      status: hasReply ? 'green' : 'red',
      detail: hasReply ? `Last reply: ${new Date(account.lastEngagement.date).toLocaleDateString()}` : 'No replies from any contact',
    },
    {
      label: 'Meeting Booked',
      value: hasMeeting ? new Date(account.lastBooked).toLocaleDateString() : 'None',
      status: hasMeeting ? 'green' : 'amber',
      detail: hasMeeting ? 'At least one meeting on record' : 'No meetings booked yet',
    },
    {
      label: 'Contact Count',
      value: account.numContacts || 0,
      status: (account.numContacts || 0) >= 10 ? 'green' : (account.numContacts || 0) >= 5 ? 'amber' : 'red',
      detail: `${account.numContacts || 0} contacts associated`,
    },
    {
      label: 'Data Quality',
      value: `${account.coveredPersonaCount || 0}/22 tagged`,
      status: (account.coveredPersonaCount || 0) >= 16 ? 'green' : (account.coveredPersonaCount || 0) >= 8 ? 'amber' : 'red',
      detail: 'Based on target_persona field population',
    },
  ]

  const statusColor = s => s === 'green' ? 'var(--green)' : s === 'amber' ? 'var(--amber)' : 'var(--red)'
  const statusBg    = s => s === 'green' ? 'rgba(52,201,122,.08)' : s === 'amber' ? 'rgba(245,166,35,.08)' : 'rgba(240,82,82,.08)'
  const statusIcon  = s => s === 'green' ? '✓' : s === 'amber' ? '◐' : '✗'

  return (
    <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:8 }}>
      {factors.map((f,i) => (
        <div key={i} style={{ display:'flex', alignItems:'flex-start', gap:10, padding:'8px 10px', borderRadius:'var(--radius)',
          background:statusBg(f.status), border:`1px solid ${statusColor(f.status)}33` }}>
          <span style={{ fontSize:14, color:statusColor(f.status), flexShrink:0, marginTop:1 }}>{statusIcon(f.status)}</span>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline' }}>
              <span style={{ fontSize:11, fontWeight:600, color:'var(--text)' }}>{f.label}</span>
              <span style={{ fontSize:11, fontWeight:700, color:statusColor(f.status), fontFamily:'monospace', marginLeft:8, flexShrink:0 }}>{f.value}</span>
            </div>
            <div style={{ fontSize:10, color:'var(--text-tertiary)', marginTop:2, lineHeight:1.4 }}>{f.detail}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

// Health score ring with hover tooltip breakdown
function HealthRing({ account }) {
  const [show, setShow] = useState(false)
  if (!account) return null

  const s = account.healthStatus || 'cold'
  const color = hcColor(s)

  // Score breakdown
  const daysSince     = account.daysSinceActivity
  const recencyPts    = daysSince == null ? 0 : daysSince <= 7 ? 35 : daysSince <= 14 ? 25 : daysSince <= 30 ? 15 : daysSince <= 60 ? 5 : 0
  const engagePts     = account.lastEngagement?.type === 'replied' ? 30 : account.lastEngagement?.type === 'clicked' ? 15 : account.lastEngagement?.type === 'opened' ? 8 : 0
  const contactPts    = (account.numContacts || 0) >= 10 ? 15 : (account.numContacts || 0) >= 5 ? 10 : (account.numContacts || 0) >= 2 ? 5 : 0
  const meetingPts    = account.lastBooked ? 15 : 0
  const personaPts    = Math.round(((account.coveredPersonaCount || 0) / 22) * 5)
  const total         = Math.min(100, recencyPts + engagePts + contactPts + meetingPts + personaPts)

  const breakdown = [
    { label:'Recency of activity',   pts:recencyPts, max:35,  detail: daysSince != null ? `Last activity ${daysSince}d ago` : 'No activity' },
    { label:'Engagement depth',      pts:engagePts,  max:30,  detail: account.lastEngagement?.type === 'replied' ? 'Has replies' : account.lastEngagement?.type || 'No engagement' },
    { label:'Contact coverage',      pts:contactPts, max:15,  detail: `${account.numContacts || 0} contacts` },
    { label:'Meeting booked',        pts:meetingPts, max:15,  detail: account.lastBooked ? new Date(account.lastBooked).toLocaleDateString() : 'None' },
    { label:'Persona data quality',  pts:personaPts, max:5,   detail: `${account.coveredPersonaCount || 0}/22 personas tagged` },
  ]

  return (
    <div style={{ position:'relative', display:'inline-block' }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}>
      <div style={{ width:60, height:60, borderRadius:'50%', border:`3px solid ${color}`,
        display:'flex', alignItems:'center', justifyContent:'center', cursor:'help',
        background: show ? statusBg(s) : 'transparent', transition:'background .15s' }}>
        <span style={{ fontSize:17, fontWeight:700, color, fontFamily:'monospace' }}>{account.health}</span>
      </div>
      <div style={{ fontSize:9, color:'var(--text-tertiary)', textAlign:'center', marginTop:3, textTransform:'uppercase' }}>{s}</div>
      {show && (
        <div style={{ position:'absolute', top:'calc(100% + 8px)', left:'50%', transform:'translateX(-50%)',
          background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)',
          padding:'10px 12px', zIndex:200, width:220, boxShadow:'0 4px 20px rgba(0,0,0,.4)' }}>
          <div style={{ fontSize:11, fontWeight:600, color:'var(--text)', marginBottom:8 }}>
            Health Score: {total}/100
          </div>
          {breakdown.map((b,i) => (
            <div key={i} style={{ marginBottom:6 }}>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:10, marginBottom:2 }}>
                <span style={{ color:'var(--text-secondary)' }}>{b.label}</span>
                <span style={{ fontWeight:600, color:b.pts>0?'var(--green)':'var(--text-tertiary)', fontFamily:'monospace' }}>{b.pts}/{b.max}</span>
              </div>
              <div style={{ height:4, background:'var(--border)', borderRadius:2, overflow:'hidden' }}>
                <div style={{ width:`${(b.pts/b.max)*100}%`, height:'100%', background:b.pts>=b.max*0.7?'var(--green)':b.pts>0?'var(--amber)':'transparent', borderRadius:2 }} />
              </div>
              <div style={{ fontSize:9, color:'var(--text-tertiary)', marginTop:1 }}>{b.detail}</div>
            </div>
          ))}
          <div style={{ fontSize:9, color:'var(--text-tertiary)', marginTop:6, paddingTop:6, borderTop:'1px solid var(--border)' }}>
            Hover over score ring for breakdown
          </div>
        </div>
      )}
    </div>
  )
}

// Helper for gap summary background
const statusBg = s => s==='active'?'rgba(52,201,122,.06)':s==='attention'?'rgba(245,166,35,.06)':s==='risk'?'rgba(240,82,82,.06)':'var(--bg-secondary)'

// Gap list with priority badges
function GapList({ missingPersonas, maxShow = 8 }) {
  const [showAll, setShowAll] = useState(false)
  if (!missingPersonas?.length) return <div style={{ fontSize:12, color:'var(--green)', padding:'8px 0' }}>✓ All personas mapped</div>
  const display = showAll ? missingPersonas : missingPersonas.slice(0, maxShow)
  return (
    <div>
      {display.map((g,i) => (
        <div key={i} style={{ display:'flex', alignItems:'center', gap:8, padding:'5px 0', borderBottom:'1px solid var(--border)' }}>
          <span style={{ fontSize:9, fontWeight:700, textTransform:'uppercase', padding:'2px 5px', borderRadius:3,
            color:prioColor(g.priority),
            background: g.priority==='critical'?'rgba(240,82,82,.12)':g.priority==='high'?'rgba(245,166,35,.12)':'var(--bg-secondary)',
            border:`1px solid ${prioColor(g.priority)}44`, flexShrink:0 }}>
            {g.priority}
          </span>
          <span style={{ fontSize:11, color:'var(--text-secondary)' }}>{g.label}</span>
        </div>
      ))}
      {missingPersonas.length > maxShow && (
        <button onClick={() => setShowAll(v => !v)} style={{ fontSize:10, color:'var(--accent)', background:'none', border:'none', cursor:'pointer', padding:'6px 0 0' }}>
          {showAll ? 'Show less' : `+${missingPersonas.length - maxShow} more gaps`}
        </button>
      )}
    </div>
  )
}

// Export helpers
function exportGoldCSV(accounts, filename) {
  const rows = [
    ['Rank','Account','Tier','BDR','VP','Health','Status','Days Since Activity','Contacts','Critical Gaps','High Gaps','Persona Coverage','Last Reply'],
    ...accounts.map((a,i) => [
      i+1, a.name, a.tier, a.assignedBdr, GOLD_OWNER_MAP[a.ownerId]||'',
      a.health, a.healthStatus,
      a.daysSinceActivity != null ? a.daysSinceActivity : 'N/A',
      a.numContacts||0, a.criticalGaps||0, a.highGaps||0,
      `${a.coveredPersonaCount||0}/${a.totalPersonas||22}`,
      a.lastEngagement?.type === 'replied' ? new Date(a.lastEngagement.date).toLocaleDateString() : 'None',
    ])
  ]
  const csv = rows.map(r => r.map(v => `"${String(v||'').replace(/"/g,'""')}"`).join(',')).join('\n')
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'}))
  link.download = filename || `gold-export-${new Date().toISOString().slice(0,10)}.csv`
  link.click()
}

function exportAccountCSV(a) {
  if (!a) return
  const rows = [
    ['Field','Value'],
    ['Account', a.name], ['Tier', a.tier], ['BDR', a.assignedBdr], ['VP', GOLD_OWNER_MAP[a.ownerId]||''],
    ['Health Score', a.health], ['Status', a.healthStatus],
    ['Days Since Activity', a.daysSinceActivity != null ? a.daysSinceActivity : 'N/A'],
    ['Total Contacts', a.numContacts||0], ['Notes', a.numNotes||0],
    ['Last Reply', a.lastEngagement?.type==='replied' ? a.lastEngagement.date : 'None'],
    ['Meeting Booked', a.lastBooked ? new Date(a.lastBooked).toLocaleDateString() : 'None'],
    ['Critical Gaps', a.criticalGaps||0], ['High Gaps', a.highGaps||0],
    ['Persona Coverage', `${a.coveredPersonaCount||0}/${a.totalPersonas||22}`],
    [''],
    ['PERSONA COVERAGE'],
    ['Persona','Priority','Status','Contacts'],
    ...(a.personaCoverage||[]).map(p => [p.label, p.priority, p.engagement, p.contacts.map(c=>c.name).join(', ')]),
    [''],
    ['CONTACTS'],
    ['Name','Title','Target Persona','Buying Role','In Sequence','Last Reply','Last Send'],
    ...(a.contacts||[]).map(c => [c.name, c.title, c.persona, c.buyingRole, c.inSequence?'Yes':'No',
      c.lastReply ? new Date(c.lastReply).toLocaleDateString() : '—',
      c.lastSent  ? new Date(c.lastSent).toLocaleDateString()  : '—',
    ])
  ]
  const csv = rows.map(r => r.map(v => `"${String(v||'').replace(/"/g,'""')}"`).join(',')).join('\n')
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'}))
  link.download = `gold-${(a.name||'account').replace(/[^a-z0-9]/gi,'-').toLowerCase()}.csv`
  link.click()
}

// Controls bar shared by both tabs
function GoldControls({ search, setSearch, filterBdr, setFilterBdr, BDR_OPTIONS, goldTabTier, setGoldTabTier, sortBy, setSortBy, onRefresh, onExport, extraRight }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap', marginBottom:12 }}>
      <div style={{ display:'flex', alignItems:'center', gap:6, background:'rgba(245,166,35,.12)', border:'1px solid rgba(245,166,35,.35)', borderRadius:'var(--radius)', padding:'4px 10px', flexShrink:0 }}>
        <span style={{ fontSize:12 }}>⭐</span>
        <span style={{ fontSize:10, fontWeight:600, letterSpacing:'.06em', textTransform:'uppercase', color:'var(--amber)' }}>Gold</span>
      </div>
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search accounts…"
        style={{ flex:1, minWidth:140, padding:'6px 10px', background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:12, color:'var(--text)', outline:'none' }} />
      <Select value={filterBdr} onChange={setFilterBdr} options={[{value:'',label:'All Reps'}, ...BDR_OPTIONS]} />
      <Select value={goldTabTier} onChange={setGoldTabTier} options={GOLD_TIER_OPTIONS} />
      <Select value={sortBy} onChange={setSortBy} options={[
        {value:'tier',label:'Tier'},{value:'health',label:'Health'},
        {value:'activity',label:'Activity'},{value:'gaps',label:'Critical Gaps'},
        {value:'coverage',label:'Coverage'},
      ]} />
      {extraRight}
      {onExport && <button onClick={onExport} style={{ padding:'6px 12px', background:'none', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:11, color:'var(--text-secondary)', cursor:'pointer', flexShrink:0 }}>Export CSV</button>}
      <button onClick={onRefresh} style={{ padding:'6px 12px', background:'none', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:11, color:'var(--accent)', cursor:'pointer', flexShrink:0 }}>↻</button>
    </div>
  )
}

// ─── Gold Overview Tab ────────────────────────────────────────────────────────
function GoldOverviewTab({ accounts, meta, loading, onRefresh, filterBdr, setFilterBdr, BDR_OPTIONS, goldTabTier, setGoldTabTier }) {
  const [sortBy, setSortBy]   = useState('tier')
  const [search, setSearch]   = useState('')
  const [view, setView]       = useState('pipeline') // 'pipeline' | 'reporting'
  const filtered = useGoldSort(accounts, search, sortBy)

  // Pipeline health buckets
  const active    = filtered.filter(a => a.healthStatus === 'active')
  const attention = filtered.filter(a => a.healthStatus === 'attention')
  const risk      = filtered.filter(a => a.healthStatus === 'risk')
  const cold      = filtered.filter(a => a.healthStatus === 'cold')

  // Persona gap rollup across all accounts
  const personaGapRollup = useMemo(() => {
    const map = {}
    TARGET_PERSONAS.forEach(p => { map[p.value] = { label:p.label, priority:p.priority, missing:0, total:filtered.length } })
    filtered.forEach(a => {
      ;(a.missingPersonas||[]).forEach(g => { if (map[g.value]) map[g.value].missing++ })
    })
    return Object.values(map)
      .filter(p => p.missing > 0)
      .sort((a,b) => {
        const po = {critical:0,high:1,medium:2}
        if (po[a.priority] !== po[b.priority]) return po[a.priority] - po[b.priority]
        return b.missing - a.missing
      })
  }, [filtered])

  // Rep performance summary
  const repSummary = useMemo(() => {
    const map = {}
    filtered.forEach(a => {
      const key = a.assignedBdr || 'Unassigned'
      if (!map[key]) map[key] = { name:key, accounts:0, active:0, avgHealth:0, totalHealth:0, critGaps:0, withReplies:0 }
      map[key].accounts++
      if (a.healthStatus==='active') map[key].active++
      map[key].totalHealth += a.health||0
      map[key].critGaps    += a.criticalGaps||0
      if (a.lastEngagement?.type==='replied') map[key].withReplies++
    })
    return Object.values(map).map(r => ({
      ...r, avgHealth: r.accounts > 0 ? Math.round(r.totalHealth/r.accounts) : 0
    })).sort((a,b) => b.avgHealth - a.avgHealth)
  }, [filtered])

  const exportPipelineCSV = () => {
    const rows = [
      ['Account','Tier','BDR','VP','Health','Status','Days Inactive','Contacts','Critical Gaps','Coverage','Last Reply'],
      ...filtered.map(a => [
        a.name, a.tier, a.assignedBdr, GOLD_OWNER_MAP[a.ownerId]||'',
        a.health, a.healthStatus,
        a.daysSinceActivity!=null?a.daysSinceActivity:'N/A',
        a.numContacts||0, a.criticalGaps||0,
        `${a.coveredPersonaCount||0}/22`,
        a.lastEngagement?.type==='replied'?new Date(a.lastEngagement.date).toLocaleDateString():'None',
      ])
    ]
    const csv = rows.map(r=>r.map(v=>`"${String(v||'').replace(/"/g,'""')}"`).join(',')).join('\n')
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'}))
    link.download = `gold-pipeline-${new Date().toISOString().slice(0,10)}.csv`; link.click()
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
      {/* Controls */}
      <GoldControls
        search={search} setSearch={setSearch}
        filterBdr={filterBdr} setFilterBdr={setFilterBdr} BDR_OPTIONS={BDR_OPTIONS}
        goldTabTier={goldTabTier} setGoldTabTier={setGoldTabTier}
        sortBy={sortBy} setSortBy={setSortBy}
        onRefresh={onRefresh} onExport={exportPipelineCSV}
        extraRight={
          <div style={{ display:'flex', background:'var(--bg-panel)', borderRadius:'var(--radius)', border:'1px solid var(--border)', padding:3, gap:2 }}>
            {[{k:'pipeline',l:'Pipeline'},{k:'reporting',l:'Reporting'}].map(({k,l}) => (
              <button key={k} onClick={() => setView(k)}
                style={{ fontSize:12, padding:'4px 12px', borderRadius:'var(--radius)', border:'none', cursor:'pointer',
                  fontWeight:view===k?500:400, background:view===k?'var(--bg-secondary)':'transparent',
                  color:view===k?'var(--text)':'var(--text-secondary)' }}>{l}</button>
            ))}
          </div>
        }
      />

      {view === 'pipeline' && (
        <>
          {/* Top KPIs */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(8,1fr)', gap:8 }}>
            <KpiCard label="Total Accounts"    value={filtered.length} />
            <KpiCard label="Active"            value={active.length}    accent />
            <KpiCard label="Needs Attention"   value={attention.length} />
            <KpiCard label="At Risk"           value={risk.length + cold.length} />
            <KpiCard label="Avg Health"        value={`${meta.avgHealth||0}%`} />
            <KpiCard label="With Replies"      value={meta.withReplies||0} accent />
            <KpiCard label="Critical Gaps"     value={meta.totalCriticalGaps||0} />
            <KpiCard label="Avg Coverage"      value={`${meta.avgPersonaCoverage||0}/22`} />
          </div>

          {loading
            ? <div style={{ padding:40, textAlign:'center', color:'var(--text-tertiary)' }}>Loading…</div>
            : <>
              {/* Pipeline health buckets */}
              <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12 }}>
                {[
                  { label:'Active', accounts:active,    color:'var(--green)',  bg:'rgba(52,201,122,.06)',  border:'rgba(52,201,122,.25)' },
                  { label:'Needs Attention', accounts:attention, color:'var(--amber)', bg:'rgba(245,166,35,.06)', border:'rgba(245,166,35,.25)' },
                  { label:'At Risk', accounts:risk,      color:'var(--red)',    bg:'rgba(240,82,82,.06)',   border:'rgba(240,82,82,.25)' },
                  { label:'Cold',   accounts:cold,       color:'var(--text-tertiary)', bg:'var(--bg-secondary)', border:'var(--border)' },
                ].map((bucket,i) => (
                  <div key={i} style={{ background:bucket.bg, border:`1px solid ${bucket.border}`, borderRadius:'var(--radius)', overflow:'hidden' }}>
                    <div style={{ padding:'8px 12px', borderBottom:`1px solid ${bucket.border}`, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                      <span style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:'.06em', color:bucket.color }}>{bucket.label}</span>
                      <span style={{ fontSize:16, fontWeight:700, color:bucket.color, fontFamily:'monospace' }}>{bucket.accounts.length}</span>
                    </div>
                    <div style={{ maxHeight:220, overflowY:'auto', padding:'4px 6px' }}>
                      {bucket.accounts.length === 0
                        ? <div style={{ padding:'12px 6px', fontSize:11, color:'var(--text-tertiary)', textAlign:'center' }}>None</div>
                        : bucket.accounts.map((a,j) => (
                          <div key={j} style={{ padding:'5px 6px', display:'flex', alignItems:'center', gap:8, borderBottom:'1px solid rgba(255,255,255,.04)', fontSize:11 }}>
                            <div style={{ flex:1, minWidth:0 }}>
                              <div style={{ fontWeight:500, color:'var(--text)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{a.name}</div>
                              <div style={{ fontSize:9, color:'var(--text-tertiary)' }}>{a.tier.replace('GOLD - ','')} · {a.assignedBdr||'—'}</div>
                            </div>
                            <span style={{ fontFamily:'monospace', fontSize:10, fontWeight:700, color:bucket.color, flexShrink:0 }}>{a.health}</span>
                          </div>
                        ))
                      }
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
                {/* Rep performance */}
                <Panel>
                  <SectionTitle>Performance by Rep</SectionTitle>
                  <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                    <THead cols={['Rep','Accounts','Active','Avg Health','Replies','Crit Gaps']} />
                    <tbody>
                      {repSummary.map((r,i) => (
                        <tr key={i} style={{ borderBottom:'1px solid var(--border)' }}>
                          <td style={{ padding:'7px 10px 7px 0', fontWeight:500 }}>{r.name}</td>
                          <td style={{ padding:'7px 10px 7px 0' }}>{r.accounts}</td>
                          <td style={{ padding:'7px 10px 7px 0', color:'var(--green)' }}>{r.active}</td>
                          <td style={{ padding:'7px 10px 7px 0', fontFamily:'monospace', fontWeight:600,
                            color:r.avgHealth>=65?'var(--green)':r.avgHealth>=35?'var(--amber)':'var(--red)' }}>{r.avgHealth}</td>
                          <td style={{ padding:'7px 10px 7py 0', color:'var(--accent)' }}>{r.withReplies}</td>
                          <td style={{ padding:'7px 0', color:r.critGaps>0?'var(--red)':'var(--text-tertiary)' }}>{r.critGaps}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Panel>

                {/* Portfolio-wide persona gaps */}
                <Panel>
                  <SectionTitle>Top Persona Gaps Across Portfolio</SectionTitle>
                  {personaGapRollup.slice(0,10).map((g,i) => (
                    <div key={i} style={{ display:'flex', alignItems:'center', gap:10, marginBottom:8 }}>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ display:'flex', justifyContent:'space-between', marginBottom:2 }}>
                          <span style={{ fontSize:11, color:'var(--text-secondary)' }}>{g.label}</span>
                          <span style={{ fontSize:11, fontWeight:600, color:prioColor(g.priority), flexShrink:0, marginLeft:8 }}>
                            {g.missing}/{g.total}
                          </span>
                        </div>
                        <div style={{ height:5, background:'var(--border)', borderRadius:3, overflow:'hidden' }}>
                          <div style={{ width:`${(g.missing/g.total)*100}%`, height:'100%',
                            background:g.priority==='critical'?'var(--red)':g.priority==='high'?'var(--amber)':'var(--text-tertiary)',
                            borderRadius:3 }} />
                        </div>
                      </div>
                      <span style={{ fontSize:9, fontWeight:600, textTransform:'uppercase', color:prioColor(g.priority), flexShrink:0, width:48, textAlign:'right' }}>{g.priority}</span>
                    </div>
                  ))}
                </Panel>
              </div>

              {/* No activity alerts */}
              {filtered.filter(a => a.daysSinceActivity==null || a.daysSinceActivity > 30).length > 0 && (
                <Panel>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
                    <SectionTitle style={{ margin:0 }}>No Activity in 30+ Days</SectionTitle>
                    <span style={{ fontSize:10, fontWeight:700, color:'var(--red)', background:'rgba(240,82,82,.1)', borderRadius:4, padding:'2px 8px' }}>
                      {filtered.filter(a => a.daysSinceActivity==null || a.daysSinceActivity > 30).length} accounts
                    </span>
                  </div>
                  <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
                    {filtered.filter(a => a.daysSinceActivity==null || a.daysSinceActivity > 30)
                      .sort((a,b) => (b.daysSinceActivity||999) - (a.daysSinceActivity||999))
                      .slice(0,20)
                      .map((a,i) => (
                        <a key={i} href={a.url} target="_blank" rel="noopener noreferrer"
                          style={{ fontSize:11, padding:'4px 10px', borderRadius:'var(--radius)',
                            background:'rgba(240,82,82,.06)', border:'1px solid rgba(240,82,82,.2)',
                            color:'var(--text)', textDecoration:'none', display:'inline-flex', gap:6, alignItems:'center' }}>
                          <span>{a.name}</span>
                          <span style={{ color:'var(--red)', fontFamily:'monospace', fontSize:10 }}>
                            {a.daysSinceActivity!=null?`${a.daysSinceActivity}d`:'never'}
                          </span>
                        </a>
                      ))
                    }
                  </div>
                </Panel>
              )}
            </>
          }
        </>
      )}

      {view === 'reporting' && (
        <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10 }}>
            <KpiCard label="Total Accounts"  value={filtered.length} />
            <KpiCard label="Avg Health"      value={`${meta.avgHealth||0}%`} />
            <KpiCard label="Critical Gaps"   value={meta.totalCriticalGaps||0} />
            <KpiCard label="Avg Coverage"    value={`${meta.avgPersonaCoverage||0}/22`} />
          </div>

          {/* Persona coverage chart */}
          <Panel>
            <SectionTitle>Persona Coverage Across Gold Portfolio</SectionTitle>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:8 }}>
              {TARGET_PERSONAS.map((p,i) => {
                const covered = filtered.filter(a =>
                  (a.personaCoverage||[]).find(pc => pc.persona===p.value && pc.covered)
                ).length
                const total = filtered.length || 1
                const pct = Math.round((covered/total)*100)
                return (
                  <div key={i} style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:2 }}>
                        <span style={{ fontSize:11, color:'var(--text-secondary)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                          {p.priority==='critical' && <span style={{ color:'var(--red)', marginRight:4 }}>●</span>}
                          {p.priority==='high' && <span style={{ color:'var(--amber)', marginRight:4 }}>●</span>}
                          {p.label}
                        </span>
                        <span style={{ fontSize:11, fontWeight:600, color:pct>=80?'var(--green)':pct>=50?'var(--amber)':'var(--red)', flexShrink:0, marginLeft:8 }}>{pct}%</span>
                      </div>
                      <div style={{ height:5, background:'var(--border)', borderRadius:3, overflow:'hidden' }}>
                        <div style={{ width:`${pct}%`, height:'100%', borderRadius:3,
                          background:pct>=80?'var(--green)':pct>=50?'var(--amber)':'var(--red)' }} />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </Panel>

          {/* Full table */}
          <Panel>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
              <SectionTitle style={{ margin:0 }}>Full Account List ({filtered.length})</SectionTitle>
              <button onClick={exportPipelineCSV}
                style={{ padding:'6px 12px', background:'none', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:11, color:'var(--text-secondary)', cursor:'pointer' }}>
                Export CSV
              </button>
            </div>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
              <THead cols={['Account','Tier','BDR','VP','Health','Status','Days','Contacts','Crit','Cover','Last Reply']} />
              <tbody>
                {filtered.map((a,i) => (
                  <tr key={i} style={{ borderBottom:'1px solid var(--border)' }}
                    onMouseEnter={e => e.currentTarget.style.background='var(--bg-secondary)'}
                    onMouseLeave={e => e.currentTarget.style.background=''}>
                    <td style={{ padding:'7px 10px 7px 0', fontWeight:500 }}>
                      <a href={a.url} target="_blank" rel="noopener noreferrer" style={{ color:'var(--accent)', textDecoration:'none' }}>{a.name}</a>
                    </td>
                    <td style={{ padding:'7px 10px 7px 0', fontSize:10, color:'var(--text-tertiary)' }}>{a.tier.replace('GOLD - ','')}</td>
                    <td style={{ padding:'7px 10px 7px 0', color:'var(--text-secondary)' }}>{a.assignedBdr||'—'}</td>
                    <td style={{ padding:'7px 10px 7px 0', color:'var(--text-secondary)' }}>{GOLD_OWNER_MAP[a.ownerId]||'—'}</td>
                    <td style={{ padding:'7px 10px 7px 0', fontFamily:'monospace', fontWeight:700, color:hcColor(a.healthStatus) }}>{a.health}</td>
                    <td style={{ padding:'7px 10px 7px 0' }}>
                      <span style={{ fontSize:9, fontWeight:700, textTransform:'uppercase', color:hcColor(a.healthStatus) }}>{a.healthStatus}</span>
                    </td>
                    <td style={{ padding:'7px 10px 7px 0', color:(a.daysSinceActivity||0)>30?'var(--red)':'var(--text-secondary)' }}>{a.daysSinceActivity!=null?`${a.daysSinceActivity}d`:'—'}</td>
                    <td style={{ padding:'7px 10px 7px 0' }}>{a.numContacts||0}</td>
                    <td style={{ padding:'7px 10px 7px 0', color:(a.criticalGaps||0)>0?'var(--red)':'var(--text-tertiary)' }}>{a.criticalGaps||0}</td>
                    <td style={{ padding:'7px 10px 7px 0', color:(a.coveredPersonaCount||0)<12?'var(--amber)':'var(--text-secondary)' }}>{a.coveredPersonaCount||0}/22</td>
                    <td style={{ padding:'7px 0', color:a.lastEngagement?.type==='replied'?'var(--green)':'var(--text-tertiary)', whiteSpace:'nowrap' }}>
                      {a.lastEngagement?.type==='replied'?new Date(a.lastEngagement.date).toLocaleDateString():'—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
      )}
    </div>
  )
}

// Per-account To-Do section for Gold Command tab
// Filters the shared todo store to items linked to this company,
// and allows creating new items that also appear on the main Dashboard.
function GoldAccountTodo({ account, safeFetch }) {
  const [items, setItems]       = useState([])
  const [loading, setLoading]   = useState(false)
  const [input, setInput]       = useState('')
  const [dueDate, setDueDate]   = useState('')
  const [saving, setSaving]     = useState(false)

  const companyId = account?.id

  // Fetch todos for this company -- filter by contactId or hubspotUrl containing companyId
  const fetchTodos = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    try {
      const data = await safeFetch('/api/hubspot/todo')
      const all = data.items || data || []
      // Filter: items linked to this company via hubspotUrl or subtext containing company name
      const accountItems = all.filter(t =>
        (t.hubspotUrl && t.hubspotUrl.includes(`/0-2/${companyId}`)) ||
        (t.subtext && account?.name && t.subtext.toLowerCase().includes(account.name.toLowerCase())) ||
        (t.text && account?.name && t.autoDetected === false && t.companyId === companyId)
      )
      setItems(accountItems)
    } catch (e) { console.error('[gold-todo]', e) }
    finally { setLoading(false) }
  }, [companyId, safeFetch, account?.name])

  useEffect(() => { fetchTodos() }, [fetchTodos])

  const addItem = async () => {
    if (!input.trim()) return
    setSaving(true)
    try {
      await safeFetch('/api/hubspot/todo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text:        input.trim(),
          type:        'manual',
          dueDate:     dueDate || null,
          companyId,
          hubspotUrl:  account?.url,
          subtext:     account?.name || '',
        }),
      })
      setInput('')
      setDueDate('')
      fetchTodos()
    } catch (e) { console.error('[gold-todo add]', e) }
    finally { setSaving(false) }
  }

  const toggleItem = async (id, completed) => {
    setItems(prev => prev.map(t => t.id === id ? { ...t, completed, completedAt: completed ? new Date().toISOString() : null } : t))
    try {
      await safeFetch(`/api/hubspot/todo/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed }),
      })
    } catch (e) { console.error('[gold-todo toggle]', e) }
  }

  const deleteItem = async (id) => {
    setItems(prev => prev.filter(t => t.id !== id))
    try {
      await safeFetch(`/api/hubspot/todo/${id}`, { method: 'DELETE' })
    } catch (e) { console.error('[gold-todo delete]', e) }
  }

  const active    = items.filter(t => !t.completed)
  const completed = items.filter(t => t.completed)

  return (
    <div style={{ background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)', overflow:'hidden' }}>
      <div style={{ padding:'9px 13px', borderBottom:'1px solid var(--border)', background:'var(--bg-secondary)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <span style={{ fontSize:10, fontWeight:600, letterSpacing:'.07em', textTransform:'uppercase', color:'var(--text-tertiary)' }}>
          Account To-Do {items.length > 0 && <span style={{ color:'var(--accent)', marginLeft:6 }}>{active.length}</span>}
        </span>
        <span style={{ fontSize:10, color:'var(--text-tertiary)' }}>Also appears on main Dashboard</span>
      </div>
      <div style={{ padding:'10px 13px', display:'flex', flexDirection:'column', gap:8 }}>
        {/* Add input */}
        <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
          <input value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addItem()}
            placeholder={`Add to-do for ${account?.name||'account'}…`}
            style={{ flex:1, minWidth:160, padding:'6px 10px', background:'var(--bg-secondary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:12, color:'var(--text)', outline:'none' }} />
          <input type="datetime-local" value={dueDate} onChange={e => setDueDate(e.target.value)}
            style={{ padding:'6px 8px', background:'var(--bg-secondary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:11, color:'var(--text)', outline:'none' }} />
          <button onClick={addItem} disabled={saving || !input.trim()}
            style={{ padding:'6px 14px', background:'var(--accent)', color:'#fff', border:'none', borderRadius:'var(--radius)', fontSize:12, fontWeight:500, cursor:'pointer', opacity:saving||!input.trim()?0.6:1 }}>
            {saving ? '…' : 'Add'}
          </button>
        </div>

        {loading && <div style={{ fontSize:12, color:'var(--text-tertiary)' }}>Loading…</div>}

        {/* Active items */}
        {active.map(item => (
          <div key={item.id} style={{ display:'flex', alignItems:'flex-start', gap:8, padding:'5px 4px', borderRadius:'var(--radius)' }}
            onMouseEnter={e => e.currentTarget.style.background='var(--bg-secondary)'}
            onMouseLeave={e => e.currentTarget.style.background='transparent'}>
            <input type="checkbox" checked={false} onChange={() => toggleItem(item.id, true)}
              style={{ flexShrink:0, cursor:'pointer', accentColor:'var(--accent)', width:15, height:15, marginTop:2 }} />
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:12, color:'var(--text)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{item.text}</div>
              <div style={{ display:'flex', gap:8, marginTop:2 }}>
                {item.createdAt && <span style={{ fontSize:10, color:'var(--text-tertiary)' }}>
                  Added {new Date(item.createdAt).toLocaleDateString()}
                </span>}
                {item.dueDate && <span style={{ fontSize:10, fontWeight:600,
                  color:new Date(item.dueDate)<new Date()?'var(--red)':'var(--amber)' }}>
                  Due {new Date(item.dueDate).toLocaleDateString()}
                </span>}
              </div>
            </div>
            <button onClick={() => deleteItem(item.id)}
              style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-tertiary)', fontSize:14, padding:0, flexShrink:0 }}>×</button>
          </div>
        ))}

        {!loading && active.length === 0 && (
          <div style={{ fontSize:11, color:'var(--text-tertiary)', padding:'4px 0' }}>No open tasks for this account.</div>
        )}

        {/* Completed */}
        {completed.length > 0 && (
          <>
            <div style={{ fontSize:9, fontWeight:600, textTransform:'uppercase', letterSpacing:'.05em', color:'var(--text-tertiary)', paddingTop:8, borderTop:'1px solid var(--border)', marginTop:4 }}>
              Completed
            </div>
            {completed.map(item => (
              <div key={item.id} style={{ display:'flex', alignItems:'center', gap:8, padding:'4px', opacity:0.55 }}>
                <input type="checkbox" checked={true} onChange={() => toggleItem(item.id, false)}
                  style={{ flexShrink:0, cursor:'pointer', accentColor:'var(--accent)', width:15, height:15 }} />
                <div style={{ flex:1, fontSize:11, color:'var(--text-tertiary)', textDecoration:'line-through',
                  overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{item.text}</div>
                {item.completedAt && <span style={{ fontSize:10, color:'var(--text-tertiary)', flexShrink:0 }}>
                  ✓ {new Date(item.completedAt).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}
                </span>}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}

function GoldCommandTab({ accounts, loading, onRefresh, safeFetch, filterBdr, setFilterBdr, BDR_OPTIONS, goldTabTier, setGoldTabTier }) {
  const [search, setSearch]     = useState('')
  const [selected, setSelected] = useState(null)
  const [sortBy, setSortBy]     = useState('tier')
  const [view, setView]         = useState('workspace') // 'workspace' | 'reporting'
  const [gapState, setGapState]     = useState({}) // keyed by "companyId:persona"
  const [gapRunning, setGapRunning] = useState(false)
  const [gapProgress, setGapProgress] = useState('')
  const [mapVersion, setMapVersion] = useState(0) // increment to force persona map refresh
  const [gapLastRun, setGapLastRun]   = useState({}) // keyed by companyId -> ISO date
  const [gapCacheLoaded, setGapCacheLoaded] = useState(false)

  // Load cached gap results from Azure Blob on mount
  useEffect(() => {
    if (gapCacheLoaded) return
    setGapCacheLoaded(true)
    safeFetch('/api/hubspot/gap-cache').then(data => {
      if (data?.gapState)   setGapState(data.gapState)
      if (data?.gapLastRun) setGapLastRun(data.gapLastRun)
    }).catch(() => {})
  }, [])

  // Save gap results to Azure Blob
  const saveGapCache = async (newGapState, newLastRun) => {
    safeFetch('/api/hubspot/gap-cache', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gapState: newGapState, gapLastRun: newLastRun }),
    }).catch(() => {})
  }
  const filtered = useGoldSort(accounts, search, sortBy)
  // Derive sel from current accounts (not stale selected reference) so Refresh map works
  const sel = (selected ? filtered.find(a => a.id === selected.id) : null) || filtered[0] || null

  const searchGap = async (companyId, companyName, domain, persona, existingContacts = []) => {
    const key = `${companyId}:${persona}`
    setGapState(s => ({ ...s, [key]: { status: 'searching', result: null } }))
    try {
      // Pass existing CRM contacts so the model can reason about title fit
      // and avoid creating duplicates for people already in the CRM
      // Gold route returns flattened objects: { name, title, persona, ... }
      const contactContext = existingContacts.map(c => ({
        name:    c.name || '',
        title:   c.title || '',
        persona: c.persona || '',
      })).filter(c => c.name)

      const data = await safeFetch('/api/hubspot-gap-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyName,
          domain,
          missingPersonas:  [persona],
          existingContacts: contactContext,
        }),
      })
      const found = (data.found || []).find(f => f.persona === persona) || null
      setGapState(s => ({ ...s, [key]: { status: 'done', result: found } }))
    } catch(e) {
      setGapState(s => ({ ...s, [key]: { status: 'error', result: null, error: e.message } }))
    }
  }

  const exportGapResults = (account) => {
    const key = account?.id
    if (!key) return

    const assignedBdr = account.assignedBdr || account.bdr || ''
    const slug = (account.name||'account').replace(/[^a-z0-9]+/gi,'-')
    const date = new Date().toISOString().slice(0,10)
    const toCSV = rows => rows.map(r =>
      r.map(c => `"${String(c||'').replace(/"/g,'""')}"`).join(',')
    ).join('\n')

    // ── File 1: HubSpot import (new contacts to create) ───────────────────────
    // Two sets of rows:
    // 1. NEW contacts to import (not in CRM)
    // 2. EXISTING contacts that need target_persona updated
    const importRows = [['First Name','Last Name','Email','Job Title','Company Name',
      'Email Domain','Company Domain Name','Company Record ID',
      'Target Persona','Assigned BDR','LinkedIn URL','Status']]
    const updateRows = [['First Name','Last Name','Job Title','Current Persona','Recommended Persona',
      'Action Needed','Title Fit Reasoning']]
    Object.entries(gapState)
      .filter(([k]) => k.startsWith(key+':'))
      .forEach(([k, v]) => {
        const persona = k.replace(key+':', '')
        const r = v.result
        if (!r?.name) return
        const parts = r.name.trim().split(' ')
        if (r.alreadyInCRM) {
          // Already in CRM — add to update list (needs target_persona set)
          updateRows.push([parts[0]||'', parts.slice(1).join(' ')||'',
            r.title||'', '', persona,
            'Update target_persona in HubSpot',
            r.titleFitReasoning||''])
        } else {
          // New contact — add to import list
          const emailDomain = r.email ? r.email.split('@')[1] : (account.domain||'')
          importRows.push([parts[0]||'', parts.slice(1).join(' ')||'',
            r.email||'', r.title||'', account.name||'',
            emailDomain,
            account.domain||'',
            key||'',
            persona, assignedBdr, r.linkedinUrl||'', 'NEW'])
        }
      })

    // ── File 2: Update personas file (existing CRM contacts needing target_persona) ──
    if (updateRows.length > 1) {
      const a3 = document.createElement('a')
      a3.href = URL.createObjectURL(new Blob([toCSV(updateRows)], { type: 'text/csv' }))
      a3.download = `UPDATE-PERSONAS-${slug}-${date}.csv`
      a3.click()
    }

    // ── File 3: Full review file ───────────────────────────────────────────────
    const reviewRows = [['Status','Persona','Name','Title','Email','LinkedIn','Source','Confidence','Notes']]
    ;(account.personaCoverage||[]).filter(p => p.covered).forEach(p => {
      const c = p.contacts?.[0]
      reviewRows.push(['In CRM', p.persona, c?.name||'', c?.title||'', '', '', 'HubSpot', 'confirmed', ''])
    })
    Object.entries(gapState).filter(([k]) => k.startsWith(key+':')).forEach(([k, v]) => {
      const persona = k.replace(key+':', '')
      const r = v.result
      reviewRows.push([
        r?.name ? 'Found - needs import' : 'Not found',
        persona, r?.name||'', r?.title||'', r?.email||'',
        r?.linkedinUrl||'', r?.source||'', r?.confidence||'', r?.notes||''
      ])
    })

    if (importRows.length > 1) {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([toCSV(importRows)], { type: 'text/csv' }))
      a.download = `UPLOAD-TO-HUBSPOT-gap-contacts-${slug}-${date}.csv`
      a.click()
    }
    setTimeout(() => {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([toCSV(reviewRows)], { type: 'text/csv' }))
      a.download = `REVIEW-gap-analysis-${slug}-${date}.csv`
      a.click()
    }, 500)
  }

  const searchAllGaps = async (account) => {
    if (!account?.personaCoverage) return
    const missing = account.personaCoverage.filter(p => !p.covered).map(p => p.persona)
    if (!missing.length) return

    // Skip personas that already have a cached result with a name found
    const needsSearch = missing.filter(persona => {
      const cached = gapState[`${account.id}:${persona}`]
      return !cached?.result?.name // only search if no name was previously found
    })

    if (!needsSearch.length) {
      setGapProgress(`✓ All ${missing.length} gaps already searched — use Export Results to download`)
      return
    }

    setGapRunning(true)
    setGapProgress(`Searching ${needsSearch.length} personas (${missing.length - needsSearch.length} cached)...`)

    for (let i = 0; i < needsSearch.length; i++) {
      const persona = needsSearch[i]
      setGapProgress(`Searching ${i+1}/${needsSearch.length}: ${persona}...`)
      await searchGap(account.id, account.name, account.domain, persona, account.contacts || [])
      // Save after each result so a crash doesn't lose progress
      const newLastRun = { ...gapLastRun, [account.id]: new Date().toISOString() }
      saveGapCache(gapState, newLastRun)
      await new Promise(r => setTimeout(r, 1500))
    }
    const newLastRun = { ...gapLastRun, [account.id]: new Date().toISOString() }
    setGapLastRun(newLastRun)
    setGapProgress(`✓ Done — searched ${needsSearch.length} personas (${missing.length - needsSearch.length} cached)`)
    setGapRunning(false)
    saveGapCache(gapState, newLastRun)
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
      {/* Controls */}
      <GoldControls
        search={search} setSearch={setSearch}
        filterBdr={filterBdr} setFilterBdr={setFilterBdr} BDR_OPTIONS={BDR_OPTIONS}
        goldTabTier={goldTabTier} setGoldTabTier={setGoldTabTier}
        sortBy={sortBy} setSortBy={setSortBy}
        onRefresh={onRefresh}
        onExport={() => sel && exportAccountCSV(sel)}
        extraRight={
          <div style={{ display:'flex', background:'var(--bg-panel)', borderRadius:'var(--radius)', border:'1px solid var(--border)', padding:3, gap:2 }}>
            {[{k:'workspace',l:'Workspace'},{k:'reporting',l:'Reporting'}].map(({k,l}) => (
              <button key={k} onClick={() => setView(k)}
                style={{ fontSize:12, padding:'4px 12px', borderRadius:'var(--radius)', border:'none', cursor:'pointer', fontWeight:view===k?500:400,
                  background:view===k?'var(--bg-secondary)':'transparent', color:view===k?'var(--text)':'var(--text-secondary)' }}>
                {l}
              </button>
            ))}
          </div>
        }
      />

      {view === 'workspace' && (
        loading
          ? <div style={{ padding:40, textAlign:'center', color:'var(--text-tertiary)', fontSize:13 }}>Loading…</div>
          : <div style={{ display:'grid', gridTemplateColumns:'240px 1fr', border:'1px solid var(--border)', borderRadius:'var(--radius)', overflow:'hidden' }}>
            {/* Left: account picker */}
            <div style={{ borderRight:'1px solid var(--border)', display:'flex', flexDirection:'column' }}>
              <div style={{ padding:'8px 12px', borderBottom:'1px solid var(--border)', background:'var(--bg-panel)', fontSize:10, fontWeight:600, letterSpacing:'.06em', textTransform:'uppercase', color:'var(--text-tertiary)' }}>
                {filtered.length} Accounts
              </div>
              <div style={{ maxHeight:700, overflowY:'auto', padding:4, display:'flex', flexDirection:'column', gap:2 }}>
                {filtered.map(a => (
                  <div key={a.id} onClick={() => setSelected(a)}
                    style={{ padding:'8px 10px', borderRadius:'var(--radius)', cursor:'pointer',
                      background:sel?.id===a.id?'rgba(79,142,247,.12)':'transparent',
                      border:sel?.id===a.id?'1px solid var(--accent)':'1px solid transparent',
                      borderLeft:`3px solid ${hcColor(a.healthStatus)}` }}
                    onMouseEnter={e => { if(sel?.id!==a.id) e.currentTarget.style.background='var(--bg-secondary)' }}
                    onMouseLeave={e => { if(sel?.id!==a.id) e.currentTarget.style.background='transparent' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:12, fontWeight:sel?.id===a.id?600:400, color:'var(--text)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{a.name}</div>
                        <div style={{ fontSize:10, color:'var(--text-tertiary)' }}>{a.tier.replace('GOLD - ','')} · {a.assignedBdr||'—'}</div>
                      </div>
                      <div style={{ flexShrink:0, textAlign:'right' }}>
                        <div style={{ fontSize:10, fontWeight:700, color:hcColor(a.healthStatus), fontFamily:'monospace' }}>{a.health}</div>
                        {(a.criticalGaps||0) > 0 && <div style={{ fontSize:9, color:'var(--red)' }}>{a.criticalGaps}⚠</div>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Right: account workspace */}
            {!sel
              ? <div style={{ display:'flex', alignItems:'center', justifyContent:'center', color:'var(--text-tertiary)', fontSize:13, padding:40 }}>Select an account</div>
              : <div style={{ padding:16, display:'flex', flexDirection:'column', gap:14 }}>
                {/* Header */}
                <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:12 }}>
                  <div>
                    <div style={{ fontSize:20, fontWeight:700, color:'var(--text)', marginBottom:4 }}>{sel.name}</div>
                    <div style={{ fontSize:12, color:'var(--text-secondary)' }}>
                      {sel.tier} · {sel.city&&sel.state?`${sel.city}, ${sel.state} · `:''}BDR: {sel.assignedBdr||'—'} · VP: {GOLD_OWNER_MAP[sel.ownerId]||'—'}
                    </div>
                  </div>
                  <div style={{ display:'flex', gap:8, alignItems:'center', flexShrink:0 }}>
                    <HealthRing account={sel} />
                    <a href={sel.url} target="_blank" rel="noopener noreferrer"
                      style={{ padding:'7px 12px', background:'var(--accent)', color:'#fff', borderRadius:'var(--radius)', fontSize:12, fontWeight:500, textDecoration:'none' }}>
                      HubSpot ↗
                    </a>
                    <button onClick={() => exportAccountCSV(sel)}
                      style={{ padding:'7px 12px', background:'none', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:12, color:'var(--text-secondary)', cursor:'pointer' }}>
                      Export
                    </button>
                  </div>
                </div>

                {/* Account To-Do — above KPI bar */}
                <GoldAccountTodo account={sel} safeFetch={safeFetch} />

                {/* KPI row */}
                <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:10 }}>
                  <KpiCard label="Contacts"          value={sel.numContacts||0} />
                  <KpiCard label="Notes"             value={sel.numNotes||0} />
                  <KpiCard label="Days Inactive"     value={sel.daysSinceActivity!=null?`${sel.daysSinceActivity}d`:'—'} />
                  <KpiCard label="Persona Coverage"  value={`${sel.coveredPersonaCount||0}/22`} accent={(sel.coveredPersonaCount||0)>=16} />
                  <KpiCard label="Critical Gaps"     value={sel.criticalGaps||0} />
                </div>

                {/* Persona heatmap */}
                <div style={{ background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)', overflow:'hidden' }}>
                  <div style={{ padding:'9px 13px', borderBottom:'1px solid var(--border)', background:'var(--bg-secondary)', display:'flex', justifyContent:'space-between' }}>
                    <span style={{ fontSize:10, fontWeight:600, letterSpacing:'.07em', textTransform:'uppercase', color:'var(--text-tertiary)' }}>Persona Coverage Map</span>
                    <span style={{ fontSize:10, color:'var(--text-tertiary)' }}>{sel.coveredPersonaCount||0}/22 personas covered</span>
                  </div>
                  <div style={{ padding:'12px 13px' }}>
                    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:6 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <span style={{ fontSize:11, color:'var(--text-tertiary)' }}>
                        {sel.personaCoverage?.filter(p=>p.covered).length||0}/22 personas covered
                      </span>
                      <button onClick={() => { onRefresh(); setMapVersion(v => v+1); }}
                        title="Re-fetch contacts from HubSpot to update the persona map"
                        style={{ fontSize:11, padding:'4px 12px', background:'var(--bg-secondary)',
                          border:'1px solid var(--accent)', borderRadius:'var(--radius)',
                          color:'var(--accent)', cursor:'pointer', fontWeight:600 }}>
                        ↻ Refresh map
                      </button>
                    </div>
                    <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                      <button onClick={() => searchAllGaps(sel)} disabled={gapRunning}
                        style={{ fontSize:11, padding:'4px 10px', background: gapRunning ? 'var(--bg)' : 'var(--accent)',
                          color: gapRunning ? 'var(--text-tertiary)' : '#fff',
                          border:'none', borderRadius:'var(--radius)',
                          cursor: gapRunning ? 'not-allowed' : 'pointer', fontWeight:600 }}>
                        {gapRunning ? '⟳ Searching...' : '⬡ Find All Missing Contacts'}
                      </button>
                      {Object.keys(gapState).some(k => k.startsWith((sel?.id||'')+ ':')) && (
                        <button onClick={() => exportGapResults(sel)}
                          style={{ fontSize:11, padding:'4px 10px', background:'none',
                            color:'var(--accent)', border:'1px solid var(--accent)',
                            borderRadius:'var(--radius)', cursor:'pointer', fontWeight:600 }}>
                          ⬇ Export Results
                        </button>
                      )}
                      {gapLastRun[sel?.id] && (
                        <span style={{ fontSize:10, color:'var(--text-tertiary)' }}>
                          Last run: {new Date(gapLastRun[sel.id]).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })}
                        </span>
                      )}
                      {gapProgress && (
                        <span style={{ fontSize:11, color:'var(--text-tertiary)' }}>{gapProgress}</span>
                      )}
                    </div>
                  </div>
                  <OrgChart account={sel} gapState={gapState} searchGap={searchGap} />
                  </div>
                </div>

                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
                  {/* Gaps */}
                  <div style={{ background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)', overflow:'hidden' }}>
                    <div style={{ padding:'9px 13px', borderBottom:'1px solid var(--border)', background:'var(--bg-secondary)', display:'flex', justifyContent:'space-between' }}>
                      <span style={{ fontSize:10, fontWeight:600, letterSpacing:'.07em', textTransform:'uppercase', color:'var(--text-tertiary)' }}>Missing Personas</span>
                      <span style={{ fontSize:9, fontWeight:700, padding:'2px 6px', borderRadius:3, background:'rgba(240,82,82,.12)', color:'var(--red)', border:'1px solid rgba(240,82,82,.3)' }}>
                        {(sel.missingPersonas||[]).length} gaps
                      </span>
                    </div>
                    <div style={{ padding:'8px 13px' }}>
                      <GapList missingPersonas={sel.missingPersonas} />
                    </div>
                  </div>

                  {/* Engagement */}
                  <div style={{ background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)', overflow:'hidden' }}>
                    <div style={{ padding:'9px 13px', borderBottom:'1px solid var(--border)', background:'var(--bg-secondary)' }}>
                      <span style={{ fontSize:10, fontWeight:600, letterSpacing:'.07em', textTransform:'uppercase', color:'var(--text-tertiary)' }}>Engagement History</span>
                    </div>
                    <div style={{ padding:'10px 13px', display:'flex', flexDirection:'column', gap:8 }}>
                      {[
                        { label:'Last Activity',   value:sel.lastActivityDate ? new Date(sel.lastActivityDate).toLocaleDateString() : 'Never', color:!sel.lastActivityDate?'var(--red)':'var(--text)' },
                        { label:'Last Reply',      value:sel.lastEngagement?.type==='replied'?`${new Date(sel.lastEngagement.date).toLocaleDateString()} — ${sel.lastEngagement.contact||''}`:'None', color:sel.lastEngagement?.type==='replied'?'var(--green)':'var(--text-tertiary)' },
                        { label:'Last Email Sent', value:sel.lastSent?`${new Date(sel.lastSent.date).toLocaleDateString()} → ${sel.lastSent.contact||''}`:'—', color:'var(--text-secondary)' },
                        { label:'Meeting Booked',  value:sel.lastBooked?new Date(sel.lastBooked).toLocaleDateString():'None', color:sel.lastBooked?'var(--green)':'var(--text-tertiary)' },
                        { label:'Last Call',       value:sel.lastCall?new Date(sel.lastCall).toLocaleDateString():'None', color:'var(--text-secondary)' },
                      ].map((row,i) => (
                        <div key={i} style={{ display:'flex', justifyContent:'space-between', fontSize:12 }}>
                          <span style={{ color:'var(--text-tertiary)' }}>{row.label}</span>
                          <span style={{ color:row.color, fontWeight:500 }}>{row.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Account Score Breakdown */}
                <div style={{ background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)', overflow:'hidden' }}>
                  <div style={{ padding:'9px 13px', borderBottom:'1px solid var(--border)', background:'var(--bg-secondary)' }}>
                    <span style={{ fontSize:10, fontWeight:600, letterSpacing:'.07em', textTransform:'uppercase', color:'var(--text-tertiary)' }}>Account Score Breakdown</span>
                  </div>
                  <div style={{ padding:'10px 13px' }}>
                    <GapSummary account={sel} />
                  </div>
                </div>

                {/* Contacts table */}
                <div style={{ background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)', overflow:'hidden' }}>
                  <div style={{ padding:'9px 13px', borderBottom:'1px solid var(--border)', background:'var(--bg-secondary)', display:'flex', justifyContent:'space-between' }}>
                    <span style={{ fontSize:10, fontWeight:600, letterSpacing:'.07em', textTransform:'uppercase', color:'var(--text-tertiary)' }}>Contacts ({(sel.contacts||[]).length})</span>
                    <span style={{ fontSize:10, color:'var(--text-tertiary)' }}>Click row to open in HubSpot</span>
                  </div>
                  {(sel.contacts||[]).length === 0
                    ? <div style={{ padding:'12px 14px', fontSize:12, color:'var(--text-tertiary)' }}>No contacts loaded (max 5 per account). Open in HubSpot for full list.</div>
                    : <table style={{ width:'100%', borderCollapse:'collapse' }}>
                      <thead><tr>{['Name','Title','Persona','Buying Role','Sequence','Last Reply','Last Send'].map(h => (
                        <th key={h} style={{ padding:'6px 12px', fontSize:9, fontWeight:600, textTransform:'uppercase', letterSpacing:'.05em', color:'var(--text-tertiary)', borderBottom:'1px solid var(--border)', textAlign:'left' }}>{h}</th>
                      ))}</tr></thead>
                      <tbody>
                        {(sel.contacts||[]).map((c,i) => (
                          <tr key={i} style={{ borderBottom:'1px solid var(--border)', cursor:'pointer' }}
                            onClick={() => window.open(c.url,'_blank','noopener,noreferrer')}
                            onMouseEnter={e => e.currentTarget.style.background='var(--bg-secondary)'}
                            onMouseLeave={e => e.currentTarget.style.background=''}>
                            <td style={{ padding:'7px 12px', fontSize:12, fontWeight:500, color:'var(--accent)' }}>{c.name||'—'}</td>
                            <td style={{ padding:'7px 12px', fontSize:11, color:'var(--text-secondary)' }}>{c.title||'—'}</td>
                            <td style={{ padding:'7px 12px', fontSize:11, color:'var(--text-secondary)' }}>{c.persona||'—'}</td>
                            <td style={{ padding:'7px 12px', fontSize:11, color:'var(--text-secondary)' }}>{c.buyingRole||'—'}</td>
                            <td style={{ padding:'7px 12px' }}>
                              {c.inSequence
                                ? <span style={{ fontSize:9, fontWeight:700, textTransform:'uppercase', color:'var(--amber)', background:'rgba(245,166,35,.12)', borderRadius:3, padding:'2px 5px' }}>Active</span>
                                : <span style={{ fontSize:9, color:'var(--text-tertiary)' }}>—</span>}
                            </td>
                            <td style={{ padding:'7px 12px', fontSize:11, color:c.lastReply?'var(--green)':'var(--text-tertiary)' }}>
                              {c.lastReply?new Date(c.lastReply).toLocaleDateString():'—'}
                            </td>
                            <td style={{ padding:'7px 12px', fontSize:11, color:'var(--text-tertiary)' }}>
                              {c.lastSent?new Date(c.lastSent).toLocaleDateString():'—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  }
                </div>

              </div>
            }
          </div>
      )}

      {view === 'reporting' && (
        <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10 }}>
            <KpiCard label="Accounts"         value={accounts.length} />
            <KpiCard label="Avg Health"       value={`${meta?.avgHealth||0}%`} />
            <KpiCard label="Critical Gaps"    value={meta?.totalCriticalGaps||0} />
            <KpiCard label="Avg Coverage"     value={`${meta?.avgPersonaCoverage||0}/16`} />
          </div>

          {/* Persona gap breakdown */}
          <Panel>
            <SectionTitle>Persona Coverage Across All Gold Accounts</SectionTitle>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:8 }}>
              {TARGET_PERSONAS.map((p,i) => {
                const covered = accounts.filter(a =>
                  (a.personaCoverage||[]).find(pc => pc.persona===p.value && pc.covered)
                ).length
                const total = accounts.length || 1
                const pct = Math.round((covered/total)*100)
                return (
                  <div key={i} style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:2 }}>
                        <span style={{ fontSize:11, color:'var(--text-secondary)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{p.label}</span>
                        <span style={{ fontSize:11, fontWeight:600, color:pct>=80?'var(--green)':pct>=50?'var(--amber)':'var(--red)', flexShrink:0, marginLeft:8 }}>{pct}%</span>
                      </div>
                      <div style={{ height:5, background:'var(--border)', borderRadius:3, overflow:'hidden' }}>
                        <div style={{ width:`${pct}%`, height:'100%', background:pct>=80?'var(--green)':pct>=50?'var(--amber)':'var(--red)', borderRadius:3 }} />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </Panel>

          {/* Account table */}
          <Panel>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
              <SectionTitle style={{ margin:0 }}>Account Detail ({filtered.length})</SectionTitle>
              <button onClick={() => exportGoldCSV(filtered, 'gold-command-report.csv')}
                style={{ padding:'6px 12px', background:'none', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:11, color:'var(--text-secondary)', cursor:'pointer' }}>
                Export CSV
              </button>
            </div>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
              <THead cols={['Account','Tier','BDR','Health','Coverage','Critical','High','Days','Last Reply']} />
              <tbody>
                {filtered.map((a,i) => (
                  <tr key={i} style={{ borderBottom:'1px solid var(--border)', cursor:'pointer' }}
                    onClick={() => { setSelected(a); setView('workspace') }}
                    onMouseEnter={e => e.currentTarget.style.background='var(--bg-secondary)'}
                    onMouseLeave={e => e.currentTarget.style.background=''}>
                    <td style={{ padding:'7px 10px 7px 0', fontWeight:500, color:'var(--accent)' }}>{a.name}</td>
                    <td style={{ padding:'7px 10px 7px 0', fontSize:10, color:'var(--text-tertiary)' }}>{a.tier.replace('GOLD - ','')}</td>
                    <td style={{ padding:'7px 10px 7px 0', color:'var(--text-secondary)' }}>{a.assignedBdr||'—'}</td>
                    <td style={{ padding:'7px 10px 7px 0', fontFamily:'monospace', fontWeight:700, color:hcColor(a.healthStatus) }}>{a.health}</td>
                    <td style={{ padding:'7px 10px 7px 0', color:(a.coveredPersonaCount||0)<12?'var(--amber)':'var(--text-secondary)' }}>{a.coveredPersonaCount||0}/22</td>
                    <td style={{ padding:'7px 10px 7px 0', color:(a.criticalGaps||0)>0?'var(--red)':'var(--text-tertiary)' }}>{a.criticalGaps||0}</td>
                    <td style={{ padding:'7px 10px 7px 0', color:(a.highGaps||0)>0?'var(--amber)':'var(--text-tertiary)' }}>{a.highGaps||0}</td>
                    <td style={{ padding:'7px 10px 7px 0', color:(a.daysSinceActivity||0)>30?'var(--red)':'var(--text-secondary)' }}>{a.daysSinceActivity!=null?`${a.daysSinceActivity}d`:'—'}</td>
                    <td style={{ padding:'7px 0', color:a.lastEngagement?.type==='replied'?'var(--green)':'var(--text-tertiary)', whiteSpace:'nowrap' }}>
                      {a.lastEngagement?.type==='replied'?new Date(a.lastEngagement.date).toLocaleDateString():'—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
      )}
    </div>
  )
}


// ─── Add App tab ──────────────────────────────────────────────────────────────
function AddAppTab({ safeFetch, onSaved, existingTabs, onDelete, isAdmin }) {
  const [url, setUrl]               = useState('')
  const [label, setLabel]           = useState('')
  const [badge, setBadge]           = useState('')
  const [tabType, setTabType]       = useState('iframe')
  const [personal, setPersonal]     = useState(true) // default "Just me"
  const [previewing, setPreviewing] = useState(false)
  const [saving, setSaving]         = useState(false)
  const [message, setMessage]       = useState(null)
  const [deleteConfirm, setDeleteConfirm] = useState(null)

  const handleUrlBlur = async () => {
    if (!url.trim() || label) return
    setPreviewing(true)
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
        body: JSON.stringify({ url: url.trim(), label: label.trim(), badge: badge.trim() || null, type: tabType, personal }),
      })
      onSaved(data.tab)
      setUrl('')
      setLabel('')
      setBadge('')
      setTabType('iframe')
      setPersonal(true)
      const scope  = personal ? 'visible to you only' : 'visible to everyone'
      const action = tabType === 'link' ? 'Opens in a new window.' : 'Taking you there now.'
      setMessage({ type:'success', text:`"${data.tab.label}" added (${scope}). ${action}` })
    } catch (err) {
      setMessage({ type:'error', text: err.message || 'Something went wrong.' })
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (tabId, tabLabel, isPersonal) => {
    if (deleteConfirm !== tabId) { setDeleteConfirm(tabId); return; }
    try {
      const url = isPersonal
        ? `/api/hubspot/tabs/${tabId}?personal=true`
        : `/api/hubspot/tabs/${tabId}`
      await safeFetch(url, { method: 'DELETE' })
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
            <label style={{ fontSize:12, fontWeight:500, color:'var(--text-secondary)', display:'block', marginBottom:8 }}>Who can see this tab?</label>
            <div style={{ display:'flex', gap:8 }}>
              {[
                { value: true,  label: 'Just me',         desc: 'Only visible in your nav' },
                { value: false, label: 'Everyone',         desc: isAdmin ? 'Visible to all users' : 'Requires admin access', disabled: !isAdmin },
              ].map(opt => (
                <div key={String(opt.value)} onClick={() => !opt.disabled && setPersonal(opt.value)}
                  style={{ flex:1, padding:'10px 12px', borderRadius:'var(--radius)', border:`1px solid ${personal===opt.value ? 'var(--accent)' : 'var(--border)'}`, background: opt.disabled ? 'var(--bg-secondary)' : personal===opt.value ? 'var(--accent-light)' : 'var(--bg-secondary)', cursor: opt.disabled ? 'not-allowed' : 'pointer', opacity: opt.disabled ? 0.5 : 1 }}>
                  <div style={{ fontSize:12, fontWeight:500, color: personal===opt.value ? 'var(--accent-text)' : 'var(--text)', marginBottom:3 }}>{opt.label}</div>
                  <div style={{ fontSize:11, color:'var(--text-tertiary)', lineHeight:1.4 }}>{opt.desc}</div>
                </div>
              ))}
            </div>
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
                    <span style={{ fontSize:9, fontWeight:600, borderRadius:4, padding:'1px 5px', background: tab.personal ? 'var(--bg-secondary)' : 'var(--accent-light)', color: tab.personal ? 'var(--text-tertiary)' : 'var(--accent)' }}>
                      {tab.personal ? 'Just me' : 'Shared'}
                    </span>
                  </div>
                  <div style={{ fontSize:11, color:'var(--text-tertiary)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{tab.url}</div>
                </div>
                <button
                  onClick={() => handleDelete(tab.id, tab.label, tab.personal)}
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
