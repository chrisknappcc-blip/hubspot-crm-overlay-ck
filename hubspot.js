// netlify/functions/hubspot.js
// Routes:
//   GET  /hubspot/auth/connect            → redirect to HubSpot OAuth
//   GET  /hubspot/auth/callback           → exchange code, store tokens
//   GET  /hubspot/status                  → check which services are connected
//   GET  /hubspot/contacts                → list contacts
//   GET  /hubspot/contacts/:id            → single contact detail + engagements
//   GET  /hubspot/signals                 → ranked intent signals (bot-filtered)
//   GET  /hubspot/feed/:contactId         → full merged activity feed for a contact
//                                           (engagements + timeline events + sequences
//                                            + lifecycle changes, merged and sorted)
//   GET  /hubspot/feed/team               → activity feed across all contacts (team view)
//   POST /hubspot/activity                → log a note/call/meeting to a contact

import { withAuth } from "./utils/auth.js";
import { getTokens, setTokens, isTokenValid } from "./utils/tokenStore.js";

const HS_CLIENT_ID     = process.env.HUBSPOT_CLIENT_ID;
const HS_CLIENT_SECRET = process.env.HUBSPOT_CLIENT_SECRET;
const HS_REDIRECT_URI  = process.env.HUBSPOT_REDIRECT_URI;
const HS_API           = "https://api.hubapi.com";

// Scopes needed for full activity feed + signals access.
// NOTE: If you already authorized with the old scope list, each user must
// re-authorize by visiting /hubspot/auth/connect again after deploying this.
const HS_SCOPES = [
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.objects.deals.read",
  "timeline",           // read/write native + custom timeline events
  "sales-email-read",   // 1:1 sales email open/click/reply metadata
  "crm.lists.read",     // sequence enrollment lists
  "automation",         // sequence enrollment status
].join(" ");


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
// Pulls from four separate HubSpot APIs and normalizes into one unified shape.

// 1. Classic engagements: emails, calls, meetings, notes logged by reps
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
    return []; // fail gracefully — don't break the whole feed
  }
}

// 2. CRM Timeline Events: sequence steps, form fills, page views,
//    workflow triggers, and custom events from integrations
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
      contactId: null, // already scoped to this contact
    }));
  } catch {
    return [];
  }
}

// 3. Sequence enrollments: which sequences the contact is/was in,
//    current step, and enrollment state
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

// 4. Lifecycle stage + lead status history from property change log
async function fetchLifecycleHistory(userId, contactId) {
  try {
    const data = await hsGet(
      userId,
      `/crm/v3/objects/contacts/${contactId}`,
      {
        properties:              "lifecyclestage,hs_lead_status",
        propertiesWithHistory:   "lifecyclestage,hs_lead_status",
      }
    );

    const history = [];

    (data.propertiesWithHistory?.lifecyclestage || []).forEach((h) => {
      history.push({
        source:    "lifecycle",
        id:        `lc-${h.timestamp}-${h.value}`,
        type:      "LIFECYCLE_CHANGE",
        timestamp: h.timestamp,
        subject:   `Lifecycle stage → ${h.value}`,
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
        subject:   `Lead status → ${h.value}`,
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

// Merge all four sources, sort newest-first, deduplicate by id
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


// ─── Bot detection ────────────────────────────────────────────────────────────
// Identifies likely security-scanner opens using layered behavioral heuristics.
// Returns { isBot, confidence, reasons[] }
//
// Five signals (none conclusive alone):
//   1. HubSpot's filteredEvent flag  (known bot IP list)
//   2. Time-to-open < 10s            (scanners fire on delivery)
//   3. Opens with 0 clicks + no reply
//   4. 4+ opens, 0 clicks            (burst/retry scanner pattern)
//   5. Off-hours open, no follow-on  (low confidence)

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
    reasons.push(`${item.numOpens} opens, 0 clicks — burst pattern`);
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
  if (hardSignals >= 1)      confidence = "high";
  else if (softSignals >= 2) confidence = "medium";
  else if (softSignals === 1) confidence = "low";

  return { isBot: confidence === "high" || confidence === "medium", confidence, reasons };
}


// ─── Signal scoring ───────────────────────────────────────────────────────────
// Unified scorer across all activity feed sources.
//
// Weights:
//   Reply / sequence reply        = 100
//   Click                         = 60 + 5/extra click
//   Sequence completed            = 50
//   Lifecycle / lead status move  = 45
//   Open (human)                  = 30 + 10/open
//   Sequence enrolled (active)    = 20
//   Timeline event (form, page)   = 15
//   Other engagement (call, note) = 25
//   Open (suspected bot)          → bots[] unless includeBots=true

function scoreAllSignals(feedItems, includeBots = false) {
  const real = [];
  const bots = [];

  for (const item of feedItems) {
    let score = 0;
    let label = "";

    if (item.source === "engagement" && item.type === "EMAIL") {
      if (item.replied)            { score = 100; label = "Replied"; }
      else if (item.numClicks > 0) { score = 60 + item.numClicks * 5; label = `Clicked link${item.numClicks > 1 ? ` ${item.numClicks}x` : ""}`; }
      else if (item.numOpens > 0)  { score = 30 + item.numOpens * 10; label = `Opened${item.numOpens > 1 ? ` ${item.numOpens}x` : ""}`; }

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

    // CALL, MEETING, NOTE — always real, moderate score
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


// ─── Main router ──────────────────────────────────────────────────────────────

export const handler = withAuth(async (event, context, user) => {
  const path   = event.path.replace("/.netlify/functions/hubspot", "");
  const method = event.httpMethod;
  const qp     = event.queryStringParameters || {};

  // ── OAuth: start connect ───────────────────────────────────────────────────
  if (method === "GET" && path === "/auth/connect") {
    const url = new URL("https://app.hubspot.com/oauth/authorize");
    url.searchParams.set("client_id",    HS_CLIENT_ID);
    url.searchParams.set("redirect_uri", HS_REDIRECT_URI);
    url.searchParams.set("scope",        HS_SCOPES);
    url.searchParams.set("state",        user.userId);
    return { statusCode: 302, headers: { Location: url.toString() }, body: "" };
  }

  // ── OAuth: callback ────────────────────────────────────────────────────────
  if (method === "GET" && path === "/auth/callback") {
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
    if (!res.ok) return error(400, "Token exchange failed");
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
      headers: { Location: process.env.APP_URL + "?connected=hubspot" },
      body: "",
    };
  }

  // ── Connection status ──────────────────────────────────────────────────────
  if (method === "GET" && path === "/status") {
    const tokens = await getTokens(user.userId);
    return ok({
      hubspot:   !!tokens.hubspot?.access_token,
      microsoft: !!tokens.microsoft?.access_token,
    });
  }

  // ── Contacts list ──────────────────────────────────────────────────────────
  if (method === "GET" && path === "/contacts") {
    const data = await hsGet(user.userId, "/crm/v3/objects/contacts", {
      limit: 100,
      properties: "firstname,lastname,email,company,jobtitle,phone,hs_lead_status,hubspot_owner_id,notes_last_contacted,num_contacted_notes,lifecyclestage",
      associations: "deals",
    });
    return ok({ contacts: data.results, total: data.total });
  }

  // ── Single contact ─────────────────────────────────────────────────────────
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

  // ── Full merged activity feed for a contact ────────────────────────────────
  // GET /hubspot/feed/:contactId
  // ?sources=engagements,timeline,sequences,lifecycle  (default: all)
  // ?types=EMAIL,SEQUENCE_ENROLLMENT                   (optional type filter)
  if (method === "GET" && path.startsWith("/feed/") && path !== "/feed/team") {
    const contactId = path.split("/feed/")[1];
    const sources   = (qp.sources || "engagements,timeline,sequences,lifecycle").split(",");

    const [engagements, timelineEvents, sequences, lifecycle] = await Promise.all([
      sources.includes("engagements") ? fetchEngagements(user.userId, contactId)         : Promise.resolve([]),
      sources.includes("timeline")    ? fetchTimelineEvents(user.userId, contactId)      : Promise.resolve([]),
      sources.includes("sequences")   ? fetchSequenceEnrollments(user.userId, contactId) : Promise.resolve([]),
      sources.includes("lifecycle")   ? fetchLifecycleHistory(user.userId, contactId)    : Promise.resolve([]),
    ]);

    const feed = mergeFeed(engagements, timelineEvents, sequences, lifecycle);

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

  // ── Team activity feed ─────────────────────────────────────────────────────
  // GET /hubspot/feed/team
  // ?hours=24   lookback window (default 24, max 168)
  // ?limit=50   max items (default 50, max 200)
  // ?showBots=true   include suspected bot signals in response
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

  // ── Signals: ranked intent across all contacts ─────────────────────────────
  // GET /hubspot/signals
  // ?hours=48          lookback (default 48, max 168)
  // ?includeBots=true  skip filtering (still tags each signal)
  // ?showBots=true     include suspectedBotSignals[] in response
  if (method === "GET" && path === "/signals") {
    const hours = Math.min(parseInt(qp.hours || "48", 10), 168);
    const since = Date.now() - hours * 60 * 60 * 1000;

    const data = await hsGet(user.userId, "/engagements/v1/engagements/paged", {
      limit: 100,
      since,
    });

    const items = (data.results || []).map((eng) => ({
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

    const { real, bots } = scoreAllSignals(items, qp.includeBots === "true");

    const contactIds = [...new Set(
      [...real, ...(qp.includeBots === "true" ? bots : [])]
        .slice(0, 30).map((s) => s.contactId).filter(Boolean)
    )];
    let contactMap = {};
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

  // ── Log activity to a contact ──────────────────────────────────────────────
  // POST /hubspot/activity
  // Body: { contactId, note, type? }   type: NOTE (default) | CALL | MEETING | EMAIL
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
});


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
