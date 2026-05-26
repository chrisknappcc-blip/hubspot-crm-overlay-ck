// ─── Cipher — Gold Account Gap Search ────────────────────────────────────────
// Uses Claude with web_search tool to find contacts for missing personas
// at Gold accounts. Called per-persona to stay within Netlify 26s timeout.
//
// POST /api/hubspot-gap-search
// Body: { companyName, domain, tier, missingPersonas: [...], batchSize: 3 }
// Returns: { found: [{ persona, name, title, linkedinUrl, source, confidence }] }

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Persona → search hints for what titles to look for
const PERSONA_TITLE_HINTS = {
  "Access/Patient Access":    "Director of Patient Access, VP Patient Access, Chief Access Officer",
  "Ambulatory/Urgent Care":   "VP Ambulatory, Director Ambulatory Care, Chief Ambulatory Officer",
  "Business Development":     "VP Business Development, Chief Business Development Officer, Director BD",
  "Case Management":          "VP Case Management, Director Case Management, Chief Care Management Officer",
  "Clinical Operations":      "VP Clinical Operations, COO Clinical, Director Clinical Operations",
  "Emergency Department":     "Chief of Emergency Medicine, VP Emergency Services, Medical Director ED",
  "Executive/Leadership":     "CEO, President, Executive Vice President",
  "Finance":                  "CFO, Chief Financial Officer, VP Finance, SVP Finance",
  "Innovation":               "Chief Innovation Officer, VP Innovation, Chief Digital Officer",
  "Medical Group":            "Medical Group CEO, President Medical Group, VP Medical Group",
  "Medical Information":      "CMIO, Chief Medical Information Officer, VP Medical Informatics",
  "Chief Clinical Officer":   "CCO, Chief Clinical Officer, EVP Clinical Affairs",
  "Medical Officer":          "CMO, Chief Medical Officer, SVP Medical Affairs",
  "Nursing Officer":          "CNO, Chief Nursing Officer, VP Nursing, Chief Nursing Executive",
  "Operating Officer":        "COO, Chief Operating Officer, EVP Operations",
  "Patient Experience":       "Chief Experience Officer, VP Patient Experience, Director Patient Experience",
  "Physician Executive":      "Chief Physician Executive, VP Medical Staff, SVP Physician Services",
  "Population Health":        "VP Population Health, Chief Population Health Officer, SVP Value Based Care",
  "Quality Officer":          "Chief Quality Officer, VP Quality, Chief Patient Safety Officer",
  "Service Line":             "VP Service Lines, Chief Service Line Officer, SVP Service Lines",
  "Strategy":                 "Chief Strategy Officer, VP Strategy, SVP Strategic Planning",
  "Value Based Care":         "VP Value Based Care, Chief Value Officer, VP ACO",
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
    const { companyName, domain, missingPersonas = [], batchSize = 3 } = body;

    if (!companyName || !missingPersonas.length) {
      return new Response(JSON.stringify({ error: "companyName and missingPersonas required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // Process up to batchSize personas per call to stay within timeout
    const personasToSearch = missingPersonas.slice(0, batchSize);

    // Build the prompt for Claude
    const personaList = personasToSearch.map(p => {
      const hints = PERSONA_TITLE_HINTS[p] || p;
      return `- **${p}** (titles to look for: ${hints})`;
    }).join("\n");

    const prompt = `You are a healthcare sales researcher. Find the specific individuals currently holding these roles at ${companyName}${domain ? ` (${domain})` : ""}.

For each role, search LinkedIn, the organization's website, press releases, and news to find the current person in that position.

Roles to find:
${personaList}

For each role, provide:
1. The person's full name
2. Their exact current title
3. Their LinkedIn URL (if findable)
4. Your confidence level (high/medium/low)
5. Your source (LinkedIn, company website, press release, etc.)

If you cannot find someone for a role, say "Not found" for that role.

Respond in JSON only, no markdown:
{
  "found": [
    {
      "persona": "exact persona name from the list",
      "name": "Full Name or null",
      "title": "Exact Title or null",
      "linkedinUrl": "https://linkedin.com/in/... or null",
      "source": "LinkedIn/Company Website/Press Release/etc",
      "confidence": "high/medium/low",
      "notes": "any relevant notes"
    }
  ]
}`;

    // Call Claude with web_search tool
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
        tools: [{
          type: "web_search_20250305",
          name: "web_search",
        }],
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Claude API error: ${err.slice(0, 200)}`);
    }

    const data = await response.json();

    // Extract text from response (may include tool use blocks)
    const textBlocks = (data.content || []).filter(b => b.type === "text");
    const rawText    = textBlocks.map(b => b.text).join("\n");

    // Parse JSON from response
    let found = [];
    try {
      const clean   = rawText.replace(/```json|```/g, "").trim();
      const parsed  = JSON.parse(clean);
      found         = parsed.found || [];
    } catch {
      // Try to extract JSON from within text
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          found        = parsed.found || [];
        } catch {
          found = personasToSearch.map(p => ({
            persona:    p,
            name:       null,
            title:      null,
            linkedinUrl: null,
            source:     "parse error",
            confidence: "low",
            notes:      "Could not parse response",
          }));
        }
      }
    }

    // Ensure all searched personas have a result
    const foundPersonas = new Set(found.map(f => f.persona));
    for (const p of personasToSearch) {
      if (!foundPersonas.has(p)) {
        found.push({
          persona:     p,
          name:        null,
          title:       null,
          linkedinUrl: null,
          source:      "not found",
          confidence:  "low",
          notes:       "No result returned",
        });
      }
    }

    return new Response(JSON.stringify({
      companyName,
      searchedPersonas: personasToSearch,
      remainingPersonas: missingPersonas.slice(batchSize),
      hasMore: missingPersonas.length > batchSize,
      found,
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
