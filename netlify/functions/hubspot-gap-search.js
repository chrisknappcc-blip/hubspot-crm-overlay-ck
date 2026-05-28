// ─── Cipher — Gold Account Gap Search (Claude + Web Search) ──────────────────
// Uses Claude Sonnet with web_search to find the BEST possible candidate for
// each missing persona at a Gold account. Prioritizes accuracy, verified emails,
// and cross-source confirmation. Built to the highest standard.

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Comprehensive role definitions per persona — titles, common aliases, search strategies
const PERSONA_DEFINITIONS = {
  "Access/Patient Access": {
    titles:    ["Chief Access Officer", "VP Patient Access", "Vice President Patient Access", "Director Patient Access", "Director of Access Services", "VP of Patient Access & Scheduling"],
    searchHints: "patient access scheduling registration admissions",
  },
  "Ambulatory/Urgent Care": {
    titles:    ["Chief Ambulatory Officer", "VP Ambulatory Care", "VP Ambulatory Services", "Chief of Ambulatory Medicine", "VP Ambulatory Operations", "SVP Ambulatory"],
    searchHints: "ambulatory care outpatient urgent care clinic operations",
  },
  "Business Development": {
    titles:    ["Chief Business Development Officer", "VP Business Development", "SVP Business Development", "VP of Growth", "Chief Growth Officer", "VP Strategic Partnerships"],
    searchHints: "business development partnerships growth strategy expansion",
  },
  "Case Management": {
    titles:    ["VP Case Management", "Chief Care Management Officer", "Director Case Management", "VP Care Management", "Director of Care Coordination", "VP Care Transitions"],
    searchHints: "case management care coordination transitions utilization",
  },
  "Clinical Operations": {
    titles:    ["VP Clinical Operations", "Chief Clinical Operations Officer", "SVP Clinical Operations", "COO Clinical Division", "VP Clinical Services"],
    searchHints: "clinical operations hospital operations patient care services",
  },
  "Emergency Department": {
    titles:    ["Chief of Emergency Medicine", "Medical Director Emergency Department", "VP Emergency Services", "Chair Emergency Medicine", "Chief Emergency Services"],
    searchHints: "emergency department emergency medicine emergency services ED",
  },
  "Executive/Leadership": {
    titles:    ["CEO", "President", "President & CEO", "Chief Executive Officer", "Executive Director", "System President"],
    searchHints: "chief executive president hospital health system leadership",
  },
  "Finance": {
    titles:    ["CFO", "Chief Financial Officer", "SVP Finance", "EVP & CFO", "VP Finance", "Senior Vice President Finance"],
    searchHints: "chief financial officer CFO finance revenue cycle",
  },
  "Innovation": {
    titles:    ["Chief Innovation Officer", "Chief Digital Officer", "Chief Transformation Officer", "VP Innovation", "Chief Information & Innovation Officer", "CDO"],
    searchHints: "innovation digital transformation technology health IT",
  },
  "Medical Group": {
    titles:    ["President Medical Group", "CEO Medical Group", "Chief Medical Group Officer", "VP Medical Group", "Executive Director Medical Group", "Medical Group CEO"],
    searchHints: "medical group physician group practice management employed physicians",
  },
  "Medical Information": {
    titles:    ["CMIO", "Chief Medical Information Officer", "VP Medical Informatics", "Chief Clinical Informatics Officer", "Medical Director Informatics"],
    searchHints: "CMIO medical informatics clinical informatics EHR information technology physician",
  },
  "Chief Clinical Officer": {
    titles:    ["CCO", "Chief Clinical Officer", "EVP Clinical Affairs", "Chief of Clinical Affairs", "Chief Clinical Integration Officer"],
    searchHints: "chief clinical officer clinical affairs quality clinical integration",
  },
  "Medical Officer": {
    titles:    ["CMO", "Chief Medical Officer", "SVP Medical Affairs", "VP Medical Affairs", "Chief of Medicine", "Physician-in-Chief"],
    searchHints: "chief medical officer CMO physician leadership medical staff",
  },
  "Nursing Officer": {
    titles:    ["CNO", "Chief Nursing Officer", "Chief Nursing Executive", "VP Nursing", "SVP Patient Care Services", "EVP Patient Care & CNO"],
    searchHints: "chief nursing officer CNO nursing patient care services nursing executive",
  },
  "Operating Officer": {
    titles:    ["COO", "Chief Operating Officer", "EVP Operations", "SVP Operations", "President & COO", "Chief Operations Officer"],
    searchHints: "chief operating officer COO operations hospital operations",
  },
  "Patient Experience": {
    titles:    ["Chief Experience Officer", "Chief Patient Experience Officer", "VP Patient Experience", "Director Patient Experience", "Chief of Patient Experience"],
    searchHints: "patient experience patient satisfaction service excellence",
  },
  "Physician Executive": {
    titles:    ["Chief Physician Executive", "VP Medical Staff", "SVP Physician Services", "Chief Physician Officer", "VP Physician Integration", "Medical Executive Director"],
    searchHints: "physician executive physician leadership physician services medical staff",
  },
  "Population Health": {
    titles:    ["Chief Population Health Officer", "VP Population Health", "SVP Population Health", "VP Value-Based Care & Population Health", "Director Population Health"],
    searchHints: "population health community health value-based care ACO",
  },
  "Quality Officer": {
    titles:    ["Chief Quality Officer", "VP Quality", "Chief Patient Safety Officer", "VP Quality & Safety", "Chief Quality & Safety Officer", "SVP Quality"],
    searchHints: "quality patient safety quality improvement accreditation",
  },
  "Service Line": {
    titles:    ["VP Service Lines", "Chief Service Line Officer", "SVP Service Lines", "VP Clinical Service Lines", "VP Hospital Operations & Service Lines"],
    searchHints: "service line cardiology oncology orthopedics neuroscience clinical program",
  },
  "Strategy": {
    titles:    ["Chief Strategy Officer", "CSO", "VP Strategy", "SVP Strategy", "Chief Planning Officer", "VP Strategic Planning"],
    searchHints: "strategy strategic planning mergers acquisitions growth planning",
  },
  "Value Based Care": {
    titles:    ["Chief Value Officer", "VP Value Based Care", "SVP Value Based Care", "VP ACO", "Chief ACO Officer", "VP Accountable Care"],
    searchHints: "value based care accountable care ACO bundled payments risk",
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
    const body = await req.json();
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
    const titles     = definition?.titles?.join(", ") || persona;
    const hints      = definition?.searchHints || "";

    const prompt = `You are an expert healthcare executive researcher with access to web search. Your task is to find the CURRENT person holding a specific leadership role at a health system. Accuracy and completeness are paramount.

## Target Organization
**Health System:** ${companyName}${domain ? ` | Domain: ${domain}` : ""}

## Role to Find
**Persona Category:** ${persona}
**Typical Titles:** ${titles}
**Search Hints:** ${hints}

## Research Instructions

Search thoroughly using multiple approaches:
1. Search LinkedIn for "${companyName} ${titles.split(",")[0]}" and similar variations
2. Search the organization's official website (${domain || companyName + " website"}) for leadership/executive team pages
3. Search recent press releases, news articles, and announcements about ${companyName} executive appointments
4. Search industry directories (Modern Healthcare, Becker's Hospital Review, Health Leaders, etc.)
5. Cross-reference multiple sources to confirm the current person — NOT someone who left

## Critical Requirements
- Find who is IN THIS ROLE **RIGHT NOW** — verify they are currently employed at ${companyName}
- If someone recently left or was replaced, find the CURRENT person
- Get their **work email** — try: firstname.lastname@${domain || "domain.com"}, f.lastname@${domain || "domain.com"}, firstnamelastname@${domain || "domain.com"}
- Get their **exact current title** as listed on LinkedIn or the org website
- Get their **LinkedIn URL** if available
- Rate confidence: HIGH (confirmed on LinkedIn + org site), MEDIUM (one source), LOW (unverified)

## Output Format
Respond with ONLY a JSON object, no markdown, no explanation:
{
  "name": "Full Name",
  "title": "Exact Current Title",
  "linkedinUrl": "https://www.linkedin.com/in/username or null",
  "email": "work.email@${domain || "organization.com"} or null",
  "emailConfidence": "verified/pattern/unknown",
  "source": "LinkedIn + Organization Website",
  "confidence": "high/medium/low",
  "currentEmployer": "${companyName}",
  "notes": "Brief note on how found and any caveats"
}

If you cannot find anyone currently in this role after thorough searching, return the JSON with null for name, title, linkedinUrl, email and confidence: "low".`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-5", // Sonnet for best search quality
        max_tokens: 1500,
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

    // Extract final text response (after tool use)
    const textBlocks = (data.content || []).filter(b => b.type === "text");
    const rawText    = textBlocks.map(b => b.text).join("\n").trim();

    let result = {
      persona,
      name:            null,
      title:           null,
      linkedinUrl:     null,
      email:           null,
      emailConfidence: "unknown",
      source:          "not found",
      confidence:      "low",
      notes:           null,
    };

    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        result = {
          persona,
          name:            parsed.name            || null,
          title:           parsed.title           || null,
          linkedinUrl:     parsed.linkedinUrl     || null,
          email:           parsed.email           || null,
          emailConfidence: parsed.emailConfidence || "unknown",
          source:          parsed.source          || "web search",
          confidence:      parsed.confidence      || "low",
          notes:           parsed.notes           || null,
        };
      }
    } catch (parseErr) {
      console.error("[gap-search] JSON parse error:", parseErr.message);
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
