// ─── Cipher — Outlook OAuth Callback ─────────────────────────────────────────
// GET /api/outlook-callback?code=...&state=...
// No external dependencies — uses fetch + Azure Blob REST API directly.

const CLIENT_ID     = process.env.MICROSOFT_CLIENT_ID;
const CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const REDIRECT_URI  = "https://hubspot-overlay-ck.netlify.app/api/outlook-callback";
const TENANT        = "common";
const AZURE_ACCOUNT = "carepathiqdata";
const CONTAINER     = "crm-tokens";
const DASHBOARD     = "https://hubspot-overlay-ck.netlify.app";

// ── Azure Blob Storage via REST API (no SDK needed) ───────────────────────────
async function storeTokens(userId, tokens) {
  const sas      = process.env.AZURE_STORAGE_SAS_TOKEN;
  const blobName = `outlook-tokens-${userId}.json`;
  const data     = JSON.stringify({
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at:    Date.now() + tokens.expires_in * 1000,
    scope:         tokens.scope,
    stored_at:     new Date().toISOString(),
  });

  const url = `https://${AZURE_ACCOUNT}.blob.core.windows.net/${CONTAINER}/${blobName}?${sas}`;
  const res = await fetch(url, {
    method:  "PUT",
    headers: {
      "Content-Type":   "application/json",
      "Content-Length": String(new TextEncoder().encode(data).length),
      "x-ms-blob-type": "BlockBlob",
    },
    body: data,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Azure PUT failed ${res.status}: ${err.slice(0, 100)}`);
  }
}

function redirect(to) {
  return new Response(null, { status: 302, headers: { Location: to } });
}

export const config = { path: "/api/outlook-callback" };

export default async function handler(req) {
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
      return redirect(`${DASHBOARD}/?outlook_error=no_code`);
    }

    // Decode userId from state
    let userId = "default";
    try {
      const decoded = JSON.parse(atob(state || ""));
      userId = decoded.userId || "default";
    } catch (e) {
      console.error("[outlook-callback] State decode failed:", e.message);
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

    const responseText = await tokenRes.text();

    if (!tokenRes.ok) {
      console.error("[outlook-callback] Token exchange failed:", tokenRes.status, responseText.slice(0, 200));
      return redirect(`${DASHBOARD}/?outlook_error=token_exchange_failed`);
    }

    const tokens = JSON.parse(responseText);

    await storeTokens(userId, tokens);
    console.log("[outlook-callback] Tokens stored for userId:", userId);

    return redirect(`${DASHBOARD}/?outlook_connected=1`);

  } catch (err) {
    console.error("[outlook-callback] Unhandled error:", err.message);
    return new Response(
      `Outlook connection failed: ${err.message}`,
      { status: 500, headers: { "Content-Type": "text/plain" } }
    );
  }
}
