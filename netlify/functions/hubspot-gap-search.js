// ─── Cipher — Gold Account Gap Search ────────────────────────────────────────
// Claude Sonnet + web_search + direct org website fetch
// Priority: org website first → LinkedIn → news → fallback search
// Recency: 2023-2026 only, explicitly reject stale sources

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const PERSONA_DEFINITIONS = {
  "Access/Patient Access": {
    titles: ["Chief Access Officer", "VP Patient Access", "Vice President Patient Access", "Director Patient Access", "VP Access Services", "VP Patient Access & Scheduling"],
    keywords: "patient access scheduling registration admissions",
  },
  "Ambulatory/Urgent Care": {
    titles: ["Chief Ambulatory Officer", "VP Ambulatory", "VP Ambulatory Care", "VP Ambulatory Services", "Ambulatory Chief Medical Officer", "VP Ambulatory Operations", "SVP Ambulatory", "Medical Director Ambulatory", "VP Multispecialty", "Chief Medical Officer Ambulatory"],
    keywords: "ambulatory care outpatient urgent care clinic multispecialty",
  },
  "Business Development": {
    titles: ["Chief Business Development Officer", "VP Business Development", "SVP Business Development", "VP Growth", "Chief Growth Officer", "VP Strategic Partnerships", "VP Corporate Development"],
    keywords: "business development partnerships growth strategy expansion",
  },
  "Case Management": {
    titles: ["VP Case Management", "Chief Care Management Officer", "Director Case Management", "VP Care Management", "VP Care Transitions", "VP Care Coordination", "Chief Care Coordination Officer"],
    keywords: "case management care coordination transitions utilization discharge",
  },
  "Clinical Operations": {
    titles: ["VP Clinical Operations", "Chief Clinical Operations Officer", "SVP Clinical Operations", "VP Clinical Services", "Chief Operating Officer Clinical"],
    keywords: "clinical operations hospital operations patient care services",
  },
  "Emergency Department": {
    titles: ["Chief of Emergency Medicine", "Medical Director Emergency", "VP Emergency Services", "Chair Emergency Medicine", "Chief Emergency Services", "Emergency Medicine Chair"],
    keywords: "emergency department emergency medicine ED urgent emergency services",
  },
  "Executive/Leadership": {
    titles: ["CEO", "President", "President & CEO", "Chief Executive Officer", "Executive Director", "System President", "President and Chief Executive Officer"],
    keywords: "chief executive president hospital health system leadership top executive",
  },
  "Finance": {
    titles: ["CFO", "Chief Financial Officer", "SVP Finance", "EVP & CFO", "VP Finance", "Senior Vice President Finance", "Executive VP Finance"],
    keywords: "chief financial officer CFO finance revenue cycle budget",
  },
  "Innovation": {
    titles: ["Chief Innovation Officer", "Chief Digital Officer", "Chief Transformation Officer", "VP Innovation", "Chief Information & Innovation Officer", "CDO", "Chief Technology & Innovation Officer"],
    keywords: "innovation digital transformation technology health IT digital strategy",
  },
  "Medical Group": {
    titles: ["President Medical Group", "CEO Medical Group", "Chief Medical Group Officer", "VP Medical Group", "Executive Director Medical Group", "Medical Group CEO", "Medical Group President"],
    keywords: "medical group physician group practice management employed physicians",
  },
  "Medical": {
    titles: ["CMIO", "Chief Medical Information Officer", "VP Medical Informatics", "Chief Clinical Informatics Officer", "Medical Director Informatics", "Chief Health Information Officer"],
    keywords: "CMIO medical informatics clinical informatics EHR information officer physician",
  },
  "Chief Clinical Officer": {
    titles: ["CCO", "Chief Clinical Officer", "EVP Clinical Affairs", "Chief of Clinical Affairs", "Chief Clinical Integration Officer", "Chief Clinical and Quality Officer"],
    keywords: "chief clinical officer clinical affairs quality clinical integration",
  },
  "Medical Officer": {
    titles: ["CMO", "Chief Medical Officer", "SVP Medical Affairs", "VP Medical Affairs", "Chief of Medicine", "Physician-in-Chief", "Executive Vice President Medical Affairs"],
    keywords: "chief medical officer CMO physician leadership medical staff medical affairs",
  },
  "Nursing Officer": {
    titles: ["CNO", "Chief Nursing Officer", "Chief Nursing Executive", "VP Nursing", "SVP Patient Care Services", "EVP Patient Care & CNO", "Chief Nurse Executive"],
    keywords: "chief nursing officer CNO nursing patient care services nursing executive",
  },
  "Operating Officer": {
    titles: ["COO", "Chief Operating Officer", "EVP Operations", "SVP Operations", "President & COO", "Chief Operations Officer", "Executive Vice President Operations"],
    keywords: "chief operating officer COO operations hospital operations",
  },
  "Patient Experience": {
    titles: ["Chief Experience Officer", "Chief Patient Experience Officer", "VP Patient Experience", "Director Patient Experience", "Chief of Patient Experience", "VP Experience"],
    keywords: "patient experience patient satisfaction service excellence experience officer",
  },
  "Physician Executive": {
    titles: ["Chief Physician Executive", "VP Medical Staff", "SVP Physician Services", "Chief Physician Officer", "VP Physician Integration", "Medical Executive Director", "VP Physician Relations"],
    keywords: "physician executive physician leadership physician services medical staff relations",
  },
  "Population Health": {
    titles: ["Chief Population Health Officer", "VP Population Health", "SVP Population Health", "VP Value-Based Care & Population Health", "Director Population Health", "Chief Population Health & Value Officer"],
    keywords: "population health community health value-based care ACO accountable care",
  },
  "Quality Officer": {
    titles: ["Chief Quality Officer", "VP Quality", "Chief Patient Safety Officer", "VP Quality & Safety", "Chief Quality & Safety Officer", "SVP Quality", "Chief Quality and Patient Safety Officer"],
    keywords: "quality patient safety quality improvement accreditation regulatory",
  },
  "Service Line": {
    titles: ["VP Service Lines", "Chief Service Line Officer", "SVP Service Lines", "VP Clinical Service Lines", "VP Hospital Operations & Service Lines", "Service Line VP"],
    keywords: "service line cardiology oncology orthopedics neuroscience clinical program",
  },
  "Strategy": {
    titles: ["Chief Strategy Officer", "CSO", "VP Strategy", "SVP Strategy", "Chief Planning Officer", "VP Strategic Planning", "Chief Strategy and Transformation Officer"],
    keywords: "strategy strategic planning mergers acquisitions growth planning",
  },
  "Value Based Care": {
    titles: ["Chief Value Officer", "VP Value Based Care", "SVP Value Based Care", "VP ACO", "Chief ACO Officer", "VP Accountable Care", "VP Value-Based Programs"],
    keywords: "value based care accountable care ACO bundled payments risk contracts",
  },
};

export const config = { path: "/api/hubspot-gap-search" };

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  try {
    const body      = await req.json();
    const { companyName, domain, missingPersonas = [] } = body;

    if (!companyName || !missingPersonas.length) {
      return new Response(JSON.stringify({ error: "companyName and missingPersonas required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    if (!ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const persona    = missingPersonas[0];
    const definition = PERSONA_DEFINITIONS[persona];
    const titles     = (definition?.titles || [persona]).join('", "');
    const keywords   = definition?.keywords || persona;
    const domainStr  = domain ? `https://${domain}` : companyName;

    const prompt = `You are researching who currently holds a specific leadership role at a healthcare organization. Your goal is to find the CURRENT person in this role with HIGH accuracy.

## Target
Organization: ${companyName}
Website: ${domainStr}
Role Category: ${persona}
Typical Titles: "${titles}"
Role Keywords: ${keywords}

## SEARCH STRATEGY — Follow in this exact order:

### Step 1: Go directly to the organization's website
Search for: site:${domain || companyName.toLowerCase().replace(/\s+/g, '')+".org"} leadership OR "executive team" OR "our leaders" OR "leadership team"
Also try fetching: ${domainStr}/about/leadership OR ${domainStr}/about/our-team OR ${domainStr}/leadership

### Step 2: Search LinkedIn with current role context
Search: "${companyName}" "${keywords.split(" ").slice(0,3).join(" ")}" site:linkedin.com/in
Also try: "${companyName}" "${(definition?.titles||[])[0]||persona}" linkedin 2024 OR 2025

### Step 3: Search for recent news/announcements (2023-2026 ONLY)
Search: "${companyName}" "${(definition?.titles||[])[0]||persona}" appointed OR named OR joins 2024 OR 2025
Search: "${companyName}" leadership team 2024 OR 2025

### Step 4: Industry publications
Search: "${companyName}" "${keywords.split(" ")[0]}" site:beckershospitalreview.com OR site:modernhealthcare.com OR site:healthleadersmedia.com

## CRITICAL RULES
1. **RECENCY**: Only use sources from 2022 or later. If a source is from 2021 or earlier, IGNORE IT completely — leadership changes frequently and old data creates duplicates in our CRM.
2. **FUNCTIONAL FIT**: Match on what the person DOES, not exact title. "VP Ambulatory Chief Medical Officer, Multispecialty Services" = Ambulatory/Urgent Care. Use judgment.
3. **CURRENT EMPLOYMENT**: Verify the person is still at ${companyName} RIGHT NOW. Do not return someone who left.
4. **PREFER ORG WEBSITE**: The organization's own website is the most reliable source for current leadership. Prioritize it.
5. **EMAIL PATTERN**: If email not explicitly found, construct it from the org domain (${domain || "org domain"}): firstname.lastname@${domain || "domain.org"} — mark as "pattern"

## REASONING
Before outputting JSON, think:
- Did I check the org's website first?
- Is my source from 2022 or later?
- Does this person's title FUNCTIONALLY match the ${persona} role?
- Is there any evidence they're still at ${companyName} as of 2024-2025?

## OUTPUT
Respond with ONLY valid JSON — no markdown, no explanation, no preamble:
{
  "name": "Full Name or null",
  "title": "Exact current title or null",
  "linkedinUrl": "https://linkedin.com/in/... or null",
  "email": "email@domain.org or null",
  "emailConfidence": "found/pattern/unknown",
  "sourceUrl": "URL where you found this person",
  "sourceYear": "2024 or 2025 etc",
  "confidence": "high/medium/low",
  "titleFitReasoning": "Why this title fits the ${persona} persona",
  "notes": "How found, any caveats"
}

If not found after all steps, return JSON with null values and confidence: "low".`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-5",
        max_tokens: 2000,
        tools: [{
          type: "web_search_20250305",
          name: "web_search",
        }],
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Claude API error ${response.status}: ${err.slice(0, 300)}`);
    }

    const data = await response.json();

    // Extract final text block (after all tool use)
    const textBlocks = (data.content || []).filter(b => b.type === "text");
    const rawText    = textBlocks.map(b => b.text).join("\n").trim();

    let result = {
      persona,
      name:             null,
      title:            null,
      linkedinUrl:      null,
      email:            null,
      emailConfidence:  "unknown",
      sourceUrl:        null,
      sourceYear:       null,
      confidence:       "low",
      titleFitReasoning: null,
      notes:            null,
    };

    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        // Hard reject if source is pre-2022
        const year = parseInt(parsed.sourceYear || "2025");
        const sourceOk = isNaN(year) || year >= 2022;
        result = {
          persona,
          name:              sourceOk ? (parsed.name  || null) : null,
          title:             sourceOk ? (parsed.title || null) : null,
          linkedinUrl:       sourceOk ? (parsed.linkedinUrl || null) : null,
          email:             sourceOk ? (parsed.email || null) : null,
          emailConfidence:   parsed.emailConfidence  || "unknown",
          sourceUrl:         parsed.sourceUrl        || null,
          sourceYear:        parsed.sourceYear       || null,
          confidence:        sourceOk ? (parsed.confidence || "low") : "low",
          titleFitReasoning: parsed.titleFitReasoning || null,
          notes:             sourceOk
            ? (parsed.notes || null)
            : `Source rejected — year ${parsed.sourceYear} is too old (pre-2022)`,
        };
      }
    } catch (parseErr) {
      console.error("[gap-search] parse error:", parseErr.message, rawText.slice(0, 200));
    }

    return new Response(JSON.stringify({
      companyName,
      searchedPersonas:  [persona],
      remainingPersonas: missingPersonas.slice(1),
      hasMore:           missingPersonas.length > 1,
      found:             [result],
    }), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("[gap-search] error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
}
