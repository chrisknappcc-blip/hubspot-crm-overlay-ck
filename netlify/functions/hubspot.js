// netlify/functions/hubspot.js
// Routes:
//   GET  /hubspot/auth/connect            -> redirect to HubSpot OAuth
//   GET  /hubspot/auth/callback           -> exchange code, store tokens (no auth required)
//   GET  /hubspot/status                  -> check which services are connected
//   GET  /hubspot/contacts                -> list contacts
//   GET  /hubspot/contacts/:id            -> single contact detail + engagements
//   GET  /hubspot/signals                 -> ranked intent signals (bot-filtered)
//   GET  /hubspot/feed/:contactId         -> full merged activity feed for a contact
//   GET  /hubspot/feed/team               -> activity feed across all contacts (team view)
//   POST /hubspot/activity                -> log a note/call/meeting to a contact

import { withAuth } from "./utils/auth.js";
import { getTokens, setTokens, isTokenValid } from "./utils/tokenStore.js";

const HS_CLIENT_ID     = process.env.HUBSPOT_CLIENT_ID;
const HS_CLIENT_SECRET = process.env.HUBSPOT_CLIENT_SECRET;
const HS_REDIRECT_URI  = process.env.HUBSPOT_REDIRECT_URI;
const HS_API           = "https://api.hubapi.com";

const HS_SCOPES = [
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.objects.deals.read",
  "timeline",
  "sales-email-read",
  "crm.lists.read",
  "automation",
  "crm.objects.marketing_events.read",
  "crm.objects.marketing_events.write",
  "content",
  "marketing-email",
  "e-commerce",
  "oauth",
].join(" ");;


// ─── OAuth helpers ────────────────────────────────────────────────────────────

async function refreshHubSpotToken(userId, tokens) {
  const res = await fetch("https://api.hubapi.com/oauth/v1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      client_id:     HS_CLIENT_ID,
      client_secret: HS_CLIENT_SECRET,
      refresh_token: tokens.hubspot.refresh_token,
    }),
  });
  if (!res.ok) throw new Error("HubSpot token refresh failed");
  const data = await res.json();
  const updated = {
    hubspot: {
      access_token:  data.access_token,
      refresh_token: data.refresh_token || tokens.hubspot.refresh_token,
      expires_at:    Date.now() + data.expires_in * 1000,
    },
  };
  await setTokens(userId, updated);
  return updated.hubspot;
}

async function getValidHubSpotToken(userId) {
  const tokens = await getTokens(userId);
  if (!tokens.hubspot?.access_token) {
    throw new ApiError("HubSpot not connected. Visit /hubspot/auth/connect", 403);
  }
  if (!isTokenValid(tokens.hubspot)) {
    return await refreshHubSpotToken(userId, tokens);
  }
  return tokens.hubspot;
}

async function hsGet(userId, path, params = {}) {
  const token = await getValidHubSpotToken(userId);
  const url   = new URL(`${HS_API}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new ApiError(`HubSpot API error (${res.status}): ${err}`, res.status);
  }
  return res.json();
}

async function hsPost(userId, path, body) {
  const token = await getValidHubSpotToken(userId);
  const res = await fetch(`${HS_API}${path}`, {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${token.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new ApiError(`HubSpot API error (${res.status}): ${err}`, res.status);
  }
  return res.json();
}


// ─── Activity feed helpers ────────────────────────────────────────────────────

async function fetchEngagements(userId, contactId, limit = 50) {
  try {
    const data = await hsGet(
      userId,
      `/engagements/v1/engagements/associated/CONTACT/${contactId}/paged`,
      { limit }
    );
    return (data.results || []).map((eng) => ({
      source:        "engagement",
      id:            `eng-${eng.engagement?.id}`,
      type:          eng.engagement?.type || "UNKNOWN",
      timestamp:     eng.engagement?.createdAt || eng.engagement?.timestamp || null,
      subject:       eng.metadata?.subject || eng.metadata?.title || null,
      body:          eng.metadata?.body || eng.metadata?.text || null,
      numOpens:      eng.metadata?.numOpens      || 0,
      numClicks:     eng.metadata?.numClicks     || 0,
      replied:       eng.metadata?.replied       || false,
      filteredEvent: eng.metadata?.filteredEvent || false,
      sentAt:        eng.metadata?.sentAt        || null,
      openedAt:      eng.metadata?.openedAt      || null,
      contactId:     eng.associations?.contactIds?.[0] ?? null,
    }));
  } catch {
    return [];
  }
}

async function fetchTimelineEvents(userId, contactId, limit = 50) {
  try {
    const data = await hsGet(
      userId,
      `/crm/v3/timeline/events`,
      { objectType: "CONTACT", objectId: contactId, limit }
    );
    return (data.results || []).map((ev) => ({
      source:    "timeline",
      id:        `tl-${ev.id}`,
      type:      "TIMELINE_EVENT",
      eventType: ev.eventTemplateId || ev.objectType || "unknown",
      timestamp: ev.createdAt || ev.occurredAt || null,
      subject:   ev.tokens?.subject    || ev.extraData?.subject     || null,
      body:      ev.tokens?.body       || ev.extraData?.description || null,
      tokens:    ev.tokens    || {},
      extraData: ev.extraData || {},
      contactId: null,
    }));
  } catch {
    return [];
  }
}

async function fetchSequenceEnrollments(userId, contactId) {
  try {
    const data = await hsGet(
      userId,
      `/crm/v3/objects/contacts/${contactId}/associations/SEQUENCE_ENROLLMENT`,
      { limit: 10 }
    );
    const enrollmentIds = (data.results || []).map((r) => r.id);
    if (enrollmentIds.length === 0) return [];

    const batch = await hsPost(
      userId,
      "/crm/v3/objects/sequence_enrollments/batch/read",
      {
        properties: [
          "hs_enrollment_state",
          "hs_sequence_id",
          "hs_sequence_name",
          "hs_current_step_order",
          "hs_enrolled_at",
          "hs_ended_at",
          "hs_finished_at",
        ],
        inputs: enrollmentIds.map((id) => ({ id })),
      }
    );

    return (batch.results || []).map((enr) => ({
      source:      "sequence",
      id:          `seq-${enr.id}`,
      type:        "SEQUENCE_ENROLLMENT",
      timestamp:   enr.properties?.hs_enrolled_at || null,
      subject:     enr.properties?.hs_sequence_name || "Sequence",
      body:        null,
      state:       enr.properties?.hs_enrollment_state   || null,
      currentStep: enr.properties?.hs_current_step_order || null,
      sequenceId:  enr.properties?.hs_sequence_id        || null,
      enrolledAt:  enr.properties?.hs_enrolled_at        || null,
      endedAt:     enr.properties?.hs_ended_at || enr.properties?.hs_finished_at || null,
      contactId:   null,
    }));
  } catch {
    return [];
  }
}

async function fetchLifecycleHistory(userId, contactId) {
  try {
    const data = await hsGet(
      userId,
      `/crm/v3/objects/contacts/${contactId}`,
      {
        properties:            "lifecyclestage,hs_lead_status",
        propertiesWithHistory: "lifecyclestage,hs_lead_status",
      }
    );

    const history = [];

    (data.propertiesWithHistory?.lifecyclestage || []).forEach((h) => {
      history.push({
        source:    "lifecycle",
        id:        `lc-${h.timestamp}-${h.value}`,
        type:      "LIFECYCLE_CHANGE",
        timestamp: h.timestamp,
        subject:   `Lifecycle stage: ${h.value}`,
        body:      null,
        value:     h.value,
        contactId: null,
      });
    });

    (data.propertiesWithHistory?.hs_lead_status || []).forEach((h) => {
      history.push({
        source:    "lifecycle",
        id:        `ls-${h.timestamp}-${h.value}`,
        type:      "LEAD_STATUS_CHANGE",
        timestamp: h.timestamp,
        subject:   `Lead status: ${h.value}`,
        body:      null,
        value:     h.value,
        contactId: null,
      });
    });

    return history;
  } catch {
    return [];
  }
}

function mergeFeed(engagements, timelineEvents, sequences, lifecycle) {
  const all  = [...engagements, ...timelineEvents, ...sequences, ...lifecycle];
  const seen = new Set();
  return all
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return tb - ta;
    });
}


// 5. Marketing email events: opens, clicks, deliveries from HubSpot Marketing Hub
//    Uses /marketing/v3/emails/statistics/query to get recipient-level events
async function fetchMarketingEmailEvents(userId, since) {
  try {
    const sinceISO = new Date(since).toISOString();
    const data = await hsPost(userId, "/marketing/v3/emails/statistics/query", {
      property: ["hs_email_sends_by_deliverability", "hs_email_open_rate", "hs_email_click_rate"],
      filters: {
        startTimestamp: sinceISO,
      },
      limit: 100,
    });

    // The statistics API returns aggregate data per email, not per recipient.
    // We need the recipient-level events from the email events API instead.
    return [];
  } catch {
    return [];
  }
}

// Fetch per-recipient marketing email events using the Email Events API
async function fetchMarketingEmailRecipientEvents(userId, since) {
  try {
    const data = await hsGet(userId, "/email/public/v1/events", {
      startTimestamp: since,
      limit: 100,
    });

    return (data.events || []).map((ev) => ({
      source:    "marketing_email",
      id:        `mev-${ev.id || ev.created}`,
      type:      "MARKETING_EMAIL",
      eventType: ev.type, // OPEN, CLICK, DELIVERED, BOUNCE, UNSUBSCRIBE
      timestamp: ev.created || null,
      subject:   ev.emailCampaignGroupName || ev.emailCampaignId || "Marketing email",
      body:      null,
      numOpens:  ev.type === "OPEN"  ? 1 : 0,
      numClicks: ev.type === "CLICK" ? 1 : 0,
      replied:   false,
      filteredEvent: ev.type === "OPEN" && ev.browser?.name === "unknown",
      sentAt:    null,
      openedAt:  ev.type === "OPEN" ? ev.created : null,
      contactId: ev.recipient ? String(ev.recipient) : null,
      recipientEmail: ev.recipient || null,
      url:       ev.url || null, // for clicks
    }));
  } catch (err) {
    console.error("Marketing email events fetch failed:", err.message);
    return [];
  }
}

// ─── Bot detection ────────────────────────────────────────────────────────────

function detectBot(item) {
  const reasons = [];

  if (item.filteredEvent) {
    reasons.push("HubSpot flagged as filtered/bot event");
  }

  if (item.sentAt && item.openedAt) {
    const secondsToOpen = (item.openedAt - item.sentAt) / 1000;
    if (secondsToOpen >= 0 && secondsToOpen < 10) {
      reasons.push(`Opened ${secondsToOpen.toFixed(1)}s after send (threshold: <10s)`);
    }
  }

  if (item.numOpens > 0 && item.numClicks === 0 && !item.replied) {
    reasons.push("Opens with no clicks or reply");
  }

  if (item.numOpens >= 4 && item.numClicks === 0 && !item.replied) {
    reasons.push(`${item.numOpens} opens, 0 clicks - burst pattern`);
  }

  if (item.openedAt) {
    const hour = new Date(item.openedAt).getHours();
    if ((hour < 6 || hour > 22) && item.numClicks === 0 && !item.replied) {
      reasons.push("Opened outside business hours with no follow-on");
    }
  }

  const hardSignals = reasons.filter(
    (r) => r.includes("HubSpot flagged") || r.includes("after send")
  ).length;
  const softSignals = reasons.length - hardSignals;

  let confidence = "none";
  if (hardSignals >= 1)       confidence = "high";
  else if (softSignals >= 2)  confidence = "medium";
  else if (softSignals === 1) confidence = "low";

  return { isBot: confidence === "high" || confidence === "medium", confidence, reasons };
}


// ─── Signal scoring ───────────────────────────────────────────────────────────

function scoreAllSignals(feedItems, includeBots = false) {
  const real = [];
  const bots = [];

  for (const item of feedItems) {
    let score = 0;
    let label = "";

    if ((item.source === "engagement" && item.type === "EMAIL") ||
         item.source === "marketing_email") {
      if (item.replied)            { score = 100; label = "Replied"; }
      else if (item.numClicks > 0) {
        score = 60 + item.numClicks * 5;
        label = item.url
          ? `Clicked link${item.numClicks > 1 ? ` ${item.numClicks}x` : ""}: ${item.url.replace(/^https?:\/\//, "").slice(0, 40)}`
          : `Clicked link${item.numClicks > 1 ? ` ${item.numClicks}x` : ""}`;
      }
      else if (item.numOpens > 0)  {
        score = 30 + item.numOpens * 10;
        label = `Opened${item.numOpens > 1 ? ` ${item.numOpens}x` : ""}`;
      }
      else if (item.eventType === "DELIVERED") continue; // skip pure delivery events
      else if (item.eventType === "BOUNCE")    { score = 10; label = "Bounced"; }
      else if (item.eventType === "UNSUBSCRIBE") { score = 5; label = "Unsubscribed"; }

      if (score === 0) continue;

      const botCheck = detectBot(item);
      const signal   = { ...item, score, label, botCheck };

      if (botCheck.isBot && item.numClicks === 0 && !item.replied) {
        bots.push(signal);
      } else {
        real.push(signal);
      }
      continue;
    }

    if (item.source === "sequence") {
      if (item.state === "FINISHED")    { score = 50; label = `Completed sequence: ${item.subject}`; }
      else if (item.state === "ACTIVE") { score = 20; label = `In sequence: ${item.subject} (step ${item.currentStep || "?"})`; }
      else continue;
      real.push({ ...item, score, label, botCheck: null });
      continue;
    }

    if (item.source === "lifecycle") {
      score = 45;
      label = item.subject;
      real.push({ ...item, score, label, botCheck: null });
      continue;
    }

    if (item.source === "timeline") {
      score = 15;
      label = item.subject || item.eventType || "Activity";
      real.push({ ...item, score, label, botCheck: null });
      continue;
    }

    if (item.source === "engagement") {
      score = 25;
      label = item.type.charAt(0) + item.type.slice(1).toLowerCase();
      if (item.subject) label += `: ${item.subject}`;
      real.push({ ...item, score, label, botCheck: null });
    }
  }

  real.sort((a, b) => b.score - a.score);
  bots.sort((a, b) => b.score - a.score);
  return { real, bots };
}


// ─── OAuth callback (no auth required) ───────────────────────────────────────
// HubSpot redirects the browser here after OAuth -- no Clerk token is present.
// We extract the code and userId (from state), exchange for tokens, store them,
// then redirect the user back to the app.

async function handleOAuthCallback(event) {
  const qp     = event.queryStringParameters || {};
  const code   = qp.code;
  const userId = qp.state;

  if (!code || !userId) return error(400, "Missing code or state");

  const res = await fetch("https://api.hubapi.com/oauth/v1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "authorization_code",
      client_id:     HS_CLIENT_ID,
      client_secret: HS_CLIENT_SECRET,
      redirect_uri:  HS_REDIRECT_URI,
      code,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("HubSpot token exchange failed:", errText);
    return error(400, "Token exchange failed");
  }

  const data = await res.json();

  await setTokens(userId, {
    hubspot: {
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_at:    Date.now() + data.expires_in * 1000,
    },
  });

  return {
    statusCode: 302,
    headers: {
      Location:                      process.env.APP_URL + "?connected=hubspot",
      "Access-Control-Allow-Origin": "*",
    },
    body: "",
  };
}


// ─── Main router ──────────────────────────────────────────────────────────────

export const handler = async (event, context) => {
  const rawPath = (event.path || "")
    .replace("/.netlify/functions/hubspot", "")
    .replace("/api/hubspot", "");

  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      },
      body: "",
    };
  }

  // OAuth callback runs without Clerk auth -- HubSpot redirects here
  if (event.httpMethod === "GET" && rawPath === "/auth/callback") {
    return handleOAuthCallback(event);
  }

  // Temporary debug route -- shows raw marketing email events without auth
  // Remove this after debugging is complete
  if (event.httpMethod === "GET" && rawPath === "/debug/marketing") {
    const since = Date.now() - 48 * 60 * 60 * 1000;
    const qp = event.queryStringParameters || {};
    const userId = qp.userId;
    if (!userId) return error(400, "Pass ?userId=YOUR_CLERK_USER_ID");
    try {
      const data = await hsGet(userId, "/email/public/v1/events", {
        startTimestamp: since,
        limit: 10,
      });
      return ok({ count: (data.events||[]).length, sample: (data.events||[]).slice(0,3), raw: data });
    } catch (err) {
      return ok({ error: err.message });
    }
  }

  // Everything else requires a valid Clerk session
  return withAuth(async (event, context, user) => {
    const path   = rawPath;
    const method = event.httpMethod;
    const qp     = event.queryStringParameters || {};

    // ── OAuth: start connect ─────────────────────────────────────────────────
    if (method === "GET" && path === "/auth/connect") {
      const url = new URL("https://app.hubspot.com/oauth/authorize");
      url.searchParams.set("client_id",    HS_CLIENT_ID);
      url.searchParams.set("redirect_uri", HS_REDIRECT_URI);
      url.searchParams.set("scope",        HS_SCOPES);
      url.searchParams.set("state",        user.userId);
      return ok({ authUrl: url.toString() });
    }

    // ── Connection status ────────────────────────────────────────────────────
    if (method === "GET" && path === "/status") {
      const tokens = await getTokens(user.userId);
      return ok({
        hubspot:   !!tokens.hubspot?.access_token,
        microsoft: !!tokens.microsoft?.access_token,
      });
    }

    // ── Contacts list ────────────────────────────────────────────────────────
    if (method === "GET" && path === "/contacts") {
      const data = await hsGet(user.userId, "/crm/v3/objects/contacts", {
        limit: 100,
        properties: "firstname,lastname,email,company,jobtitle,phone,hs_lead_status,hubspot_owner_id,notes_last_contacted,num_contacted_notes,lifecyclestage",
        associations: "deals",
      });
      return ok({ contacts: data.results, total: data.total });
    }

    // ── Single contact ───────────────────────────────────────────────────────
    if (method === "GET" && path.startsWith("/contacts/")) {
      const id = path.split("/contacts/")[1];
      const [contact, engagements] = await Promise.all([
        hsGet(user.userId, `/crm/v3/objects/contacts/${id}`, {
          properties: "firstname,lastname,email,company,jobtitle,phone,hs_lead_status,notes_last_contacted,lifecyclestage",
          associations: "deals,engagements",
        }),
        fetchEngagements(user.userId, id, 20),
      ]);
      return ok({ contact, engagements });
    }

    // ── Full merged activity feed for a contact ──────────────────────────────
    if (method === "GET" && path.startsWith("/feed/") && path !== "/feed/team") {
      const contactId = path.split("/feed/")[1];
      const sources   = (qp.sources || "engagements,timeline,sequences,lifecycle").split(",");

      const [engagements, timelineEvents, sequences, lifecycle] = await Promise.all([
        sources.includes("engagements") ? fetchEngagements(user.userId, contactId)         : Promise.resolve([]),
        sources.includes("timeline")    ? fetchTimelineEvents(user.userId, contactId)      : Promise.resolve([]),
        sources.includes("sequences")   ? fetchSequenceEnrollments(user.userId, contactId) : Promise.resolve([]),
        sources.includes("lifecycle")   ? fetchLifecycleHistory(user.userId, contactId)    : Promise.resolve([]),
      ]);

      const feed       = mergeFeed(engagements, timelineEvents, sequences, lifecycle);
      const typeFilter = qp.types ? qp.types.split(",") : null;
      const filtered   = typeFilter ? feed.filter((item) => typeFilter.includes(item.type)) : feed;

      return ok({
        feed: filtered,
        meta: {
          total: filtered.length,
          bySource: {
            engagements:    engagements.length,
            timelineEvents: timelineEvents.length,
            sequences:      sequences.length,
            lifecycle:      lifecycle.length,
          },
        },
      });
    }

    // ── Team activity feed ───────────────────────────────────────────────────
    if (method === "GET" && path === "/feed/team") {
      const hours = Math.min(parseInt(qp.hours || "24", 10), 168);
      const limit = Math.min(parseInt(qp.limit || "50",  10), 200);
      const since = Date.now() - hours * 60 * 60 * 1000;

      const engData = await hsGet(user.userId, "/engagements/v1/engagements/paged", {
        limit: 100,
        since,
      });

      const items = (engData.results || []).map((eng) => ({
        source:        "engagement",
        id:            `eng-${eng.engagement?.id}`,
        type:          eng.engagement?.type || "UNKNOWN",
        timestamp:     eng.engagement?.createdAt || null,
        subject:       eng.metadata?.subject || null,
        body:          eng.metadata?.body    || null,
        numOpens:      eng.metadata?.numOpens      || 0,
        numClicks:     eng.metadata?.numClicks     || 0,
        replied:       eng.metadata?.replied       || false,
        filteredEvent: eng.metadata?.filteredEvent || false,
        sentAt:        eng.metadata?.sentAt        || null,
        openedAt:      eng.metadata?.openedAt      || null,
        contactId:     eng.associations?.contactIds?.[0] ?? null,
      }));

      const { real, bots } = scoreAllSignals(items, qp.includeBots === "true");

      const contactIds = [...new Set(real.slice(0, limit).map((s) => s.contactId).filter(Boolean))];
      let contactMap   = {};
      if (contactIds.length > 0) {
        const batch = await hsPost(user.userId, "/crm/v3/objects/contacts/batch/read", {
          properties: ["firstname", "lastname", "company", "jobtitle"],
          inputs:     contactIds.map((id) => ({ id })),
        });
        (batch.results || []).forEach((c) => {
          contactMap[c.id] = {
            name:    `${c.properties.firstname || ""} ${c.properties.lastname || ""}`.trim(),
            company: c.properties.company  || "",
            title:   c.properties.jobtitle || "",
          };
        });
      }

      const enrich   = (s) => ({ ...s, contact: contactMap[s.contactId] || null });
      const response = {
        feed: real.slice(0, limit).map(enrich),
        meta: {
          total:             real.length,
          suspectedBotCount: bots.length,
          hoursSearched:     hours,
          botSummary: bots.length > 0
            ? `${bots.length} open event${bots.length > 1 ? "s" : ""} filtered as likely bot scan`
            : null,
        },
      };
      if (qp.showBots === "true") {
        response.suspectedBotSignals = bots.slice(0, 20).map(enrich);
      }
      return ok(response);
    }

    // ── Signals ──────────────────────────────────────────────────────────────
    if (method === "GET" && path === "/signals") {
      const hours = Math.min(parseInt(qp.hours || "48", 10), 168);
      const since = Date.now() - hours * 60 * 60 * 1000;

      // Fetch both engagement data and marketing email events in parallel
      const [engData, marketingEvents] = await Promise.all([
        hsGet(user.userId, "/engagements/v1/engagements/paged", {
          limit: 100,
          since,
        }).catch(() => ({ results: [] })),
        fetchMarketingEmailRecipientEvents(user.userId, since),
      ]);

      const engItems = (engData.results || []).map((eng) => ({
        source:        "engagement",
        id:            `eng-${eng.engagement?.id}`,
        type:          eng.engagement?.type || "UNKNOWN",
        timestamp:     eng.engagement?.createdAt || null,
        subject:       eng.metadata?.subject      || null,
        numOpens:      eng.metadata?.numOpens      || 0,
        numClicks:     eng.metadata?.numClicks     || 0,
        replied:       eng.metadata?.replied       || false,
        filteredEvent: eng.metadata?.filteredEvent || false,
        sentAt:        eng.metadata?.sentAt        || null,
        openedAt:      eng.metadata?.openedAt      || null,
        contactId:     eng.associations?.contactIds?.[0] ?? null,
      }));

      // Merge engagement items + marketing email events
      const allItems = [...engItems, ...marketingEvents];
      const { real, bots } = scoreAllSignals(allItems, qp.includeBots === "true");

      const allSignals = [...real, ...(qp.includeBots === "true" ? bots : [])].slice(0, 30);

      // Collect contact IDs (from engagements) and emails (from marketing events)
      const contactIds    = [...new Set(allSignals.map(s => s.contactId).filter(Boolean))]
      const recipientEmails = [...new Set(allSignals.map(s => s.recipientEmail).filter(s => s && !s.contactId))]

      let contactMap = {};

      // Look up by contact ID
      if (contactIds.length > 0) {
        const batch = await hsPost(user.userId, "/crm/v3/objects/contacts/batch/read", {
          properties: ["firstname", "lastname", "company", "jobtitle", "email"],
          inputs:     contactIds.map((id) => ({ id })),
        });
        (batch.results || []).forEach((c) => {
          const info = {
            name:    `${c.properties.firstname || ""} ${c.properties.lastname || ""}`.trim(),
            company: c.properties.company  || "",
            title:   c.properties.jobtitle || "",
          };
          contactMap[c.id] = info;
          // Also index by email so marketing events can find them
          if (c.properties.email) contactMap[c.properties.email] = info;
        });
      }

      // Look up marketing event contacts by email if not already found
      const missingEmails = recipientEmails.filter(e => !contactMap[e]);
      if (missingEmails.length > 0) {
        try {
          const emailBatch = await hsPost(user.userId, "/crm/v3/objects/contacts/batch/read", {
            properties:  ["firstname", "lastname", "company", "jobtitle", "email"],
            idProperty:  "email",
            inputs:      missingEmails.map(e => ({ id: e })),
          });
          (emailBatch.results || []).forEach((c) => {
            const info = {
              name:    `${c.properties.firstname || ""} ${c.properties.lastname || ""}`.trim(),
              company: c.properties.company  || "",
              title:   c.properties.jobtitle || "",
            };
            if (c.properties.email) contactMap[c.properties.email] = info;
            contactMap[c.id] = info;
          });
        } catch { /* fail silently */ }
      }

      const enrich = (s) => ({
        ...s,
        contact: contactMap[s.contactId] || contactMap[s.recipientEmail] || null,
      });
      const response = {
        signals: real.slice(0, 20).map(enrich),
        meta: {
          total:             real.length,
          suspectedBotCount: bots.length,
          hoursSearched:     hours,
          botSummary: bots.length > 0
            ? `${bots.length} open event${bots.length > 1 ? "s" : ""} filtered as likely bot scan`
            : null,
        },
      };
      if (qp.showBots === "true") {
        response.suspectedBotSignals = bots.slice(0, 20).map(enrich);
      }
      return ok(response);
    }

    // ── Log activity ─────────────────────────────────────────────────────────
    if (method === "POST" && path === "/activity") {
      const body = JSON.parse(event.body || "{}");
      const { contactId, note, type = "NOTE" } = body;
      if (!contactId || !note) return error(400, "contactId and note are required");

      const activity = await hsPost(user.userId, "/engagements/v1/engagements", {
        engagement:   { active: true, type, timestamp: Date.now() },
        associations: { contactIds: [contactId] },
        metadata:     { body: note },
      });

      return ok({ success: true, engagementId: activity.engagement?.id });
    }

    return error(404, "Route not found");

  })(event, context);
};


// ─── Response helpers ─────────────────────────────────────────────────────────

function ok(data) {
  return {
    statusCode: 200,
    headers: {
      "Content-Type":                "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(data),
  };
}

function error(status, message) {
  return {
    statusCode: status,
    headers: {
      "Content-Type":                "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify({ error: message }),
  };
}

class ApiError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
  }
}
