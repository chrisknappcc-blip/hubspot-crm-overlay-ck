// utils/tokenStore.js
// Reads and writes per-user OAuth tokens to Azure Blob Storage.
// Each user gets one JSON file: tokens/{clerkUserId}.json
// Structure: { hubspot: { access_token, refresh_token, expires_at }, microsoft: { ... } }

const STORAGE_ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const SAS_TOKEN = process.env.AZURE_STORAGE_SAS_TOKEN;
const CONTAINER = "crm-tokens";
const BASE_URL = `https://${STORAGE_ACCOUNT}.blob.core.windows.net/${CONTAINER}`;

function blobUrl(userId) {
  return `${BASE_URL}/tokens/${userId}.json${SAS_TOKEN}`;
}

export async function getTokens(userId) {
  try {
    const res = await fetch(blobUrl(userId));
    if (res.status === 404) return {};
    if (!res.ok) throw new Error(`Blob read failed: ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(`[tokenStore] getTokens failed for ${userId}:`, err.message);
    return {};
  }
}

export async function setTokens(userId, tokens) {
  const existing = await getTokens(userId);
  const merged = { ...existing, ...tokens };
  const res = await fetch(blobUrl(userId), {
    method: "PUT",
    headers: {
      "x-ms-blob-type": "BlockBlob",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(merged),
  });
  if (!res.ok) throw new Error(`Blob write failed: ${res.status}`);
  return merged;
}

export async function clearServiceTokens(userId, service) {
  const existing = await getTokens(userId);
  delete existing[service];
  const res = await fetch(blobUrl(userId), {
    method: "PUT",
    headers: {
      "x-ms-blob-type": "BlockBlob",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(existing),
  });
  if (!res.ok) throw new Error(`Blob write failed: ${res.status}`);
  return existing;
}

// Returns true if a token exists and hasn't expired (with 5-min buffer)
export function isTokenValid(tokenObj) {
  if (!tokenObj?.access_token) return false;
  if (!tokenObj.expires_at) return true;
  return Date.now() < tokenObj.expires_at - 5 * 60 * 1000;
}
