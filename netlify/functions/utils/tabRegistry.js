// netlify/functions/utils/tabRegistry.js
// Reads and writes the dynamic tab registry to Azure Blob Storage.
// Uses the same storage account as tokenStore (carepathiqdata / crm-tokens).
// Registry is stored as a single JSON blob at key: tabs--registry.json
//
// Tab schema:
//   id          string   -- url-safe slug, auto-generated from label
//   label       string   -- display name in the nav
//   url         string   -- iframe src URL
//   type        string   -- "iframe" (only type for now)
//   enabled     boolean  -- false hides the tab without deleting it
//   allowedUsers string[] -- empty = all users, otherwise Clerk user IDs
//   badge       string   -- optional pill text (e.g. "SOON", "NEW", "BETA")
//   addedBy     string   -- Clerk user ID of whoever added it
//   createdAt   string   -- ISO timestamp
//   updatedAt   string   -- ISO timestamp

const AZURE_ACCOUNT   = process.env.AZURE_STORAGE_ACCOUNT   || "carepathiqdata";
const AZURE_KEY       = process.env.AZURE_STORAGE_KEY;
const AZURE_CONTAINER = process.env.AZURE_STORAGE_CONTAINER  || "crm-tokens";
const REGISTRY_BLOB   = "tabs--registry.json";

// ── Azure Blob helpers ────────────────────────────────────────────────────────

function getBaseUrl() {
  return `https://${AZURE_ACCOUNT}.blob.core.windows.net/${AZURE_CONTAINER}`;
}

async function getAuthHeader(method, blobName, contentLength = 0, contentType = "") {
  // Shared Key authentication for Azure Blob Storage
  const { createHmac } = await import("crypto");
  const date = new Date().toUTCString();

  const canonicalHeaders = `x-ms-date:${date}\nx-ms-version:2020-10-02`;
  const canonicalResource = `/${AZURE_ACCOUNT}/${AZURE_CONTAINER}/${blobName}`;

  const stringToSign = [
    method.toUpperCase(),
    "",             // Content-Encoding
    "",             // Content-Language
    contentLength > 0 ? String(contentLength) : "",
    "",             // Content-MD5
    contentType,
    "",             // Date
    "",             // If-Modified-Since
    "",             // If-Match
    "",             // If-None-Match
    "",             // If-Unmodified-Since
    "",             // Range
    canonicalHeaders,
    canonicalResource,
  ].join("\n");

  const key    = Buffer.from(AZURE_KEY, "base64");
  const sig    = createHmac("sha256", key).update(stringToSign, "utf8").digest("base64");
  const auth   = `SharedKey ${AZURE_ACCOUNT}:${sig}`;
  return { auth, date };
}

async function blobGet(blobName) {
  const { auth, date } = await getAuthHeader("GET", blobName);
  const res = await fetch(`${getBaseUrl()}/${blobName}`, {
    headers: {
      Authorization:  auth,
      "x-ms-date":    date,
      "x-ms-version": "2020-10-02",
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Azure GET failed: ${res.status} ${await res.text()}`);
  return res.text();
}

async function blobPut(blobName, content) {
  const body        = typeof content === "string" ? content : JSON.stringify(content);
  const bodyBytes   = Buffer.from(body, "utf8");
  const { auth, date } = await getAuthHeader("PUT", blobName, bodyBytes.length, "application/json");

  const res = await fetch(`${getBaseUrl()}/${blobName}`, {
    method: "PUT",
    headers: {
      Authorization:    auth,
      "x-ms-date":      date,
      "x-ms-version":   "2020-10-02",
      "Content-Type":   "application/json",
      "Content-Length": String(bodyBytes.length),
      "x-ms-blob-type": "BlockBlob",
    },
    body: bodyBytes,
  });
  if (!res.ok) throw new Error(`Azure PUT failed: ${res.status} ${await res.text()}`);
}

async function blobDelete(blobName) {
  const { auth, date } = await getAuthHeader("DELETE", blobName);
  const res = await fetch(`${getBaseUrl()}/${blobName}`, {
    method: "DELETE",
    headers: {
      Authorization:  auth,
      "x-ms-date":    date,
      "x-ms-version": "2020-10-02",
    },
  });
  if (!res.ok && res.status !== 404) throw new Error(`Azure DELETE failed: ${res.status}`);
}

// ── Registry helpers ──────────────────────────────────────────────────────────

export async function getRegistry() {
  try {
    const raw = await blobGet(REGISTRY_BLOB);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export async function saveRegistry(tabs) {
  await blobPut(REGISTRY_BLOB, JSON.stringify(tabs, null, 2));
}

// Returns tabs visible to a given Clerk user ID
export async function getTabsForUser(userId) {
  const all = await getRegistry();
  return all.filter(tab => {
    if (!tab.enabled) return false;
    if (!tab.allowedUsers || tab.allowedUsers.length === 0) return true;
    return tab.allowedUsers.includes(userId);
  });
}

// Generates a url-safe ID from a label string
export function slugify(label) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || `tab-${Date.now()}`;
}

// Attempts to fetch the <title> of a URL for auto-naming
export async function fetchPageTitle(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "CarePathIQ-TabBot/1.0" },
      signal:  AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const html  = await res.text();
    const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return match ? match[1].trim().slice(0, 60) : null;
  } catch {
    return null;
  }
}
