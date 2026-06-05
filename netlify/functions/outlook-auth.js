// ─── Cipher — Outlook OAuth Start ────────────────────────────────────────────
// GET /api/outlook-auth?userId=<clerkUserId>
// Redirects the browser to Microsoft's consent screen.

const CLIENT_ID   = process.env.MICROSOFT_CLIENT_ID;
const REDIRECT_URI = "https://hubspot-overlay-ck.netlify.app/api/outlook-callback";
const SCOPES      = "Mail.Read offline_access";
const TENANT      = "common";

export const config = { path: "/api/outlook-auth" };

export default async function handler(req) {
  const url    = new URL(req.url);
  const userId = url.searchParams.get("userId") || "default";

  // Encode userId in state so callback knows who to store tokens for
  const state = btoa(JSON.stringify({ userId, ts: Date.now() }));

  const authUrl = new URL(
    `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`
  );
  authUrl.searchParams.set("client_id",     CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri",  REDIRECT_URI);
  authUrl.searchParams.set("scope",         SCOPES);
  authUrl.searchParams.set("state",         state);
  authUrl.searchParams.set("response_mode", "query");
  authUrl.searchParams.set("prompt",        "select_account");

  return new Response(null, {
    status:  302,
    headers: { Location: authUrl.toString() },
  });
}
