// ─── Cipher — Gold Account Gap Search (Direct Web Search) ────────────────────
// Finds missing persona contacts using direct web search — no Claude API needed.
// Searches LinkedIn, company website, and news for each missing role.
//
// POST /api/hubspot-gap-search
// Body: { companyName, domain, missingPersonas: [...] }
// Returns: { found: [{ persona, name, title, linkedinUrl, source, confidence }] }

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Persona → search query templates
const PERSONA_QUERIES = {
  "Access/Patient Access":    ["VP Patient Access {org}", "Director Patient Access {org}", "Chief Access Officer {org}"],
  "Ambulatory/Urgent Care":   ["VP Ambulatory Care {org}", "Chief Ambulatory Officer {org}", "Director Ambulatory {org}"],
  "Business Development":     ["Chief Business Development Officer {org}", "VP Business Development {org}"],
  "Case Management":          ["VP Case Management {org}", "Chief Care Management {org}", "Director Case Management {org}"],
  "Clinical Operations":      ["VP Clinical Operations {org}", "Chief Clinical Operations {org}"],
  "Emergency Department":     ["Chief Emergency Medicine {org}", "VP Emergency Services {org}", "Medical Director Emergency {org}"],
  "Executive/Leadership":     ["CEO {org}", "President {org}", "Chief Executive Officer {org}"],
  "Finance":                  ["CFO {org}", "Chief Financial Officer {org}", "VP Finance {org}"],
  "Innovation":               ["Chief Innovation Officer {org}", "Chief Digital Officer {org}", "VP Innovation {org}"],
  "Medical Group":            ["President Medical Group {org}", "CEO Medical Group {org}"],
  "Medical Information":      ["CMIO {org}", "Chief Medical Information Officer {org}", "VP Medical Informatics {org}"],
  "Chief Clinical Officer":   ["CCO {org}", "Chief Clinical Officer {org}", "EVP Clinical {org}"],
  "Medical Officer":          ["CMO {org}", "Chief Medical Officer {org}", "SVP Medical Affairs {org}"],
  "Nursing Officer":          ["CNO {org}", "Chief Nursing Officer {org}", "VP Nursing {org}"],
  "Operating Officer":        ["COO {org}", "Chief Operating Officer {org}", "EVP Operations {org}"],
  "Patient Experience":       ["Chief Experience Officer {org}", "VP Patient Experience {org}"],
  "Physician Executive":      ["Chief Physician Executive {org}", "VP Physician Services {org}"],
  "Population Health":        ["VP Population Health {org}", "Chief Population Health Officer {org}"],
  "Quality Officer":          ["Chief Quality Officer {org}", "VP Quality {org}", "Chief Patient Safety {org}"],
  "Service Line":             ["VP Service Lines {org}", "Chief Service Line Officer {org}"],
  "Strategy":                 ["Chief Strategy Officer {org}", "VP Strategy {org}", "CSO {org}"],
  "Value Based Care":         ["VP Value Based Care {org}", "Chief Value Officer {org}"],
};

// Common title patterns to extract from search snippets
const TITLE_PATTERNS = [
  /(?:Chief|VP|Vice President|President|Director|SVP|EVP|Senior Vice President|Executive Vice President|Medical Director)\s+[A-Z][^,\n.]{5,60}/gi,
  /[A-Z][a-z]+ [A-Z][a-z]+,\s*(?:Chief|VP|Vice President|President|Director|SVP|EVP)/gi,
];

// Extract a person's name and title from a search result snippet
function extractPersonFromSnippet(snippet, orgName) {
  if (!snippet) return null;

  // Look for LinkedIn-style "Name - Title - Organization" patterns
  const linkedinPattern = /^([A-Z][a-z]+(?: [A-Z][a-z.]+)+)\s*[-–]\s*([^-\n]{10,80})\s*[-–]\s*/m;
  const linkedinMatch   = snippet.match(linkedinPattern);
  if (linkedinMatch) {
    return { name: linkedinMatch[1].trim(), title: linkedinMatch[2].trim() };
  }

  // Look for "Name is the Chief..." patterns
  const namedPattern = /([A-Z][a-z]+(?: [A-Z][a-z.]+)+) (?:is|serves as|was named|was appointed)(?: the)? ([A-Z][^,.]{8,60})/;
  const namedMatch   = snippet.match(namedPattern);
  if (namedMatch) {
    return { name: namedMatch[1].trim(), title: namedMatch[2].trim() };
  }

  // Look for quoted title + name patterns: "Chief Nursing Officer Jane Smith"
  const titleFirstPattern = /(?:Chief|VP|Vice President|President|Director|SVP|EVP)[^,.\n]{5,50},?\s+([A-Z][a-z]+(?: [A-Z][a-z.]+)+)/;
  const titleFirstMatch   = snippet.match(titleFirstPattern);
  if (titleFirstMatch) {
    return { name: titleFirstMatch[1].trim(), title: null };
  }

  return null;
}

// Extract LinkedIn URL from search results
function extractLinkedInUrl(url, snippet) {
  if (url && url.includes('linkedin.com/in/')) return url;
  const urlMatch = (snippet || '').match(/linkedin\.com\/in\/[a-z0-9-]+/i);
  return urlMatch ? `https://www.${urlMatch[0]}` : null;
}

// Try to find work email for a person at a company
async function findWorkEmail(name, companyName, domain) {
  try {
    // Pattern 1: Try common email formats against company domain
    if (domain) {
      const parts     = name.toLowerCase().split(' ').filter(Boolean)
      const firstName = parts[0] || ''
      const lastName  = parts[parts.length - 1] || ''
      const cleanDomain = domain.replace(/^www\./, '')
      // Most common formats
      const candidates = [
        `${firstName}.${lastName}@${cleanDomain}`,
        `${firstName[0]}${lastName}@${cleanDomain}`,
        `${firstName}@${cleanDomain}`,
        `${lastName}@${cleanDomain}`,
      ]
      // We can't verify without SMTP, so return most likely format with low confidence
      return { email: candidates[0], confidence: 'low', method: 'pattern' }
    }

    // Pattern 2: Search web for email
    const query    = encodeURIComponent(`"${name}" "${companyName}" email contact`)
    const res      = await fetch(
      `https://api.duckduckgo.com/?q=${query}&format=json&no_redirect=1&no_html=1`,
      { headers: { 'Accept': 'application/json' } }
    )
    if (!res.ok) return null
    const data     = await res.json()
    const text     = [data.AbstractText, ...(data.RelatedTopics||[]).map(t=>t.Text)].join(' ')
    const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g)
    if (emailMatch?.length) {
      // Filter out generic/noreply emails
      const real = emailMatch.find(e => !e.match(/noreply|no-reply|info@|contact@|admin@/i))
      if (real) return { email: real, confidence: 'medium', method: 'web' }
    }
    return null
  } catch { return null }
}

// Search using SerpAPI-compatible endpoint or DuckDuckGo
async function webSearch(query) {
  try {
    // Use DuckDuckGo Instant Answer API (free, no key needed)
    const encoded = encodeURIComponent(query);
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${encoded}&format=json&no_redirect=1&no_html=1&skip_disambig=1`,
      { headers: { 'Accept': 'application/json' } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data;
  } catch {
    return null;
  }
}

// Search LinkedIn specifically
async function searchLinkedIn(query) {
  try {
    const encoded = encodeURIComponent(`site:linkedin.com/in ${query}`);
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${encoded}&format=json&no_redirect=1&no_html=1`,
      { headers: { 'Accept': 'application/json' } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.Results || [];
  } catch {
    return [];
  }
}

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

    const personasToSearch = missingPersonas.slice(0, batchSize);
    const found = [];

    for (const persona of personasToSearch) {
      const queries = (PERSONA_QUERIES[persona] || [`${persona} ${companyName}`])
        .map(q => q.replace('{org}', companyName));

      let result = {
        persona,
        name:        null,
        title:       null,
        linkedinUrl: null,
        source:      null,
        confidence:  'low',
        notes:       null,
      };

      // Try each query until we get a result
      for (const query of queries) {
        // Search LinkedIn first
        const liQuery  = `site:linkedin.com/in "${companyName}" ${query.split(' ').slice(0, 3).join(' ')}`;
        const liResult = await webSearch(liQuery);

        if (liResult?.RelatedTopics?.length > 0) {
          for (const topic of liResult.RelatedTopics.slice(0, 3)) {
            const url     = topic.FirstURL || '';
            const text    = topic.Text     || '';
            const liUrl   = extractLinkedInUrl(url, text);
            const person  = extractPersonFromSnippet(text, companyName);

            if (liUrl && person?.name) {
              result = {
                persona,
                name:        person.name,
                title:       person.title || queries[0].replace(companyName, '').trim(),
                linkedinUrl: liUrl,
                source:      'LinkedIn',
                confidence:  'medium',
                notes:       text.slice(0, 100),
              };
              break;
            }
          }
          if (result.name) break;
        }

        // Try general web search
        const general = await webSearch(`${query} LinkedIn`);
        if (general?.AbstractText) {
          const person = extractPersonFromSnippet(general.AbstractText, companyName);
          if (person?.name) {
            result = {
              persona,
              name:        person.name,
              title:       person.title || query.split(' ').slice(0, 3).join(' '),
              linkedinUrl: extractLinkedInUrl(general.AbstractURL, general.AbstractText),
              source:      general.AbstractSource || 'Web',
              confidence:  'low',
              notes:       general.AbstractText.slice(0, 100),
            };
            break;
          }
        }

        // Try news/press releases
        if (general?.RelatedTopics?.length > 0) {
          for (const topic of general.RelatedTopics.slice(0, 5)) {
            const text   = topic.Text || '';
            const person = extractPersonFromSnippet(text, companyName);
            if (person?.name && text.toLowerCase().includes(companyName.toLowerCase())) {
              result = {
                persona,
                name:        person.name,
                title:       person.title,
                linkedinUrl: extractLinkedInUrl(topic.FirstURL, text),
                source:      'Web search',
                confidence:  'low',
                notes:       text.slice(0, 100),
              };
              break;
            }
          }
          if (result.name) break;
        }

        // Small gap between queries
        await new Promise(r => setTimeout(r, 200));
      }

      // Email enrichment — try to find work email for found contacts
      if (result.name) {
        const emailResult = await findWorkEmail(result.name, companyName, domain)
        if (emailResult) {
          result.email           = emailResult.email
          result.emailConfidence = emailResult.confidence
          result.emailMethod     = emailResult.method
        }
      }

      found.push(result);
    }

    return new Response(JSON.stringify({
      companyName,
      searchedPersonas:  personasToSearch,
      remainingPersonas: missingPersonas.slice(batchSize),
      hasMore:           missingPersonas.length > batchSize,
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
