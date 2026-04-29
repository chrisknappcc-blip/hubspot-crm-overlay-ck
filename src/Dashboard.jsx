import { useState, useEffect, useCallback } from 'react'
import { useClerk } from '@clerk/clerk-react'
import { apiFetch } from './api'

const PERSONAS = {
  cfo: { label:'CFO', color:'#1D4ED8', bg:'#EFF6FF' },
  cno: { label:'CNO', color:'#0D4D34', bg:'#E3F2EC' },
  vp_finance: { label:'VP Finance', color:'#B45309', bg:'#FEF3C7' },
  vp_strategy: { label:'VP Strategy', color:'#6D28D9', bg:'#EDE9FE' },
  dir_ops: { label:'Dir. Ops', color:'#C5372A', bg:'#FCECEA' },
  default: { label:'Contact', color:'#6B6A65', bg:'#F0EEE9' },
}

function getPersona(title = '') {
  const t = title.toLowerCase()
  if (t.includes('cfo') || t.includes('chief financial')) return PERSONAS.cfo
  if (t.includes('cno') || t.includes('chief nursing')) return PERSONAS.cno
  if (t.includes('finance')) return PERSONAS.vp_finance
  if (t.includes('strategy')) return PERSONAS.vp_strategy
  if (t.includes('operat') || t.includes('director')) return PERSONAS.dir_ops
  return PERSONAS.default
}

function initials(name = '') {
  return name.split(' ').map(p => p[0]).join('').slice(0,2).toUpperCase() || '??'
}

function timeAgo(ts) {
  if (!ts) return ''
  const diff = Date.now() - new Date(ts).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'Just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h/24)}d ago`
}

function Badge({ label, type = 'default' }) {
  const colors = {
    hot: { bg:'var(--red-light)', color:'var(--red)' },
    warm: { bg:'var(--amber-light)', color:'var(--amber)' },
    reply: { bg:'var(--accent-light)', color:'var(--accent-text)' },
    click: { bg:'var(--blue-light)', color:'var(--blue)' },
    default: { bg:'var(--bg-secondary)', color:'var(--text-secondary)' },
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
    <div style={{ width:size, height:size, borderRadius:'50%', background:'var(--accent-light)', color:'var(--accent-text)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:size*0.34, fontWeight:500, flexShrink:0 }}>
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

export default function Dashboard({ user, theme, toggleTheme, getToken }) {
  const { signOut } = useClerk()
  const [signals, setSignals] = useState([])
  const [contacts, setContacts] = useState([])
  const [feed, setFeed] = useState([])
  const [loading, setLoading] = useState(true)
  const [botCount, setBotCount] = useState(0)
  const [activeTab, setActiveTab] = useState('dashboard')
  const [selectedContact, setSelectedContact] = useState(null)

  const firstName = user?.firstName || user?.emailAddresses?.[0]?.emailAddress?.split('@')[0] || 'there'

  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'

  const today = new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' })

  const fetch = useCallback(async () => {
    setLoading(true)
    try {
      const [sigData, contactData] = await Promise.all([
        apiFetch('/api/hubspot/signals?hours=48&showBots=true', getToken),
        apiFetch('/api/hubspot/contacts', getToken),
      ])
      setSignals(sigData.signals || [])
      setBotCount(sigData.meta?.suspectedBotCount || 0)
      setContacts(contactData.contacts || [])
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [getToken])

  useEffect(() => { fetch() }, [fetch])

  const loadContactFeed = useCallback(async (contactId) => {
    try {
      const data = await apiFetch(`/api/hubspot/feed/${contactId}`, getToken)
      setFeed(data.feed || [])
    } catch (e) { setFeed([]) }
  }, [getToken])

  useEffect(() => {
    if (selectedContact) loadContactFeed(selectedContact.id)
  }, [selectedContact, loadContactFeed])

  const tasks = signals.slice(0, 8).map(s => ({
    name: s.contact?.name || 'Unknown',
    company: s.contact?.company || '',
    title: s.contact?.title || '',
    label: s.label,
    score: s.score,
    ts: s.timestamp,
    contactId: s.contactId,
    priority: s.score >= 100 ? 'hot' : s.score >= 60 ? 'warm' : 'normal',
    badgeType: s.score >= 100 ? 'reply' : s.score >= 60 ? 'click' : 'hot',
  }))

  const contentEngagement = signals.filter(s => s.label?.toLowerCase().includes('click')).map(s => ({
    name: s.contact?.name || 'Unknown',
    company: s.contact?.company || '',
    title: s.contact?.title || '',
    action: s.label,
    subject: s.subject || 'Email',
    ts: s.timestamp,
    score: s.score,
  }))

  const hotCount = signals.filter(s => s.score >= 100).length
  const warmCount = signals.filter(s => s.score >= 60 && s.score < 100).length

  return (
    <div style={{ minHeight:'100vh', background:'var(--bg)', display:'flex', flexDirection:'column' }}>

      {/* Top nav */}
      <nav style={{ background:'var(--bg-panel)', borderBottom:'1px solid var(--border)', padding:'0 1.5rem', display:'flex', alignItems:'center', height:52, gap:24, position:'sticky', top:0, zIndex:50 }}>
        <div style={{ fontSize:13, fontWeight:500, letterSpacing:'.05em', textTransform:'uppercase', color:'var(--accent)', marginRight:8 }}>CarePathIQ</div>

        {['dashboard','contacts'].map(tab => (
         style={{ fontSize:13, fontWeight:activeTab===tab?500:400, color:activeTab===tab?'var(--text)':'var(--text-secondary)', padding:'0 2px', height:52, background:'none', border:'none', borderBottom:activeTab===tab?'2px solid var(--accent)':'2px solid transparent', cursor:'pointer', textTransform:'capitalize' }}
            {tab}
          </button>
        ))}

        <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:12 }}>
          {botCount > 0 && (
            <div style={{ fontSize:11, color:'var(--text-tertiary)', background:'var(--bg-secondary)', padding:'3px 10px', borderRadius:20 }}>
              {botCount} bot open{botCount>1?'s':''} filtered
            </div>
          )}
          <button onClick={toggleTheme} style={{ width:32, height:32, borderRadius:'var(--radius)', background:'var(--bg-secondary)', display:'flex', alignItems:'center', justifyContent:'center', border:'1px solid var(--border)', cursor:'pointer' }} title="Toggle theme">
            {theme === 'light'
              ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
              : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
            }
          </button>
          <button onClick={() => signOut()} style={{ fontSize:12, color:'var(--text-tertiary)', background:'none', border:'none', cursor:'pointer' }}>Sign out</button>
        </div>
      </nav>

      {/* Content */}
      <div style={{ flex:1, padding:'1.5rem', maxWidth:1280, margin:'0 auto', width:'100%' }}>

        {activeTab === 'dashboard' && (
          <>
            {/* Header */}
            <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:'1.25rem' }}>
              <div>
                <h1 style={{ fontSize:20, fontWeight:500, color:'var(--text)', marginBottom:2 }}>{greeting}, {firstName}</h1>
                <div style={{ fontSize:13, color:'var(--text-tertiary)' }}>{today} &mdash; {tasks.length} items need your attention</div>
              </div>
              <button onClick={fetch} style={{ fontSize:12, color:'var(--text-secondary)', background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'6px 14px', cursor:'pointer' }}>
                Refresh
              </button>
            </div>

            {/* Metrics */}
            <div style={{ display:'grid', gridTemplateColumns:'repeat(4,minmax(0,1fr))', gap:10, marginBottom:'1.25rem' }}>
              <MetricCard label="Hot signals" value={hotCount} sub="Replies + clicks" subType="up" />
              <MetricCard label="Warm signals" value={warmCount} sub="Opens w/ engagement" subType="neutral" />
              <MetricCard label="Active contacts" value={contacts.length} sub="In HubSpot" subType="neutral" />
              <MetricCard label="Bot opens filtered" value={botCount} sub="Not shown in feed" subType="neutral" />
            </div>

            {/* Two columns */}
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:12 }}>

              {/* Task queue */}
              <Panel>
                <SectionTitle>Task queue</SectionTitle>
                {loading && <div style={{ color:'var(--text-tertiary)', fontSize:13 }}>Loading...</div>}
                {!loading && tasks.length === 0 && <div style={{ color:'var(--text-tertiary)', fontSize:13 }}>No urgent tasks right now.</div>}
                {tasks.map((t, i) => (
                  <div key={i} style={{ display:'flex', gap:10, padding:'10px 0', borderBottom: i < tasks.length-1 ? '1px solid var(--border)' : 'none', cursor:'pointer' }}
                    onClick={() => { const c = contacts.find(c => c.id === t.contactId); if(c) { setSelectedContact(c); setActiveTab('contacts') } }}>
                    <PriorityDot level={t.priority} />
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontWeight:500, fontSize:13, color:'var(--text)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{t.name}</div>
                      <div style={{ fontSize:12, color:'var(--text-secondary)', marginBottom:4 }}>{t.title}{t.company ? ` · ${t.company}` : ''}</div>
                      <Badge label={t.label} type={t.badgeType} />
                    </div>
                    <div style={{ fontSize:11, color:'var(--text-tertiary)', whiteSpace:'nowrap', flexShrink:0 }}>{timeAgo(t.ts)}</div>
                  </div>
                ))}
              </Panel>

              {/* Live signals */}
              <Panel>
                <SectionTitle>Live signals</SectionTitle>
                {loading && <div style={{ color:'var(--text-tertiary)', fontSize:13 }}>Loading...</div>}
                {!loading && signals.length === 0 && <div style={{ color:'var(--text-tertiary)', fontSize:13 }}>No signals in the last 48 hours.</div>}
                {signals.slice(0,8).map((s, i) => {
                  const isReply = s.score >= 100
                  const isClick = s.score >= 60 && s.score < 100
                  const iconColor = isReply ? 'var(--accent)' : isClick ? 'var(--amber)' : 'var(--blue)'
                  const iconBg = isReply ? 'var(--accent-light)' : isClick ? 'var(--amber-light)' : 'var(--blue-light)'
                  return (
                    <div key={i} style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 0', borderBottom: i < signals.slice(0,8).length-1 ? '1px solid var(--border)' : 'none' }}>
                      <div style={{ width:28, height:28, borderRadius:'var(--radius)', background:iconBg, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                        {isReply
                          ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={iconColor} strokeWidth="2" strokeLinecap="round"><path d="M9 17H5a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v5"/><polyline points="17 11 12 16 7 11"/></svg>
                          : isClick
                          ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={iconColor} strokeWidth="2" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                          : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={iconColor} strokeWidth="2" strokeLinecap="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                        }
                      </div>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:13, fontWeight:500, color:'var(--text)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                          {s.contact?.name || 'Unknown'} &mdash; {s.label}
                        </div>
                        <div style={{ fontSize:11, color:'var(--text-tertiary)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{s.subject}</div>
                      </div>
                      <div style={{ fontSize:11, color:'var(--text-tertiary)', whiteSpace:'nowrap', flexShrink:0 }}>{timeAgo(s.timestamp)}</div>
                    </div>
                  )
                })}
              </Panel>
            </div>

            {/* AI Recommendations */}
            <Panel style={{ marginBottom:12 }}>
              <SectionTitle>AI recommendations &mdash; persona-aware</SectionTitle>
              {signals.length === 0 && !loading && <div style={{ color:'var(--text-tertiary)', fontSize:13 }}>No signals to base recommendations on yet.</div>}
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                {tasks.slice(0,4).map((t, i) => {
                  const persona = getPersona(t.title)
                  const actions = {
                    reply: { verb:'Draft reply', prompt:`Draft a reply to ${t.name}, ${t.title} at ${t.company}, who replied to my outreach.` },
                    click: { verb:'Draft LinkedIn msg', prompt:`Draft a LinkedIn message for ${t.name}, ${t.title} at ${t.company}, who clicked my email link.` },
                    hot: { verb:'Draft follow-up', prompt:`Draft a follow-up email for ${t.name}, ${t.title} at ${t.company}, who opened my email multiple times.` },
                  }
                  const action = actions[t.badgeType] || actions.hot
                  const rec = {
                    reply: `${t.name} replied positively. Strike quickly -- ${persona.label} personas respond best to specific time proposals and strategic framing, not product features.`,
                    click: `${t.name} clicked a link -- a warm signal from a ${persona.label}. A brief follow-up referencing value (not pricing) tends to convert well.`,
                    hot: `${t.name} has opened multiple times. ${persona.label} personas at health systems respond to cost avoidance and operational outcome framing.`,
                  }
                  return (
                    <div key={i} style={{ background:'var(--bg-secondary)', borderRadius:'var(--radius)', padding:'12px 14px' }}>
                      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
                        <span style={{ fontSize:11, fontWeight:500, padding:'2px 8px', borderRadius:20, background:persona.bg, color:persona.color }}>{persona.label}</span>
                        <span style={{ fontSize:11, color:'var(--text-tertiary)' }}>{t.label}</span>
                      </div>
                      <div style={{ fontSize:13, color:'var(--text)', lineHeight:1.5, marginBottom:8 }}>{rec[t.badgeType] || rec.hot}</div>
                      <button
                        onClick={() => window.open(`https://claude.ai/new?q=${encodeURIComponent(action.prompt)}`, '_blank')}
                        style={{ fontSize:12, color:'var(--accent)', background:'none', border:'1px solid var(--border-strong)', borderRadius:'var(--radius)', padding:'5px 12px', cursor:'pointer' }}>
                        {action.verb} &nearr;
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
                <div style={{ color:'var(--text-tertiary)', fontSize:13 }}>No link clicks or document views tracked in the last 48 hours.</div>
              )}
              {contentEngagement.length > 0 && (
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                  <thead>
                    <tr>
                      {['Contact','Title / Company','Action','Content','Time'].map(h => (
                        <th key={h} style={{ textAlign:'left', fontSize:11, fontWeight:500, color:'var(--text-tertiary)', textTransform:'uppercase', letterSpacing:'.04em', padding:'0 0 8px', borderBottom:'1px solid var(--border)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {contentEngagement.slice(0,10).map((c, i) => (
                      <tr key={i} style={{ borderBottom: i < contentEngagement.slice(0,10).length-1 ? '1px solid var(--border)' : 'none' }}>
                        <td style={{ padding:'9px 0', fontWeight:500, color:'var(--text)' }}>{c.name}</td>
                        <td style={{ padding:'9px 8px 9px 0', color:'var(--text-secondary)', fontSize:12 }}>{c.title}{c.company ? ` · ${c.company}` : ''}</td>
                        <td style={{ padding:'9px 8px 9px 0' }}><Badge label={c.action} type="click" /></td>
                        <td style={{ padding:'9px 8px 9px 0', color:'var(--text-secondary)', fontSize:12, maxWidth:200, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{c.subject}</td>
                        <td style={{ padding:'9px 0', color:'var(--text-tertiary)', fontSize:12, whiteSpace:'nowrap' }}>{timeAgo(c.ts)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div style={{ marginTop:10, fontSize:11, color:'var(--text-tertiary)' }}>
                Time-on-document tracking available for links shared via HubSpot Documents. Attachments sent directly do not include view duration.
              </div>
            </Panel>

            {/* Sequence pipeline */}
            <Panel>
              <SectionTitle>Contact pipeline</SectionTitle>
              {contacts.length === 0 && !loading && <div style={{ color:'var(--text-tertiary)', fontSize:13 }}>No contacts found.</div>}
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                <thead>
                  <tr>
                    {['Contact','Title','Company','Last contacted','Status'].map(h => (
                      <th key={h} style={{ textAlign:'left', fontSize:11, fontWeight:500, color:'var(--text-tertiary)', textTransform:'uppercase', letterSpacing:'.04em', padding:'0 8px 8px 0', borderBottom:'1px solid var(--border)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {contacts.slice(0,15).map((c, i) => {
                    const props = c.properties || {}
                    const name = `${props.firstname||''} ${props.lastname||''}`.trim() || 'Unknown'
                    const status = props.hs_lead_status || 'Active'
                    const statusColors = {
                      'NEW': { bg:'var(--blue-light)', color:'var(--blue)' },
                      'OPEN': { bg:'var(--accent-light)', color:'var(--accent-text)' },
                      'IN_PROGRESS': { bg:'var(--amber-light)', color:'var(--amber)' },
                      'UNQUALIFIED': { bg:'var(--bg-secondary)', color:'var(--text-tertiary)' },
                    }
                    const sc = statusColors[status] || { bg:'var(--bg-secondary)', color:'var(--text-secondary)' }
                    return (
                      <tr key={i} style={{ borderBottom: i < contacts.slice(0,15).length-1 ? '1px solid var(--border)' : 'none', cursor:'pointer' }}
                        onClick={() => { setSelectedContact(c); setActiveTab('contacts') }}>
                        <td style={{ padding:'9px 8px 9px 0' }}>
                          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                            <Avatar name={name} size={26} />
                            <span style={{ fontWeight:500, color:'var(--text)' }}>{name}</span>
                          </div>
                        </td>
                        <td style={{ padding:'9px 8px 9px 0', color:'var(--text-secondary)' }}>{props.jobtitle || '—'}</td>
                        <td style={{ padding:'9px 8px 9px 0', color:'var(--text-secondary)' }}>{props.company || '—'}</td>
                        <td style={{ padding:'9px 8px 9px 0', color:'var(--text-tertiary)', fontSize:12 }}>{props.notes_last_contacted ? new Date(parseInt(props.notes_last_contacted)).toLocaleDateString() : '—'}</td>
                        <td style={{ padding:'9px 0' }}>
                          <span style={{ fontSize:11, fontWeight:500, padding:'2px 8px', borderRadius:20, background:sc.bg, color:sc.color }}>
                            {status.replace('_',' ')}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </Panel>
          </>
        )}

        {activeTab === 'contacts' && (
          <ContactsView
            contacts={contacts}
            selected={selectedContact}
            onSelect={c => { setSelectedContact(c); loadContactFeed(c.id) }}
            feed={feed}
            getToken={getToken}
          />
        )}
      </div>
    </div>
  )
}

function ContactsView({ contacts, selected, onSelect, feed, getToken }) {
  const [search, setSearch] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const filtered = contacts.filter(c => {
    const p = c.properties || {}
    const name = `${p.firstname||''} ${p.lastname||''}`.toLowerCase()
    const company = (p.company||'').toLowerCase()
    const s = search.toLowerCase()
    return name.includes(s) || company.includes(s)
  })

  const logNote = async () => {
    if (!note.trim() || !selected) return
    setSaving(true)
    try {
      await apiFetch('/api/hubspot/activity', getToken, {
        method:'POST',
        body: JSON.stringify({ contactId: selected.id, note }),
      })
      setNote('')
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch(e) { console.error(e) }
    finally { setSaving(false) }
  }

  const props = selected?.properties || {}
  const selectedName = `${props.firstname||''} ${props.lastname||''}`.trim() || 'Unknown'
  const persona = getPersona(props.jobtitle || '')

  return (
    <div style={{ display:'grid', gridTemplateColumns:'280px 1fr', gap:12, height:'calc(100vh - 100px)' }}>

      {/* Contact list */}
      <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search contacts..."
          style={{ background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'8px 12px', fontSize:13, color:'var(--text)', outline:'none', width:'100%' }}
        />
        <div style={{ overflow:'auto', flex:1 }}>
          {filtered.slice(0,50).map((c, i) => {
            const p = c.properties || {}
            const name = `${p.firstname||''} ${p.lastname||''}`.trim() || 'Unknown'
            const isSelected = selected?.id === c.id
            return (
              <div key={i} onClick={() => onSelect(c)}
                style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', borderRadius:'var(--radius)', cursor:'pointer', background: isSelected ? 'var(--accent-light)' : 'transparent', marginBottom:2 }}>
                <Avatar name={name} size={30} />
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:13, fontWeight:500, color: isSelected ? 'var(--accent-text)' : 'var(--text)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{name}</div>
                  <div style={{ fontSize:11, color:'var(--text-tertiary)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{p.company||'—'}</div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Contact detail */}
      {selected ? (
        <div style={{ overflow:'auto', display:'flex', flexDirection:'column', gap:12 }}>

          {/* Header card */}
          <Panel>
            <div style={{ display:'flex', alignItems:'center', gap:14, marginBottom:16 }}>
              <Avatar name={selectedName} size={48} />
              <div>
                <h2 style={{ fontSize:17, fontWeight:500, color:'var(--text)', marginBottom:2 }}>{selectedName}</h2>
                <div style={{ fontSize:13, color:'var(--text-secondary)' }}>{props.jobtitle||'—'} &middot; {props.company||'—'}</div>
                <span style={{ display:'inline-block', marginTop:4, fontSize:11, fontWeight:500, padding:'2px 8px', borderRadius:20, background:persona.bg, color:persona.color }}>{persona.label}</span>
              </div>
              <div style={{ marginLeft:'auto', display:'flex', flexDirection:'column', gap:4, alignItems:'flex-end' }}>
                {props.email && <a href={`mailto:${props.email}`} style={{ fontSize:12, color:'var(--accent)' }}>{props.email}</a>}
                {props.phone && <div style={{ fontSize:12, color:'var(--text-secondary)' }}>{props.phone}</div>}
              </div>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8 }}>
              <div style={{ background:'var(--bg-secondary)', borderRadius:'var(--radius)', padding:'10px 12px' }}>
                <div style={{ fontSize:11, color:'var(--text-tertiary)', marginBottom:2 }}>Lead status</div>
                <div style={{ fontSize:13, fontWeight:500, color:'var(--text)' }}>{props.hs_lead_status||'—'}</div>
              </div>
              <div style={{ background:'var(--bg-secondary)', borderRadius:'var(--radius)', padding:'10px 12px' }}>
                <div style={{ fontSize:11, color:'var(--text-tertiary)', marginBottom:2 }}>Times contacted</div>
                <div style={{ fontSize:13, fontWeight:500, color:'var(--text)' }}>{props.num_contacted_notes||'0'}</div>
              </div>
              <div style={{ background:'var(--bg-secondary)', borderRadius:'var(--radius)', padding:'10px 12px' }}>
                <div style={{ fontSize:11, color:'var(--text-tertiary)', marginBottom:2 }}>Last contacted</div>
                <div style={{ fontSize:13, fontWeight:500, color:'var(--text)' }}>
                  {props.notes_last_contacted ? new Date(parseInt(props.notes_last_contacted)).toLocaleDateString() : '—'}
                </div>
              </div>
            </div>
          </Panel>

          {/* Log a note */}
          <Panel>
            <SectionTitle>Log activity</SectionTitle>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="Add a call note, meeting summary, or activity..."
              rows={3}
              style={{ width:'100%', background:'var(--bg-secondary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'10px 12px', fontSize:13, color:'var(--text)', resize:'vertical', outline:'none', fontFamily:'var(--font)' }}
            />
            <div style={{ display:'flex', justifyContent:'flex-end', marginTop:8 }}>
              <button onClick={logNote} disabled={saving||!note.trim()} style={{ fontSize:13, fontWeight:500, background:'var(--accent)', color:'#fff', border:'none', borderRadius:'var(--radius)', padding:'7px 18px', cursor:'pointer', opacity: saving||!note.trim() ? 0.5 : 1 }}>
                {saving ? 'Saving...' : saved ? 'Saved!' : 'Log to HubSpot'}
              </button>
            </div>
          </Panel>

          {/* Activity feed */}
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
                  <div style={{ fontSize:12, color:'var(--text-secondary)', marginTop:2 }}>{item.body || item.subject || item.note || '—'}</div>
                  <div style={{ fontSize:11, color:'var(--text-tertiary)', marginTop:4 }}>{timeAgo(item.timestamp || item.createdAt)}</div>
                </div>
              </div>
            ))}
          </Panel>
        </div>
      ) : (
        <Panel style={{ display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ textAlign:'center', color:'var(--text-tertiary)' }}>
            <div style={{ fontSize:13 }}>Select a contact to view details</div>
          </div>
        </Panel>
      )}
    </div>
  )
}
