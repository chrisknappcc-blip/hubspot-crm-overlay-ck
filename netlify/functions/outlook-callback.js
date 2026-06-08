// ─── Cipher — Outlook OAuth Callback ─────────────────────────────────────────
// GET /api/outlook-callback?code=...&state=...
// Microsoft redirects here after consent. Exchanges code for tokens,
// stores them in Azure Blob, then redirects back to the Dashboard.
//
// IMPORTANT: Every code path returns a Response — even on error — so Netlify
// never sees an empty body ("unexpected end of JSON input").

import { BlobServiceClient } from "@azure/storage-blob";

const CLIENT_ID     = process.env.MICROSOFT_CLIENT_ID;
const CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const REDIRECT_URI  = "https://hubspot-overlay-ck.netlify.app/api/outlook-callback";
const TENANT        = "common";
const AZURE_ACCOUNT = "carepathiqdata";
const CONTAINER     = "crm-tokens";
const DASHBOARD     = "https://hubspot-overlay-ck.netlify.app";

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

function redirect(to) {
  return new Response(null, { status: 302, headers: { Location: to } });
}

export const config = { path: "/api/outlook-callback" };

export default async function handler(req) {
  // Wrap EVERYTHING — function must always return a Response
  try {
    const url   = new URL(req.url);
    const code  = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      console.error("[outlook-callback] OAuth error:", error);
      return redirect(`${DASHBOARD}/?outlook_error=${encodeURIComponent(error)}`);
    }

    if (!code) {
      console.error("[outlook-callback] No code received");
      return redirect(`${DASHBOARD}/?outlook_error=no_code`);
    }

    // Decode userId from state
    let userId = "default";
    try {
      const decoded = JSON.parse(atob((state || "").replace(/%3d/gi, "=").replace(/%2B/gi, "+").replace(/%2F/gi, "/")));
      userId = decoded.userId || "default";
    } catch (e) {
      console.error("[outlook-callback] State decode failed:", e.message, "state:", state?.slice(0, 50));
      // Continue with default userId — don't abort
    }

    console.log("[outlook-callback] Exchanging code for userId:", userId);

    // Exchange code for tokens
    let tokenRes;
    try {
      tokenRes = await fetch(
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
    } catch (fetchErr) {
      console.error("[outlook-callback] fetch to token endpoint failed:", fetchErr.message);
      return redirect(`${DASHBOARD}/?outlook_error=network_error`);
    }

    const responseText = await tokenRes.text();

    if (!tokenRes.ok) {
      console.error("[outlook-callback] Token exchange failed:", tokenRes.status, responseText.slice(0, 300));
      return redirect(`${DASHBOARD}/?outlook_error=token_exchange_failed`);
    }

    let tokens;
    try {
      tokens = JSON.parse(responseText);
    } catch (parseErr) {
      console.error("[outlook-callback] Could not parse token response:", responseText.slice(0, 200));
      return redirect(`${DASHBOARD}/?outlook_error=bad_token_response`);
    }

    // Store tokens in Azure
    try {
      await storeTokens(userId, tokens);
      console.log("[outlook-callback] Tokens stored for userId:", userId);
    } catch (storeErr) {
      console.error("[outlook-callback] Token storage failed:", storeErr.message);
      // Don't block the redirect — connection worked even if storage failed
      return redirect(`${DASHBOARD}/?outlook_error=storage_failed`);
    }

    return redirect(`${DASHBOARD}/?outlook_connected=1`);

  } catch (topLevelErr) {
    // Last resort — should never reach here but ensures a Response is always returned
    console.error("[outlook-callback] Unhandled error:", topLevelErr.message);
    return new Response(
      `Outlook connection failed: ${topLevelErr.message}`,
      { status: 500, headers: { "Content-Type": "text/plain" } }
    );
  }
}
