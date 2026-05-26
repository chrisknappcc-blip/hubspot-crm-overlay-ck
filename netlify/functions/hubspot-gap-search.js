// ─── Cipher — Gold Account Gap Search (Claude + Web Search) ──────────────────
// Uses Claude Haiku with web_search tool to find missing persona contacts
// at Gold accounts. Called per-persona to stay within Netlify 26s timeout.
//
// POST /api/hubspot-gap-search
// Body: { companyName, domain, missingPersonas: [...], batchSize: 1 }
// Returns: { found: [{ persona, name, title, linkedinUrl, source, confidence, email }] }

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Persona → role titles to search for
const PERSONA_TITLES = {
  "Access/Patient Access":    "Director or VP of Patient Access",
  "Ambulatory/Urgent Care":   "VP or Chief of Ambulatory Care",
  "Business Development":     "Chief Business Development Officer or VP Business Development",
  "Case Management":          "VP or Director of Case Management",
  "Clinical Operations":      "VP Clinical Operations or Chief Clinical Operations Officer",
  "Emergency Department":     "Chief of Emergency Medicine or VP Emergency Services",
  "Executive/Leadership":     "CEO or President",
  "Finance":                  "CFO or Chief Financial Officer",
  "Innovation":               "Chief Innovation Officer or Chief Digital Officer",
  "Medical Group":            "President or CEO of Medical Group",
  "Medical Information":      "CMIO or Chief Medical Information Officer",
  "Chief Clinical Officer":   "CCO or Chief Clinical Officer",
  "Medical Officer":          "CMO or Chief Medical Officer",
  "Nursing Officer":          "CNO or Chief Nursing Officer",
  "Operating Officer":        "COO or Chief Operating Officer",
  "Patient Experience":       "Chief Experience Officer or VP Patient Experience",
  "Physician Executive":      "Chief Physician Executive or VP Physician Services",
  "Population Health":        "VP Population Health or Chief Population Health Officer",
  "Quality Officer":          "Chief Quality Officer or VP Quality",
  "Service Line":             "VP Service Lines or Chief Service Line Officer",
  "Strategy":                 "Chief Strategy Officer or VP Strategy",
  "Value Based Care":         "VP Value Based Care or Chief Value Officer",
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
    const { companyName, domain, missingPersonas = [], batchSize = 1 } = body;

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

    // Process one persona at a time to stay well within 26s timeout
    const persona = missingPersonas[0];
    const roleTitle = PERSONA_TITLES[persona] || persona;

    const prompt = `Find the current person holding the role of ${roleTitle} at ${companyName}${domain ? ` (${domain})` : ""}.

Search LinkedIn, the organization's website, and recent press releases/news to find who currently holds this position.

Return ONLY a JSON object with no markdown, no explanation:
{
  "name": "Full Name or null if not found",
  "title": "Their exact current title or null",
  "linkedinUrl": "https://linkedin.com/in/... or null",
  "email": "work email if findable or null",
  "source": "LinkedIn/Company Website/Press Release/etc",
  "confidence": "high/medium/low",
  "notes": "brief note on how you found this"
}

If you cannot find anyone for this role, return the JSON with null values and confidence: "low".`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 1000,
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

    // Extract text blocks from response
    const textBlocks = (data.content || []).filter(b => b.type === "text");
    const rawText    = textBlocks.map(b => b.text).join("\n").trim();

    // Parse JSON result
    let result = {
      persona,
      name:        null,
      title:       null,
      linkedinUrl: null,
      email:       null,
      source:      "not found",
      confidence:  "low",
      notes:       null,
    };

    try {
      const clean   = rawText.replace(/```json|```/g, "").trim();
      // Find the JSON object in the response
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        result = {
          persona,
          name:        parsed.name        || null,
          title:       parsed.title       || null,
          linkedinUrl: parsed.linkedinUrl || null,
          email:       parsed.email       || null,
          source:      parsed.source      || "web search",
          confidence:  parsed.confidence  || "low",
          notes:       parsed.notes       || null,
        };
      }
    } catch (parseErr) {
      console.error("[gap-search] JSON parse error:", parseErr.message, "raw:", rawText.slice(0, 200));
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
