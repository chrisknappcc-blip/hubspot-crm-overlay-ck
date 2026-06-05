// ─── Cipher — Outlook OAuth Callback ─────────────────────────────────────────
// GET /api/outlook-callback?code=...&state=...
// Microsoft redirects here after consent. Exchanges code for tokens,
// stores them in Azure Blob, then redirects back to the Dashboard.

import { BlobServiceClient } from "@azure/storage-blob";

const CLIENT_ID    = process.env.MICROSOFT_CLIENT_ID;
const CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const REDIRECT_URI  = "https://hubspot-overlay-ck.netlify.app/api/outlook-callback";
const TENANT        = "common";
const AZURE_ACCOUNT = "carepathiqdata";
const CONTAINER     = "crm-tokens";

async function storeTokens(userId, tokens) {
  const sas    = process.env.AZURE_STORAGE_SAS_TOKEN;
  const client = new BlobServiceClient(
    `https://${AZURE_ACCOUNT}.blob.core.windows.net?${sas}`
  );
  const blob = client.getContainerClient(CONTAINER)
    .getBlockBlobClient(`outlook-tokens-${userId}.json`);
  const data = JSON.stringify({
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at:    Date.now() + tokens.expires_in * 1000,
    scope:         tokens.scope,
    stored_at:     new Date().toISOString(),
  });
  await blob.upload(data, data.length, {
    blobHTTPHeaders: { blobContentType: "application/json" },
  });
}

export const config = { path: "/api/outlook-callback" };

export default async function handler(req) {
  const url   = new URL(req.url);
  const code  = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const dashboard = "https://hubspot-overlay-ck.netlify.app";

  if (error) {
    console.error("[outlook-callback] OAuth error:", error);
    return new Response(null, {
      status:  302,
      headers: { Location: `${dashboard}/?outlook_error=${encodeURIComponent(error)}` },
    });
  }

  // Decode userId from state
  let userId = "default";
  try {
    const decoded = JSON.parse(atob(state || ""));
    userId = decoded.userId || "default";
  } catch (e) {
    console.error("[outlook-callback] state decode failed:", e.message);
  }

  // Exchange code for tokens
  const tokenRes = await fetch(
    `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    new URLSearchParams({
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri:  REDIRECT_URI,
        grant_type:    "authorization_code",
      }).toString(),
    }
  );

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    console.error("[outlook-callback] token exchange failed:", err.slice(0, 300));
    return new Response(null, {
      status:  302,
      headers: { Location: `${dashboard}/?outlook_error=token_exchange_failed` },
    });
  }

  const tokens = await tokenRes.json();
  await storeTokens(userId, tokens);
  console.log("[outlook-callback] tokens stored for userId:", userId);

  return new Response(null, {
    status:  302,
    headers: { Location: `${dashboard}/?outlook_connected=1` },
  });
}
