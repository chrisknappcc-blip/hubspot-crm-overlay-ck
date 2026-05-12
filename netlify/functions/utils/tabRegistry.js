// netlify/functions/utils/tabRegistry.js
// Reads and writes the dynamic tab registry to Azure Blob Storage.
// Uses SAS token auth (same as tokenStore) rather than SharedKey HMAC.
//
// Tab schema:
//   id          string   -- url-safe slug, auto-generated from label
//   label       string   -- display name in the nav
//   url         string   -- iframe src URL
//   type        string   -- "iframe" | "link"
//   enabled     boolean  -- false hides the tab without deleting it
//   allowedUsers string[] -- empty = all users, otherwise Clerk user IDs
//   badge       string   -- optional pill text (e.g. "SOON", "NEW", "BETA")
//   addedBy     string   -- Clerk user ID of whoever added it
//   personal    boolean  -- true = personal tab, false = shared
//   createdAt   string   -- ISO timestamp
//   updatedAt   string   -- ISO timestamp

const AZURE_ACCOUNT   = process.env.AZURE_STORAGE_ACCOUNT_NAME || process.env.AZURE_STORAGE_ACCOUNT || "carepathiqdata";
const AZURE_SAS       = process.env.AZURE_STORAGE_SAS_TOKEN    || process.env.AZURE_STORAGE_KEY     || "";
const AZURE_CONTAINER = process.env.AZURE_STORAGE_CONTAINER    || "crm-tokens";
const REGISTRY_BLOB   = "tabs--registry.json";

function blobUrl(blobName) {
  const sas = AZURE_SAS.startsWith("?") ? AZURE_SAS : `?${AZURE_SAS}`;
  return `https://${AZURE_ACCOUNT}.blob.core.windows.net/${AZURE_CONTAINER}/${blobName}${sas}`;
}

async function blobGet(blobName) {
  const res = await fetch(blobUrl(blobName));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Azure GET failed: ${res.status} ${await res.text()}`);
  return res.text();
}

async function blobPut(blobName, content) {
  const body = typeof content === "string" ? content : JSON.stringify(content);
  const res  = await fetch(blobUrl(blobName), {
    method: "PUT",
    headers: {
      "Content-Type":   "application/json",
      "x-ms-blob-type": "BlockBlob",
    },
    body,
  });
  if (!res.ok) throw new Error(`Azure PUT failed: ${res.status} ${await res.text()}`);
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

// ── Personal tab registry (per-user) ─────────────────────────────────────────

function personalBlobName(userId) {
  // Sanitize userId for blob key -- replace any non-alphanumeric with _
  return `tabs--personal--${userId.replace(/[^a-zA-Z0-9]/g, '_')}.json`;
}

export async function getPersonalTabs(userId) {
  try {
    const raw = await blobGet(personalBlobName(userId));
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export async function savePersonalTabs(userId, tabs) {
  await blobPut(personalBlobName(userId), JSON.stringify(tabs, null, 2));
}

// Returns shared + personal tabs merged, personal flagged
export async function getAllTabsForUser(userId) {
  const [shared, personal] = await Promise.all([
    getTabsForUser(userId),
    getPersonalTabs(userId),
  ]);
  const sharedMapped   = shared.map(t => ({ ...t, personal: false }));
  const personalMapped = personal
    .filter(t => t.enabled !== false)
    .map(t => ({ ...t, personal: true }));
  return [...sharedMapped, ...personalMapped];
}
