// ─── Cipher — Contact Intelligence ───────────────────────────────────────────
// POST /api/contact-intel
// Body: { name, title, org, domain?, mode: 'individual' }
//
// Researches a specific person using Claude + web_search.
// Returns a structured profile with REAL data only — no hallucination.
// Results are cached in Azure Blob for 24 hours.

import Anthropic        from "@anthropic-ai/sdk";
import { BlobServiceClient } from "@azure/storage-blob";

const AZURE_ACCOUNT = "carepathiqdata";
const CONTAINER     = "crm-tokens";
const CACHE_TTL_MS  = 24 * 60 * 60 * 1000; // 24 hours

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ── Azure helpers ─────────────────────────────────────────────────────────────
function blobContainer() {
  const sas = process.env.AZURE_STORAGE_SAS_TOKEN;
  return new BlobServiceClient(
    `https://${AZURE_ACCOUNT}.blob.core.windows.net?${sas}`
  ).getContainerClient(CONTAINER);
}

async function getBlob(name) {
  try {
    const dl = await blobContainer().getBlockBlobClient(name).download();
    const chunks = [];
    for await (const c of dl.readableStreamBody) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { return null; }
}

async function setBlob(name, data) {
  const text = JSON.stringify(data);
  await blobContainer().getBlockBlobClient(name)
    .upload(text, text.length, { blobHTTPHeaders: { blobContentType: "application/json" } });
}

// ── Cache key ─────────────────────────────────────────────────────────────────
function cacheKey(name, org) {
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  return `ci-individual-${slug(name)}-${slug(org)}.json`;
}

// ── Claude prompt ─────────────────────────────────────────────────────────────
const SYSTEM = `You are a professional intelligence researcher for a B2B healthcare sales team.
Your job is to find REAL, VERIFIED background information on healthcare executives.
RULES:
- Only include information you verified through web search — never guess or hallucinate.
- Career history: only include roles you actually found in search results with sources.
- If you cannot verify something, omit it rather than guessing.
- Return ONLY valid JSON with no markdown fences, no preamble, no trailing text.`;

function buildPrompt(name, title, org, domain) {
  const domainHint = domain ? ` (domain: ${domain})` : "";
  return `Research this person for a healthcare B2B sales team:
Name: ${name}
Title: ${title}
Organization: ${org}${domainHint}

Perform 3–5 web searches. Suggested queries:
1. "${name}" "${org}" — verify their current role
2. "${name}" press release OR article — find published content
3. "${name}" "${org}" podcast OR speaker OR award — find engagements
4. "${org}" "${title}" — cross-check the role if name search is thin

Return a single JSON object in this exact shape:

{
  "name": "${name}",
  "title": "${title}",
  "org": "${org}",
  "verifiedRole": true,
  "careerHistory": [
    { "title": "Chief Medical Officer", "org": "Endeavor Health", "years": "2022–present", "summary": "Leads clinical strategy…" }
  ],
  "recentContent": [
    { "type": "press_release", "title": "Endeavor Health names new CMO", "date": "2022-04", "url": "https://…", "summary": "Appointed to lead…" }
  ],
  "orgContext": "2–3 sentences about this person's strategic priorities and how they fit into the org.",
  "outreachIntel": "Specific, concrete talking points for cold outreach. What initiative are they leading? What award or publication can you reference? What challenge in their role maps to Care Continuity's value?",
  "confidence": "high",
  "sources": ["url1", "url2"]
}

Types for recentContent: press_release | article | award | podcast | presentation | other
Confidence: high (found them clearly) | medium (partial info) | low (barely found them)
careerHistory: most recent role first. Only include if verified — empty array if not found.
recentContent: only real URLs you found — empty array if none found.`;
}

// ── Parse Claude response ─────────────────────────────────────────────────────
function extractJson(text) {
  try { return JSON.parse(text); } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch {} }
  const braced = text.match(/\{[\s\S]*\}/);
  if (braced) { try { return JSON.parse(braced[0]); } catch {} }
  return null;
}

// ── Main handler ──────────────────────────────────────────────────────────────
export const config = { path: "/api/contact-intel" };

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const body = await req.json().catch(() => ({}));
  const { name, title = "", org, domain = "" } = body;

  if (!name?.trim() || !org?.trim()) {
    return json({ error: "name and org are required" }, 400);
  }

  // Serve from cache if fresh
  const key    = cacheKey(name.trim(), org.trim());
  const cached = await getBlob(key);
  if (cached?.profile && cached?.cachedAt) {
    const age = Date.now() - new Date(cached.cachedAt).getTime();
    if (age < CACHE_TTL_MS) return json({ ...cached, fromCache: true });
  }

  // Call Claude with web_search
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let profile = null;
  try {
    const response = await client.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 2000,
      system:     SYSTEM,
      tools:      [{ type: "web_search_20250305", name: "web_search" }],
      messages:   [{ role: "user", content: buildPrompt(name, title, org, domain) }],
    });

    // Find the text content block
    const textBlock = response.content.find(b => b.type === "text");
    if (textBlock) profile = extractJson(textBlock.text);
  } catch (e) {
    console.error("[contact-intel] Claude error:", e.message);
    return json({ error: "Research failed: " + e.message }, 500);
  }

  if (!profile) {
    return json({ error: "Could not parse research results" }, 500);
  }

  const result = {
    profile,
    cachedAt:  new Date().toISOString(),
    fromCache: false,
  };

  setBlob(key, result).catch(e =>
    console.error("[contact-intel] cache write failed:", e.message)
  );

  return json(result);
}
