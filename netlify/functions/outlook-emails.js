// ─── Cipher — Outlook Sent Emails ────────────────────────────────────────────
// GET /api/outlook-emails?userId=<clerkUserId>&days=30
//
// Returns a map of recipientEmail → [{ sentAt, subject }] built from
// the user's Outlook Sent Items. Results are cached in Azure Blob for
// 15 minutes to avoid hammering the Graph API on every signal refresh.
//
// Response shape:
// {
//   connected: true,
//   emails: { "contact@hospital.com": [{ sentAt: "ISO", subject: "..." }] },
//   totalFetched: 142,
//   cachedAt: "ISO",
//   fromCache: true | false
// }
// OR { connected: false, emails: {} }  when no tokens stored

import { BlobServiceClient } from "@azure/storage-blob";

const CLIENT_ID     = process.env.MICROSOFT_CLIENT_ID;
const CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const AZURE_ACCOUNT = "carepathiqdata";
const CONTAINER     = "crm-tokens";
const CACHE_TTL_MS  = 15 * 60 * 1000; // 15 minutes

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ── Azure Blob helpers ────────────────────────────────────────────────────────
function container() {
  const sas = process.env.AZURE_STORAGE_SAS_TOKEN;
  return new BlobServiceClient(
    `https://${AZURE_ACCOUNT}.blob.core.windows.net?${sas}`
  ).getContainerClient(CONTAINER);
}

async function getBlob(name) {
  try {
    const dl   = await container().getBlockBlobClient(name).download();
    const chunks = [];
    for await (const chunk of dl.readableStreamBody) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { return null; }
}

async function setBlob(name, data) {
  const text = JSON.stringify(data);
  await container().getBlockBlobClient(name)
    .upload(text, text.length, { blobHTTPHeaders: { blobContentType: "application/json" } });
}

// ── Token management ──────────────────────────────────────────────────────────
async function getAccessToken(userId) {
  let tokens = await getBlob(`outlook-tokens-${userId}.json`);
  if (!tokens) return null;

  // Refresh if expires within 5 minutes
  if (tokens.expires_at < Date.now() + 5 * 60 * 1000) {
    try {
      const res = await fetch(
        "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        {
          method:  "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body:    new URLSearchParams({
            client_id:     CLIENT_ID,
            client_secret: CLIENT_SECRET,
            refresh_token: tokens.refresh_token,
            grant_type:    "refresh_token",
          }).toString(),
        }
      );
      if (!res.ok) throw new Error(await res.text());
      const t = await res.json();
      tokens = {
        access_token:  t.access_token,
        refresh_token: t.refresh_token || tokens.refresh_token,
        expires_at:    Date.now() + t.expires_in * 1000,
        scope:         t.scope,
        stored_at:     new Date().toISOString(),
      };
      await setBlob(`outlook-tokens-${userId}.json`, tokens);
    } catch (e) {
      console.error("[outlook-emails] token refresh failed:", e.message);
      return null;
    }
  }
  return tokens.access_token;
}

// ── Graph API fetch ───────────────────────────────────────────────────────────
async function fetchSentEmails(accessToken, days) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  let messages = [];
  let url =
    `https://graph.microsoft.com/v1.0/me/mailFolders/SentItems/messages` +
    `?$filter=sentDateTime ge ${since}` +
    `&$select=id,subject,sentDateTime,toRecipients` +
    `&$top=100` +
    `&$orderby=sentDateTime desc`;

  // Fetch up to 3 pages (300 emails max)
  for (let page = 0; page < 3 && url; page++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      console.error("[outlook-emails] Graph error:", res.status, await res.text().catch(() => ""));
      break;
    }
    const data = await res.json();
    messages = messages.concat(data.value || []);
    url = data["@odata.nextLink"] || null;
  }
  return messages;
}

// ── Main handler ──────────────────────────────────────────────────────────────
export const config = { path: "/api/outlook-emails" };

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url    = new URL(req.url);
  const userId = url.searchParams.get("userId") || "default";
  const days   = parseInt(url.searchParams.get("days") || "30", 10);

  // Serve from cache if fresh
  const cacheKey = `outlook-email-cache-${userId}.json`;
  const cached = await getBlob(cacheKey);
  if (cached?.cachedAt) {
    const age = Date.now() - new Date(cached.cachedAt).getTime();
    if (age < CACHE_TTL_MS) return json({ ...cached, fromCache: true });
  }

  // Get a valid access token
  const accessToken = await getAccessToken(userId);
  if (!accessToken) return json({ connected: false, emails: {} });

  // Fetch from Graph
  const messages = await fetchSentEmails(accessToken, days);

  // Build recipientEmail → [{ sentAt, subject }] map
  const emailMap = {};
  for (const msg of messages) {
    const sentAt  = msg.sentDateTime;
    const subject = msg.subject || "";
    for (const r of msg.toRecipients || []) {
      const addr = r.emailAddress?.address?.toLowerCase();
      if (!addr) continue;
      if (!emailMap[addr]) emailMap[addr] = [];
      emailMap[addr].push({ sentAt, subject });
    }
  }

  const result = {
    connected:    true,
    emails:       emailMap,
    totalFetched: messages.length,
    cachedAt:     new Date().toISOString(),
    fromCache:    false,
  };

  await setBlob(cacheKey, result).catch(e =>
    console.error("[outlook-emails] cache write failed:", e.message)
  );

  return json(result);
}
