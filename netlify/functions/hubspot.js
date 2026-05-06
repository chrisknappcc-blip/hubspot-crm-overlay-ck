// netlify/functions/hubspot.js
// Routes:
//   GET  /hubspot/auth/connect            -> redirect to HubSpot OAuth
//   GET  /hubspot/auth/callback           -> exchange code, store tokens (no auth required)
//   GET  /hubspot/status                  -> check which services are connected
//   GET  /hubspot/owners                  -> list HubSpot owners (reps) for filter dropdown
//   GET  /hubspot/contacts                -> list contacts with custom property filters
//   GET  /hubspot/contacts/:id            -> single contact detail + engagements
//   GET  /hubspot/signals                 -> ranked intent signals with custom property filters
//   GET  /hubspot/feed/:contactId         -> full merged activity feed for a contact
//   GET  /hubspot/tasks                   -> open tasks in a rolling date window (?days=7|14|21|30)
//   GET  /hubspot/gold                    -> Gold-tier contacts sorted by tier + activity (?assigned_bdr=)
//   GET  /hubspot/activity                -> outbound + inbound activity counts (?days=7|14|30|90&scope=me|team)
//   POST /hubspot/activity                -> log a note/call/meeting to a contact
//
// Custom filter query params (all optional, stackable):
//   assigned_bdr=Chris+Knapp
//   territory=Northeast
//   priority_tier__bdr=GOLD+1-10
//   target_account__bdr_led_outreach=Chris+Knapp

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
  "e-commerce",
  "oauth",
].join(" ");

// All custom properties to include in every contact fetch
const CUSTOM_PROPS = [
  "assigned_bdr",
  "target_account__bdr_led_outreach",
  "territory",
  "priority_tier__bdr",
];

// Standard contact properties always fetched
const BASE_CONTACT_PROPS = [
  "firstname", "lastname", "email", "company", "jobtitle", "phone",
  "hs_lead_status", "lifecyclestage", "hubspot_owner_id",
  "notes_last_contacted", "num_contacted_notes",
  "hs_last_email_activity_date",
  "hs_last_sales_activity_date",
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
    priority_tier__bdr:              "priority_tier__bdr",
    target_account__bdr_led_outreach:"target_account__bdr_led_outreach",
  };

  Object.entries(FILTER_MAP).forEach(([param, prop]) => {
    if (qp[param]) {
      // Decode URI encoding and trim whitespace to ensure clean filter values
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
    priorityTier:        p.priority_tier__bdr || "",
    // Marketing email timestamps (hs_email_* -- marketing hub sends)
    lastEmailActivityDate: p.hs_last_email_activity_date || null,
    lastSalesActivityDate: p.hs_last_sales_activity_date || null,
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
      const baseFilters = buildCustomFilters(qp);
      let contacts = [];

      if (baseFilters.length > 0) {
        // Paginate through search API -- up to 500 contacts
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
        // Paginate through list API -- up to 500 contacts
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

    // ── Tasks (date-windowed) ─────────────────────────────────────────────────
    // Returns open tasks assigned to the current user within a rolling date window.
    // Query params:
    //   days=7|14|21|30  (default: 14)
    //   status=NOT_STARTED|IN_PROGRESS|WAITING  (default: NOT_STARTED,IN_PROGRESS,WAITING -- all open)
    //
    // Tasks are filtered by hs_timestamp (due date) within the window.
    // We also fetch overdue tasks (due date before today, not completed) separately
    // so the rep sees everything that needs attention.
    if (method === "GET" && path === "/tasks") {
      try {
        const days    = Math.min(parseInt(qp.days || "14", 10), 30);
        const now     = Date.now();
        const windowEnd   = new Date(now + days * 24 * 60 * 60 * 1000).toISOString();
        const overdueFrom = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString(); // up to 90 days back

        // Fetch open tasks in the forward window + overdue in parallel
        const [upcomingData, overdueData] = await Promise.all([
          // Tasks due within the next N days
          hsPost(user.userId, "/crm/v3/objects/tasks/search", {
            filterGroups: [{
              filters: [
                { propertyName: "hubspot_owner_id",  operator: "EQ",      value: String(user.ownerId || "") },
                { propertyName: "hs_task_status",    operator: "NOT_IN",  values: ["COMPLETED", "DEFERRED"] },
                { propertyName: "hs_timestamp",      operator: "GTE",     value: new Date(now).toISOString() },
                { propertyName: "hs_timestamp",      operator: "LTE",     value: windowEnd },
              ],
            }],
            properties: ["hs_task_subject","hs_task_status","hs_task_type","hs_timestamp","hs_task_priority","hs_task_body","hubspot_owner_id"],
            sorts:      [{ propertyName: "hs_timestamp", direction: "ASCENDING" }],
            limit:      200,
          }).catch(() => ({ results: [] })),

          // Overdue tasks -- due before today, not completed
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
            sorts:      [{ propertyName: "hs_timestamp", direction: "ASCENDING" }],
            limit:      200,
          }).catch(() => ({ results: [] })),
        ]);

        const normalize = (t, overdue = false) => ({
          id:        t.id,
          subject:   t.properties?.hs_task_subject  || "Untitled task",
          status:    t.properties?.hs_task_status   || "NOT_STARTED",
          type:      t.properties?.hs_task_type     || "TODO",
          dueDate:   t.properties?.hs_timestamp     || null,
          priority:  t.properties?.hs_task_priority || "NONE",
          body:      t.properties?.hs_task_body     || null,
          overdue,
          url: `https://app.hubspot.com/tasks/39921549/view/all/task/${t.id}`,
        });

        const upcoming = (upcomingData.results || []).map(t => normalize(t, false));
        const overdue  = (overdueData.results  || []).map(t => normalize(t, true));

        return ok({
          tasks: [...overdue, ...upcoming],
          meta: {
            overdue:   overdue.length,
            upcoming:  upcoming.length,
            total:     overdue.length + upcoming.length,
            days,
            windowEnd,
          },
        });
      } catch (err) {
        console.error("[tasks] Error:", err.message);
        return error(500, `Tasks error: ${err.message}`);
      }
    }

    // ── Gold Accounts panel ───────────────────────────────────────────────────
    // Returns contacts with any GOLD priority_tier__bdr value, sorted tier-first
    // (GOLD 1-10 at top) then by most recent activity within each tier.
    //
    // Query params:
    //   assigned_bdr=Chris+Knapp   (recommended -- filter to one rep's Gold list)
    //   limit=N                    (default: 200, max: 500)
    //
    // Tier sort: extracts the leading number from "GOLD N-NN" strings so the sort
    // is numeric, not alphabetical. "GOLD 1-10" < "GOLD 11-20" < "GOLD 91-100".
    //
    // Signal status is derived from contact properties -- same logic as /signals
    // but simplified (no bot filtering, just the most recent action label).
    if (method === "GET" && path === "/gold") {
      try {
        const limit = Math.min(parseInt(qp.limit || "200", 10), 500);
        const customFilters = buildCustomFilters(qp);

        // All 10 Gold tiers as defined in the custom property
        const GOLD_TIERS = [
          "GOLD 1-10","GOLD 11-20","GOLD 21-30","GOLD 31-40","GOLD 41-50",
          "GOLD 51-60","GOLD 61-70","GOLD 71-80","GOLD 81-90","GOLD 91-100",
        ];

        // Paginate through all Gold contacts (up to limit)
        let goldContacts = [];
        let after = undefined;
        while (goldContacts.length < limit) {
          const body = {
            filterGroups: [{
              filters: [
                { propertyName: "priority_tier__bdr", operator: "IN", values: GOLD_TIERS },
                ...customFilters,
              ],
            }],
            properties: [
              ...BASE_CONTACT_PROPS,
              // Ensure signal props are included even if BASE_CONTACT_PROPS changes
              "hs_email_last_open_date",
              "hs_email_last_click_date",
              "hs_email_last_reply_date",
              "hs_email_last_send_date",
              "hs_email_last_email_name",
              "hs_sales_email_last_opened",
              "hs_sales_email_last_clicked",
              "hs_sales_email_last_replied",
            ],
            sorts:  [{ propertyName: "notes_last_contacted", direction: "DESCENDING" }],
            limit:  100,
          };
          if (after) body.after = after;
          const data = await hsPost(user.userId, "/crm/v3/objects/contacts/search", body);
          goldContacts.push(...(data.results || []));
          if (!data.paging?.next?.after || (data.results || []).length < 100) break;
          after = data.paging.next.after;
        }

        // Extract leading number from tier string for correct numeric sort
        // "GOLD 1-10" -> 1, "GOLD 11-20" -> 11, "GOLD 91-100" -> 91
        const tierRank = (tier) => {
          const match = (tier || "").match(/(\d+)/);
          return match ? parseInt(match[1], 10) : 999;
        };

        // Derive the most recent signal and its type for each contact
        const signalStatus = (p) => {
          const mktReplyTs  = p.hs_email_last_reply_date    ? new Date(p.hs_email_last_reply_date).getTime()    : 0;
          const mktClickTs  = p.hs_email_last_click_date    ? new Date(p.hs_email_last_click_date).getTime()    : 0;
          const mktOpenTs   = p.hs_email_last_open_date     ? new Date(p.hs_email_last_open_date).getTime()     : 0;
          const salesReplyTs= p.hs_sales_email_last_replied ? new Date(p.hs_sales_email_last_replied).getTime() : 0;
          const salesClickTs= p.hs_sales_email_last_clicked ? new Date(p.hs_sales_email_last_clicked).getTime() : 0;
          const salesOpenTs = p.hs_sales_email_last_opened  ? new Date(p.hs_sales_email_last_opened).getTime()  : 0;

          const replyTs = Math.max(mktReplyTs,  salesReplyTs);
          const clickTs = Math.max(mktClickTs,  salesClickTs);
          const openTs  = Math.max(mktOpenTs,   salesOpenTs);

          if (replyTs > 0) return { status: "replied",  timestamp: new Date(replyTs).toISOString(), label: "Replied" };
          if (clickTs > 0) return { status: "clicked",  timestamp: new Date(clickTs).toISOString(), label: "Clicked" };
          if (openTs  > 0) return { status: "opened",   timestamp: new Date(openTs).toISOString(),  label: "Opened"  };
          return             { status: "no_signal", timestamp: null,                                label: "No recent activity" };
        };

        const normalized = goldContacts.map(c => {
          const p    = c.properties || {};
          const tier = p.priority_tier__bdr || "";
          const sig  = signalStatus(p);

          // Last activity: most recent across all tracked dates
          const allDates = [
            p.notes_last_contacted,
            p.hs_last_email_activity_date,
            p.hs_last_sales_activity_date,
            p.hs_email_last_send_date,
            sig.timestamp,
          ].filter(Boolean).map(d => new Date(d).getTime());
          const lastActivityTs  = allDates.length > 0 ? Math.max(...allDates) : 0;
          const lastActivityDate = lastActivityTs > 0 ? new Date(lastActivityTs).toISOString() : null;

          return {
            id:              c.id,
            name:            `${p.firstname || ""} ${p.lastname || ""}`.trim(),
            email:           p.email    || "",
            company:         p.company  || "",
            title:           p.jobtitle || "",
            tier,
            tierRank:        tierRank(tier),
            assignedBdr:     p.assigned_bdr || "",
            territory:       p.territory    || "",
            lastActivityDate,
            signal:          sig,
            lastEmailName:   p.hs_email_last_email_name || null,
            url: `https://app.hubspot.com/contacts/39921549/record/0-1/${c.id}`,
          };
        });

        // Sort: tier rank ascending (1-10 first), then most recent activity descending
        normalized.sort((a, b) => {
          if (a.tierRank !== b.tierRank) return a.tierRank - b.tierRank;
          const dateA = a.lastActivityDate ? new Date(a.lastActivityDate).getTime() : 0;
          const dateB = b.lastActivityDate ? new Date(b.lastActivityDate).getTime() : 0;
          return dateB - dateA;
        });

        // Count by tier for the panel header
        const byTier = {};
        normalized.forEach(c => {
          byTier[c.tier] = (byTier[c.tier] || 0) + 1;
        });

        return ok({
          accounts: normalized,
          meta: {
            total:   normalized.length,
            byTier,
            filters: {
              assigned_bdr: qp.assigned_bdr || null,
              territory:    qp.territory    || null,
            },
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
    //   days=7|14|30|90    (default: 7)
    //   scope=me|team      (default: me)
    //
    // IMPORTANT -- what these counts mean:
    //   Counts are UNIQUE CONTACTS TOUCHED in each category within the window,
    //   not raw send/event volume. HubSpot's per-event email API 504s at high
    //   send volume so we derive counts from contact properties and engagements.
    //
    // Outbound: emailsSent, sequencesStarted, callsLogged, meetingsLogged, notesLogged
    // Inbound:  repliesReceived, linksClicked, emailsOpened
    //
    // Team scope: fans out contact-property queries across all owner IDs and sums counts.
    if (method === "GET" && path === "/activity") {
      try {
        const days  = [7, 14, 30, 90].includes(parseInt(qp.days, 10))
          ? parseInt(qp.days, 10)
          : 7;
        const scope    = qp.scope === "team" ? "team" : "me";
        const since    = Date.now() - days * 24 * 60 * 60 * 1000;
        const sinceISO = new Date(since).toISOString();

        // Resolve owner IDs for the scope
        let ownerIds = [String(user.ownerId || user.userId)];
        if (scope === "team") {
          try {
            const ownersData = await hsGet(user.userId, "/crm/v3/owners", { limit: 100 });
            ownerIds = (ownersData.results || []).map(o => String(o.id)).filter(Boolean);
          } catch { /* fall back to current user */ }
        }

        // Count contacts matching a date property filter for a given owner.
        // Uses limit:1 and reads data.total -- no need to fetch actual records.
        async function countContactsByProp(dateProp, ownerId) {
          try {
            const data = await hsPost(user.userId, "/crm/v3/objects/contacts/search", {
              filterGroups: [{
                filters: [
                  { propertyName: "hubspot_owner_id", operator: "EQ",  value: ownerId },
                  { propertyName: dateProp,           operator: "GTE", value: sinceISO },
                ],
              }],
              properties: ["hubspot_owner_id"],
              limit: 1,
            });
            return data.total || 0;
          } catch {
            return 0;
          }
        }

        // Count contacts where EITHER of two date props falls in the window (OR logic).
        async function countContactsEitherProp(propA, propB, ownerId) {
          try {
            const data = await hsPost(user.userId, "/crm/v3/objects/contacts/search", {
              filterGroups: [
                { filters: [
                  { propertyName: "hubspot_owner_id", operator: "EQ",  value: ownerId },
                  { propertyName: propA,              operator: "GTE", value: sinceISO },
                ]},
                { filters: [
                  { propertyName: "hubspot_owner_id", operator: "EQ",  value: ownerId },
                  { propertyName: propB,              operator: "GTE", value: sinceISO },
                ]},
              ],
              properties: ["hubspot_owner_id"],
              limit: 1,
            });
            return data.total || 0;
          } catch {
            return 0;
          }
        }

        // Fan out all contact-property counts across all owners in parallel
        const ownerResults = await Promise.all(ownerIds.map(async (ownerId) => {
          const [emailsSent, sequencesStarted, replies, clicks, opens] = await Promise.all([
            countContactsEitherProp("hs_email_last_send_date", "hs_last_email_activity_date", ownerId),
            countContactsByProp("hs_latest_sequence_enrolled_date", ownerId),
            countContactsEitherProp("hs_email_last_reply_date", "hs_sales_email_last_replied", ownerId),
            countContactsEitherProp("hs_email_last_click_date", "hs_sales_email_last_clicked", ownerId),
            countContactsEitherProp("hs_email_last_open_date",  "hs_sales_email_last_opened",  ownerId),
          ]);
          return { ownerId, emailsSent, sequencesStarted, replies, clicks, opens };
        }));

        // Engagements: calls, meetings, notes -- one paginated fetch, grouped by owner
        const engByOwner = {};
        ownerIds.forEach(id => { engByOwner[id] = { calls: 0, meetings: 0, notes: 0 }; });
        const engTotals = { calls: 0, meetings: 0, notes: 0 };
        const ownerSet  = new Set(ownerIds);

        try {
          let hasMore = true;
          let offset  = 0;
          while (hasMore && offset < 2000) { // cap at 2000 to stay within Netlify timeout
            const engData = await hsGet(user.userId, "/engagements/v1/engagements/paged", {
              limit: 250, offset, since,
            }).catch(() => ({ results: [], hasMore: false }));

            for (const eng of (engData.results || [])) {
              const ts      = eng.engagement?.createdAt || 0;
              const ownerId = String(eng.engagement?.ownerId || "");
              const type    = eng.engagement?.type || "";
              if (ts < since) continue;
              if (scope === "me" && !ownerSet.has(ownerId)) continue;

              const bucket = engByOwner[ownerId] || (engByOwner[ownerId] = { calls: 0, meetings: 0, notes: 0 });
              if (type === "CALL")    { engTotals.calls++;    bucket.calls++;    }
              if (type === "MEETING") { engTotals.meetings++; bucket.meetings++; }
              if (type === "NOTE")    { engTotals.notes++;    bucket.notes++;    }
            }

            hasMore = engData.hasMore && (engData.results || []).length === 250;
            offset += (engData.results || []).length;
          }
        } catch { /* engagement counts fall back to 0 */ }

        // Sum totals across all owners
        const totals = ownerResults.reduce((acc, r) => {
          acc.emailsSent       += r.emailsSent;
          acc.sequencesStarted += r.sequencesStarted;
          acc.replies          += r.replies;
          acc.clicks           += r.clicks;
          acc.opens            += r.opens;
          return acc;
        }, { emailsSent: 0, sequencesStarted: 0, replies: 0, clicks: 0, opens: 0 });

        const summary = {
          outbound: {
            emailsSent:       totals.emailsSent,
            sequencesStarted: totals.sequencesStarted,
            callsLogged:      engTotals.calls,
            meetingsLogged:   engTotals.meetings,
            notesLogged:      engTotals.notes,
          },
          inbound: {
            repliesReceived: totals.replies,
            linksClicked:    totals.clicks,
            emailsOpened:    totals.opens,
          },
        };

        // Per-owner breakdown for team scope
        const byOwner = scope === "team"
          ? Object.fromEntries(ownerIds.map(id => {
              const r = ownerResults.find(x => x.ownerId === id) || {};
              return [id, {
                outbound: {
                  emailsSent:       r.emailsSent       || 0,
                  sequencesStarted: r.sequencesStarted || 0,
                  callsLogged:      engByOwner[id]?.calls    || 0,
                  meetingsLogged:   engByOwner[id]?.meetings || 0,
                  notesLogged:      engByOwner[id]?.notes    || 0,
                },
                inbound: {
                  repliesReceived: r.replies || 0,
                  linksClicked:    r.clicks  || 0,
                  emailsOpened:    r.opens   || 0,
                },
              }];
            }))
          : null;

        return ok({
          summary,
          byOwner,
          meta: {
            days,
            scope,
            since:    sinceISO,
            ownerIds,
            note: "Counts represent unique contacts touched, not total send or event volume.",
          },
        });

      } catch (err) {
        console.error("[activity] Error:", err.message);
        return error(500, `Activity error: ${err.message}`);
      }
    }

    if (method === "GET" && path === "/signals") {
      try {
      const hours      = Math.min(parseInt(qp.hours || "2880", 10), 2880);
      const since      = Date.now() - hours * 60 * 60 * 1000;
      const sinceISO   = new Date(since).toISOString();
      const includeBots = qp.includeBots === "true";

      // Build filter groups -- use OR logic across multiple date properties
      // so we catch contacts active via marketing emails, sequences, AND 1:1 sales emails.
      // HubSpot sequences update hs_last_sales_activity_date, not hs_last_email_activity_date.
      // Marketing emails update hs_email_last_send_date.
      // Sales / 1:1 emails update hs_sales_email_last_opened / clicked / replied.
      // We run one search per date property and merge results.
      const customFilters = buildCustomFilters(qp);

      const activityDateProps = [
        "hs_last_email_activity_date",    // 1:1 sales emails, general activity
        "hs_email_last_send_date",         // marketing + sequence sends
        "hs_last_sales_activity_date",     // sequence steps, calls, meetings
        "hs_sales_email_last_opened",      // 1:1 sales email opens
        "hs_sales_email_last_replied",     // 1:1 sales email replies
      ];

      // Run all three searches in parallel for maximum coverage
      const searchResults = await Promise.all(
        activityDateProps.map(prop =>
          hsPost(user.userId, "/crm/v3/objects/contacts/search", {
            filterGroups: [{ filters: [
              { propertyName: prop, operator: "GTE", value: sinceISO },
              ...customFilters,
            ]}],
            properties: BASE_CONTACT_PROPS,
            sorts:      [{ propertyName: prop, direction: "DESCENDING" }],
            limit:      100,
          }).catch(() => ({ results: [] }))
        )
      );

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
          new Date(a.properties?.hs_last_email_activity_date  || 0).getTime(),
          new Date(a.properties?.hs_email_last_send_date      || 0).getTime(),
          new Date(a.properties?.hs_last_sales_activity_date  || 0).getTime(),
          new Date(a.properties?.hs_sales_email_last_opened   || 0).getTime(),
          new Date(a.properties?.hs_sales_email_last_replied  || 0).getTime(),
        );
        const dateB = Math.max(
          new Date(b.properties?.hs_last_email_activity_date  || 0).getTime(),
          new Date(b.properties?.hs_email_last_send_date      || 0).getTime(),
          new Date(b.properties?.hs_last_sales_activity_date  || 0).getTime(),
          new Date(b.properties?.hs_sales_email_last_opened   || 0).getTime(),
          new Date(b.properties?.hs_sales_email_last_replied  || 0).getTime(),
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
        const botCheck = detectBot({
          filteredEvent: false,
          sentAt:    mktSendTs || null,
          openedAt:  botOpenTs || null,
          numOpens:  openTs > 0  ? 1 : 0,
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
      // (e.g. calls, meetings, notes which don't affect hs_last_email_activity_date)
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

      const response = {
        signals: finalReal,
        meta: {
          total:             finalReal.length,
          suspectedBotCount: finalBots.length,
          hoursSearched:     hours,
          activeFilters: {
            assigned_bdr:                    qp.assigned_bdr || null,
            territory:                       qp.territory    || null,
            priority_tier__bdr:              qp.priority_tier__bdr || null,
            target_account__bdr_led_outreach:qp.target_account__bdr_led_outreach || null,
          },
          botSummary: finalBots.length > 0
            ? `${finalBots.length} open event${finalBots.length > 1 ? "s" : ""} filtered as likely bot scan`
            : null,
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
