// netlify/functions/utils/activityLog.js
// Per-user manual activity log stored in Azure Blob.
// Blob key: activity-log--{userId}.json
//
// Entry schema:
//   id          string   -- random ID
//   text        string   -- description of the activity
//   type        string   -- "call" | "email" | "linkedin" | "meeting" | "note" | "other"
//   contactName string   -- optional contact name
//   company     string   -- optional company name
//   contactId   string   -- optional HubSpot contact ID
//   rep         string   -- rep name (auto-set to current user)
//   createdAt   string   -- ISO timestamp
//   date        string   -- YYYY-MM-DD

const AZURE_ACCOUNT   = process.env.AZURE_STORAGE_ACCOUNT_NAME || process.env.AZURE_STORAGE_ACCOUNT || "carepathiqdata";
const AZURE_SAS       = process.env.AZURE_STORAGE_SAS_TOKEN    || process.env.AZURE_STORAGE_KEY     || "";
const AZURE_CONTAINER = process.env.AZURE_STORAGE_CONTAINER    || "crm-tokens";

function blobUrl(blobName) {
  const sas = AZURE_SAS.startsWith("?") ? AZURE_SAS : `?${AZURE_SAS}`;
  return `https://${AZURE_ACCOUNT}.blob.core.windows.net/${AZURE_CONTAINER}/${blobName}`;
}

// Note: SAS token must be appended for auth
function blobUrlWithSas(blobName) {
  const sas = AZURE_SAS.startsWith("?") ? AZURE_SAS : `?${AZURE_SAS}`;
  return `https://${AZURE_ACCOUNT}.blob.core.windows.net/${AZURE_CONTAINER}/${blobName}${sas}`;
}

function logBlobName(userId) {
  return `activity-log--${userId.replace(/[^a-zA-Z0-9]/g, "_")}.json`;
}

async function readLog(userId) {
  try {
    const res = await fetch(blobUrlWithSas(logBlobName(userId)));
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`Azure GET failed: ${res.status}`);
    return JSON.parse(await res.text());
  } catch { return []; }
}

async function writeLog(userId, entries) {
  const body = JSON.stringify(entries, null, 2);
  const res  = await fetch(blobUrlWithSas(logBlobName(userId)), {
    method: "PUT",
    headers: { "Content-Type": "application/json", "x-ms-blob-type": "BlockBlob" },
    body,
  });
  if (!res.ok) throw new Error(`Azure PUT failed: ${res.status} ${await res.text()}`);
}

export async function getActivityLog(userId, { since, until, rep } = {}) {
  const entries = await readLog(userId);
  return entries.filter(e => {
    if (since && e.createdAt < since) return false;
    if (until && e.createdAt > until) return false;
    if (rep   && e.rep !== rep)       return false;
    return true;
  });
}

export async function addActivityEntry(userId, entry, repName) {
  const entries = await readLog(userId);
  const now = new Date().toISOString();
  const newEntry = {
    id:          Math.random().toString(36).slice(2, 10),
    text:        (entry.text        || "").trim().slice(0, 500),
    type:        entry.type         || "other",
    contactName: (entry.contactName || "").trim().slice(0, 100),
    company:     (entry.company     || "").trim().slice(0, 100),
    contactId:   entry.contactId    || null,
    rep:         repName            || entry.rep || "",
    createdAt:   now,
    date:        entry.date         || now.slice(0, 10),
  };
  entries.unshift(newEntry); // newest first
  await writeLog(userId, entries);
  return newEntry;
}

export async function deleteActivityEntry(userId, entryId) {
  const entries = await readLog(userId);
  const filtered = entries.filter(e => e.id !== entryId);
  await writeLog(userId, filtered);
}
