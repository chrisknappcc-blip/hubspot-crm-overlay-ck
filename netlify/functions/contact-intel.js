// ─── Cipher — Contact Intelligence ───────────────────────────────────────────
// POST /api/contact-intel
// Body: { name?, title?, org, domain? }
// name OR title is required; org is always required.
//
// Uses direct Anthropic fetch (no SDK) + web_search to research a person.
// Results cached in Azure Blob for 24 hours.

import { BlobServiceClient } from "@azure/storage-blob";

const AZURE_ACCOUNT = "carepathiqdata";
const CONTAINER     = "crm-tokens";
const CACHE_TTL_MS  = 24 * 60 * 60 * 1000;

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResp(data, status = 200) {
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
function cacheKey(name, title, org) {
  const slug = (s) => (s||'').toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  return `ci-${slug(name || title)}-${slug(org)}.json`;
}

// ── Prompt ────────────────────────────────────────────────────────────────────
const SYSTEM = `You are a professional intelligence researcher for a B2B healthcare SaaS sales team (Care Continuity).
Find REAL, VERIFIED background information on healthcare executives to help write personalized cold outreach.

RULES:
1. Use web_search at least 3 times. Do not guess without searching.
2. Career history: ONLY verified roles with sources. No invention.
3. recentContent: ONLY real URLs you found. Never fabricate.
4. outreachIntel: SPECIFIC — name a real initiative, award, or publication. Generic = useless.
5. If little info found, set confidence: "low" and return empty arrays.
6. Return ONLY valid JSON — no markdown, no preamble, no extra text.`;

function buildPrompt(name, title, org, domain) {
  const who = name ? `${name}${title ? `, ${title}` : ''}` : title;
  const domainHint = domain ? ` (domain: ${domain})` : "";
  return `Research this healthcare executive for a sales team:
${name ? `Name: ${name}` : ''}
${title ? `Title: ${title}` : ''}
Organization: ${org}${domainHint}

Search queries to run:
1. ${name ? `"${name}" "${org}"` : `"${title}" "${org}"`} — verify role
2. ${name ? `"${name}"` : `"${org}" "${title}"`} press release OR article OR award
3. ${name ? `"${name}"` : `"${org}" "${title}"`} podcast OR speaker OR conference

Return this JSON shape exactly:
{
  "name": "${name || '[name from search]'}",
  "title": "${title || '[title from search]'}",
  "org": "${org}",
  "verifiedRole": true,
  "careerHistory": [
    { "title": "Chief Medical Officer", "org": "Endeavor Health", "years": "2022–present", "summary": "Leads clinical strategy" }
  ],
  "recentContent": [
    { "type": "press_release", "title": "...", "date": "2024-03", "url": "https://...", "summary": "..." }
  ],
  "orgContext": "2–3 sentences about their strategic priorities.",
  "outreachIntel": "Specific talking point for a cold email — reference a real initiative, award, or publication you found.",
  "confidence": "high",
  "sources": ["url1", "url2"]
}

Types: press_release | article | award | podcast | presentation | other
Confidence: high | medium | low`;
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
  if (req.method !== "POST") return jsonResp({ error: "POST only" }, 405);

  const body = await req.json().catch(() => ({}));
  const { name = "", title = "", org = "", domain = "" } = body;

  if ((!name.trim() && !title.trim()) || !org.trim()) {
    return jsonResp({ error: "At least a title and org are required" }, 400);
  }

  // Cache check
  const key    = cacheKey(name.trim(), title.trim(), org.trim());
  const cached = await getBlob(key);
  if (cached?.profile && cached?.cachedAt) {
    const age = Date.now() - new Date(cached.cachedAt).getTime();
    if (age < CACHE_TTL_MS) return jsonResp({ ...cached, fromCache: true });
  }

  // Direct Anthropic API call (no SDK)
  const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":    "application/json",
      "x-api-key":       process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 3000,
      system:     SYSTEM,
      tools:      [{ type: "web_search_20250305", name: "web_search" }],
      messages:   [{ role: "user", content: buildPrompt(name, title, org, domain) }],
    }),
  });

  if (!apiRes.ok) {
    const err = await apiRes.text();
    console.error("[contact-intel] API error:", apiRes.status, err.slice(0, 200));
    return jsonResp({ error: `Anthropic API error: ${apiRes.status}` }, 502);
  }

  const apiData = await apiRes.json();

  // Extract the text content block (ignore tool_use blocks)
  const textBlock = (apiData.content || []).find(b => b.type === "text");
  if (!textBlock?.text) {
    return jsonResp({ error: "No text response from model" }, 500);
  }

  const profile = extractJson(textBlock.text);
  if (!profile) {
    return jsonResp({ error: "Could not parse research results" }, 500);
  }

  const result = { profile, cachedAt: new Date().toISOString(), fromCache: false };
  setBlob(key, result).catch(e => console.error("[contact-intel] cache write:", e.message));

  return jsonResp(result);
}
