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
  "hs_email_last_open_date",
  "hs_email_last_click_date",
  "hs_email_last_reply_date",
  "hs_email_last_send_date",
  "hs_email_last_email_name",   // name of the last email sent to this contact
  "hs_sequences_actively_enrolled_count",
  "hs_sequence_name",           // name of active sequence if enrolled
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
    // Email activity timestamps
    lastEmailActivityDate: p.hs_last_email_activity_date || null,
    lastSalesActivityDate: p.hs_last_sales_activity_date || null,
    lastOpenDate:          p.hs_email_last_open_date     || null,
    lastClickDate:         p.hs_email_last_click_date    || null,
    lastReplyDate:         p.hs_email_last_reply_date    || null,
    lastSendDate:          p.hs_email_last_send_date     || null,
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
    // Returns all HubSpot users with their owner IDs for the filter dropdown
    if (method === "GET" && path === "/owners") {
      const data = await hsGet(user.userId, "/crm/v3/owners", { limit: 100 });
      const owners = (data.results || []).map(o => ({
        id:        o.id,
        firstName: o.firstName || "",
        lastName:  o.lastName  || "",
        email:     o.email     || "",
        name:      `${o.firstName || ""} ${o.lastName || ""}`.trim(),
      }));
      return ok({ owners });
    }

    // ── Contacts list (with custom property filters) ──────────────────────────
    if (method === "GET" && path === "/contacts") {
      const baseFilters = buildCustomFilters(qp);

      let contacts;
      if (baseFilters.length > 0) {
        // Use search API when filters are active
        const data = await hsPost(user.userId, "/crm/v3/objects/contacts/search", {
          filterGroups: [{ filters: baseFilters }],
          properties:   BASE_CONTACT_PROPS,
          sorts:        [{ propertyName: "lastname", direction: "ASCENDING" }],
          limit:        100,
        });
        contacts = data.results || [];
      } else {
        // Use list API when no filters (faster)
        const data = await hsGet(user.userId, "/crm/v3/objects/contacts", {
          limit:      100,
          properties: BASE_CONTACT_PROPS.join(","),
        });
        contacts = data.results || [];
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

    if (method === "GET" && path === "/signals") {
      try {
      const hours      = Math.min(parseInt(qp.hours || "2880", 10), 2880);
      const since      = Date.now() - hours * 60 * 60 * 1000;
      const sinceISO   = new Date(since).toISOString();
      const includeBots = qp.includeBots === "true";

      // Build filter groups -- use OR logic across multiple date properties
      // so we catch contacts active via marketing emails, sequences, AND 1:1 emails.
      // HubSpot sequences update hs_last_sales_activity_date, not hs_last_email_activity_date.
      // Marketing emails update hs_email_last_send_date.
      // We run one search per date property and merge results.
      const customFilters = buildCustomFilters(qp);

      const activityDateProps = [
        "hs_last_email_activity_date",   // 1:1 sales emails, general activity
        "hs_email_last_send_date",        // marketing + sequence sends
        "hs_last_sales_activity_date",    // sequence steps, calls, meetings
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
          new Date(a.properties?.hs_last_email_activity_date || 0).getTime(),
          new Date(a.properties?.hs_email_last_send_date     || 0).getTime(),
          new Date(a.properties?.hs_last_sales_activity_date || 0).getTime(),
        );
        const dateB = Math.max(
          new Date(b.properties?.hs_last_email_activity_date || 0).getTime(),
          new Date(b.properties?.hs_email_last_send_date     || 0).getTime(),
          new Date(b.properties?.hs_last_sales_activity_date || 0).getTime(),
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

      // Build signals from contact properties (covers all email types)
      const contactSignals = (recentContactsData.results || []).map(c => {
        const p    = c.properties || {};
        const info = contactMap[c.id];

        const replyTs = p.hs_email_last_reply_date  ? new Date(p.hs_email_last_reply_date).getTime()  : 0;
        const clickTs = p.hs_email_last_click_date  ? new Date(p.hs_email_last_click_date).getTime()  : 0;
        const openTs  = p.hs_email_last_open_date   ? new Date(p.hs_email_last_open_date).getTime()   : 0;
        const sendTs  = p.hs_email_last_send_date   ? new Date(p.hs_email_last_send_date).getTime()   : 0;

        let score = 0, label = "", primaryTs = null, eventType = "OPEN";

        if (replyTs > 0 && replyTs >= since) {
          score = 100; label = "Replied"; primaryTs = p.hs_email_last_reply_date; eventType = "REPLY";
        } else if (clickTs > 0 && clickTs >= since) {
          score = 70; label = "Clicked link"; primaryTs = p.hs_email_last_click_date; eventType = "CLICK";
        } else if (openTs > 0 && openTs >= since) {
          score = 40; label = "Opened"; primaryTs = p.hs_email_last_open_date; eventType = "OPEN";
        } else {
          return null;
        }

        // Build event chain in chronological order
        const eventChain = [];
        if (sendTs > 0)  eventChain.push({ type:"SENT",    timestamp: p.hs_email_last_send_date,  label:"Sent" });
        if (openTs > 0)  eventChain.push({ type:"OPENED",  timestamp: p.hs_email_last_open_date,  label:"Opened" });
        if (clickTs > 0) eventChain.push({ type:"CLICKED", timestamp: p.hs_email_last_click_date, label:"Clicked" });
        if (replyTs > 0) eventChain.push({ type:"REPLIED", timestamp: p.hs_email_last_reply_date, label:"Replied" });
        eventChain.sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));

        const botCheck = detectBot({
          filteredEvent: false,
          sentAt:    sendTs || null,
          openedAt:  openTs || null,
          numOpens:  openTs > 0 ? 1 : 0,
          numClicks: clickTs > 0 ? 1 : 0,
          replied:   replyTs > 0,
        });

        return {
          source:    "contact_activity",
          id:        `ca-${c.id}`,
          type:      eventType,
          timestamp: primaryTs,
          score,
          label,
          eventChain,
          contactId: c.id,
          contact:   info,
          botCheck,
          isBot:     botCheck.isBot && eventType === "OPEN",
          subject:   p.hs_email_last_email_name || p.hs_sequence_name || null,
          sentAt:    p.hs_email_last_send_date  || null,
          openedAt:  p.hs_email_last_open_date  || null,
          clickedAt: p.hs_email_last_click_date || null,
          repliedAt: p.hs_email_last_reply_date || null,
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

      const response = {
        signals: allReal,
        meta: {
          total:             allReal.length,
          suspectedBotCount: allBots.length,
          hoursSearched:     hours,
          activeFilters: {
            assigned_bdr:                    qp.assigned_bdr || null,
            territory:                       qp.territory    || null,
            priority_tier__bdr:              qp.priority_tier__bdr || null,
            target_account__bdr_led_outreach:qp.target_account__bdr_led_outreach || null,
          },
          botSummary: allBots.length > 0
            ? `${allBots.length} open event${allBots.length > 1 ? "s" : ""} filtered as likely bot scan`
            : null,
        },
      };
      if (qp.showBots === "true") {
        response.suspectedBotSignals = allBots.slice(0, 50);
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
