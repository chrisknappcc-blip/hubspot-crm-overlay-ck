// netlify/functions/hubspot.js
// Routes:
//   GET  /hubspot/auth/connect            -> redirect to HubSpot OAuth
//   GET  /hubspot/auth/callback           -> exchange code, store tokens (no auth required)
//   GET  /hubspot/status                  -> check which services are connected
//   GET  /hubspot/owners                  -> list HubSpot owners (reps) for filter dropdown
//   GET  /hubspot/contacts                -> list contacts with custom property filters
//   GET  /hubspot/contacts/:id            -> single contact detail + engagements
//   GET  /hubspot/signals                 -> ranked intent signals with custom property filters
//   GET  /hubspot/signals/recent          -> last 15 min of email events for real-time polling
//   GET  /hubspot/feed/:contactId         -> full merged activity feed for a contact
//   GET  /hubspot/tasks                   -> smart task queue three sections
//   GET  /hubspot/gold                    -> Gold-tier companies + contacts
//   GET  /hubspot/activity                -> outbound + inbound activity counts
//   POST /hubspot/activity                -> log a note/call/meeting to a contact
//   GET  /hubspot/tabs                    -> dynamic tab registry for current user
//   POST /hubspot/tabs                    -> add or update a tab (admin only)
//   DELETE /hubspot/tabs/:id              -> remove a tab (admin only)
//   GET  /hubspot/tabs/preview            -> fetch page title from a URL for auto-naming
//
// Custom filter query params (all optional, stackable):
//   assigned_bdr=Chris+Knapp
//   territory=Northeast
//   priority_tier__bdr=GOLD+1-10
//   target_account__bdr_led_outreach=Chris+Knapp

import { withAuth } from "./utils/auth.js";
import { getTokens, setTokens, isTokenValid } from "./utils/tokenStore.js";
import { getTabsForUser, getRegistry, saveRegistry, slugify, fetchPageTitle } from "./utils/tabRegistry.js";

// Admin user IDs -- comma-separated Clerk user IDs in ADMIN_USER_IDS env var
// e.g. ADMIN_USER_IDS=user_abc123,user_def456
const ADMIN_USER_IDS = new Set(
  (process.env.ADMIN_USER_IDS || "").split(",").map(s => s.trim()).filter(Boolean)
);

const HS_CLIENT_ID     = process.env.HUBSPOT_CLIENT_ID;
const HS_CLIENT_SECRET = process.env.HUBSPOT_CLIENT_SECRET;
const HS_REDIRECT_URI  = process.env.HUBSPOT_REDIRECT_URI;
const HS_API           = "https://api.hubapi.com";

const HS_SCOPES = [
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.objects.deals.read",
  "crm.objects.companies.read",   // required for gold accounts panel
  "timeline",
  "sales-email-read",
  "crm.lists.read",
  "automation",
  "crm.objects.marketing_events.read",
  "crm.objects.marketing_events.write",
  "content",
  "e-commerce",
  "oauth",
].join(" ");

// All custom properties to include in every contact fetch
// NOTE: priority_tier__bdr lives on the COMPANY object, not contacts.
// Do not add it here -- it will cause HubSpot to 400 on every contact search.
const CUSTOM_PROPS = [
  "assigned_bdr",
  "target_account__bdr_led_outreach",
  "territory",
];

// Standard contact properties always fetched
const BASE_CONTACT_PROPS = [
  "firstname", "lastname", "email", "company", "jobtitle", "phone",
  "hs_lead_status", "lifecyclestage", "hubspot_owner_id",
  "notes_last_contacted", "num_contacted_notes",
  "hs_last_sales_activity_timestamp",
  "hs_last_sales_activity_timestamp",
  // Marketing email timestamps (hs_email_* prefix)
  "hs_email_last_open_date",
  "hs_email_last_click_date",
  "hs_email_last_reply_date",
  "hs_email_last_send_date",
  "hs_email_last_email_name",        // name of last marketing email sent
  // Sales / 1:1 email timestamps (hs_sales_email_* prefix)
  "hs_sales_email_last_opened",      // last 1:1 sales email open date
  "hs_sales_email_last_clicked",     // last 1:1 sales email click date
  "hs_sales_email_last_replied",     // last 1:1 sales email reply date
  // Sequence enrollment -- note: hs_sequence_name does NOT exist on contacts.
  // hs_latest_sequence_enrolled stores a numeric sequence ID, not the name.
  // Name resolution requires a separate sequence enrollment lookup (fetchSequenceEnrollments).
  "hs_sequences_actively_enrolled_count",
  "hs_sequences_is_enrolled",
  "hs_latest_sequence_enrolled",     // numeric sequence ID of last enrollment
  "hs_latest_sequence_enrolled_date",
  ...CUSTOM_PROPS,
];


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


// ─── Filter helpers ───────────────────────────────────────────────────────────
// Builds HubSpot search filter groups from query params.
// Filters stack (AND logic) -- each active filter adds to the group.

function buildCustomFilters(qp, baseFilters = []) {
  const filters = [...baseFilters];

  const FILTER_MAP = {
    assigned_bdr:                    "assigned_bdr",
    territory:                       "territory",
    // NOTE: priority_tier__bdr is a COMPANY property, not a contact property.
    // It cannot be used to filter contacts directly. Omitted intentionally.
    target_account__bdr_led_outreach:"target_account__bdr_led_outreach",
  };

  Object.entries(FILTER_MAP).forEach(([param, prop]) => {
    if (qp[param]) {
      const val = decodeURIComponent(qp[param]).trim();
      if (val) {
        filters.push({
          propertyName: prop,
          operator:     "EQ",
          value:        val,
        });
      }
    }
  });

  return filters;
}

// Normalize a contact record into a clean info object
function normalizeContact(c) {
  const p = c.properties || {};
  return {
    id:           c.id,
    name:         `${p.firstname || ""} ${p.lastname || ""}`.trim(),
    email:        p.email || "",
    company:      p.company || "",
    title:        p.jobtitle || "",
    phone:        p.phone || "",
    leadStatus:   p.hs_lead_status || "",
    lifecycle:    p.lifecyclestage || "",
    lastContacted:p.notes_last_contacted || null,
    numContacted: p.num_contacted_notes || "0",
    // Custom properties
    assignedBdr:         p.assigned_bdr || "",
    targetAccount:       p.target_account__bdr_led_outreach || "",
    territory:           p.territory || "",
    // priorityTier lives on Company object, not contact -- omitted here
    // Marketing email timestamps (hs_email_* -- marketing hub sends)
    lastEmailActivityDate: p.hs_last_sales_activity_timestamp || null,
    lastSalesActivityDate: p.hs_last_sales_activity_timestamp || null,
    lastOpenDate:          p.hs_email_last_open_date     || null,
    lastClickDate:         p.hs_email_last_click_date    || null,
    lastReplyDate:         p.hs_email_last_reply_date    || null,
    lastSendDate:          p.hs_email_last_send_date     || null,
    lastEmailName:         p.hs_email_last_email_name    || null,
    // Sales / 1:1 email timestamps (hs_sales_email_* -- sequences and manual sends)
    salesLastOpened:       p.hs_sales_email_last_opened  || null,
    salesLastClicked:      p.hs_sales_email_last_clicked || null,
    salesLastReplied:      p.hs_sales_email_last_replied || null,
    // Sequence enrollment (ID only -- name requires fetchSequenceEnrollments)
    sequenceId:            p.hs_latest_sequence_enrolled      || null,
    sequenceEnrolledDate:  p.hs_latest_sequence_enrolled_date || null,
    inSequence:            p.hs_sequences_is_enrolled === "true",
  };
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
          "hs_enrollment_state", "hs_sequence_id", "hs_sequence_name",
          "hs_current_step_order", "hs_enrolled_at", "hs_ended_at", "hs_finished_at",
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

// Fetch per-recipient marketing email events
async function fetchMarketingEmailRecipientEvents(userId, since) {
  try {
    const data = await hsGet(userId, "/email/public/v1/events", {
      startTimestamp: since,
      limit: 200,
    });

    // Log first event to see all available fields for debugging
    if (data.events && data.events.length > 0) {
      console.log("[mkt-email] Sample event fields:", Object.keys(data.events[0]).join(", "));
      console.log("[mkt-email] Sample event:", JSON.stringify(data.events[0]).slice(0, 500));
    }

    return (data.events || [])
      .filter(ev => ["OPEN", "CLICK"].includes(ev.type))
      .map((ev) => ({
        source:         "marketing_email",
        id:             `mev-${ev.id || ev.created}`,
        type:           "MARKETING_EMAIL",
        eventType:      ev.type,
        timestamp:      ev.created || null,
        // emailCampaignGroupName is the actual campaign name when HubSpot populates it
        // emailCampaignId is the numeric send ID -- different from the email template ID
        subject:        ev.emailCampaignGroupName || ev.appName || null,
        campaignId:     ev.emailCampaignId ? String(ev.emailCampaignId) : null,
        body:           null,
        numOpens:       ev.type === "OPEN"  ? 1 : 0,
        numClicks:      ev.type === "CLICK" ? 1 : 0,
        replied:        false,
        filteredEvent:  ev.type === "OPEN" && ev.browser?.name === "unknown",
        sentAt:         null,
        openedAt:       ev.type === "OPEN"  ? ev.created : null,
        clickedAt:      ev.type === "CLICK" ? ev.created : null,
        contactId:      ev.contactId ? String(ev.contactId) : null,
        recipientEmail: ev.recipient || null,
        url:            ev.url || null,
      }));
  } catch (err) {
    console.error("Marketing email events fetch failed:", err.message);
    return [];
  }
}


// ─── Bot detection ────────────────────────────────────────────────────────────
// Bot/scanner opens have distinctive patterns -- we check multiple signals
// and assign confidence levels so we never filter out clicks or replies.
//
// Thresholds (based on industry research):
//   < 60 seconds to open  = almost certainly a security scanner (HIGH confidence)
//   < 5 minutes to open   = very likely a scanner (MEDIUM confidence)
//   Opens with no clicks  = soft signal (LOW confidence alone)
//   4+ opens, 0 clicks    = burst scan pattern (MEDIUM confidence)
//   Off-hours open        = soft signal (LOW confidence alone)

function detectBot(item) {
  const reasons = [];

  // Normalize timestamps -- accept both ms numbers and ISO strings
  const toMs = (v) => {
    if (!v) return null;
    if (typeof v === "number") return v;
    const t = new Date(v).getTime();
    return isNaN(t) ? null : t;
  };

  const sentMs   = toMs(item.sentAt);
  const openedMs = toMs(item.openedAt);

  // 1. HubSpot's own bot filter flag (always high confidence)
  if (item.filteredEvent) {
    reasons.push("HubSpot flagged as bot/filtered event");
  }

  // 2. Time-to-open heuristics
  if (sentMs && openedMs && openedMs >= sentMs) {
    const secondsToOpen = (openedMs - sentMs) / 1000;
    if (secondsToOpen < 60) {
      // Under 60 seconds is almost always a security scanner
      reasons.push(`Opened ${secondsToOpen.toFixed(0)}s after send (scanner threshold: <60s)`);
    } else if (secondsToOpen < 300) {
      // Under 5 minutes is suspicious but lower confidence
      reasons.push(`Opened ${Math.round(secondsToOpen / 60)}m after send (suspicious: <5min)`);
    }
  }

  // 3. Opens with no clicks or reply (weak signal alone, strong combined)
  if (item.numOpens > 0 && item.numClicks === 0 && !item.replied) {
    reasons.push("Opened with no clicks or reply");
  }

  // 4. Burst pattern: 4+ opens, zero clicks
  if (item.numOpens >= 4 && item.numClicks === 0 && !item.replied) {
    reasons.push(`${item.numOpens} opens, 0 clicks -- burst scan pattern`);
  }

  // 5. Off-hours open with no follow-on (weak signal)
  if (openedMs) {
    const hour = new Date(openedMs).getHours();
    if ((hour < 6 || hour > 22) && item.numClicks === 0 && !item.replied) {
      reasons.push("Opened outside business hours with no follow-on activity");
    }
  }

  // Confidence scoring:
  // Hard signals: HubSpot flag OR time-based (< 60s always hard, < 5min is medium)
  // Soft signals: everything else
  const hardSignals = reasons.filter(r =>
    r.includes("HubSpot flagged") || r.includes("scanner threshold")
  ).length;
  const medSignals = reasons.filter(r =>
    r.includes("suspicious") || r.includes("burst scan")
  ).length;
  const softSignals = reasons.length - hardSignals - medSignals;

  let confidence = "none";
  if (hardSignals >= 1)                          confidence = "high";
  else if (medSignals >= 1 || softSignals >= 2)  confidence = "medium";
  else if (softSignals === 1)                    confidence = "low";

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
        score = 70 + item.numClicks * 5;
        label = `Clicked link${item.numClicks > 1 ? ` ${item.numClicks}x` : ""}`;
      }
      else if (item.numOpens > 0)  {
        score = 40 + item.numOpens * 5;
        label = `Opened${item.numOpens > 1 ? ` ${item.numOpens}x` : ""}`;
      }
      else continue;

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
      score = 45; label = item.subject;
      real.push({ ...item, score, label, botCheck: null });
      continue;
    }

    if (item.source === "timeline") {
      score = 15; label = item.subject || item.eventType || "Activity";
      real.push({ ...item, score, label, botCheck: null });
      continue;
    }

    if (item.source === "engagement") {
      // Only score actual engagement types -- never show raw type strings as subject
      const typeLabel = {
        CALL:    "Call logged",
        MEETING: "Meeting logged",
        NOTE:    "Note logged",
        TASK:    "Task",
      };
      label = typeLabel[item.type] || item.type;
      if (item.subject) label += `: ${item.subject}`;
      score = 25;
      real.push({ ...item, score, label, botCheck: null });
    }
  }

  real.sort((a, b) => b.score - a.score);
  bots.sort((a, b) => b.score - a.score);
  return { real, bots };
}


// ─── OAuth callback (no auth required) ───────────────────────────────────────

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

  if (event.httpMethod === "GET" && rawPath === "/auth/callback") {
    return handleOAuthCallback(event);
  }

  return withAuth(async (event, context, user) => {
    const path   = rawPath;
    const method = event.httpMethod;

    // Parse query params from every possible Netlify source.
    // Log all sources so we can see what's actually available.
    const qpFromParams  = event.queryStringParameters || {};
    const qpFromMulti   = event.multiValueQueryStringParameters || {};
    const rawQuery      = event.rawQuery || "";
    const rawUrl        = event.rawUrl   || "";

    // Try rawQuery first (most reliable on Netlify), fall back to queryStringParameters
    let qp = {};
    if (rawQuery) {
      try {
        qp = Object.fromEntries(new URLSearchParams(rawQuery).entries());
      } catch { qp = {}; }
    }
    if (Object.keys(qp).length === 0 && rawUrl.includes("?")) {
      try {
        qp = Object.fromEntries(new URL(rawUrl).searchParams.entries());
      } catch { qp = {}; }
    }
    if (Object.keys(qp).length === 0) {
      qp = qpFromParams;
    }

    console.log(`[router] path=${path} rawQuery="${rawQuery}" qpKeys=${JSON.stringify(Object.keys(qp))} assigned_bdr="${qp.assigned_bdr || "(none)"}`);

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

    // ── Owners (reps) list ───────────────────────────────────────────────────
    // Returns all HubSpot users with their owner IDs for the filter dropdown.
    //
    // IMPORTANT for filter usage: the assigned_bdr contact property stores the
    // rep's display name as a plain string (e.g. "Chris Knapp"), NOT the numeric
    // owner ID. When filtering contacts by rep, pass filterValue (the name string)
    // as the assigned_bdr query param -- NOT the numeric id.
    //
    // Example: GET /hubspot/signals?assigned_bdr=Chris+Knapp  ✓
    //          GET /hubspot/signals?assigned_bdr=78304576     ✗ (will return 0 results)
    if (method === "GET" && path === "/owners") {
      const data = await hsGet(user.userId, "/crm/v3/owners", { limit: 100 });
      const owners = (data.results || []).map(o => ({
        id:          o.id,
        firstName:   o.firstName || "",
        lastName:    o.lastName  || "",
        email:       o.email     || "",
        name:        `${o.firstName || ""} ${o.lastName || ""}`.trim(),
        // filterValue is what to send as ?assigned_bdr= when filtering contacts.
        // It matches the string stored in the assigned_bdr contact property.
        filterValue: `${o.firstName || ""} ${o.lastName || ""}`.trim(),
      }));
      return ok({ owners });
    }

    // ── Contacts list (with custom property filters, paginated up to 500) ───────
    if (method === "GET" && path === "/contacts") {
      try {
        const baseFilters = buildCustomFilters(qp);
        let contacts = [];

        if (baseFilters.length > 0) {
          let after = undefined;
          while (contacts.length < 500) {
            const body = {
              filterGroups: [{ filters: baseFilters }],
              properties:   BASE_CONTACT_PROPS,
              sorts:        [{ propertyName: "lastname", direction: "ASCENDING" }],
              limit:        100,
            };
            if (after) body.after = after;
            const data = await hsPost(user.userId, "/crm/v3/objects/contacts/search", body);
            contacts.push(...(data.results || []));
            if (!data.paging?.next?.after || (data.results || []).length < 100) break;
            after = data.paging.next.after;
          }
        } else {
          let after = undefined;
          while (contacts.length < 500) {
            const params = {
              limit:      100,
              properties: BASE_CONTACT_PROPS.join(","),
            };
            if (after) params.after = after;
            const data = await hsGet(user.userId, "/crm/v3/objects/contacts", params);
            contacts.push(...(data.results || []));
            if (!data.paging?.next?.after || (data.results || []).length < 100) break;
            after = data.paging.next.after;
          }
        }

        return ok({ contacts, total: contacts.length });
      } catch (err) {
        console.error("[contacts] Error:", err.message);
        return error(500, `Contacts error: ${err.message}`);
      }
    }

    // ── Single contact ───────────────────────────────────────────────────────
    if (method === "GET" && path.startsWith("/contacts/")) {
      const id = path.split("/contacts/")[1];
      const [contact, engagements] = await Promise.all([
        hsGet(user.userId, `/crm/v3/objects/contacts/${id}`, {
          properties:   BASE_CONTACT_PROPS.join(","),
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

    // ── Task Queue (three smart sections) ────────────────────────────────────
    // Returns a unified smart task queue with three sections:
    //
    //   1. repliesAwaitingResponse -- contacts who replied to any email within the
    //      day window but have had no outbound activity logged since that reply.
    //      Detection: hs_sales_email_last_replied > hs_last_sales_activity_timestamp
    //               OR hs_email_last_reply_date   > hs_last_sales_activity_timestamp
    //      Filterable by assigned_bdr so each rep sees their own queue.
    //
    //   2. upcomingSequences -- contacts currently enrolled in a sequence
    //      (hs_sequences_is_enrolled = true), full contact card + sequence info.
    //      Sorted by sequence enrolled date ascending (oldest enrollment first).
    //
    //   3. dueTasks -- open HubSpot tasks within the day window + overdue tasks.
    //      Same as the previous /tasks implementation.
    //
    // Query params:
    //   days=7|14|21|30     (default: 14) -- applies to all three sections
    //   assigned_bdr=name   (optional)    -- filters replies and sequences by rep
    if (method === "GET" && path === "/tasks") {
      try {
        const days    = Math.min(parseInt(qp.days || "14", 10), 30);
        const now     = Date.now();
        const sinceISO    = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
        const windowEnd   = new Date(now + days * 24 * 60 * 60 * 1000).toISOString();
        const overdueFrom = new Date(now - 90  * 24 * 60 * 60 * 1000).toISOString();

        const customFilters = buildCustomFilters(qp); // picks up assigned_bdr, territory etc.

        // ── Section 1: Replies awaiting response ───────────────────────────────
        // Find contacts where the most recent reply timestamp is AFTER the most
        // recent outbound activity timestamp -- meaning we haven't responded yet.
        //
        // Strategy: fetch contacts with a recent reply date, then client-side
        // filter for those where reply > last outbound. HubSpot search can't do
        // a cross-property comparison natively.
        const repliesData = await hsPost(user.userId, "/crm/v3/objects/contacts/search", {
          filterGroups: [
            // OR: sales email reply in window
            { filters: [
              { propertyName: "hs_sales_email_last_replied", operator: "GTE", value: sinceISO },
              ...customFilters,
            ]},
            // OR: marketing email reply in window
            { filters: [
              { propertyName: "hs_email_last_reply_date", operator: "GTE", value: sinceISO },
              ...customFilters,
            ]},
          ],
          properties: [
            ...BASE_CONTACT_PROPS,
            "hs_sales_email_last_replied",
            "hs_email_last_reply_date",
            "hs_last_sales_activity_timestamp",
            "hs_last_sales_activity_timestamp",
          ],
          sorts:  [{ propertyName: "hs_sales_email_last_replied", direction: "DESCENDING" }],
          limit:  200,
        }).catch(() => ({ results: [] }));

        const repliesAwaitingResponse = (repliesData.results || [])
          .map(c => {
            const p = c.properties || {};

            // Most recent reply across both email types
            const salesReplyTs = p.hs_sales_email_last_replied ? new Date(p.hs_sales_email_last_replied).getTime() : 0;
            const mktReplyTs   = p.hs_email_last_reply_date    ? new Date(p.hs_email_last_reply_date).getTime()    : 0;
            const replyTs      = Math.max(salesReplyTs, mktReplyTs);
            const replyDate    = replyTs === salesReplyTs
              ? p.hs_sales_email_last_replied
              : p.hs_email_last_reply_date;

            // Most recent outbound activity
            const lastOutboundTs = Math.max(
              p.hs_last_sales_activity_timestamp  ? new Date(p.hs_last_sales_activity_timestamp).getTime()  : 0,
              p.hs_last_sales_activity_timestamp  ? new Date(p.hs_last_sales_activity_timestamp).getTime()  : 0,
            );

            // Only include if reply is more recent than last outbound
            if (replyTs <= lastOutboundTs) return null;

            const info = normalizeContact(c);
            return {
              contactId:      c.id,
              contact:        info,
              replyDate,
              replySource:    salesReplyTs >= mktReplyTs ? "sales" : "marketing",
              lastOutboundDate: lastOutboundTs > 0 ? new Date(lastOutboundTs).toISOString() : null,
              waitingHours:   Math.round((now - replyTs) / (1000 * 60 * 60)),
              subject:        p.hs_email_last_email_name || null,
              url: `https://app.hubspot.com/contacts/39921549/record/0-1/${c.id}`,
            };
          })
          .filter(Boolean)
          .sort((a, b) => new Date(b.replyDate) - new Date(a.replyDate));

        // ── Section 2: Upcoming sequences (currently enrolled) ────────────────
        const sequencesData = await hsPost(user.userId, "/crm/v3/objects/contacts/search", {
          filterGroups: [{
            filters: [
              { propertyName: "hs_sequences_is_enrolled", operator: "EQ", value: "true" },
              ...customFilters,
            ],
          }],
          properties: BASE_CONTACT_PROPS,
          sorts:  [{ propertyName: "hs_latest_sequence_enrolled_date", direction: "ASCENDING" }],
          limit:  200,
        }).catch(() => ({ results: [] }));

        const upcomingSequences = (sequencesData.results || []).map(c => {
          const p    = c.properties || {};
          const info = normalizeContact(c);

          // Best signal state for this contact
          const salesReplyTs = p.hs_sales_email_last_replied ? new Date(p.hs_sales_email_last_replied).getTime() : 0;
          const mktReplyTs   = p.hs_email_last_reply_date    ? new Date(p.hs_email_last_reply_date).getTime()    : 0;
          const clickTs      = Math.max(
            p.hs_sales_email_last_clicked ? new Date(p.hs_sales_email_last_clicked).getTime() : 0,
            p.hs_email_last_click_date    ? new Date(p.hs_email_last_click_date).getTime()    : 0,
          );
          const openTs = Math.max(
            p.hs_sales_email_last_opened ? new Date(p.hs_sales_email_last_opened).getTime() : 0,
            p.hs_email_last_open_date    ? new Date(p.hs_email_last_open_date).getTime()    : 0,
          );
          const replyTs = Math.max(salesReplyTs, mktReplyTs);

          let signalLabel = "No recent activity";
          if (replyTs > 0) signalLabel = "Replied";
          else if (clickTs > 0) signalLabel = "Clicked link";
          else if (openTs  > 0) signalLabel = "Opened";

          return {
            contactId:        c.id,
            contact:          info,
            sequenceId:       p.hs_latest_sequence_enrolled      || null,
            sequenceLabel:    p.hs_latest_sequence_enrolled
              ? `Sequence #${p.hs_latest_sequence_enrolled}`
              : "Unknown sequence",
            enrolledDate:     p.hs_latest_sequence_enrolled_date || null,
            signal:           signalLabel,
            lastEmailName:    p.hs_email_last_email_name         || null,
            url: `https://app.hubspot.com/contacts/39921549/record/0-1/${c.id}`,
          };
        });

        // ── Section 3: Due tasks (HubSpot tasks with date window) ─────────────
        const [upcomingTasksData, overdueTasksData] = await Promise.all([
          hsPost(user.userId, "/crm/v3/objects/tasks/search", {
            filterGroups: [{
              filters: [
                { propertyName: "hubspot_owner_id", operator: "EQ",     value: String(user.ownerId || "") },
                { propertyName: "hs_task_status",   operator: "NOT_IN", values: ["COMPLETED", "DEFERRED"] },
                { propertyName: "hs_timestamp",     operator: "GTE",    value: new Date(now).toISOString() },
                { propertyName: "hs_timestamp",     operator: "LTE",    value: windowEnd },
              ],
            }],
            properties: ["hs_task_subject","hs_task_status","hs_task_type","hs_timestamp","hs_task_priority","hs_task_body","hubspot_owner_id"],
            sorts:  [{ propertyName: "hs_timestamp", direction: "ASCENDING" }],
            limit:  200,
          }).catch(() => ({ results: [] })),

          hsPost(user.userId, "/crm/v3/objects/tasks/search", {
            filterGroups: [{
              filters: [
                { propertyName: "hubspot_owner_id", operator: "EQ",     value: String(user.ownerId || "") },
                { propertyName: "hs_task_status",   operator: "NOT_IN", values: ["COMPLETED", "DEFERRED"] },
                { propertyName: "hs_timestamp",     operator: "GTE",    value: overdueFrom },
                { propertyName: "hs_timestamp",     operator: "LT",     value: new Date(now).toISOString() },
              ],
            }],
            properties: ["hs_task_subject","hs_task_status","hs_task_type","hs_timestamp","hs_task_priority","hs_task_body","hubspot_owner_id"],
            sorts:  [{ propertyName: "hs_timestamp", direction: "ASCENDING" }],
            limit:  200,
          }).catch(() => ({ results: [] })),
        ]);

        const normalizeTask = (t, overdue = false) => ({
          id:       t.id,
          subject:  t.properties?.hs_task_subject  || "Untitled task",
          status:   t.properties?.hs_task_status   || "NOT_STARTED",
          type:     t.properties?.hs_task_type     || "TODO",
          dueDate:  t.properties?.hs_timestamp     || null,
          priority: t.properties?.hs_task_priority || "NONE",
          body:     t.properties?.hs_task_body     || null,
          overdue,
          url: `https://app.hubspot.com/tasks/39921549/view/all/task/${t.id}`,
        });

        const dueTasks = [
          ...(overdueTasksData.results  || []).map(t => normalizeTask(t, true)),
          ...(upcomingTasksData.results || []).map(t => normalizeTask(t, false)),
        ];

        return ok({
          repliesAwaitingResponse,
          upcomingSequences,
          dueTasks,
          meta: {
            days,
            counts: {
              repliesAwaitingResponse: repliesAwaitingResponse.length,
              upcomingSequences:       upcomingSequences.length,
              dueTasks:                dueTasks.length,
              overdueTasks:            (overdueTasksData.results || []).length,
            },
            filters: {
              assigned_bdr: qp.assigned_bdr || null,
              territory:    qp.territory    || null,
            },
          },
        });

      } catch (err) {
        console.error("[tasks] Error:", err.message);
        return error(500, `Tasks error: ${err.message}`);
      }
    }

    // ── Gold Accounts panel ───────────────────────────────────────────────────
    // Priority Tier - BDR lives on the COMPANY object, not contacts.
    // Actual enum values use dashes: "GOLD - 1-10", "GOLD - 11-20", etc.
    //
    // Strategy:
    //   1. Search companies where priority_tier__bdr is any GOLD value
    //   2. Filter by assigned_bdr on the company if provided
    //   3. Fetch associated contacts for each company (up to 3 per company)
    //   4. Merge company tier + signal data from associated contacts
    //
    // Query params:
    //   assigned_bdr=Chris+Knapp   (filters companies by their assigned BDR)
    //   limit=N                    (default: 100 companies, max: 200)
    if (method === "GET" && path === "/gold") {
      try {
        const limit = Math.min(parseInt(qp.limit || "100", 10), 200);

        // Actual enum values from HubSpot -- dashes between GOLD and range
        const GOLD_TIERS = [
          "GOLD - 1-10","GOLD - 11-20","GOLD - 21-30","GOLD - 31-40","GOLD - 41-50",
          "GOLD - 51-60","GOLD - 61-70","GOLD - 71-80","GOLD - 81-90","GOLD - 91-100",
        ];

        const companyFilters = [
          { propertyName: "priority_tier__bdr", operator: "IN", values: GOLD_TIERS },
        ];
        if (qp.assigned_bdr) {
          companyFilters.push({
            propertyName: "assigned_bdr",
            operator:     "EQ",
            value:        decodeURIComponent(qp.assigned_bdr).trim(),
          });
        }

        // Paginate through Gold companies
        let goldCompanies = [];
        let after = undefined;
        while (goldCompanies.length < limit) {
          const body = {
            filterGroups: [{ filters: companyFilters }],
            properties: [
              "name", "domain", "industry", "assigned_bdr", "territory",
              "priority_tier__bdr", "target_account__bdr_led_outreach",
              "notes_last_contacted", "hs_last_sales_activity_timestamp",
            ],
            sorts:  [{ propertyName: "priority_tier__bdr", direction: "ASCENDING" }],
            limit:  100,
          };
          if (after) body.after = after;
          const data = await hsPost(user.userId, "/crm/v3/objects/companies/search", body);
          goldCompanies.push(...(data.results || []));
          if (!data.paging?.next?.after || (data.results || []).length < 100) break;
          after = data.paging.next.after;
        }

        if (goldCompanies.length === 0) {
          return ok({ accounts: [], meta: { total: 0, byTier: {}, filters: { assigned_bdr: qp.assigned_bdr || null } } });
        }

        // Fetch contacts via batch associations API.
        // POST /crm/v3/associations/companies/contacts/batch/read takes up to 100 company IDs
        // and returns all associated contact IDs -- 1 call instead of 68.
        // Then one batch contact read for all contact IDs -- 2 total API calls.
        const CONTACT_PROPS = [
          "firstname","lastname","email","jobtitle","company","assigned_bdr",
          "hs_email_last_open_date","hs_email_last_click_date",
          "hs_email_last_reply_date","hs_email_last_send_date","hs_email_last_email_name",
          "hs_sales_email_last_opened","hs_sales_email_last_clicked","hs_sales_email_last_replied",
          "notes_last_contacted",
        ];

        const bdrFilterValue = qp.assigned_bdr
          ? decodeURIComponent(qp.assigned_bdr).trim()
          : null;

        const contactsByCompany = {};
        try {
          // Step 1: batch fetch all associations for all Gold companies at once
          const companyIds = goldCompanies.map(c => c.id);
          const assocData  = await hsPost(user.userId, "/crm/v3/associations/companies/contacts/batch/read", {
            inputs: companyIds.map(id => ({ id })),
          });

          // Build map: companyId -> [contactId, ...]
          const companyContactIds = {};
          for (const result of (assocData.results || [])) {
            const companyId  = result.from?.id;
            const contactIds = (result.to || []).map(t => t.id).slice(0, 5);
            if (companyId && contactIds.length > 0) {
              companyContactIds[companyId] = contactIds;
            }
          }

          // Step 2: collect all unique contact IDs across all companies
          const allContactIds = [...new Set(Object.values(companyContactIds).flat())];
          if (allContactIds.length === 0) {
            console.log("[gold] no associated contacts found");
          } else {
            // Step 3: batch read all contacts at once (up to 100 per batch)
            const allContacts = {};
            for (let i = 0; i < allContactIds.length; i += 100) {
              const batchIds = allContactIds.slice(i, i + 100);
              const batchData = await hsPost(user.userId, "/crm/v3/objects/contacts/batch/read", {
                properties: CONTACT_PROPS,
                inputs:     batchIds.map(id => ({ id })),
              });
              for (const c of (batchData.results || [])) {
                allContacts[c.id] = c;
              }
              if (i + 100 < allContactIds.length) {
                await new Promise(r => setTimeout(r, 150));
              }
            }

            // Assign contacts back to companies, optionally filtering by BDR
            for (const [companyId, contactIds] of Object.entries(companyContactIds)) {
              const contacts = contactIds
                .map(id => allContacts[id])
                .filter(c => {
                  if (!c) return false;
                  if (bdrFilterValue) {
                    return c.properties?.assigned_bdr === bdrFilterValue;
                  }
                  return true; // no BDR filter -- include all contacts
                });
              if (contacts.length > 0) {
                contactsByCompany[companyId] = contacts;
              }
            }
            console.log(`[gold] matched contacts to ${Object.keys(contactsByCompany).length} of ${goldCompanies.length} companies`);
          }
        } catch (err) {
          console.error("[gold] contact fetch failed:", err.message);
          // Continue -- companies will show without contact detail
        }

        // Extract leading number from tier for numeric sort
        // "GOLD - 1-10" -> 1, "GOLD - 11-20" -> 11
        const tierRank = (tier) => {
          const match = (tier || "").match(/(\d+)/);
          return match ? parseInt(match[1], 10) : 999;
        };

        // Best signal across a company's contacts
        const companySignal = (contacts) => {
          let bestReplyTs = 0, bestClickTs = 0, bestOpenTs = 0;
          for (const c of contacts) {
            const p = c.properties || {};
            bestReplyTs = Math.max(bestReplyTs,
              p.hs_email_last_reply_date    ? new Date(p.hs_email_last_reply_date).getTime()    : 0,
              p.hs_sales_email_last_replied ? new Date(p.hs_sales_email_last_replied).getTime() : 0,
            );
            bestClickTs = Math.max(bestClickTs,
              p.hs_email_last_click_date    ? new Date(p.hs_email_last_click_date).getTime()    : 0,
              p.hs_sales_email_last_clicked ? new Date(p.hs_sales_email_last_clicked).getTime() : 0,
            );
            bestOpenTs = Math.max(bestOpenTs,
              p.hs_email_last_open_date    ? new Date(p.hs_email_last_open_date).getTime()    : 0,
              p.hs_sales_email_last_opened ? new Date(p.hs_sales_email_last_opened).getTime() : 0,
            );
          }
          if (bestReplyTs > 0) return { status:"replied", timestamp: new Date(bestReplyTs).toISOString(), label:"Replied" };
          if (bestClickTs > 0) return { status:"clicked", timestamp: new Date(bestClickTs).toISOString(), label:"Clicked" };
          if (bestOpenTs  > 0) return { status:"opened",  timestamp: new Date(bestOpenTs).toISOString(),  label:"Opened"  };
          return                      { status:"no_signal", timestamp: null, label:"No recent activity" };
        };

        const normalized = goldCompanies.map(company => {
          const p        = company.properties || {};
          const contacts = contactsByCompany[company.id] || [];
          const tier     = p.priority_tier__bdr || "";
          const signal   = companySignal(contacts);

          // Last sent: most recent send date across all contacts (no time window)
          let lastSentTs = 0, lastSentName = null, lastSentContact = null;
          for (const c of contacts) {
            const cp = c.properties || {};
            const ts = cp.hs_email_last_send_date ? new Date(cp.hs_email_last_send_date).getTime() : 0;
            if (ts > lastSentTs) {
              lastSentTs      = ts;
              lastSentName    = cp.hs_email_last_email_name || null;
              lastSentContact = `${cp.firstname||""} ${cp.lastname||""}`.trim();
            }
          }

          // Best engagement across all contacts (most recent reply > click > open)
          let lastEngagement = null;
          for (const c of contacts) {
            const cp = c.properties || {};
            const replyTs = Math.max(
              cp.hs_email_last_reply_date    ? new Date(cp.hs_email_last_reply_date).getTime()    : 0,
              cp.hs_sales_email_last_replied ? new Date(cp.hs_sales_email_last_replied).getTime() : 0,
            );
            const clickTs = Math.max(
              cp.hs_email_last_click_date    ? new Date(cp.hs_email_last_click_date).getTime()    : 0,
              cp.hs_sales_email_last_clicked ? new Date(cp.hs_sales_email_last_clicked).getTime() : 0,
            );
            const openTs = Math.max(
              cp.hs_email_last_open_date    ? new Date(cp.hs_email_last_open_date).getTime()    : 0,
              cp.hs_sales_email_last_opened ? new Date(cp.hs_sales_email_last_opened).getTime() : 0,
            );
            const contactName = `${cp.firstname||""} ${cp.lastname||""}`.trim();
            const best = replyTs > 0
              ? { type:"replied",  ts: replyTs,  label:"Replied",      date: new Date(replyTs).toISOString(),  contact: contactName }
              : clickTs > 0
              ? { type:"clicked",  ts: clickTs,  label:"Clicked link", date: new Date(clickTs).toISOString(),  contact: contactName }
              : openTs  > 0
              ? { type:"opened",   ts: openTs,   label:"Opened",       date: new Date(openTs).toISOString(),   contact: contactName }
              : null;
            if (best && (!lastEngagement || best.ts > lastEngagement.ts)) {
              lastEngagement = best;
            }
          }

          const allDates = [
            p.notes_last_contacted,
            p.hs_last_sales_activity_timestamp,
            lastSentTs > 0 ? new Date(lastSentTs).toISOString() : null,
            lastEngagement?.date,
          ].filter(Boolean).map(d => new Date(d).getTime());
          const lastActivityTs   = allDates.length > 0 ? Math.max(...allDates) : 0;
          const lastActivityDate = lastActivityTs > 0 ? new Date(lastActivityTs).toISOString() : null;

          return {
            id:              company.id,
            name:            p.name       || "",
            domain:          p.domain     || "",
            industry:        p.industry   || "",
            tier,
            tierRank:        tierRank(tier),
            assignedBdr:     p.assigned_bdr || "",
            territory:       p.territory    || "",
            lastActivityDate,
            signal,
            // Last send across all contacts
            lastSent: lastSentTs > 0 ? {
              date:    new Date(lastSentTs).toISOString(),
              subject: lastSentName,
              contact: lastSentContact,
            } : null,
            // Best engagement across all contacts (no time window)
            lastEngagement,
            contacts: contacts.map(c => {
              const cp = c.properties || {};
              return {
                id:       c.id,
                name:     `${cp.firstname||""} ${cp.lastname||""}`.trim(),
                title:    cp.jobtitle || "",
                email:    cp.email    || "",
                lastSent: cp.hs_email_last_send_date || null,
                lastOpen: cp.hs_email_last_open_date || cp.hs_sales_email_last_opened || null,
                lastReply:cp.hs_email_last_reply_date || cp.hs_sales_email_last_replied || null,
                lastClick:cp.hs_email_last_click_date || cp.hs_sales_email_last_clicked || null,
                emailName:cp.hs_email_last_email_name || null,
                url:      `https://app.hubspot.com/contacts/39921549/record/0-1/${c.id}`,
              };
            }),
            url: `https://app.hubspot.com/companies/39921549/company/${company.id}`,
          };
        });

        // Sort: tier rank ascending (GOLD - 1-10 first), then most recent activity
        normalized.sort((a, b) => {
          if (a.tierRank !== b.tierRank) return a.tierRank - b.tierRank;
          const dateA = a.lastActivityDate ? new Date(a.lastActivityDate).getTime() : 0;
          const dateB = b.lastActivityDate ? new Date(b.lastActivityDate).getTime() : 0;
          return dateB - dateA;
        });

        const byTier = {};
        normalized.forEach(c => { byTier[c.tier] = (byTier[c.tier] || 0) + 1; });

        return ok({
          accounts: normalized,
          meta: {
            total: normalized.length,
            byTier,
            filters: { assigned_bdr: qp.assigned_bdr || null },
          },
        });
      } catch (err) {
        console.error("[gold] Error:", err.message);
        return error(500, `Gold accounts error: ${err.message}`);
      }
    }

    // ── Activity summary ──────────────────────────────────────────────────────
    // Returns outbound + inbound activity counts for a rolling date window.
    //
    // Query params:
    //   days=7|14|30|90         (default: 7)
    //   rep=Chris+Knapp|all     (default: "all" -- filter by assigned_bdr name, or all reps)
    //   include_owned=true      (optional -- also count contacts owned via hubspot_owner_id,
    //                            useful for AEs who want to see both BDR outreach + their own)
    //
    // Counts use assigned_bdr property (not hubspot_owner_id) because BDRs do outreach
    // on behalf of AEs. hubspot_owner_id typically maps to the AE, not the BDR.
    // Setting include_owned=true adds a second pass using hubspot_owner_id for AE views.
    if (method === "GET" && path === "/activity") {
      try {
        const days  = [7, 14, 30, 90].includes(parseInt(qp.days, 10))
          ? parseInt(qp.days, 10)
          : 7;
        const since    = Date.now() - days * 24 * 60 * 60 * 1000;
        const sinceISO = new Date(since).toISOString();
        const includeOwned = qp.include_owned === "true";

        // rep param: "all" = both BDRs, anything else = filter to that rep's assigned_bdr value
        const repFilter = qp.rep && qp.rep !== "all"
          ? decodeURIComponent(qp.rep).trim()
          : null;

        // Known BDR names -- these are the only values used in the assigned_bdr property.
        // We hardcode these rather than fetching all 25 HubSpot owners (most of which
        // have zero contacts with their name as assigned_bdr, causing 25x unnecessary API calls).
        const KNOWN_BDRS = ["Chris Knapp", "Chiara Pate"];
        const targetReps = repFilter ? [repFilter] : KNOWN_BDRS;

        // Count contacts where assigned_bdr = repName AND dateProp >= since
        async function countByBdr(dateProp, repName) {
          try {
            const data = await hsPost(user.userId, "/crm/v3/objects/contacts/search", {
              filterGroups: [{
                filters: [
                  { propertyName: "assigned_bdr", operator: "EQ",  value: repName },
                  { propertyName: dateProp,        operator: "GTE", value: sinceISO },
                ],
              }],
              properties: ["assigned_bdr"],
              limit: 1,
            });
            return data.total || 0;
          } catch (err) {
            console.error(`[activity] countByBdr ${dateProp} ${repName}:`, err.message);
            return 0;
          }
        }

        // Count contacts where EITHER prop >= since AND assigned_bdr = repName (OR filter groups)
        async function countEitherByBdr(propA, propB, repName) {
          try {
            const data = await hsPost(user.userId, "/crm/v3/objects/contacts/search", {
              filterGroups: [
                { filters: [
                  { propertyName: "assigned_bdr", operator: "EQ",  value: repName },
                  { propertyName: propA,           operator: "GTE", value: sinceISO },
                ]},
                { filters: [
                  { propertyName: "assigned_bdr", operator: "EQ",  value: repName },
                  { propertyName: propB,           operator: "GTE", value: sinceISO },
                ]},
              ],
              properties: ["assigned_bdr"],
              limit: 1,
            });
            return data.total || 0;
          } catch (err) {
            console.error(`[activity] countEitherByBdr ${propA}/${propB} ${repName}:`, err.message);
            return 0;
          }
        }

        // AE view: count by hubspot_owner_id (for include_owned mode)
        async function countByOwnerId(dateProp, ownerId) {
          try {
            const data = await hsPost(user.userId, "/crm/v3/objects/contacts/search", {
              filterGroups: [{
                filters: [
                  { propertyName: "hubspot_owner_id", operator: "EQ",  value: String(ownerId) },
                  { propertyName: dateProp,            operator: "GTE", value: sinceISO },
                ],
              }],
              properties: ["hubspot_owner_id"],
              limit: 1,
            });
            return data.total || 0;
          } catch { return 0; }
        }

        // Run counts sequentially per rep to avoid rate limits.
        // 2 reps × 5 queries each = 10 total -- sequential is fine here.
        const repResults = [];
        for (const repName of targetReps) {
          const [emailsSent, sequencesStarted, replies, clicks, opens] = await Promise.all([
            countEitherByBdr("hs_email_last_send_date", "hs_last_sales_activity_timestamp", repName),
            countByBdr("hs_latest_sequence_enrolled_date", repName),
            countEitherByBdr("hs_email_last_reply_date", "hs_sales_email_last_replied", repName),
            countEitherByBdr("hs_email_last_click_date", "hs_sales_email_last_clicked", repName),
            countEitherByBdr("hs_email_last_open_date",  "hs_sales_email_last_opened",  repName),
          ]);
          console.log(`[activity] rep=${repName} emailsSent=${emailsSent} sequences=${sequencesStarted} replies=${replies} clicks=${clicks} opens=${opens}`);
          repResults.push({ repName, emailsSent, sequencesStarted, replies, clicks, opens });
          await new Promise(r => setTimeout(r, 200)); // gap between reps
        }

        // Optional AE pass: also count by hubspot_owner_id
        let ownedCounts = { emailsSent:0, replies:0, clicks:0, opens:0 };
        if (includeOwned) {
          try {
            // Look up the current user's HubSpot owner ID
            const meData = await hsGet(user.userId, "/crm/v3/owners/me", {}).catch(() => null);
            if (meData?.id) {
              const [oSent, oReplies, oClicks, oOpens] = await Promise.all([
                countByOwnerId("hs_email_last_send_date",     meData.id),
                countByOwnerId("hs_sales_email_last_replied", meData.id),
                countByOwnerId("hs_sales_email_last_clicked", meData.id),
                countByOwnerId("hs_sales_email_last_opened",  meData.id),
              ]);
              ownedCounts = { emailsSent: oSent, replies: oReplies, clicks: oClicks, opens: oOpens };
            }
          } catch { /* fall through */ }
        }

        // Engagements: calls, meetings, notes -- filter by owner name where possible
        const engTotals = { calls: 0, meetings: 0, notes: 0 };
        const engByRep  = {};
        targetReps.forEach(r => { engByRep[r] = { calls:0, meetings:0, notes:0 }; });

        try {
          let hasMore = true;
          let offset  = 0;
          while (hasMore && offset < 2000) {
            const engData = await hsGet(user.userId, "/engagements/v1/engagements/paged", {
              limit: 250, offset, since,
            }).catch(() => ({ results: [], hasMore: false }));

            for (const eng of (engData.results || [])) {
              const ts   = eng.engagement?.createdAt || 0;
              const type = eng.engagement?.type || "";
              if (ts < since) continue;

              // Match engagements to reps via the associated contact's assigned_bdr if available
              // For now count all engagements if scope is all, or skip if rep-filtered
              // (engagement owner ID doesn't reliably map to BDR)
              if (repFilter) {
                // Can't reliably filter engagements by BDR name -- include all and note limitation
              }
              const bucket = engByRep[repFilter || targetReps[0]] || (engByRep[targetReps[0]] = { calls:0, meetings:0, notes:0 });
              if (type === "CALL")    { engTotals.calls++;    bucket.calls++;    }
              if (type === "MEETING") { engTotals.meetings++; bucket.meetings++; }
              if (type === "NOTE")    { engTotals.notes++;    bucket.notes++;    }
            }

            hasMore = engData.hasMore && (engData.results || []).length === 250;
            offset += (engData.results || []).length;
          }
        } catch { /* fall through */ }

        // Sum totals
        const totals = repResults.reduce((acc, r) => {
          acc.emailsSent       += r.emailsSent;
          acc.sequencesStarted += r.sequencesStarted;
          acc.replies          += r.replies;
          acc.clicks           += r.clicks;
          acc.opens            += r.opens;
          return acc;
        }, { emailsSent:0, sequencesStarted:0, replies:0, clicks:0, opens:0 });

        const summary = {
          outbound: {
            emailsSent:       totals.emailsSent       + (includeOwned ? ownedCounts.emailsSent : 0),
            sequencesStarted: totals.sequencesStarted,
            callsLogged:      engTotals.calls,
            meetingsLogged:   engTotals.meetings,
            notesLogged:      engTotals.notes,
          },
          inbound: {
            repliesReceived: totals.replies + (includeOwned ? ownedCounts.replies : 0),
            linksClicked:    totals.clicks  + (includeOwned ? ownedCounts.clicks  : 0),
            emailsOpened:    totals.opens   + (includeOwned ? ownedCounts.opens   : 0),
          },
        };

        // Per-rep breakdown
        const byRep = Object.fromEntries(repResults.map(r => [r.repName, {
          outbound: {
            emailsSent:       r.emailsSent,
            sequencesStarted: r.sequencesStarted,
            callsLogged:      engByRep[r.repName]?.calls    || 0,
            meetingsLogged:   engByRep[r.repName]?.meetings || 0,
            notesLogged:      engByRep[r.repName]?.notes    || 0,
          },
          inbound: {
            repliesReceived: r.replies,
            linksClicked:    r.clicks,
            emailsOpened:    r.opens,
          },
        }]));

        return ok({
          summary,
          byRep: targetReps.length > 1 ? byRep : null,
          meta: {
            days,
            rep:          repFilter || "all",
            since:        sinceISO,
            includeOwned,
            note: "Counts = unique contacts touched via assigned_bdr, not raw send volume.",
          },
        });

      } catch (err) {
        console.error("[activity] Error:", err.message);
        return error(500, `Activity error: ${err.message}`);
      }
    }

    // ── Real-time signals (last 15 minutes) ──────────────────────────────────
    // Lightweight polling endpoint. Fetches the last 15 min of email open/click
    // events from /email/public/v1/events. Safe at high volume because the time
    // window is tiny -- only events since the last poll, not the full history.
    //
    // The frontend calls this every 3 minutes and merges new signals into the feed.
    // Bot detection runs the same logic as /signals so new items are already scored.
    //
    // Query params:
    //   since=<ISO>   (optional -- override the 15-min window for a custom lookback)
    //   assigned_bdr= (optional -- filter to a specific rep after enrichment)
    if (method === "GET" && path === "/signals/recent") {
      try {
        const windowMs  = 15 * 60 * 1000; // 15 minutes
        const sinceMs   = qp.since
          ? new Date(qp.since).getTime()
          : Date.now() - windowMs;
        const sinceISO  = new Date(sinceMs).toISOString();
        const bdrFilter = qp.assigned_bdr
          ? decodeURIComponent(qp.assigned_bdr).trim()
          : null;

        // Fetch raw email events -- tiny window so no 504 risk
        const eventsData = await hsGet(user.userId, "/email/public/v1/events", {
          startTimestamp: sinceMs,
          limit: 100,
        }).catch(() => ({ events: [] }));

        const rawEvents = (eventsData.events || [])
          .filter(ev => ["OPEN","CLICK","REPLY"].includes(ev.type));

        if (rawEvents.length === 0) {
          return ok({ signals: [], meta: { since: sinceISO, count: 0 } });
        }

        // Enrich with contact data to apply assigned_bdr filter
        const contactIds = [...new Set(
          rawEvents.map(ev => ev.contactId ? String(ev.contactId) : null).filter(Boolean)
        )];

        const contactMap = {};
        if (contactIds.length > 0) {
          try {
            const batch = await hsPost(user.userId, "/crm/v3/objects/contacts/batch/read", {
              properties: BASE_CONTACT_PROPS,
              inputs:     contactIds.map(id => ({ id })),
            });
            (batch.results || []).forEach(c => {
              const info = normalizeContact(c);
              contactMap[c.id] = info;
            });
          } catch { /* enrichment best-effort */ }
        }

        const signals = rawEvents
          .map(ev => {
            const contactId = ev.contactId ? String(ev.contactId) : null;
            const contact   = contactId ? (contactMap[contactId] || null) : null;

            // Apply BDR filter if specified
            if (bdrFilter && contact?.assignedBdr !== bdrFilter) return null;

            const eventType = ev.type;
            let score = 0, label = "";
            if (eventType === "REPLY")  { score = 100; label = "Replied"; }
            else if (eventType === "CLICK") { score = 70;  label = "Clicked link"; }
            else if (eventType === "OPEN")  { score = 40;  label = "Opened"; }

            const botCheck = detectBot({
              filteredEvent: false,
              sentAt:    null, // raw events don't have sent timestamp
              openedAt:  eventType === "OPEN"  ? ev.created : null,
              numOpens:  eventType === "OPEN"  ? 1 : 0,
              numClicks: eventType === "CLICK" ? 1 : 0,
              replied:   eventType === "REPLY",
            });

            return {
              source:         "realtime_event",
              id:             `rt-${ev.id || ev.created}`,
              type:           eventType,
              emailSource:    "marketing",
              timestamp:      ev.created || null,
              score,
              label,
              contactId,
              contact,
              botCheck,
              isBot:          botCheck.isBot && eventType === "OPEN",
              subject:        ev.emailCampaignGroupName || ev.appName || null,
              campaignId:     ev.emailCampaignId ? String(ev.emailCampaignId) : null,
              openedAt:       eventType === "OPEN"  ? ev.created : null,
              clickedAt:      eventType === "CLICK" ? ev.created : null,
              repliedAt:      eventType === "REPLY" ? ev.created : null,
              sentAt:         null,
              url:            ev.url || null,
            };
          })
          .filter(Boolean)
          .filter(s => !s.isBot) // filter bots before sending to client
          .sort((a, b) => b.score - a.score || new Date(b.timestamp||0) - new Date(a.timestamp||0));

        return ok({
          signals,
          meta: {
            since:   sinceISO,
            count:   signals.length,
            rawCount: rawEvents.length,
          },
        });
      } catch (err) {
        console.error("[signals/recent] Error:", err.message);
        return error(500, `Recent signals error: ${err.message}`);
      }
    }

    if (method === "GET" && path === "/signals") {
      try {
      const hours       = Math.min(parseInt(qp.hours || "2880", 10), 2880);
      const since       = Date.now() - hours * 60 * 60 * 1000;
      const sinceISO    = new Date(since).toISOString();
      const includeBots = qp.includeBots === "true";

      // Tiered pagination for high-volume accuracy without blocking first render.
      // Frontend calls with offset=0 first (fast), then offset=100 in the background.
      // Each tier fetches 100 per prop * 5 props = up to 500 contacts before dedup.
      // Two tiers = up to 1,000 unique contacts total.
      //
      // Usage:
      //   GET /signals              -> tier 1 (offset 0, returns hasMore flag)
      //   GET /signals?offset=100   -> tier 2 (background fetch, merge into feed)
      const pageOffset  = Math.max(0, parseInt(qp.offset || "0", 10));
      const perPropLimit = 100; // per date-prop per page

      // Build filter groups -- use OR logic across multiple date properties
      // so we catch contacts active via marketing emails, sequences, AND 1:1 sales emails.
      // HubSpot sequences update hs_last_sales_activity_timestamp, not hs_last_sales_activity_timestamp.
      // Marketing emails update hs_email_last_send_date.
      // Sales / 1:1 emails update hs_sales_email_last_opened / clicked / replied.
      // We run one search per date property and merge results.
      const customFilters = buildCustomFilters(qp);

      const activityDateProps = [
        "hs_email_last_send_date",         // marketing + sequence sends
        "hs_email_last_open_date",         // marketing email opens
        "hs_email_last_click_date",        // marketing email clicks
        "hs_last_sales_activity_timestamp",// sequence steps, calls, meetings (valid property)
        "hs_sales_email_last_opened",      // 1:1 sales email opens
        "hs_sales_email_last_replied",     // 1:1 sales email replies
      ];

      // Run searches SEQUENTIALLY with 150ms gaps to avoid HubSpot's per-second rate limit.
      // 7 parallel searches = 7 API calls instantly = guaranteed 429 at our volume.
      // Sequential with small gaps keeps us well within limits.
      const searchResults = [];
      for (const prop of activityDateProps) {
        try {
          const result = await hsPost(user.userId, "/crm/v3/objects/contacts/search", {
            filterGroups: [{ filters: [
              { propertyName: prop, operator: "GTE", value: sinceISO },
              ...customFilters,
            ]}],
            properties: BASE_CONTACT_PROPS,
            sorts:      [{ propertyName: prop, direction: "DESCENDING" }],
            limit:      perPropLimit,
          });
          searchResults.push({ ...result, _prop: prop });
          console.log(`[signals] prop=${prop} returned=${(result.results||[]).length} total=${result.total||0} filters=${JSON.stringify(customFilters)}`);
        } catch (err) {
          console.error(`[signals] search failed for prop ${prop}:`, err.message);
          searchResults.push({ results: [], total: 0, _prop: prop });
        }
        await new Promise(r => setTimeout(r, 150));
      }

      // Merge and deduplicate across all three searches
      const seenIds = new Set();
      const allContactResults = [];
      for (const result of searchResults) {
        for (const c of (result.results || [])) {
          if (!seenIds.has(c.id)) {
            seenIds.add(c.id);
            allContactResults.push(c);
          }
        }
      }

      // Sort merged results by most recent activity across all date props
      allContactResults.sort((a, b) => {
        const dateA = Math.max(
          new Date(a.properties?.hs_email_last_send_date           || 0).getTime(),
          new Date(a.properties?.hs_email_last_open_date           || 0).getTime(),
          new Date(a.properties?.hs_last_sales_activity_timestamp  || 0).getTime(),
          new Date(a.properties?.hs_sales_email_last_opened        || 0).getTime(),
          new Date(a.properties?.hs_sales_email_last_replied       || 0).getTime(),
        );
        const dateB = Math.max(
          new Date(b.properties?.hs_email_last_send_date           || 0).getTime(),
          new Date(b.properties?.hs_email_last_open_date           || 0).getTime(),
          new Date(b.properties?.hs_last_sales_activity_timestamp  || 0).getTime(),
          new Date(b.properties?.hs_sales_email_last_opened        || 0).getTime(),
          new Date(b.properties?.hs_sales_email_last_replied       || 0).getTime(),
        );
        return dateB - dateA;
      });

      const recentContactsData = { results: allContactResults };

      // Fetch engagement fallback only -- marketing email events API is too slow at volume
      // Contact property timestamps already capture marketing email activity reliably
      const engData = await hsGet(user.userId, "/engagements/v1/engagements/paged", {
        limit: 100,
        since,
      }).catch(() => ({ results: [] }));

      const marketingEventsData = []; // removed -- causes 504 at high volume

      // Build contact map with full normalized data including custom properties
      const contactMap = {};
      (recentContactsData.results || []).forEach(c => {
        const info = normalizeContact(c);
        contactMap[c.id] = info;
        if (info.email) contactMap[info.email] = info;
      });

      // Build signals from contact properties (covers both marketing and sales email types)
      const contactSignals = (recentContactsData.results || []).map(c => {
        const p    = c.properties || {};
        const info = contactMap[c.id];

        // Marketing email timestamps
        const mktReplyTs = p.hs_email_last_reply_date  ? new Date(p.hs_email_last_reply_date).getTime()  : 0;
        const mktClickTs = p.hs_email_last_click_date  ? new Date(p.hs_email_last_click_date).getTime()  : 0;
        const mktOpenTs  = p.hs_email_last_open_date   ? new Date(p.hs_email_last_open_date).getTime()   : 0;
        const mktSendTs  = p.hs_email_last_send_date   ? new Date(p.hs_email_last_send_date).getTime()   : 0;

        // Sales / 1:1 email timestamps
        const salesReplyTs  = p.hs_sales_email_last_replied ? new Date(p.hs_sales_email_last_replied).getTime() : 0;
        const salesClickTs  = p.hs_sales_email_last_clicked ? new Date(p.hs_sales_email_last_clicked).getTime() : 0;
        const salesOpenTs   = p.hs_sales_email_last_opened  ? new Date(p.hs_sales_email_last_opened).getTime()  : 0;

        // Best signal across both email types (most recent wins)
        const replyTs = Math.max(mktReplyTs, salesReplyTs);
        const clickTs = Math.max(mktClickTs, salesClickTs);
        const openTs  = Math.max(mktOpenTs,  salesOpenTs);

        // Which source is driving the top signal?
        const replySource = replyTs > 0 ? (salesReplyTs >= mktReplyTs ? "sales" : "marketing") : null;
        const clickSource = clickTs > 0 ? (salesClickTs >= mktClickTs ? "sales" : "marketing") : null;
        const openSource  = openTs  > 0 ? (salesOpenTs  >= mktOpenTs  ? "sales" : "marketing") : null;

        let score = 0, label = "", primaryTs = null, eventType = "OPEN", emailSource = null;

        if (replyTs > 0 && replyTs >= since) {
          score = 100; label = "Replied"; eventType = "REPLY"; emailSource = replySource;
          primaryTs = replySource === "sales" ? p.hs_sales_email_last_replied : p.hs_email_last_reply_date;
        } else if (clickTs > 0 && clickTs >= since) {
          score = 70; label = "Clicked link"; eventType = "CLICK"; emailSource = clickSource;
          primaryTs = clickSource === "sales" ? p.hs_sales_email_last_clicked : p.hs_email_last_click_date;
        } else if (openTs > 0 && openTs >= since) {
          score = 40; label = "Opened"; eventType = "OPEN"; emailSource = openSource;
          primaryTs = openSource === "sales" ? p.hs_sales_email_last_opened : p.hs_email_last_open_date;
        } else {
          return null;
        }

        // Build unified event chain in chronological order across both email types
        const eventChain = [];
        if (mktSendTs > 0)    eventChain.push({ type:"SENT",       timestamp: p.hs_email_last_send_date,      label:"Sent (marketing)",   source:"marketing" });
        if (mktOpenTs > 0)    eventChain.push({ type:"OPENED",     timestamp: p.hs_email_last_open_date,      label:"Opened (marketing)", source:"marketing" });
        if (mktClickTs > 0)   eventChain.push({ type:"CLICKED",    timestamp: p.hs_email_last_click_date,     label:"Clicked (marketing)",source:"marketing" });
        if (mktReplyTs > 0)   eventChain.push({ type:"REPLIED",    timestamp: p.hs_email_last_reply_date,     label:"Replied (marketing)",source:"marketing" });
        if (salesOpenTs > 0)  eventChain.push({ type:"OPENED",     timestamp: p.hs_sales_email_last_opened,   label:"Opened (sales)",     source:"sales" });
        if (salesClickTs > 0) eventChain.push({ type:"CLICKED",    timestamp: p.hs_sales_email_last_clicked,  label:"Clicked (sales)",    source:"sales" });
        if (salesReplyTs > 0) eventChain.push({ type:"REPLIED",    timestamp: p.hs_sales_email_last_replied,  label:"Replied (sales)",    source:"sales" });
        eventChain.sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));

        // Use whichever open/send timestamps are available for bot detection
        const botOpenTs = openSource === "sales" ? salesOpenTs : mktOpenTs;

        // For contact-property signals, we only have the most recent event timestamps,
        // not full open/click history. Disable soft signals that require history context
        // (no-click and burst-pattern checks) -- they produce false positives here.
        // Only use time-to-open and HubSpot's own filteredEvent flag.
        const botCheck = detectBot({
          filteredEvent: false,
          sentAt:    mktSendTs || null,
          openedAt:  botOpenTs || null,
          numOpens:  0,   // set to 0 to disable history-based checks
          numClicks: clickTs > 0 ? 1 : 0,
          replied:   replyTs > 0,
        });

        // Sequence subject: hs_sequence_name does not exist on contacts.
        // Show the email name for marketing sends; sequence ID is a fallback only.
        const subjectLabel = p.hs_email_last_email_name
          || (p.hs_latest_sequence_enrolled ? `Sequence #${p.hs_latest_sequence_enrolled}` : null);

        return {
          source:      "contact_activity",
          id:          `ca-${c.id}`,
          type:        eventType,
          emailSource,                   // "marketing" | "sales" -- which system drove this signal
          timestamp:   primaryTs,
          score,
          label,
          eventChain,
          contactId:   c.id,
          contact:     info,
          botCheck,
          isBot:       botCheck.isBot && eventType === "OPEN",
          subject:     subjectLabel,
          sentAt:      p.hs_email_last_send_date        || null,
          openedAt:    primaryTs && eventType === "OPEN"   ? primaryTs : null,
          clickedAt:   primaryTs && eventType === "CLICK"  ? primaryTs : null,
          repliedAt:   primaryTs && eventType === "REPLY"  ? primaryTs : null,
        };
      }).filter(Boolean);

      // Supplement with engagements not already covered by contact search
      // (e.g. calls, meetings, notes which don't affect hs_last_sales_activity_timestamp)
      const existingIds = new Set(contactSignals.map(s => s.contactId));

      const engItems = (engData.results || [])
        .filter(eng => {
          const cid  = String(eng.associations?.contactIds?.[0] ?? "");
          const ts   = eng.engagement?.createdAt || 0;
          // Strictly enforce date range on engagements
          return cid && !existingIds.has(cid) && ts >= since;
        })
        .map(eng => {
          const typeLabel = { CALL:"Call logged", MEETING:"Meeting logged", NOTE:"Note logged", TASK:"Task" };
          const engType   = eng.engagement?.type || "UNKNOWN";
          return {
            source:        "engagement",
            id:            `eng-${eng.engagement?.id}`,
            type:          engType,
            timestamp:     eng.engagement?.createdAt || null,
            // Fix: never show raw type as subject -- use clean labels
            subject:       eng.metadata?.subject || typeLabel[engType] || engType,
            numOpens:      eng.metadata?.numOpens  || 0,
            numClicks:     eng.metadata?.numClicks || 0,
            replied:       eng.metadata?.replied   || false,
            filteredEvent: eng.metadata?.filteredEvent || false,
            sentAt:        eng.metadata?.sentAt   || null,
            openedAt:      eng.metadata?.openedAt || null,
            contactId:     String(eng.associations?.contactIds?.[0] ?? ""),
            eventChain:    [],
          };
        });

      // Marketing events: only include if contact not already in results
      const mktItems = marketingEventsData.filter(ev => {
        const key = ev.contactId || ev.recipientEmail;
        return key && !existingIds.has(key);
      });

      const { real: engReal, bots: engBots } = scoreAllSignals([...engItems, ...mktItems], includeBots);

      // Enrich engagement/marketing signals with contact info
      // including custom properties via batch read
      const unknownIds = [...new Set(
        [...engReal, ...engBots].map(s => s.contactId).filter(id => id && !contactMap[id])
      )];
      if (unknownIds.length > 0) {
        try {
          const batch = await hsPost(user.userId, "/crm/v3/objects/contacts/batch/read", {
            properties: BASE_CONTACT_PROPS,
            inputs:     unknownIds.map(id => ({ id })),
          });
          (batch.results || []).forEach(c => {
            const info = normalizeContact(c);
            contactMap[c.id] = info;
            if (info.email) contactMap[info.email] = info;
          });
        } catch { /* fail silently */ }
      }

      // Also look up marketing event contacts by email
      const unknownEmails = [...new Set(
        mktItems.map(s => s.recipientEmail).filter(e => e && !contactMap[e])
      )];
      if (unknownEmails.length > 0) {
        try {
          const batch = await hsPost(user.userId, "/crm/v3/objects/contacts/batch/read", {
            properties: BASE_CONTACT_PROPS,
            idProperty: "email",
            inputs:     unknownEmails.map(e => ({ id: e })),
          });
          (batch.results || []).forEach(c => {
            const info = normalizeContact(c);
            contactMap[c.id] = info;
            if (info.email) contactMap[info.email] = info;
          });
        } catch { /* fail silently */ }
      }

      const enrich = s => ({
        ...s,
        contact: s.contact || contactMap[s.contactId] || contactMap[s.recipientEmail] || null,
      });

      const allReal = [
        ...contactSignals.filter(s => !s.isBot),
        ...engReal.map(enrich),
      ].sort((a,b) => b.score - a.score || new Date(b.timestamp||0) - new Date(a.timestamp||0));

      const allBots = [
        ...contactSignals.filter(s => s.isBot),
        ...engBots.map(enrich),
      ];

      // ── Organizational bot detection ─────────────────────────────────────────
      // Groups open signals by email domain and flags clusters where 2+ contacts
      // from the same domain have nearly identical time-to-open or opened at
      // nearly the same clock time -- a strong indicator of a corporate email
      // security gateway scanning all inbound mail.
      //
      // Domain-based matching is more reliable than company name matching
      // since domains are always exact (no typos or variations).
      // Window: 5 minutes on either metric.

      const openSignals = allReal.filter(s =>
        (s.type === "OPEN" || s.eventType === "OPEN") && !s.replied && !s.clickedAt
      );

      // Build map: emailDomain -> array of { s, tto, openedMs }
      const domainOpenMap = {};
      openSignals.forEach(s => {
        const email = s.contact?.email || "";
        const domain = email.includes("@") ? email.split("@")[1].toLowerCase().trim() : null;
        // Skip generic free email providers
        const freeDomains = ["gmail.com","yahoo.com","hotmail.com","outlook.com","icloud.com","aol.com","protonmail.com"];
        if (!domain || freeDomains.includes(domain)) return;

        const sentMs   = s.sentAt   ? new Date(s.sentAt).getTime()   : null;
        const openedMs = s.openedAt ? new Date(s.openedAt).getTime() : null;
        if (!sentMs || !openedMs || openedMs < sentMs) return;

        const tto = openedMs - sentMs;
        if (!domainOpenMap[domain]) domainOpenMap[domain] = [];
        domainOpenMap[domain].push({ s, tto, openedMs, domain });
      });

      // Flag any domain where 2+ contacts opened within 5 minutes of each other
      // (by tto similarity OR by absolute open time)
      const orgBotContactIds = new Set();
      Object.entries(domainOpenMap).forEach(([domain, entries]) => {
        if (entries.length < 2) return;
        for (let i = 0; i < entries.length; i++) {
          for (let j = i + 1; j < entries.length; j++) {
            const ttoSimilar    = Math.abs(entries[i].tto    - entries[j].tto)    <= 5 * 60 * 1000;
            const openedSimilar = Math.abs(entries[i].openedMs - entries[j].openedMs) <= 5 * 60 * 1000;
            if (ttoSimilar || openedSimilar) {
              orgBotContactIds.add(entries[i].s.contactId);
              orgBotContactIds.add(entries[j].s.contactId);
              console.log(`[org-bot] @${domain}: contacts ${entries[i].s.contactId} and ${entries[j].s.contactId} -- tto diff: ${Math.round(Math.abs(entries[i].tto - entries[j].tto)/1000)}s`);
            }
          }
        }
      });

      // Move org-bot signals to bots array
      const finalReal = [];
      const orgBots   = [];
      allReal.forEach(s => {
        const email  = s.contact?.email || "";
        const domain = email.includes("@") ? email.split("@")[1].toLowerCase().trim() : null;
        if (orgBotContactIds.has(s.contactId) &&
            (s.type === "OPEN" || s.eventType === "OPEN") &&
            !s.replied && !s.clickedAt) {
          orgBots.push({
            ...s,
            botCheck: {
              isBot:      true,
              confidence: "high",
              reasons:    [`Organizational scan: multiple @${domain || "same domain"} contacts opened within 5 minutes of each other`],
            },
          });
        } else {
          finalReal.push(s);
        }
      });

      const finalBots = [...allBots, ...orgBots];

      // hasMore: true if any of the per-prop searches returned a full page,
      // meaning there are likely more contacts beyond this offset.
      const anyFullPage = searchResults.some(r => (r.results || []).length === perPropLimit);

      console.log(`[signals] merged=${allContactResults.length} contactSignals=${contactSignals.length} finalReal=${finalReal.length} finalBots=${finalBots.length} filters=${JSON.stringify(customFilters)}`);

      const response = {
        signals: finalReal,
        meta: {
          total:             finalReal.length,
          suspectedBotCount: finalBots.length,
          hoursSearched:     hours,
          // Pagination
          offset:    pageOffset,
          nextOffset: pageOffset + perPropLimit,
          hasMore:   anyFullPage,
          activeFilters: {
            assigned_bdr:                    qp.assigned_bdr || null,
            territory:                       qp.territory    || null,
            priority_tier__bdr:              qp.priority_tier__bdr || null,
            target_account__bdr_led_outreach:qp.target_account__bdr_led_outreach || null,
          },
          botSummary: finalBots.length > 0
            ? `${finalBots.length} open event${finalBots.length > 1 ? "s" : ""} filtered as likely bot scan`
            : null,
          // Debug info -- remove once signals filter issue is resolved
          _debug: {
            searchCounts: searchResults.map((r, i) => ({
              prop:     activityDateProps[i],
              returned: (r.results || []).length,
              total:    r.total || 0,
            })),
            contactsAfterDedup:    allContactResults.length,
            contactSignalsBuilt:   contactSignals.length,
            afterBotFilter:        finalReal.length,
            botsFiltered:          finalBots.length,
            customFiltersApplied:  customFilters,
          },
        },
      };
      if (qp.showBots === "true") {
        response.suspectedBotSignals = finalBots.slice(0, 50);
      }
      return ok(response);
      } catch (err) {
        console.error("[signals] Error:", err.message, err.stack);
        return error(500, `Signals error: ${err.message}`);
      }
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

    // ── Tab registry ──────────────────────────────────────────────────────────
    //
    // GET /tabs -- returns tabs visible to the current user
    // POST /tabs -- create or update a tab (admin only)
    // DELETE /tabs/:id -- remove a tab (admin only)
    // GET /tabs/preview?url= -- fetch page <title> for auto-naming (admin only)

    if (method === "GET" && path === "/tabs") {
      try {
        const tabs = await getTabsForUser(user.userId);
        return ok({ tabs, isAdmin: ADMIN_USER_IDS.has(user.userId) });
      } catch (err) {
        console.error("[tabs] GET error:", err.message);
        return error(500, `Tabs error: ${err.message}`);
      }
    }

    if (method === "GET" && path === "/tabs/preview") {
      if (!ADMIN_USER_IDS.has(user.userId)) return error(403, "Admin only");
      const url = qp.url ? decodeURIComponent(qp.url) : null;
      if (!url) return error(400, "url param required");
      try {
        const title = await fetchPageTitle(url);
        // Auto-generate a label: prefer page title, fall back to hostname
        let suggestedLabel = title;
        if (!suggestedLabel) {
          try { suggestedLabel = new URL(url).hostname.replace(/^www\./, ""); } catch { suggestedLabel = "New App"; }
        }
        return ok({ title, suggestedLabel });
      } catch (err) {
        return ok({ title: null, suggestedLabel: "New App" });
      }
    }

    if (method === "POST" && path === "/tabs") {
      if (!ADMIN_USER_IDS.has(user.userId)) return error(403, "Admin only");
      try {
        const body = JSON.parse(event.body || "{}");
        const { url, label, badge, allowedUsers, enabled = true, type = "iframe" } = body;

        if (!url)   return error(400, "url is required");
        if (!label) return error(400, "label is required");
        if (!["iframe","link"].includes(type)) return error(400, "type must be iframe or link");

        // Validate URL
        try { new URL(url); } catch { return error(400, "Invalid URL"); }

        const registry = await getRegistry();
        const id       = body.id || slugify(label);
        const now      = new Date().toISOString();
        const existing = registry.findIndex(t => t.id === id);

        const tab = {
          id,
          label:        label.trim().slice(0, 40),
          url:          url.trim(),
          type,
          enabled,
          allowedUsers: allowedUsers || [],
          badge:        badge || null,
          addedBy:      user.userId,
          createdAt:    existing >= 0 ? registry[existing].createdAt : now,
          updatedAt:    now,
        };

        if (existing >= 0) {
          registry[existing] = tab;
        } else {
          registry.push(tab);
        }

        await saveRegistry(registry);
        return ok({ tab, action: existing >= 0 ? "updated" : "created" });
      } catch (err) {
        console.error("[tabs] POST error:", err.message);
        return error(500, `Tab save error: ${err.message}`);
      }
    }

    if (method === "DELETE" && path.startsWith("/tabs/")) {
      if (!ADMIN_USER_IDS.has(user.userId)) return error(403, "Admin only");
      const tabId = path.split("/tabs/")[1];
      if (!tabId) return error(400, "Tab ID required");
      try {
        const registry = await getRegistry();
        const filtered = registry.filter(t => t.id !== tabId);
        if (filtered.length === registry.length) return error(404, "Tab not found");
        await saveRegistry(filtered);
        return ok({ deleted: tabId });
      } catch (err) {
        console.error("[tabs] DELETE error:", err.message);
        return error(500, `Tab delete error: ${err.message}`);
      }
    }

    // ── Reports ───────────────────────────────────────────────────────────────
    // Comprehensive sales reporting across outbound, inbound, deals, and marketing.
    //
    // Query params:
    //   section=outbound|inbound|deals|marketing  (required)
    //   period=today|week|month|quarter|6months|year|alltime  (default: month)
    //   rep=Chris+Knapp|Chiara+Pate|all  (default: all)
    //
    // Periods:
    //   today      = current calendar day (midnight to now)
    //   week       = last 7 days
    //   month      = last 30 days
    //   quarter    = last 90 days
    //   6months    = last 180 days
    //   year       = last 365 days
    //   alltime    = no date filter
    if (method === "GET" && path === "/reports") {
      try {
        const section = qp.section || "outbound";
        const period  = qp.period  || "month";
        const rep     = qp.rep && qp.rep !== "all" ? decodeURIComponent(qp.rep).trim() : null;

        // Calculate since timestamp for the period
        const now = Date.now();
        const PERIODS = {
          today:    24 * 60 * 60 * 1000,
          week:     7  * 24 * 60 * 60 * 1000,
          month:    30 * 24 * 60 * 60 * 1000,
          quarter:  90 * 24 * 60 * 60 * 1000,
          "6months":180 * 24 * 60 * 60 * 1000,
          year:     365 * 24 * 60 * 60 * 1000,
          alltime:  null,
        };
        const periodMs  = PERIODS[period] ?? PERIODS.month;
        const sinceMs   = periodMs ? now - periodMs : null;
        const sinceISO  = sinceMs ? new Date(sinceMs).toISOString() : null;

        // Rep filter builders
        const KNOWN_BDRS = ["Chris Knapp", "Chiara Pate"];
        const targetReps = rep ? [rep] : KNOWN_BDRS;

        // Helper: build BDR filter for contact searches
        const bdrContactFilter = () => rep
          ? [{ propertyName: "assigned_bdr", operator: "EQ", value: rep }]
          : [{ propertyName: "assigned_bdr", operator: "IN", values: KNOWN_BDRS }];

        // Helper: count contacts matching filters, returns total only
        const countContacts = async (filters) => {
          try {
            const data = await hsPost(user.userId, "/crm/v3/objects/contacts/search", {
              filterGroups: [{ filters }],
              properties: ["assigned_bdr"],
              limit: 1,
            });
            return data.total || 0;
          } catch { return 0; }
        };

        // Helper: fetch contacts (up to limit) with given filters
        const fetchContacts = async (filters, props, sortProp, limit = 100) => {
          try {
            const data = await hsPost(user.userId, "/crm/v3/objects/contacts/search", {
              filterGroups: [{ filters }],
              properties: props,
              sorts: [{ propertyName: sortProp, direction: "DESCENDING" }],
              limit,
            });
            return data.results || [];
          } catch { return []; }
        };

        // Helper: fetch deals with filters
        const fetchDeals = async (extraFilters = [], limit = 200) => {
          const filters = [...extraFilters];
          if (sinceISO) filters.push({ propertyName: "createdate", operator: "GTE", value: sinceISO });
          try {
            let deals = [], after;
            while (deals.length < limit) {
              const body = {
                filterGroups: [{ filters }],
                properties: ["dealname","dealstage","pipeline","amount","closedate","createdate","hubspot_owner_id","hs_projected_amount","closed_lost_reason","hs_deal_stage_probability"],
                sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
                limit: Math.min(100, limit - deals.length),
              };
              if (after) body.after = after;
              const data = await hsPost(user.userId, "/crm/v3/objects/deals/search", body);
              deals.push(...(data.results || []));
              if (!data.paging?.next?.after || (data.results || []).length < 100) break;
              after = data.paging.next.after;
            }
            return deals;
          } catch { return []; }
        };

        // Pipeline + stage reference maps (from property definitions)
        const PIPELINES = {
          "679336808": "New Business Opportunity",
          "679502246": "Expansion Deal",
          "678610513": "New Business Deal",
        };
        const STAGES = {
          "995708483": { label:"Target Identified",              pipeline:"679336808", closed:false, won:false },
          "995708484": { label:"Initial Outreach/Reengaged",     pipeline:"679336808", closed:false, won:false },
          "1284036410":{ label:"Email Opened/No Response",       pipeline:"679336808", closed:false, won:false },
          "1288757038":{ label:"Reengagement Needed",            pipeline:"679336808", closed:false, won:false },
          "995708485": { label:"Engaged",                        pipeline:"679336808", closed:false, won:false },
          "995708486": { label:"Meeting Scheduled",              pipeline:"679336808", closed:false, won:false },
          "995708487": { label:"Meeting Completed",              pipeline:"679336808", closed:false, won:false },
          "995708488": { label:"Qualified (Deal Pipeline)",      pipeline:"679336808", closed:false, won:false },
          "995708489": { label:"Unengaged",                      pipeline:"679336808", closed:false, won:false },
          "996311842": { label:"Trade Show Meeting Follow-Up",   pipeline:"679336808", closed:false, won:false },
          "1331037807":{ label:"Meeting Completed - Not A Fit",  pipeline:"679336808", closed:false, won:false },
          "1331034125":{ label:"Meeting Completed - Partnership", pipeline:"679336808", closed:false, won:false },
          "1347324753":{ label:"Closed/Lost",                    pipeline:"679336808", closed:true,  won:false },
          "995723921": { label:"Expansion Targets",              pipeline:"679502246", closed:false, won:false },
          "995723922": { label:"Engaged",                        pipeline:"679502246", closed:false, won:false },
          "995723923": { label:"Value Prop/Scoping",             pipeline:"679502246", closed:false, won:false },
          "995723924": { label:"Pricing Proposal",               pipeline:"679502246", closed:false, won:false },
          "995723926": { label:"Procurement/Contracting",        pipeline:"679502246", closed:false, won:false },
          "995723927": { label:"Closed Lost",                    pipeline:"679502246", closed:true,  won:false },
          "995739776": { label:"Closed Won",                     pipeline:"679502246", closed:true,  won:true  },
          "1004627778":{ label:"Revisit",                        pipeline:"679502246", closed:false, won:false },
          "995756094": { label:"Qualified",                      pipeline:"678610513", closed:false, won:false },
          "995756095": { label:"Problem Solution Fit",           pipeline:"678610513", closed:false, won:false },
          "995756096": { label:"Value Prop/Scoping",             pipeline:"678610513", closed:false, won:false },
          "995756097": { label:"Pricing Proposal",               pipeline:"678610513", closed:false, won:false },
          "995756098": { label:"IT/Technical Review",            pipeline:"678610513", closed:false, won:false },
          "995756099": { label:"Contracting/Legal",              pipeline:"678610513", closed:false, won:false },
          "995756100": { label:"Closed - Lost",                  pipeline:"678610513", closed:true,  won:false },
          "995749999": { label:"Closed - Won",                   pipeline:"678610513", closed:true,  won:true  },
          "995750000": { label:"Revisit",                        pipeline:"678610513", closed:false, won:false },
        };

        // ── OUTBOUND section ──────────────────────────────────────────────────
        if (section === "outbound") {
          const bdrFilters = bdrContactFilter();
          const dateFilter = sinceISO ? [{ propertyName: "hs_email_last_send_date", operator: "GTE", value: sinceISO }] : [];
          const seqFilter  = sinceISO ? [{ propertyName: "hs_latest_sequence_enrolled_date", operator: "GTE", value: sinceISO }] : [];

          // Run all counts in parallel per rep, then summarize
          const repData = await Promise.all(targetReps.map(async (repName) => {
            const repFilter = [{ propertyName: "assigned_bdr", operator: "EQ", value: repName }];
            const [emailsSent, sequencesStarted, contactsReached] = await Promise.all([
              countContacts([...repFilter, ...dateFilter.length ? dateFilter : [{ propertyName: "hs_email_last_send_date", operator: "HAS_PROPERTY" }]]),
              countContacts([...repFilter, ...seqFilter.length  ? seqFilter  : [{ propertyName: "hs_latest_sequence_enrolled_date", operator: "HAS_PROPERTY" }]]),
              sinceISO ? countContacts([...repFilter, { propertyName: "notes_last_contacted", operator: "GTE", value: sinceISO }]) : countContacts([...repFilter, { propertyName: "notes_last_contacted", operator: "HAS_PROPERTY" }]),
            ]);
            await new Promise(r => setTimeout(r, 200));
            return { rep: repName, emailsSent, sequencesStarted, contactsReached };
          }));

          // Engagement counts (calls/meetings/notes from engagements)
          const engTotals = { calls:0, meetings:0, notes:0 };
          const engByRep  = {};
          try {
            let offset = 0, hasMore = true;
            while (hasMore && offset < 3000) {
              const params = { limit: 250, offset };
              if (sinceMs) params.since = sinceMs;
              const engData = await hsGet(user.userId, "/engagements/v1/engagements/paged", params).catch(() => ({ results:[], hasMore:false }));
              for (const eng of (engData.results || [])) {
                const type = eng.engagement?.type || "";
                if (!["CALL","MEETING","NOTE"].includes(type)) continue;
                if (type === "CALL")    engTotals.calls++;
                if (type === "MEETING") engTotals.meetings++;
                if (type === "NOTE")    engTotals.notes++;
              }
              hasMore = engData.hasMore && (engData.results || []).length === 250;
              offset += (engData.results || []).length;
            }
          } catch {}

          // Recent activity list for drill-down (last 50 contacts with send date)
          const recentContacts = await fetchContacts(
            [...bdrFilters, ...dateFilter.length ? dateFilter : [{ propertyName: "hs_email_last_send_date", operator: "HAS_PROPERTY" }]],
            ["firstname","lastname","email","company","assigned_bdr","hs_email_last_send_date","hs_email_last_email_name","hs_latest_sequence_enrolled_date"],
            "hs_email_last_send_date", 50
          );

          const totals = repData.reduce((a, r) => ({
            emailsSent:       a.emailsSent       + r.emailsSent,
            sequencesStarted: a.sequencesStarted + r.sequencesStarted,
            contactsReached:  a.contactsReached  + r.contactsReached,
          }), { emailsSent:0, sequencesStarted:0, contactsReached:0 });

          return ok({
            section: "outbound",
            period,
            rep: rep || "all",
            totals: { ...totals, ...engTotals },
            byRep: repData,
            recentActivity: recentContacts.map(c => ({
              id:         c.id,
              name:       `${c.properties?.firstname||""} ${c.properties?.lastname||""}`.trim(),
              company:    c.properties?.company || "",
              assignedBdr:c.properties?.assigned_bdr || "",
              lastSent:   c.properties?.hs_email_last_send_date || null,
              emailName:  c.properties?.hs_email_last_email_name || null,
              sequenceEnrolled: c.properties?.hs_latest_sequence_enrolled_date || null,
              url: `https://app.hubspot.com/contacts/39921549/record/0-1/${c.id}`,
            })),
          });
        }

        // ── INBOUND section ───────────────────────────────────────────────────
        if (section === "inbound") {
          const bdrFilters = bdrContactFilter();

          const makeFilter = (prop) => [
            ...bdrFilters,
            ...(sinceISO ? [{ propertyName: prop, operator: "GTE", value: sinceISO }] : [{ propertyName: prop, operator: "HAS_PROPERTY" }]),
          ];

          const [replies, clicks, opens, sent] = await Promise.all([
            countContacts(makeFilter("hs_email_last_reply_date")),
            countContacts(makeFilter("hs_email_last_click_date")),
            countContacts(makeFilter("hs_email_last_open_date")),
            countContacts(bdrFilters.concat(sinceISO ? [{ propertyName: "hs_email_last_send_date", operator: "GTE", value: sinceISO }] : [{ propertyName: "hs_email_last_send_date", operator: "HAS_PROPERTY" }])),
          ]);

          const replyRate = sent > 0 ? ((replies / sent) * 100).toFixed(1) : "0.0";
          const openRate  = sent > 0 ? ((opens  / sent) * 100).toFixed(1) : "0.0";
          const clickRate = sent > 0 ? ((clicks / sent) * 100).toFixed(1) : "0.0";

          // Per-rep inbound breakdown
          const repData = await Promise.all(targetReps.map(async (repName) => {
            const rf = [{ propertyName: "assigned_bdr", operator: "EQ", value: repName }];
            const mf = (prop) => [...rf, ...(sinceISO ? [{ propertyName: prop, operator: "GTE", value: sinceISO }] : [{ propertyName: prop, operator: "HAS_PROPERTY" }])];
            const [rReplies, rClicks, rOpens, rSent] = await Promise.all([
              countContacts(mf("hs_email_last_reply_date")),
              countContacts(mf("hs_email_last_click_date")),
              countContacts(mf("hs_email_last_open_date")),
              countContacts([...rf, ...(sinceISO ? [{ propertyName: "hs_email_last_send_date", operator: "GTE", value: sinceISO }] : [{ propertyName: "hs_email_last_send_date", operator: "HAS_PROPERTY" }])]),
            ]);
            await new Promise(r => setTimeout(r, 200));
            return { rep: repName, replies: rReplies, clicks: rClicks, opens: rOpens, sent: rSent,
              replyRate: rSent > 0 ? ((rReplies/rSent)*100).toFixed(1) : "0.0",
              openRate:  rSent > 0 ? ((rOpens/rSent)*100).toFixed(1)   : "0.0",
              clickRate: rSent > 0 ? ((rClicks/rSent)*100).toFixed(1)  : "0.0",
            };
          }));

          // Recent replies for drill-down
          const recentReplies = await fetchContacts(
            [...bdrFilters, ...(sinceISO ? [{ propertyName: "hs_email_last_reply_date", operator: "GTE", value: sinceISO }] : [{ propertyName: "hs_email_last_reply_date", operator: "HAS_PROPERTY" }])],
            ["firstname","lastname","email","company","assigned_bdr","hs_email_last_reply_date","hs_email_last_email_name","hs_sales_email_last_replied"],
            "hs_email_last_reply_date", 50
          );

          return ok({
            section: "inbound",
            period,
            rep: rep || "all",
            totals: { replies, clicks, opens, sent, replyRate, openRate, clickRate },
            byRep: repData,
            recentReplies: recentReplies.map(c => ({
              id:         c.id,
              name:       `${c.properties?.firstname||""} ${c.properties?.lastname||""}`.trim(),
              company:    c.properties?.company || "",
              assignedBdr:c.properties?.assigned_bdr || "",
              replyDate:  c.properties?.hs_email_last_reply_date || c.properties?.hs_sales_email_last_replied || null,
              emailName:  c.properties?.hs_email_last_email_name || null,
              url: `https://app.hubspot.com/contacts/39921549/record/0-1/${c.id}`,
            })),
          });
        }

        // ── DEALS section ─────────────────────────────────────────────────────
        if (section === "deals") {
          // Fetch all deals in period (no owner filter -- deals owned by AEs)
          const allDeals = await fetchDeals([], 500);

          // Compute pipeline breakdown by stage
          const byStage = {};
          const byPipeline = {};
          let totalValue = 0, totalWeighted = 0;
          let wonCount = 0, wonValue = 0;
          let lostCount = 0, lostValue = 0;
          const lostReasons = {};
          const closedDeals = []; // for velocity calc

          for (const deal of allDeals) {
            const p = deal.properties || {};
            const stageId    = p.dealstage || "";
            const pipelineId = p.pipeline  || "";
            const amount     = parseFloat(p.amount || 0);
            const weighted   = parseFloat(p.hs_projected_amount || 0);
            const stage      = STAGES[stageId];

            totalValue    += amount;
            totalWeighted += weighted;

            // By pipeline
            if (!byPipeline[pipelineId]) byPipeline[pipelineId] = { label: PIPELINES[pipelineId] || pipelineId, count:0, value:0, weighted:0 };
            byPipeline[pipelineId].count++;
            byPipeline[pipelineId].value    += amount;
            byPipeline[pipelineId].weighted += weighted;

            // By stage
            if (!byStage[stageId]) byStage[stageId] = { label: stage?.label || stageId, pipeline: PIPELINES[pipelineId] || pipelineId, count:0, value:0 };
            byStage[stageId].count++;
            byStage[stageId].value += amount;

            if (stage?.won) {
              wonCount++; wonValue += amount;
              // Velocity: createdate to closedate in days
              if (p.createdate && p.closedate) {
                closedDeals.push({
                  days: Math.round((new Date(p.closedate) - new Date(p.createdate)) / (1000*60*60*24)),
                  amount,
                });
              }
            }
            if (stage?.closed && !stage?.won) {
              lostCount++; lostValue += amount;
              const reason = p.closed_lost_reason || "No reason given";
              lostReasons[reason] = (lostReasons[reason] || 0) + 1;
            }
          }

          const totalClosed  = wonCount + lostCount;
          const winRate      = totalClosed > 0 ? ((wonCount / totalClosed) * 100).toFixed(1) : "0.0";
          const avgVelocity  = closedDeals.length > 0
            ? Math.round(closedDeals.reduce((a, d) => a + d.days, 0) / closedDeals.length)
            : null;
          const avgDealSize  = wonCount > 0 ? Math.round(wonValue / wonCount) : 0;

          // Recent deals for drill-down (top 50)
          const recentDeals = allDeals.slice(0, 50).map(deal => {
            const p = deal.properties || {};
            const stage = STAGES[p.dealstage];
            return {
              id:          deal.id,
              name:        p.dealname || "",
              stage:       stage?.label || p.dealstage || "",
              pipeline:    PIPELINES[p.pipeline] || p.pipeline || "",
              amount:      parseFloat(p.amount || 0),
              weighted:    parseFloat(p.hs_projected_amount || 0),
              closeDate:   p.closedate   || null,
              createDate:  p.createdate  || null,
              ownerId:     p.hubspot_owner_id || null,
              lostReason:  p.closed_lost_reason || null,
              isWon:       stage?.won    || false,
              isLost:      (stage?.closed && !stage?.won) || false,
              url: `https://app.hubspot.com/contacts/39921549/record/0-3/${deal.id}`,
            };
          });

          return ok({
            section: "deals",
            period,
            totals: {
              total: allDeals.length, totalValue, totalWeighted,
              wonCount, wonValue, lostCount, lostValue,
              winRate, avgVelocity, avgDealSize,
            },
            byPipeline: Object.values(byPipeline),
            byStage:    Object.values(byStage).sort((a,b) => b.count - a.count),
            lostReasons: Object.entries(lostReasons)
              .map(([reason, count]) => ({ reason, count }))
              .sort((a,b) => b.count - a.count),
            recentDeals,
          });
        }

        // ── MARKETING section ─────────────────────────────────────────────────
        if (section === "marketing") {
          // Marketing = contacts reached via marketing emails (hs_email_last_send_date)
          // with open/click/reply breakdown -- not filtered by BDR since marketing
          // emails go to all contacts
          const makeFilter = (prop) => sinceISO
            ? [{ propertyName: prop, operator: "GTE", value: sinceISO }]
            : [{ propertyName: prop, operator: "HAS_PROPERTY" }];

          const [totalReached, totalOpened, totalClicked, totalReplied] = await Promise.all([
            countContacts(makeFilter("hs_email_last_send_date")),
            countContacts(makeFilter("hs_email_last_open_date")),
            countContacts(makeFilter("hs_email_last_click_date")),
            countContacts(makeFilter("hs_email_last_reply_date")),
          ]);

          const openRate  = totalReached > 0 ? ((totalOpened  / totalReached) * 100).toFixed(1) : "0.0";
          const clickRate = totalReached > 0 ? ((totalClicked / totalReached) * 100).toFixed(1) : "0.0";
          const replyRate = totalReached > 0 ? ((totalReplied / totalReached) * 100).toFixed(1) : "0.0";

          // Top email names in the period
          const recentSends = await fetchContacts(
            makeFilter("hs_email_last_send_date"),
            ["hs_email_last_send_date","hs_email_last_email_name","hs_email_last_open_date","assigned_bdr"],
            "hs_email_last_send_date", 200
          );

          // Group by email name for campaign-level summary
          const byCampaign = {};
          for (const c of recentSends) {
            const name = c.properties?.hs_email_last_email_name || "Unknown";
            if (!byCampaign[name]) byCampaign[name] = { name, sent:0, opened:0 };
            byCampaign[name].sent++;
            if (c.properties?.hs_email_last_open_date) byCampaign[name].opened++;
          }
          const campaigns = Object.values(byCampaign)
            .map(c => ({ ...c, openRate: c.sent > 0 ? ((c.opened/c.sent)*100).toFixed(1) : "0.0" }))
            .sort((a,b) => b.sent - a.sent)
            .slice(0, 20);

          return ok({
            section: "marketing",
            period,
            totals: { totalReached, totalOpened, totalClicked, totalReplied, openRate, clickRate, replyRate },
            campaigns,
          });
        }

        return error(400, `Unknown section: ${section}. Use outbound|inbound|deals|marketing`);

      } catch (err) {
        console.error("[reports] Error:", err.message, err.stack);
        return error(500, `Reports error: ${err.message}`);
      }
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
