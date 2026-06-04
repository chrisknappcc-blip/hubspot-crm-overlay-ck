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

    const systemPrompt = `You are an expert healthcare executive researcher embedded in a CRM intelligence platform for Care Continuity, a healthcare SaaS company. Your job is to find the CURRENT person holding a specific leadership role at a health system.

You have deep knowledge of healthcare org structures:
- Large health systems (>1000 beds) typically have all C-suite roles filled
- Titles are non-standard — "VP Ambulatory Chief Medical Officer, Multispecialty Services" is an Ambulatory/Urgent Care role
- Role function matters more than exact title — reason about what the person actually does
- People stay in roles for 3-10 years — recent hires are more likely to be correct than decade-old results
- IGNORE any source older than 2022 — healthcare leadership turns over frequently

Your output is used to populate a CRM. Accuracy is critical. A wrong result creates duplicate contacts and manual cleanup work. When in doubt, return null with confidence: "low" rather than guess.`;

    const userPrompt = `Find who currently holds the ${persona} role at ${companyName}.
${existingContactsText}
## ROLE TO FIND
Persona: ${persona}
Standard Titles: "${titles}"
Role Keywords: ${keywords}
Organization Website: ${domainStr}

## YOUR TASK: FIND WHO CURRENTLY HOLDS THE ${persona} ROLE AT ${companyName}
Search the web to identify the current person in this role.
If the person you find is already in the existing contacts list above, set alreadyInCRM: true AND still include their full name and title in the output — do not return null for name.

## WEB SEARCH
Use a MAXIMUM of 2-3 web searches total. Do not search more than 3 times.
1. Search: "${companyName}" "${(definition?.titles||[])[0]||persona}" 2024 OR 2025
2. Search: "${companyName}" ${keywords.split(',').slice(0,3).join(' ')} leadership
3. ONLY if needed: "${companyName}" "${persona}" site:linkedin.com

STOP searching as soon as you find a strong match. Do not run all 3 if search 1 finds someone.
Only use sources from 2022 or later.

## OUTPUT
Return ONLY valid JSON with no markdown or explanation:
{
  "name": "Full Name or null",
  "title": "Exact current title or null",
  "linkedinUrl": "https://linkedin.com/in/... or null",
  "email": "email or null",
  "emailConfidence": "found/pattern/unknown",
  "sourceUrl": "URL where found or null",
  "sourceYear": "2024 etc or null",
  "confidence": "high/medium/low/existing_crm_contact",
  "alreadyInCRM": true or false,
  "titleFitReasoning": "Why this title fits ${persona}",
  "notes": "How found, caveats"
}`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        thinking: {
          type:          "enabled",
          budget_tokens: 1024,
        },
        system: systemPrompt,
        tools: [{
          type: "web_search_20250305",
          name: "web_search",
        }],
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Claude API error ${response.status}: ${err.slice(0, 300)}`);
    }

    const data = await response.json();

    // Extract final text block (skip thinking blocks)
    const textBlocks = (data.content || []).filter(b => b.type === "text");
    const rawText    = textBlocks.map(b => b.text).join("\n").trim();

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
