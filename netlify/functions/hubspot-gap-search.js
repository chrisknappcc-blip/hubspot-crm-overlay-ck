// ─── Cipher — Gold Account Gap Search ────────────────────────────────────────
// Context-aware: receives existing CRM contacts so the model can reason about
// title fit, avoid duplicates, and search only for genuinely missing roles.
// Uses extended thinking + web_search for maximum accuracy.

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const PERSONA_DEFINITIONS = {
  // Key names are stable — they match TARGET_PERSONAS in hubspot.js and Dashboard.jsx.
  // Do not rename keys. Titles = union of both sources; keywords = rich strategic terms
  // so the model can reason about functional fit beyond exact title matching.

  "Access/Patient Access": {
    titles: [
      "Chief Access Officer","Chief Patient Access Officer",
      "VP Patient Access","Vice President Patient Access",
      "SVP Patient Access","Senior Vice President Patient Access",
      "VP Access Services","VP Patient Access & Scheduling",
      "Director Patient Access",
    ],
    keywords: "patient access strategy, revenue cycle, price transparency, financial clearance, prior authorization, insurance verification, financial counseling, cost estimation, collections, scheduling, registration, admissions",
  },

  "Ambulatory/Urgent Care": {
    titles: [
      "Chief Ambulatory Officer",
      "VP Ambulatory Services","Vice President Ambulatory Services",
      "SVP Ambulatory","SVP Urgent Care","Senior Vice President Urgent Care",
      "VP Ambulatory","VP Ambulatory Care","VP Ambulatory Operations",
      "VP Multispecialty",
      "Ambulatory Chief Medical Officer","Chief Medical Officer Ambulatory","VP Ambulatory Chief Medical Officer",
      "Medical Director Ambulatory",
      "Executive Director Outpatient Services",
    ],
    keywords: "ambulatory strategy, urgent care operations, outpatient growth, retail health, telehealth, virtual care, clinic efficiency, patient experience, provider productivity, express care, multispecialty",
  },

  "Business Development": {
    titles: [
      "Chief Business Development Officer","CBDO",
      "Chief Growth Officer",
      "SVP Business Development","Senior VP Business Development",
      "VP Business Development","VP Growth",
      "VP Strategic Partnerships","Vice President Strategic Partnerships",
      "VP Corporate Development",
      "Executive Director Business Development",
    ],
    keywords: "partnership strategy, joint ventures, JVs, M&A, mergers, acquisitions, strategic growth, market development, competitive intelligence, due diligence, business model innovation, expansion",
  },

  "Case Management": {
    titles: [
      "Chief Care Management Officer",
      "SVP Care Coordination","Senior VP Care Coordination",
      "VP Case Management","Vice President Case Management",
      "VP Care Management","VP Care Transitions","VP Care Coordination",
      "Director Case Management",
      "Executive Director Case Management",
    ],
    keywords: "case management, care coordination, utilization management, discharge planning, transitions of care, readmission reduction, length of stay, patient navigation, social determinants, complex care",
  },

  "Clinical Operations": {
    titles: [
      "Chief Clinical Operations Officer","CCOO",
      "SVP Clinical Operations","Senior Vice President Clinical Operations",
      "VP Clinical Operations","VP Clinical Services",
      "VP Ambulatory Operations","Vice President Ambulatory Operations",
      "Executive Director Clinical Services",
    ],
    keywords: "clinical operations, performance improvement, care model redesign, patient flow, throughput, care variation, service line growth, capacity management, block utilization, provider efficiency",
  },

  "Emergency Department": {
    titles: [
      "Chief of Emergency Medicine","Chief Emergency Services",
      "Medical Director Emergency Services","Medical Director Emergency",
      "VP Emergency Services","Vice President Emergency Services",
      "Chair Emergency Medicine",
      "Executive Director Trauma Services",
      "ED Operations Director",
    ],
    keywords: "ED operations, emergency care, trauma services, disaster preparedness, triage, throughput, patient flow, left without being seen, LWBS, boarding, EMS, behavioral health",
  },

  "Executive/Leadership": {
    titles: [
      "Chief Executive Officer","CEO",
      "President","President & CEO","System President",
      "President & Chief Operating Officer","President & COO",
      "Executive Vice President","EVP",
      "Senior Vice President","SVP",
      "Executive Director",
    ],
    keywords: "enterprise strategy, strategic planning, leadership development, organizational transformation, change management, governance, board relations, external affairs, government relations, corporate communications",
  },

  "Finance": {
    titles: [
      "Chief Financial Officer","CFO","EVP & CFO",
      "SVP Finance","Senior Vice President Finance",
      "VP Finance","VP Revenue Cycle","Vice President Revenue Cycle",
      "Executive Director Financial Planning",
    ],
    keywords: "financial strategy, capital planning, treasury, revenue cycle, cost reduction, risk management, value-based contracting, budgeting, forecasting, financial reporting, payer contracting",
  },

  "Innovation": {
    titles: [
      "Chief Innovation Officer","CINO",
      "Chief Digital Officer","CDO",
      "Chief Transformation Officer",
      "SVP Innovation","Senior Vice President Innovation",
      "VP Innovation","VP Digital Transformation","Vice President Digital Transformation",
      "Executive Director Innovation Strategy",
    ],
    keywords: "innovation strategy, digital health, strategic partnerships, venture investing, incubators, accelerators, disruptive innovation, design thinking, agile, pilot programs, digital transformation, health IT",
  },

  // Retained from existing — not in new list. Key name must stay "Medical Group".
  "Medical Group": {
    titles: [
      "President Medical Group","CEO Medical Group",
      "VP Medical Group","Vice President Medical Group",
      "Executive Director Medical Group",
    ],
    keywords: "medical group management, physician group strategy, employed physician enterprise, group practice operations, physician alignment, multispecialty group, faculty practice plan",
  },

  // Key name stays "Medical" — maps to label "Medical Information" in hubspot.js / Dashboard.jsx.
  "Medical": {
    titles: [
      "Chief Medical Information Officer","CMIO",
      "VP Clinical Informatics","Vice President Clinical Informatics",
      "VP Medical Informatics",
      "Chief Clinical Informatics Officer",
      "Senior Director Medical Informatics",
    ],
    keywords: "clinical informatics, EHR optimization, clinical decision support, CPOE, predictive analytics, AI, machine learning, telemedicine, interoperability, precision medicine, digital diagnostics, health information technology",
  },

  "Chief Clinical Officer": {
    titles: [
      "Chief Clinical Officer","CCO",
      "EVP Clinical Affairs","Chief of Clinical Affairs",
      "SVP Clinical Services","Senior VP Clinical Services",
    ],
    keywords: "clinical strategy, quality, safety, evidence-based practice, care standardization, clinical transformation, interprofessional practice, care model redesign, shared governance, Magnet designation",
  },

  "Medical Officer": {
    titles: [
      "Chief Medical Officer","CMO",
      "SVP Medical Affairs","Senior Vice President Medical Affairs",
      "VP Medical Affairs",
      "VP Clinical Integration","Vice President Clinical Integration",
      "Chief of Medicine","Physician-in-Chief",
      "Executive Director Population Health",
    ],
    keywords: "clinical leadership, medical staff, physician alignment, clinical integration, population health, value-based care, ACOs, accountable care, clinical informatics, care management, risk adjustment",
  },

  "Nursing Officer": {
    titles: [
      "Chief Nursing Officer","CNO",
      "Chief Nursing Executive","CNE",
      "SVP Patient Care Services","Senior VP Patient Care Services",
      "EVP Patient Care & CNO",
      "VP Nursing","Vice President Nursing",
      "Executive Director Nursing Practice",
    ],
    keywords: "nursing strategy, professional practice model, care delivery, nursing workforce, retention, Magnet, shared governance, healthy work environment, interprofessional, nurse-sensitive outcomes",
  },

  "Operating Officer": {
    titles: [
      "Chief Operating Officer","COO",
      "EVP Operations",
      "SVP Operations","Senior Vice President Operations",
      "President & COO",
      "VP Hospital Operations","Vice President Hospital Operations",
      "Executive Director Perioperative Services",
    ],
    keywords: "operations strategy, performance improvement, capacity management, patient flow, throughput, supply chain, facilities, capital projects, lean, six sigma, operational excellence",
  },

  "Patient Experience": {
    titles: [
      "Chief Experience Officer","CXO",
      "Chief Patient Experience Officer",
      "SVP Patient Experience","Senior VP Patient Experience",
      "VP Patient Experience","VP Service Excellence","Vice President Service Excellence",
      "Director Patient Experience",
      "Executive Director Patient Engagement",
    ],
    keywords: "patient experience, human-centered design, real-time feedback, patient and family advisory councils, experience governance, empathy, compassion, service recovery, experience mapping, patient-reported outcomes, service excellence",
  },

  "Physician Executive": {
    titles: [
      "Chief Physician Executive","CPE","Chief Physician Officer",
      "SVP Physician Services","SVP Physician Enterprise","Senior VP Physician Enterprise",
      "VP Medical Staff","VP Physician Integration",
      "VP Clinical Integration","Vice President Clinical Integration",
      "Executive Director Medical Group",
    ],
    keywords: "physician leadership, clinical quality, medical staff, clinical integration, physician engagement, dyad leadership, group practice management, compensation, recruitment, service line strategy",
  },

  "Population Health": {
    titles: [
      "Chief Population Health Officer","CPHO",
      "SVP Population Health","Senior Vice President Population Health",
      "VP Population Health","VP Value-Based Care & Population Health",
      "VP Care Management","Vice President Care Management",
      "Executive Director Population Health Analytics",
    ],
    keywords: "population health, risk stratification, care management, social determinants, community health, health equity, predictive analytics, clinical integration, value-based care, payer partnerships",
  },

  "Quality Officer": {
    titles: [
      "Chief Quality Officer","CQO",
      "Chief Patient Safety Officer","Chief Quality & Safety Officer",
      "SVP Quality & Safety","Senior VP Quality & Safety",
      "VP Quality","VP Quality & Safety",
      "VP Clinical Excellence","Vice President Clinical Excellence",
      "Executive Director Accreditation & Regulatory",
    ],
    keywords: "quality strategy, high reliability, patient safety, regulatory, accreditation, clinical excellence, infection prevention, quality analytics, performance improvement, harm reduction, zero harm",
  },

  "Service Line": {
    titles: [
      "Chief Service Line Officer",
      "SVP Service Lines","SVP Oncology Services",
      "VP Service Lines","VP Clinical Service Lines",
      "VP Heart & Vascular","Vice President Heart & Vascular",
      "Executive Director Orthopedics & Neurosciences",
      "Service Line CMO","Service Line Chief Medical Officer",
      "Senior Director Oncology Services",
    ],
    keywords: "service line strategy, program development, growth, market share, centers of excellence, COEs, institutes, clinical outcomes, patient experience, strategic marketing, physician engagement, subspecialty, cardiology, oncology, orthopedics, neuroscience",
  },

  "Strategy": {
    titles: [
      "Chief Strategy Officer","CSO",
      "Chief Planning Officer",
      "SVP Strategy","SVP Strategy & Growth","Senior VP Strategy & Growth",
      "VP Strategy","VP Strategic Planning","Vice President Strategic Planning",
      "Executive Director Strategy & Innovation",
    ],
    keywords: "corporate strategy, strategic planning, business development, market intelligence, partnerships, M&A, mergers, acquisitions, scenario planning, strategic execution, portfolio management, growth",
  },

  "Value Based Care": {
    titles: [
      "Chief Value Officer","CVO",
      "Chief ACO Officer",
      "SVP Value Based Care","SVP Value Transformation","Senior VP Value Transformation",
      "VP Value Based Care","VP ACO",
      "VP Population Health & Value","Vice President Population Health & Value",
      "Executive Director ACO Strategy",
    ],
    keywords: "value-based care, risk-based contracting, bundled payments, episodes of care, ACOs, accountable care, clinically integrated networks, CINs, capitation, risk adjustment, performance metrics, gainsharing",
  },
};


// ─── Persona Search Keywords ─────────────────────────────────────────────────
// Short keyword(s) used to build deterministic search queries for each persona.
// These are what a human would type into Google: "org quality director"
// Single short keyword — used as the quoted phrase in searches.
// Keep it to 1-2 words so quoted phrase matching isn't too restrictive.
const PERSONA_SEARCH_KEYWORDS = {
  "Access/Patient Access":  "patient access",
  "Ambulatory/Urgent Care": "ambulatory",
  "Business Development":   "business development",
  "Case Management":        "care management",
  "Chief Clinical Officer": "clinical officer",
  "Clinical Operations":    "clinical operations",
  "Emergency Department":   "emergency",
  "Executive/Leadership":   "executive",
  "Finance":                "chief financial",
  "Innovation":             "digital innovation",
  "Medical Group":          "physician enterprise",
  "Medical":                "informatics",
  "Medical Officer":        "chief medical",
  "Nursing Officer":        "nursing",
  "Operating Officer":      "chief operating",
  "Patient Experience":     "patient experience",
  "Physician Executive":    "physician",
  "Population Health":      "population health",
  "Quality Officer":        "quality",
  "Service Line":           "service line",
  "Strategy":               "chief strategy",
  "Value Based Care":       "value based care",
};

// ─── CRM Contact Pre-Check ───────────────────────────────────────────────────
// Deterministic keyword matching so the model can't reason past explicit rules.
// Returns the matching contact object, or null.
function preCheckCRMContact(persona, existingContacts) {
  if (!existingContacts?.length) return null;

  // Keyword maps per persona.
  // Arrays are OR-matched (any hit = match). Case-insensitive.
  const KEYWORD_MAP = {
    "Access/Patient Access":   ["Patient Access", "Access Services", "Chief Access"],
    "Ambulatory/Urgent Care":  ["Ambulatory", "Urgent Care", "Outpatient"],
    "Business Development":    ["Business Development", "CBDO", "Chief Growth", "Strategic Partnerships", "Corporate Development"],
    "Case Management":         ["Case Management", "Care Coordination", "Care Transitions", "Cross Care"],
    "Chief Clinical Officer":  ["Chief Clinical Officer", "\bCCO\b", "EVP Clinical Affairs"],
    "Clinical Operations":     ["Clinical Operations", "Clinical Services", "\bCCOO\b"],
    "Emergency Department":    ["Emergency Medicine", "Emergency Services", "Emergency Department", "Chief of Emergency"],
    "Executive/Leadership":    ["\bCEO\b", "Chief Executive", "System President", "Executive Director"],
    "Finance":                 ["\bCFO\b", "Chief Financial", "Revenue Cycle", "EVP.*Finance"],
    "Innovation":              ["Innovation", "Digital Transformation", "\bCINO\b"],
    "Medical":                 ["\bCMIO\b", "Medical Informatics", "Clinical Informatics", "Medical Information"],
    "Medical Group":           ["Medical Group", "Physician Group", "Faculty Practice"],
    "Medical Officer":         ["\bCMO\b", "Chief Medical Officer", "Medical Affairs", "Medical Staff"],
    "Nursing Officer":         ["\bCNO\b", "\bCNE\b", "Chief Nursing", "Patient Care Services", "VP Nursing", "SVP Nursing"],
    "Operating Officer":       ["\bCOO\b", "Chief Operating", "Hospital Operations",
                                "Acute & Ambulatory Operations", "Acute and Ambulatory Operations"],
    "Patient Experience":      ["Patient Experience", "Service Excellence", "\bCXO\b"],
    "Physician Executive":     ["Chief Physician", "\bCPE\b", "Physician Enterprise", "Physician Integration"],
    "Population Health":       ["Population Health", "Value-Based Care", "Value Based Care"],
    "Quality Officer":         ["Quality", "Patient Safety", "Clinical Excellence", "\bCQO\b"],
    "Service Line":            ["Cardiology", "Oncology", "Neurosciences", "Neuroscience", "Orthopedics",
                                "Heart.*Vascular", "Vascular", "Cancer", "Spine", "Surgical Services",
                                "Trauma", "Service Line"],
    "Strategy":                ["Chief Strategy", "Strategic Planning", "\bCSO\b"],
    "Value Based Care":        ["Value.Based Care", "Value Based Care", "\bACO\b", "\bCVO\b"],
  };

  const patterns = KEYWORD_MAP[persona];
  if (!patterns) return null;

  for (const contact of existingContacts) {
    // If this contact is already assigned to a different persona, skip it.
    // We don't want to double-count someone already covering another role.
    // Only skip if persona is explicitly set — unassigned contacts are fair game.
    const assignedPersona = contact.persona;
    if (assignedPersona && assignedPersona !== "unassigned" && assignedPersona !== persona) continue;
    const title = contact.title || "";
    for (const kw of patterns) {
      const re = new RegExp(kw, "i");
      if (re.test(title)) {
        console.log(`[gap-search] CRM pre-check HIT: persona="${persona}" contact="${contact.name}" title="${title}" keyword="${kw}"`);
        return contact;
      }
    }
  }
  return null;
}

export const config = { path: "/api/hubspot-gap-search" };

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...CORS, "Content-Type": "application/json" } });

  // ── Leadership page fetcher ──────────────────────────────────────────────────
  // Fetches org's own website once per call to get current leadership context.
  // Tries paths in priority order; strips HTML; limits to 3000 chars.
  async function fetchLeadershipPage(domain) {
    if (!domain) return null;
    const base = `https://${domain.replace(/^https?:\/\//, '')}`;
    const paths = ['/about/leadership','/leadership','/about/our-team','/about/team','/about'];
    for (const path of paths) {
      try {
        const r = await fetch(base + path, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CipherBot/1.0)' },
          signal: AbortSignal.timeout(5000),
          redirect: 'follow',
        });
        if (!r.ok) continue;
        const ct = r.headers.get('content-type') || '';
        if (!ct.includes('text')) continue;
        const html = await r.text();
        // Strip scripts/styles/tags, collapse whitespace
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .trim();
        if (text.length > 200) {
          return { text: text.slice(0, 3000), url: base + path };
        }
      } catch { /* timeout or network error — try next path */ }
    }
    return null;
  }

  try {
    const body = await req.json();
    const { companyName, domain, missingPersonas = [], existingContacts = [] } = body;

    if (!companyName || !missingPersonas.length) {
      return new Response(JSON.stringify({ error: "companyName and missingPersonas required" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    if (!ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
    }

    const persona    = missingPersonas[0];
    const definition = PERSONA_DEFINITIONS[persona];
    const titles     = (definition?.titles || [persona]).join('", "');
    const keywords   = definition?.keywords || persona;
    const domainStr  = domain ? `https://${domain}` : companyName;

    // ── CRM pre-check (deterministic JS — bypasses model entirely) ──────────
    const crmMatch = preCheckCRMContact(persona, existingContacts);
    if (crmMatch) {
      const result = {
        persona,
        name:              crmMatch.name  || null,
        title:             crmMatch.title || null,
        linkedinUrl:       crmMatch.linkedinUrl || null,
        email:             crmMatch.email || null,
        emailConfidence:   "unknown",
        sourceUrl:         null,
        sourceYear:        null,
        confidence:        "existing_crm_contact",
        alreadyInCRM:      true,
        titleFitReasoning: `Title "${crmMatch.title}" functionally covers ${persona} (keyword match)`,
        notes:             "Matched via CRM pre-check — no web search needed",
      };
      console.log(`[gap-search] CRM pre-check RETURN: persona="${persona}" name="${result.name}" title="${result.title}"`);
      return new Response(JSON.stringify({
        companyName,
        searchedPersonas:  [persona],
        remainingPersonas: missingPersonas.slice(1),
        hasMore:           missingPersonas.length > 1,
        found:             [result],
      }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
    }

    // Format existing contacts for context injection
    const existingContactsText = existingContacts.length > 0
      ? `\n## EXISTING CONTACTS AT ${companyName} IN YOUR CRM\nThese people are already in our CRM for this organization. Study their titles carefully — some may functionally cover a persona even if their title doesn't exactly match the standard titles listed below.\n\n${existingContacts.map(c => `- ${c.name} | ${c.title || 'No title'} | Persona: ${c.persona || 'unassigned'}`).join('\n')}\n`
      : '';

    // Fetch org's leadership page for high-signal first-party context
    const leadershipPage = await fetchLeadershipPage(domain);
    const leadershipContext = leadershipPage
      ? `\n## ORG LEADERSHIP PAGE (${leadershipPage.url})\nThis is the actual content from the organization's own website. Use it as the HIGHEST-CONFIDENCE source — if a name appears here with a matching title, it is almost certainly current.\n\n${leadershipPage.text}\n`
      : '';

    // Generate deterministic search queries — same logic a human uses:
    // try each authority level in sequence until something is found.
    const searchKeyword = PERSONA_SEARCH_KEYWORDS[persona] || persona.toLowerCase();
    const orgShort = companyName.replace(/ healthcare$/i,'').replace(/ health system$/i,'').replace(/ health$/i,'').trim();
    // Use quotes around searchKeyword to avoid generic word matches (e.g., "patient access"
    // vs patient portal access pages). ZoomInfo and LinkedIn are critical for director-level.
    const kw = `"${searchKeyword}"`;
    const deterministicQueries = [
      `${companyName} ${kw} site:theorg.com`,
      `site:${domain} ${searchKeyword}`,
      `${companyName} ${kw}`,
      `${orgShort} ${kw} officer OR "vice president"`,
      `${orgShort} ${kw} director`,
      `${orgShort} ${kw} director site:zoominfo.com`,
      `${orgShort} ${kw} director site:linkedin.com`,
      `${orgShort} ${kw} manager site:zoominfo.com`,
    ].map((q, i) => `${i + 1}. ${q}`).join('\n');

    const systemPrompt = `You are an expert healthcare executive researcher embedded in a CRM intelligence platform for Care Continuity, a healthcare SaaS company. Your job is: given a PERSONA ROLE and an org, determine whether an existing CRM contact already functionally covers it, and if not, find who currently holds it.

## FUNCTIONAL TITLE EQUIVALENCE (critical — memorize these)
These non-standard titles FUNCTIONALLY cover the persona listed. Do not search if an existing contact matches:

Operating Officer: Chief Operating Officer, COO, EVP Operations, SVP Operations, President & COO, EVP & COO, Chief Administrative Officer when they also have COO scope
Nursing Officer:   Chief Nursing Officer, CNO, Chief Nursing Executive, CNE, Chief Nurse Executive, SVP Patient Care Services, EVP Patient Care
Medical Officer:   Chief Medical Officer, CMO, SVP Medical Affairs, VP Medical Affairs, Chief of Medicine, Physician-in-Chief, EVP & CMO
Strategy:          Chief Strategy Officer, CSO, SVP Strategy, VP Strategy, VP Strategic Planning, Chief Planning Officer
Finance:           Chief Financial Officer, CFO, SVP Finance, VP Finance, VP Revenue Cycle, EVP Finance, EVP & CFO
Innovation:        Chief Digital Officer, CDO, Chief Innovation Officer, CINO, Chief Transformation Officer, SVP Digital Transformation, VP Innovation
Quality Officer:   Chief Quality Officer, CQO, Chief Patient Safety Officer, SVP Quality & Safety, VP Quality, VP Clinical Excellence
Patient Experience: Chief Experience Officer, CXO, Chief Patient Experience Officer, SVP Patient Experience, VP Patient Experience, VP Service Excellence
Business Development: Chief Business Development Officer, CBDO, Chief Growth Officer, SVP Business Development, VP Business Development, VP Strategic Partnerships
Population Health:  Chief Population Health Officer, SVP Population Health, VP Population Health, VP Value-Based Care & Population Health
Case Management:   VP Case Management, VP Care Management, VP Care Transitions, SVP Care Coordination, Chief Care Management Officer
Value Based Care:  Chief Value Officer, SVP Value Based Care, VP Value Based Care, VP ACO, Chief ACO Officer, SVP Value Transformation
Clinical Operations: Chief Clinical Operations Officer, VP Clinical Operations, VP Clinical Services, SVP Clinical Operations
Physician Executive: Chief Physician Executive, CPE, Chief Physician Officer, SVP Physician Enterprise, VP Physician Integration
Executive/Leadership: CEO, President, COO when acting as #2, EVP, SVP, Executive Director — any C-suite or senior VP not covered by a more specific persona

## EXISTING CONTACT EVALUATION (do this BEFORE searching)
Before using any search tool, reason carefully: does any existing CRM contact FUNCTIONALLY cover this persona?
- Do NOT rely on the target_persona field — it is often blank even when the contact covers the role
- DO read their job title and reason about what they actually do
- A "Chief Administrative Officer" covering COO duties = covers Operating Officer
- A "Chief Nurse Executive" = covers Nursing Officer
- A "Chief Digital Officer" = covers Innovation
- An "EVP, Academic Group" at a teaching hospital = covers Executive/Leadership
- If an existing contact functionally covers the role: set alreadyInCRM: true, return their name/title, skip web search

## HEALTHCARE WEBSITE KNOWLEDGE
Most health system leadership pages load exec names via JavaScript — the raw HTML may only show navigation, not names.
Individual bio pages are usually at paths like:
  domain.org/about-us/leadership/{firstname-lastname}
  domain.org/about/leadership/{name}
  domain.org/leadership/team/{name}
When a specific name is mentioned in a search result snippet, note the URL pattern and use it directly.

## SOURCE PRIORITY (strict — do not override this order)
1. **The org's own website** (\`site:{domain}\`) — this is ground truth. A person listed on the org's leadership page beats any external source regardless of date. If the website says X holds the role, X is the answer.
2. **Multiple corroborating external sources** (The Org + ZoomInfo + LinkedIn all agreeing) — high confidence.
3. **Single external source** (one LinkedIn post, one news article, one PDF) — medium confidence, flag it.
4. Never let a single third-party document override the org's own leadership page.

## TITLE HIERARCHY — search ALL levels, not just C-suite
If a C-suite or SVP search returns nothing, cascade DOWN the hierarchy. Many orgs fill these functions at Director level:

Quality Officer hierarchy:     Chief Quality Officer → SVP Quality → VP Quality → Director Quality Management → Director Patient Safety
Patient Access hierarchy:      Chief Patient Access Officer → VP Patient Access → Director Patient Access → Director Revenue Cycle → Patient Access Director
Nursing Officer hierarchy:     Chief Nursing Officer → VP Nursing → Director of Nursing → Associate CNO
Case Management hierarchy:     VP Case Management → Director Care Management → Director Case Management → Director Care Transitions
Population Health hierarchy:   SVP Population Health → VP Population Health → Director Population Health → Director Care Management
Clinical Operations hierarchy: VP Clinical Operations → Director Clinical Operations → Director Clinical Services
Service Line hierarchy:        SVP Service Lines → VP Service Lines → Director Oncology → Director Cardiology (use most senior service line director)
Physician Executive hierarchy: Chief Physician Executive → SVP Physician Enterprise → VP Medical Staff → Medical Director (employed physician group)
Emergency Department hierarchy: Chief Emergency Medicine → VP Emergency Services → Medical Director Emergency → ED Director

If you find someone at Director level, return them — a Director of Patient Safety is a real contact, not a consolation prize.

## ACCURACY RULES
- theorg.com + the org's own website are ground truth — they override PDFs, news articles, coalition lists.
- A single third-party document (FDA filing, conference list, news article) = confidence "medium" at best, never "high".
- confidence "high" requires: org website bio page OR theorg.com showing this person in this role.
- If a result says "former" or "previously" — ignore that person, keep searching.
- If a function is outsourced to a vendor, still find who INSIDE the org manages it — search director level.
- When in doubt, return confidence: "low" rather than guess.

Your output populates a CRM. A wrong result creates duplicates and manual cleanup.`;


    const userPrompt = `## TASK
Determine who currently holds the **${persona}** role at **${companyName}**.

${existingContactsText}${leadershipContext}
## ROLE DETAILS
Persona:         ${persona}
Standard Titles: ${titles}
Keywords:        ${keywords}
Org Website:     ${domainStr}

## STEP 1 — EVALUATE EXISTING CRM CONTACTS FIRST (no search needed if match found)
Read each existing contact above. For each one:
- What does their title indicate they actually DO at this organization?
- Does their functional role cover **${persona}**? Use the functional equivalence rules in your system instructions.
- A blank target_persona field does NOT mean the contact doesn't cover this role.
- Titles can change — an "EVP Chief Administrative Officer" may now be COO.

If ANY existing contact functionally covers ${persona}:
→ Set alreadyInCRM: true, use their name and CURRENT title (verify via web if title seems stale), skip to OUTPUT.

## STEP 2 — WEB SEARCH (only if no existing contact covers this role)
${leadershipContext ? "Leadership page content was pre-fetched above — check it for a match before additional searching." : "No leadership page was pre-fetched."}
Use a MAXIMUM of 3 web searches. Stop as soon as you find a strong match.

## EXACT SEARCHES — run these in order, stop at the first strong match
${deterministicQueries}

MANDATORY RULES — do not skip any:
1. Run ALL searches in the list above. Every single one. Do not stop early.
2. Even if search 1 returns a name — still run searches 2-7. You need multiple sources.
3. Even if the function appears outsourced — still run director-level searches. Someone internal manages it.
4. Collect results from ALL searches, then decide who the best match is.
5. theorg.com or org website = high confidence. Single PDF/article = medium only.
6. If searches disagree, use the most recent source from theorg.com or org website.
7. A Director-level person IS a valid result — do not return null just because there is no C-suite title.

## OUTPUT
Return ONLY valid JSON, no markdown, no explanation:
{
  "name": "Full Name or null",
  "title": "Exact current title or null",
  "linkedinUrl": "URL or null",
  "email": "email or null",
  "emailConfidence": "found/pattern/unknown",
  "sourceUrl": "URL where found or null",
  "sourceYear": "2024 or null",
  "confidence": "high/medium/low",
  "alreadyInCRM": true or false,
  "titleFitReasoning": "One sentence: why this title covers ${persona}",
  "notes": "Any caveats"
}`
    // ─── PHASE 1: Search execution ──────────────────────────────────────────────
    // Haiku's only job here is to call web_search for every query and return snippets.
    // No analysis, no stopping decisions. Separate from Phase 2 so both are reliable.
    const searchResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 4000,
        system: "You are a search executor. Your ONLY job is to run web searches. For EVERY numbered query in the user message, call the web_search tool with that exact query string. Run all of them — do not skip any. After all searches are done, return a JSON array: [{query, snippets: [top 3 result titles+snippets]}]. Nothing else.",
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: `Run ALL of these searches in order:\n${deterministicQueries}` }],
      }),
    });
    if (!searchResp.ok) throw new Error(`Search phase error ${searchResp.status}: ${(await searchResp.text()).slice(0,200)}`);
    const searchData = await searchResp.json();

    // Collect all text + tool result blocks from the search phase
    const searchSnippets = (searchData.content || [])
      .filter(b => b.type === "text" || b.type === "tool_result")
      .map(b => b.type === "text" ? b.text : JSON.stringify(b.content).slice(0, 800))
      .join("\n---\n")
      .slice(0, 8000); // cap to avoid phase 2 bloat

    // ─── PHASE 2: Analysis ───────────────────────────────────────────────────────
    // Takes all search snippets. No web_search tool. Just extracts the best match.
    const analyzeResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt + "\n\n## SEARCH RESULTS FROM ALL QUERIES\n" + searchSnippets }],
      }),
    });
    if (!analyzeResp.ok) throw new Error(`Analyze phase error ${analyzeResp.status}: ${(await analyzeResp.text()).slice(0,200)}`);

    const analyzeData = await analyzeResp.json();
    const analyzeText = (analyzeData.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();

    // Extract candidate name from phase 2 before verification
    let candidateName = null;
    try {
      const m = analyzeText.match(/\{[\s\S]*\}/);
      if (m) { const p = JSON.parse(m[0]); candidateName = p.alreadyInCRM ? null : p.name; }
    } catch {}

    // ─── PHASE 3: Employment verification ────────────────────────────────────────
    // If phase 2 found a new name (not already in CRM), verify they still work there
    // via a targeted LinkedIn search. ZoomInfo/news sources are often stale.
    let verificationSnippets = "";
    if (candidateName && candidateName !== "null") {
      const verifyResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model:      "claude-haiku-4-5-20251001",
          max_tokens: 1500,
          system: "You are a search executor. Run the two search queries given. Return the results as text. Nothing else.",
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{ role: "user", content:
            `Run these two verification searches for ${candidateName}:\n` +
            `1. "${candidateName}" "${companyName}" site:linkedin.com\n` +
            `2. "${candidateName}" site:${domain}`
          }],
        }),
      });
      if (verifyResp.ok) {
        const vd = await verifyResp.json();
        verificationSnippets = (vd.content || []).filter(b => b.type === "text" || b.type === "tool_result")
          .map(b => b.type === "text" ? b.text : JSON.stringify(b.content).slice(0,600)).join("\n").slice(0, 3000);
      }
    }

    // ─── Final pass: Re-analyze with verification data ───────────────────────────
    const finalPrompt = verificationSnippets
      ? analyzeText + "\n\n## EMPLOYMENT VERIFICATION RESULTS\nUse this to confirm if the candidate is CURRENTLY at " + companyName + ". If LinkedIn or org website shows them at a different organization now, downgrade confidence to low and set name to null.\n" + verificationSnippets
      : analyzeText;

    // Parse the final result — if we have verification data, re-run analysis; otherwise use phase 2
    let rawText = analyzeText;
    if (verificationSnippets) {
      const finalResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model:      "claude-haiku-4-5-20251001",
          max_tokens: 800,
          system: "You are a CRM data validator. Given a candidate finding and verification search results, output the final JSON. If verification shows the person now works elsewhere, set name to null and confidence to low.",
          messages: [{ role: "user", content: finalPrompt }],
        }),
      });
      if (finalResp.ok) {
        const fd = await finalResp.json();
        rawText = (fd.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim() || analyzeText;
      }
    }

    const data = { content: [{ type: "text", text: rawText }] };

    let result = {
      persona,
      name: null, title: null, linkedinUrl: null, email: null,
      emailConfidence: "unknown", sourceUrl: null, sourceYear: null,
      confidence: "low", alreadyInCRM: false, titleFitReasoning: null, notes: null,
    };

    // Debug: log what the model actually returned so we can diagnose low-confidence results
    console.log(`[gap-search] persona="${persona}" company="${companyName}" rawText=${rawText.slice(0, 800)}`);

    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const year   = parseInt(parsed.sourceYear || "2025");
        const stale  = !isNaN(year) && year < 2022 && parsed.confidence !== "existing_crm_contact";
        result = {
          persona,
          name:              stale ? null : (parsed.name            || null),
          title:             stale ? null : (parsed.title           || null),
          linkedinUrl:       stale ? null : (parsed.linkedinUrl     || null),
          email:             stale ? null : (parsed.email           || null),
          emailConfidence:   parsed.emailConfidence  || "unknown",
          sourceUrl:         parsed.sourceUrl        || null,
          sourceYear:        parsed.sourceYear       || null,
          confidence:        stale ? "low" : (parsed.confidence     || "low"),
          alreadyInCRM:      parsed.alreadyInCRM     || false,
          titleFitReasoning: parsed.titleFitReasoning || null,
          notes:             stale
            ? `Rejected — source year ${parsed.sourceYear} is pre-2022`
            : (parsed.notes || null),
        };
        console.log(`[gap-search] result: persona="${persona}" name="${result.name}" confidence="${result.confidence}" stale=${stale} sourceYear=${parsed.sourceYear} notes="${result.notes}"`);
      }
    } catch (e) {
      console.error("[gap-search] parse error:", e.message, rawText.slice(0, 200));
    }

    return new Response(JSON.stringify({
      companyName,
      searchedPersonas:  [persona],
      remainingPersonas: missingPersonas.slice(1),
      hasMore:           missingPersonas.length > 1,
      found:             [result],
    }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });

  } catch (err) {
    console.error("[gap-search] error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
}
