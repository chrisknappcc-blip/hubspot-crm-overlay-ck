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
  "Access/Patient Access":   { titles: ["Chief Access Officer","VP Patient Access","Vice President Patient Access","Director Patient Access","VP Access Services","VP Patient Access & Scheduling"], keywords: "patient access scheduling registration admissions" },
  "Ambulatory/Urgent Care":  { titles: ["Chief Ambulatory Officer","VP Ambulatory","VP Ambulatory Care","VP Ambulatory Services","Ambulatory Chief Medical Officer","VP Ambulatory Operations","SVP Ambulatory","Medical Director Ambulatory","VP Multispecialty","Chief Medical Officer Ambulatory","VP Ambulatory Chief Medical Officer"], keywords: "ambulatory care outpatient urgent care clinic multispecialty" },
  "Business Development":    { titles: ["Chief Business Development Officer","VP Business Development","SVP Business Development","VP Growth","Chief Growth Officer","VP Strategic Partnerships","VP Corporate Development"], keywords: "business development partnerships growth strategy expansion" },
  "Case Management":         { titles: ["VP Case Management","Chief Care Management Officer","Director Case Management","VP Care Management","VP Care Transitions","VP Care Coordination"], keywords: "case management care coordination transitions utilization discharge" },
  "Clinical Operations":     { titles: ["VP Clinical Operations","Chief Clinical Operations Officer","SVP Clinical Operations","VP Clinical Services"], keywords: "clinical operations hospital operations patient care services" },
  "Emergency Department":    { titles: ["Chief of Emergency Medicine","Medical Director Emergency","VP Emergency Services","Chair Emergency Medicine","Chief Emergency Services"], keywords: "emergency department emergency medicine ED urgent" },
  "Executive/Leadership":    { titles: ["CEO","President","President & CEO","Chief Executive Officer","Executive Director","System President"], keywords: "chief executive president hospital health system leadership" },
  "Finance":                 { titles: ["CFO","Chief Financial Officer","SVP Finance","EVP & CFO","VP Finance","Senior Vice President Finance"], keywords: "chief financial officer CFO finance revenue cycle budget" },
  "Innovation":              { titles: ["Chief Innovation Officer","Chief Digital Officer","Chief Transformation Officer","VP Innovation","CDO"], keywords: "innovation digital transformation technology health IT" },
  "Medical Group":           { titles: ["President Medical Group","CEO Medical Group","VP Medical Group","Executive Director Medical Group"], keywords: "medical group physician group practice management" },
  "Medical":                 { titles: ["CMIO","Chief Medical Information Officer","VP Medical Informatics","Chief Clinical Informatics Officer"], keywords: "CMIO medical informatics clinical informatics EHR" },
  "Chief Clinical Officer":  { titles: ["CCO","Chief Clinical Officer","EVP Clinical Affairs","Chief of Clinical Affairs"], keywords: "chief clinical officer clinical affairs quality" },
  "Medical Officer":         { titles: ["CMO","Chief Medical Officer","SVP Medical Affairs","VP Medical Affairs","Chief of Medicine","Physician-in-Chief"], keywords: "chief medical officer CMO physician leadership medical affairs" },
  "Nursing Officer":         { titles: ["CNO","Chief Nursing Officer","Chief Nursing Executive","VP Nursing","SVP Patient Care Services","EVP Patient Care & CNO"], keywords: "chief nursing officer CNO nursing patient care services" },
  "Operating Officer":       { titles: ["COO","Chief Operating Officer","EVP Operations","SVP Operations","President & COO"], keywords: "chief operating officer COO operations hospital operations" },
  "Patient Experience":      { titles: ["Chief Experience Officer","Chief Patient Experience Officer","VP Patient Experience","Director Patient Experience"], keywords: "patient experience patient satisfaction service excellence" },
  "Physician Executive":     { titles: ["Chief Physician Executive","VP Medical Staff","SVP Physician Services","Chief Physician Officer","VP Physician Integration"], keywords: "physician executive physician leadership physician services" },
  "Population Health":       { titles: ["Chief Population Health Officer","VP Population Health","SVP Population Health","VP Value-Based Care & Population Health"], keywords: "population health community health value-based care ACO" },
  "Quality Officer":         { titles: ["Chief Quality Officer","VP Quality","Chief Patient Safety Officer","VP Quality & Safety","Chief Quality & Safety Officer"], keywords: "quality patient safety quality improvement accreditation" },
  "Service Line":            { titles: ["VP Service Lines","Chief Service Line Officer","SVP Service Lines","VP Clinical Service Lines"], keywords: "service line cardiology oncology orthopedics neuroscience" },
  "Strategy":                { titles: ["Chief Strategy Officer","CSO","VP Strategy","SVP Strategy","Chief Planning Officer"], keywords: "strategy strategic planning mergers acquisitions growth" },
  "Value Based Care":        { titles: ["Chief Value Officer","VP Value Based Care","SVP Value Based Care","VP ACO","Chief ACO Officer"], keywords: "value based care accountable care ACO bundled payments risk" },
};

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

## STEP 1: CHECK EXISTING CONTACTS FIRST — NO WEB SEARCH
Review the existing contacts list above. Does any contact's title FUNCTIONALLY cover the ${persona} role?
- "VP Ambulatory Chief Medical Officer" covers Ambulatory/Urgent Care
- "Chief Nursing Executive" covers Nursing Officer
- "EVP & CFO" covers Finance
If YES → return that person immediately with confidence: "existing_crm_contact". Do NOT call web_search.

## STEP 2: ONLY IF NOT FOUND IN EXISTING CONTACTS — SEARCH THE WEB
Use a MAXIMUM of 2-3 web searches total. Do not search more than 3 times.
1. Search: "${companyName}" "${(definition?.titles||[])[0]||persona}" leadership 2024 OR 2025
2. Search: site:${domain || companyName.split(' ')[0].toLowerCase()+'.org'} leadership team
3. ONLY if needed: "${companyName}" "${keywords.split(' ').slice(0,2).join(' ')}" site:linkedin.com

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
          budget_tokens: 1000,
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
