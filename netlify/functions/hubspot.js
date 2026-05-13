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
import { getTabsForUser, getAllTabsForUser, getRegistry, saveRegistry, getPersonalTabs, savePersonalTabs, slugify, fetchPageTitle } from "./utils/tabRegistry.js";

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
  // assigned_bdr: comma-separated BDR names (contacts filtered by assigned_bdr property)
  // owner_id: comma-separated HubSpot owner IDs (contacts filtered by hubspot_owner_id)
  // When both are present, we use OR logic (multiple filterGroups in caller)
  // When only one is present, single filter
  const bdrVals = qp.assigned_bdr
    ? decodeURIComponent(qp.assigned_bdr).split(',').map(s => s.trim()).filter(Boolean)
    : [];
  const ownerVals = qp.owner_id
    ? String(qp.owner_id).split(',').map(s => s.trim()).filter(Boolean)
    : [];

  const filters = [...baseFilters];

  // If we have both BDR names AND owner IDs, caller needs to handle OR logic
  // This function returns the BDR filter only -- owner filter returned separately
  if (bdrVals.length === 1) {
    filters.push({ propertyName: "assigned_bdr", operator: "EQ",  value:  bdrVals[0] });
  } else if (bdrVals.length > 1) {
    filters.push({ propertyName: "assigned_bdr", operator: "IN",  values: bdrVals   });
  }
  if (ownerVals.length === 1 && bdrVals.length === 0) {
    filters.push({ propertyName: "hubspot_owner_id", operator: "EQ",  value:  ownerVals[0] });
  } else if (ownerVals.length > 1 && bdrVals.length === 0) {
    filters.push({ propertyName: "hubspot_owner_id", operator: "IN",  values: ownerVals   });
  }

  // Other contact filters
  const OTHER_FILTERS = {
    territory:                       "territory",
    target_account__bdr_led_outreach:"target_account__bdr_led_outreach",
  };
  Object.entries(OTHER_FILTERS).forEach(([param, prop]) => {
    if (qp[param]) {
      const val = decodeURIComponent(qp[param]).trim();
      if (val) filters.push({ propertyName: prop, operator: "EQ", value: val });
    }
  });

  return filters;
}

// Builds filterGroups that handle OR between assigned_bdr and hubspot_owner_id
// Used when a mixed group (e.g. BDRs + VPs) is selected
function buildFilterGroups(qp, extraFilters = []) {
  const bdrVals = qp.assigned_bdr
    ? decodeURIComponent(qp.assigned_bdr).split(',').map(s => s.trim()).filter(Boolean)
    : [];
  const ownerVals = qp.owner_id
    ? String(qp.owner_id).split(',').map(s => s.trim()).filter(Boolean)
    : [];

  const baseExtra = extraFilters.filter(f => f.propertyName !== "assigned_bdr" && f.propertyName !== "hubspot_owner_id");

  if (bdrVals.length > 0 && ownerVals.length > 0) {
    // OR: either assigned_bdr matches OR hubspot_owner_id matches
    const bdrFilter = bdrVals.length === 1
      ? { propertyName: "assigned_bdr", operator: "EQ", value: bdrVals[0] }
      : { propertyName: "assigned_bdr", operator: "IN", values: bdrVals };
    const ownerFilter = ownerVals.length === 1
      ? { propertyName: "hubspot_owner_id", operator: "EQ", value: ownerVals[0] }
      : { propertyName: "hubspot_owner_id", operator: "IN", values: ownerVals };
    return [
      { filters: [...baseExtra, bdrFilter] },
      { filters: [...baseExtra, ownerFilter] },
    ];
  }
  // Single filter type
  return [{ filters: buildCustomFilters(qp, baseExtra) }];
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
        const baseFilters  = buildCustomFilters(qp);
        const filterGroups = buildFilterGroups(qp);
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
        // Logic: find contacts where a reply exists in the window AND no outbound
        // activity was sent AFTER the reply BY ANYONE (not just the selected rep).
        //
        // Owner-aware: fetch hubspot_owner_id on each contact. If the contact owner
        // (AE) sent activity after the reply, exclude it -- AE is handling it.
        // Selected rep filter (assigned_bdr) determines whose queue we're showing.

        // Build owner ID lookup from the known owner list for the portal
        const OWNER_NAME_TO_ID = {};
        try {
          const ownersData = await hsGet(user.userId, "/crm/v3/owners", { limit: 100 });
          for (const o of (ownersData.results || [])) {
            const name = `${o.firstName||""} ${o.lastName||""}`.trim();
            if (name) OWNER_NAME_TO_ID[name] = String(o.id);
          }
        } catch { /* use empty map */ }

        // assigned_bdr: comma-separated BDR names
        // owner_id: comma-separated owner IDs for non-BDR members
        const assignedBdrList = qp.assigned_bdr
          ? decodeURIComponent(qp.assigned_bdr).split(',').map(s => s.trim()).filter(Boolean)
          : [];
        const ownerIdList = qp.owner_id
          ? String(qp.owner_id).split(',').map(s => s.trim()).filter(Boolean)
          : [];

        // All selected owner IDs (from both bdr names and direct owner_id param)
        const selectedOwnerIds = [
          ...assignedBdrList.map(name => OWNER_NAME_TO_ID[name]).filter(Boolean),
          ...ownerIdList,
        ];
        const selectedRepOwnerId = selectedOwnerIds.length === 1 ? selectedOwnerIds[0] : null;

        // Build filter groups for replies -- OR between assigned_bdr and hubspot_owner_id
        const replyFilterGroups = buildFilterGroups(qp).flatMap(g => [
          { filters: [{ propertyName: "hs_sales_email_last_replied", operator: "GTE", value: sinceISO }, ...g.filters] },
          { filters: [{ propertyName: "hs_email_last_reply_date",    operator: "GTE", value: sinceISO }, ...g.filters] },
        ]);

        const repliesData = await hsPost(user.userId, "/crm/v3/objects/contacts/search", {
          filterGroups: replyFilterGroups,
          properties: [
            ...BASE_CONTACT_PROPS,
            "hs_sales_email_last_replied",
            "hs_email_last_reply_date",
            "hs_last_sales_activity_timestamp",
            "hs_email_last_send_date",
            "notes_last_contacted",
            "hubspot_owner_id",
          ],
          sorts:  [{ propertyName: "hs_sales_email_last_replied", direction: "DESCENDING" }],
          limit:  200,
        }).catch(() => ({ results: [] }));

        const repliesAwaitingResponse = (repliesData.results || [])
          .map(c => {
            const p = c.properties || {};
            const salesReplyTs = p.hs_sales_email_last_replied ? new Date(p.hs_sales_email_last_replied).getTime() : 0;
            const mktReplyTs   = p.hs_email_last_reply_date    ? new Date(p.hs_email_last_reply_date).getTime()    : 0;
            const replyTs      = Math.max(salesReplyTs, mktReplyTs);
            if (replyTs === 0) return null;
            const replyDate = replyTs === salesReplyTs ? p.hs_sales_email_last_replied : p.hs_email_last_reply_date;

            // Check all available activity timestamps on the contact
            const lastActivityTs = Math.max(
              p.hs_last_sales_activity_timestamp ? new Date(p.hs_last_sales_activity_timestamp).getTime() : 0,
              p.hs_email_last_send_date           ? new Date(p.hs_email_last_send_date).getTime()           : 0,
              p.notes_last_contacted              ? new Date(p.notes_last_contacted).getTime()              : 0,
            );

            // If ANY activity happened after the reply, someone responded -- exclude
            if (lastActivityTs > replyTs) return null;

            // Get contact owner info
            const contactOwnerId   = p.hubspot_owner_id || null;
            const contactOwnerName = contactOwnerId
              ? Object.entries(OWNER_NAME_TO_ID).find(([, id]) => id === String(contactOwnerId))?.[0] || null
              : null;

            // If specific reps are selected, exclude contacts owned by anyone not in the list
            if (selectedOwnerIds.length > 0 && contactOwnerId && !selectedOwnerIds.includes(String(contactOwnerId))) {
              return null;
            }

            const info = normalizeContact(c);
            return {
              contactId:        c.id,
              contact:          info,
              replyDate,
              contactOwner:     contactOwnerName,
              isOwnedBySelected: selectedRepOwnerId ? String(contactOwnerId) === selectedRepOwnerId : false,
              lastOutboundDate: lastActivityTs > 0 ? new Date(lastActivityTs).toISOString() : null,
              waitingHours:     Math.round((now - replyTs) / (1000 * 60 * 60)),
              subject:          p.hs_email_last_email_name || null,
              url: `https://app.hubspot.com/contacts/39921549/record/0-1/${c.id}`,
            };
          })
          .filter(Boolean)
          .sort((a, b) => new Date(b.replyDate) - new Date(a.replyDate));

        // ── Section 2: Upcoming sequences (currently enrolled) ────────────────
        const seqFilterGroups = buildFilterGroups(qp, [
          { propertyName: "hs_sequences_is_enrolled", operator: "EQ", value: "true" },
        ]);
        const sequencesData = await hsPost(user.userId, "/crm/v3/objects/contacts/search", {
          filterGroups: seqFilterGroups,
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
        // Look up the current user's HubSpot owner ID for task filtering
        let ownerIdForTasks = user.ownerId || null;
        if (!ownerIdForTasks) {
          try {
            const meData = await hsGet(user.userId, "/crm/v3/owners/me", {});
            ownerIdForTasks = meData?.id || null;
          } catch { /* use null */ }
        }

        // If assigned_bdr filter is set, also look up that rep's owner ID
        const repName = qp.assigned_bdr ? decodeURIComponent(qp.assigned_bdr).trim() : null;
        let repOwnerId = ownerIdForTasks;
        if (repName) {
          try {
            const ownersData = await hsGet(user.userId, "/crm/v3/owners", { limit: 100 });
            const match = (ownersData.results || []).find(o =>
              `${o.firstName||""} ${o.lastName||""}`.trim() === repName
            );
            if (match?.id) repOwnerId = match.id;
          } catch { /* fall back to current user */ }
        }

        const taskOwnerFilter = repOwnerId
          ? [{ propertyName: "hubspot_owner_id", operator: "EQ", value: String(repOwnerId) }]
          : [];
        const [upcomingTasksData, overdueTasksData] = await Promise.all([
          hsPost(user.userId, "/crm/v3/objects/tasks/search", {
            filterGroups: [{
              filters: [
                ...taskOwnerFilter,
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
                ...taskOwnerFilter,
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
        const KNOWN_BDRS = ["Chris Knapp", "Chiara Pate", "Matt Valin", "Joseph Haine", "Tim Grisham", "Irene Wong", "Cole Hooper", "John Hansel"];
        const BDR_NAMES  = ["Chris Knapp", "Chiara Pate"]; // filter by assigned_bdr
        const OWNER_ID_MAP = {
          "Matt Valin":    "76104455",
          "Joseph Haine":  "55217954",
          "Tim Grisham":   "83862037",
          "Irene Wong":    "289209454",
          "Cole Hooper":   "85819247",
          "John Hansel":   "743772047",
        };
        const targetReps = repFilter ? [repFilter] : KNOWN_BDRS;

        // Count contacts with dateProp >= since, filtered by rep (assigned_bdr or owner_id)
        async function countForRep(dateProp, repName) {
          const ownerId = OWNER_ID_MAP[repName];
          const filter  = ownerId
            ? { propertyName: "hubspot_owner_id", operator: "EQ", value: ownerId }
            : { propertyName: "assigned_bdr",     operator: "EQ", value: repName };
          try {
            const data = await hsPost(user.userId, "/crm/v3/objects/contacts/search", {
              filterGroups: [{ filters: [
                filter,
                { propertyName: dateProp, operator: "GTE", value: sinceISO },
              ]}],
              properties: ["assigned_bdr"],
              limit: 1,
            });
            return data.total || 0;
          } catch (err) {
            console.error(`[activity] countForRep ${dateProp} ${repName}:`, err.message);
            return 0;
          }
        }

        // Count contacts where EITHER propA or propB >= since, filtered by rep
        async function countEitherForRep(propA, propB, repName) {
          const ownerId = OWNER_ID_MAP[repName];
          const filter  = ownerId
            ? { propertyName: "hubspot_owner_id", operator: "EQ", value: ownerId }
            : { propertyName: "assigned_bdr",     operator: "EQ", value: repName };
          try {
            const data = await hsPost(user.userId, "/crm/v3/objects/contacts/search", {
              filterGroups: [
                { filters: [filter, { propertyName: propA, operator: "GTE", value: sinceISO }] },
                { filters: [filter, { propertyName: propB, operator: "GTE", value: sinceISO }] },
              ],
              properties: ["assigned_bdr"],
              limit: 1,
            });
            return data.total || 0;
          } catch (err) {
            console.error(`[activity] countEitherForRep ${propA}/${propB} ${repName}:`, err.message);
            return 0;
          }
        }

        // Run counts SEQUENTIALLY per rep and per query to stay within rate limits.
        // 8 reps × 5 queries = 40 calls -- sequential with gaps avoids 429s.
        const repResults = [];
        for (const repName of targetReps) {
          const emailsSent        = await countEitherForRep("hs_email_last_send_date", "hs_last_sales_activity_timestamp", repName);
          await new Promise(r => setTimeout(r, 150));
          const sequencesStarted  = await countForRep("hs_latest_sequence_enrolled_date", repName);
          await new Promise(r => setTimeout(r, 150));
          const replies           = await countEitherForRep("hs_email_last_reply_date", "hs_sales_email_last_replied", repName);
          await new Promise(r => setTimeout(r, 150));
          const clicks            = await countEitherForRep("hs_email_last_click_date", "hs_sales_email_last_clicked", repName);
          await new Promise(r => setTimeout(r, 150));
          const opens             = await countEitherForRep("hs_email_last_open_date", "hs_sales_email_last_opened", repName);
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
      const filterGroups  = buildFilterGroups(qp);

      const activityDateProps = [
        "hs_email_last_send_date",         // marketing + sequence sends
        "hs_email_last_open_date",         // marketing email opens
        "hs_email_last_click_date",        // marketing email clicks
        "hs_last_sales_activity_timestamp",// sequence steps, calls, meetings (valid property)
        "hs_sales_email_last_opened",      // 1:1 sales email opens
        "hs_sales_email_last_replied",     // 1:1 sales email replies
      ];

      // Run searches SEQUENTIALLY with 300ms gaps and automatic retry on 429.
      // 150ms was insufficient when concurrent routes (gold, contacts) fire simultaneously
      // and share the same HubSpot per-second rate limit bucket.
      const searchResults = [];
      for (const prop of activityDateProps) {
        const dateFilter = { propertyName: prop, operator: "GTE", value: sinceISO };
        // Build filterGroups: add date filter to each group from buildFilterGroups
        const fGroups = filterGroups.map(g => ({
          filters: [dateFilter, ...g.filters],
        }));
        let attempts = 0;
        while (attempts < 2) {
          try {
            const result = await hsPost(user.userId, "/crm/v3/objects/contacts/search", {
              filterGroups: fGroups,
              properties: BASE_CONTACT_PROPS,
              sorts:      [{ propertyName: prop, direction: "DESCENDING" }],
              limit:      perPropLimit,
            });
            searchResults.push({ ...result, _prop: prop });
            console.log(`[signals] prop=${prop} returned=${(result.results||[]).length} total=${result.total||0} filters=${JSON.stringify(fGroups)}`);
            break;
          } catch (err) {
            attempts++;
            const is429 = err.message?.includes("429");
            if (is429 && attempts < 2) {
              console.log(`[signals] 429 on ${prop}, retrying after 1s...`);
              await new Promise(r => setTimeout(r, 1000));
            } else {
              console.error(`[signals] search failed for prop ${prop}:`, err.message);
              searchResults.push({ results: [], total: 0, _prop: prop });
              break;
            }
          }
        }
        await new Promise(r => setTimeout(r, 300));
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

        // Scanner rule: if open AND click both happen within 90 seconds of send,
        // it's almost certainly a security scanner regardless of event type.
        // (Gina/Nicole pattern: sent 1:27, opened 1:28, clicked 1:28 = scanner)
        const sendTs = mktSendTs || 0;
        const openClickGap = sendTs > 0 && botOpenTs > 0 && clickTs > 0
          ? Math.max(botOpenTs - sendTs, clickTs - sendTs) / 1000
          : null;
        const isScannerClick = openClickGap !== null && openClickGap < 90;

        // For contact-property signals, pass actual open timestamp so time-to-open
        // check fires. Keep numOpens: 0 to disable history-based burst checks.
        const botCheck = detectBot({
          filteredEvent: false,
          sentAt:    mktSendTs ? new Date(mktSendTs).toISOString() : null,
          openedAt:  botOpenTs ? new Date(botOpenTs).toISOString() : null,
          numOpens:  0,   // keep 0 to disable burst-pattern checks
          numClicks: clickTs > 0 ? 1 : 0,
          replied:   replyTs > 0,
        });

        // Mark as bot if: time-based scanner detected on opens, OR
        // open+click both within 90 seconds of send (scanner click pattern)
        const isBotSignal = (botCheck.isBot && eventType === "OPEN") ||
                            (isScannerClick && !replyTs);

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
          isBot:       isBotSignal,
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
        const tabs = await getAllTabsForUser(user.userId);
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
      try {
        const body = JSON.parse(event.body || "{}");
        console.log("[tabs] POST body:", JSON.stringify(body));
        const { url, label, badge, allowedUsers, enabled = true, type = "iframe" } = body;
        const isPersonal = body.personal === true;

        if (!url)   return error(400, "url is required");
        if (!label) return error(400, "label is required");
        if (!["iframe","link"].includes(type)) return error(400, "type must be iframe or link");
        try { new URL(url); } catch { return error(400, "Invalid URL"); }

        // Personal tabs: any user can create. Shared tabs: admin only.
        if (!isPersonal && !ADMIN_USER_IDS.has(user.userId)) {
          return error(403, "Admin only for shared tabs");
        }

        const now = new Date().toISOString();
        const id  = body.id || slugify(label);
        const tab = {
          id,
          label:        label.trim().slice(0, 40),
          url:          url.trim(),
          type,
          enabled,
          allowedUsers: isPersonal ? [user.userId] : (allowedUsers || []),
          badge:        badge || null,
          addedBy:      user.userId,
          personal:     isPersonal,
          createdAt:    now,
          updatedAt:    now,
        };

        if (isPersonal) {
          console.log("[tabs] saving personal tab for user:", user.userId);
          const personal = await getPersonalTabs(user.userId);
          const existing = personal.findIndex(t => t.id === id);
          if (existing >= 0) {
            personal[existing] = { ...tab, createdAt: personal[existing].createdAt };
          } else {
            personal.push(tab);
          }
          await savePersonalTabs(user.userId, personal);
        } else {
          console.log("[tabs] saving shared tab, admin:", ADMIN_USER_IDS.has(user.userId));
          const registry = await getRegistry();
          const existing = registry.findIndex(t => t.id === id);
          if (existing >= 0) {
            registry[existing] = { ...tab, createdAt: registry[existing].createdAt };
          } else {
            registry.push(tab);
          }
          await saveRegistry(registry);
        }

        return ok({ tab, action: "saved" });
      } catch (err) {
        console.error("[tabs] POST error:", err.message);
        return error(500, `Tab save error: ${err.message}`);
      }
    }

    if (method === "DELETE" && path.startsWith("/tabs/")) {
      const tabId     = path.split("/tabs/")[1];
      const isPersonal = qp.personal === "true";
      if (!tabId) return error(400, "Tab ID required");

      try {
        if (isPersonal) {
          // Any user can delete their own personal tabs
          const personal = await getPersonalTabs(user.userId);
          const filtered = personal.filter(t => t.id !== tabId);
          if (filtered.length === personal.length) return error(404, "Tab not found");
          await savePersonalTabs(user.userId, filtered);
          return ok({ deleted: tabId });
        } else {
          // Shared tabs: admin only
          if (!ADMIN_USER_IDS.has(user.userId)) return error(403, "Admin only");
          const registry = await getRegistry();
          const filtered = registry.filter(t => t.id !== tabId);
          if (filtered.length === registry.length) return error(404, "Tab not found");
          await saveRegistry(filtered);
          return ok({ deleted: tabId });
        }
      } catch (err) {
        console.error("[tabs] DELETE error:", err.message);
        return error(500, `Tab delete error: ${err.message}`);
      }
    }


    // ── Reports ───────────────────────────────────────────────────────────────
    // Tabs: email_activity | marketing | sequences | deals
    // Params: section, period (today|week|month|quarter|6months|year|alltime), rep
    //
    // HubSpot deep links use portal 39921549.
    // Dashboard: https://app.hubspot.com/reports-dashboard/39921549/view/19874520
    if (method === "GET" && path === "/reports") {
      try {
        const section = qp.section || "email_activity";
        const period  = qp.period  || "month";
        const rep     = qp.rep && qp.rep !== "all" ? decodeURIComponent(qp.rep).trim() : null;

        const PORTAL    = "39921549";
        const HS_BASE   = "https://app.hubspot.com";
        const DASHBOARD = `${HS_BASE}/reports-dashboard/${PORTAL}/view/19874520`;
        const CONTACTS_LIST = `${HS_BASE}/contacts/${PORTAL}/objects/0-1/views/all/list`;
        const DEALS_LIST    = `${HS_BASE}/contacts/${PORTAL}/objects/0-3/views/all/list`;
        const SEQUENCES     = `${HS_BASE}/sequences/${PORTAL}`;
        const MKT_EMAIL     = `${HS_BASE}/email/${PORTAL}/manage`;

        const now = Date.now();
        const PERIOD_MS = {
          today:   () => now - (now % 86400000),           // midnight today
          week:    () => now - 7   * 86400000,
          month:   () => now - 30  * 86400000,
          quarter: () => now - 90  * 86400000,
          "6months": () => now - 180 * 86400000,
          year:    () => now - 365 * 86400000,
          alltime: () => null,
        };
        const sinceMs  = (PERIOD_MS[period] ?? PERIOD_MS.month)();
        const sinceISO = sinceMs ? new Date(sinceMs).toISOString() : null;

        const KNOWN_BDRS = ["Chris Knapp", "Chiara Pate", "Matt Valin", "Joseph Haine", "Tim Grisham", "Irene Wong", "Cole Hooper", "John Hansel"];
        const repNames = rep
          ? rep.split(',').map(s => s.trim()).filter(Boolean)
          : [];
        const ownerIds = qp.owner_id
          ? String(qp.owner_id).split(',').map(s => s.trim()).filter(Boolean)
          : [];
        const targetReps = repNames.length > 0 ? repNames : KNOWN_BDRS;

        const bdrFilters = () => {
          if (repNames.length === 0 && ownerIds.length === 0) {
            return [{ propertyName: "assigned_bdr", operator: "IN", values: KNOWN_BDRS }];
          }
          if (repNames.length > 0 && ownerIds.length === 0) {
            return repNames.length === 1
              ? [{ propertyName: "assigned_bdr", operator: "EQ",  value:  repNames[0] }]
              : [{ propertyName: "assigned_bdr", operator: "IN",  values: repNames    }];
          }
          if (repNames.length === 0 && ownerIds.length > 0) {
            return ownerIds.length === 1
              ? [{ propertyName: "hubspot_owner_id", operator: "EQ",  value:  ownerIds[0] }]
              : [{ propertyName: "hubspot_owner_id", operator: "IN",  values: ownerIds    }];
          }
          // Both present -- caller must handle OR logic via filterGroups
          return [
            ...(repNames.length === 1
              ? [{ propertyName: "assigned_bdr", operator: "EQ", value: repNames[0] }]
              : [{ propertyName: "assigned_bdr", operator: "IN", values: repNames }]),
          ];
        };

        // Generic count helper
        const countC = async (filterGroups) => {
          try {
            const d = await hsPost(user.userId, "/crm/v3/objects/contacts/search", {
              filterGroups, properties: ["assigned_bdr"], limit: 1,
            });
            return d.total || 0;
          } catch (e) {
            console.error("[reports count]", e.message);
            return 0;
          }
        };

        // Count with single filterGroup
        const count1 = (filters) => countC([{ filters }]);

        // Count with OR across two date props (two filterGroups)
        const countOr = (propA, propB, extraFilters = []) => countC([
          { filters: [...extraFilters, { propertyName: propA, operator: sinceISO ? "GTE" : "HAS_PROPERTY", ...(sinceISO ? { value: sinceISO } : {}) }] },
          { filters: [...extraFilters, { propertyName: propB, operator: sinceISO ? "GTE" : "HAS_PROPERTY", ...(sinceISO ? { value: sinceISO } : {}) }] },
        ]);

        // Date filter for a property
        const df = (prop) => sinceISO
          ? [{ propertyName: prop, operator: "GTE", value: sinceISO }]
          : [{ propertyName: prop, operator: "HAS_PROPERTY" }];

        // Fetch contacts helper
        const fetchC = async (filterGroups, props, sortProp, limit = 100) => {
          try {
            const results = [];
            let after;
            while (results.length < limit) {
              const body = {
                filterGroups, properties: props,
                sorts: [{ propertyName: sortProp, direction: "DESCENDING" }],
                limit: Math.min(100, limit - results.length),
              };
              if (after) body.after = after;
              const d = await hsPost(user.userId, "/crm/v3/objects/contacts/search", body);
              results.push(...(d.results || []));
              if (!d.paging?.next?.after || (d.results||[]).length < 100) break;
              after = d.paging.next.after;
              await new Promise(r => setTimeout(r, 150));
            }
            console.log(`[reports fetchC] sortProp=${sortProp} returned=${results.length}`);
            return results;
          } catch (err) {
            console.error(`[reports fetchC] error: ${err.message}`);
            return [];
          }
        };

        // ── EMAIL ACTIVITY ────────────────────────────────────────────────────
        // Uses /email/public/v1/stats/by-event-type for SUM metrics matching
        // HubSpot's "Email Activity Results" report (sent, opens, clicks, replies).
        // Falls back to contact property counts if the stats API is unavailable.
        if (section === "email_activity") {
          const bdr = bdrFilters();

          // Run stats API attempt AND recent contacts fetch in parallel with rep counts
          const [emailStatsResult, recentContacts] = await Promise.all([
            // Try the email stats API -- returns SUM totals directly
            hsGet(user.userId, "/email/public/v1/stats/by-event-type",
              sinceISO ? { startTimestamp: sinceMs, endTimestamp: now } : {}
            ).then(d => { console.log("[reports email] stats API:", JSON.stringify(d).slice(0,200)); return d; })
              .catch(e => { console.log("[reports email] stats API unavailable:", e.message); return null; }),

            // Recent activity contacts (runs in parallel, not blocked by rep counts)
            fetchC(
              [{ filters: [...bdr, ...df("hs_email_last_send_date")] }],
              ["firstname","lastname","email","company","assigned_bdr",
               "hs_email_last_send_date","hs_email_last_email_name",
               "hs_email_last_open_date","hs_email_last_click_date",
               "hs_email_last_reply_date","hs_sales_email_last_replied"],
              "hs_email_last_send_date", 300
            ),
          ]);
          const emailStats = emailStatsResult;

          // Contact property counts (unique contacts) -- used for per-rep breakdown
          // and as fallback totals if the stats API is unavailable
          const repData = [];
          for (const repName of targetReps) {
            const rf = [{ propertyName: "assigned_bdr", operator: "EQ", value: repName }];
            const mf = (prop) => [...rf, ...df(prop)];
            const [sent, opens, clicks, mktReplies, salesReplies, seqs] = await Promise.all([
              count1(mf("hs_email_last_send_date")),
              count1(mf("hs_email_last_open_date")),
              count1(mf("hs_email_last_click_date")),
              count1(mf("hs_email_last_reply_date")),
              count1(mf("hs_sales_email_last_replied")),
              count1(mf("hs_latest_sequence_enrolled_date")),
            ]);
            const replies   = Math.max(mktReplies, salesReplies);
            repData.push({
              rep: repName, sent, opens, clicks, replies, sequences: seqs,
              openRate:  sent > 0 ? +((opens   / sent) * 100).toFixed(1) : 0,
              clickRate: sent > 0 ? +((clicks  / sent) * 100).toFixed(1) : 0,
              replyRate: sent > 0 ? +((replies / sent) * 100).toFixed(1) : 0,
            });
            await new Promise(r => setTimeout(r, 200));
          }

          // Team totals -- use stats API if available, otherwise sum rep data
          let T;
          if (emailStats && (emailStats.sent || emailStats.SENT)) {
            const s = emailStats;
            const totalSent    = s.sent    || s.SENT    || 0;
            const totalOpens   = s.open    || s.OPEN    || s.opens   || 0;
            const totalClicks  = s.click   || s.CLICK   || s.clicks  || 0;
            const totalReplies = s.reply   || s.REPLY   || s.replies || 0;
            T = {
              sent: totalSent, opens: totalOpens, clicks: totalClicks, replies: totalReplies,
              sequences: repData.reduce((a,r) => a + r.sequences, 0),
              openRate:  totalSent > 0 ? +((totalOpens   / totalSent) * 100).toFixed(1) : 0,
              clickRate: totalSent > 0 ? +((totalClicks  / totalSent) * 100).toFixed(1) : 0,
              replyRate: totalSent > 0 ? +((totalReplies / totalSent) * 100).toFixed(1) : 0,
              source: "stats_api",
            };
          } else {
            // Fall back to summing rep data (unique contacts, not raw event counts)
            T = repData.reduce((a, r) => ({
              sent:      a.sent      + r.sent,
              opens:     a.opens     + r.opens,
              clicks:    a.clicks    + r.clicks,
              replies:   a.replies   + r.replies,
              sequences: a.sequences + r.sequences,
            }), { sent:0, opens:0, clicks:0, replies:0, sequences:0 });
            T.openRate  = T.sent > 0 ? +((T.opens   / T.sent) * 100).toFixed(1) : 0;
            T.clickRate = T.sent > 0 ? +((T.clicks  / T.sent) * 100).toFixed(1) : 0;
            T.replyRate = T.sent > 0 ? +((T.replies / T.sent) * 100).toFixed(1) : 0;
            T.source    = "contact_properties";
          }

          return ok({
            section: "email_activity", period, rep: rep || "all",
            totals: T,
            byRep: repData,
            links: { dashboard: DASHBOARD, contacts: CONTACTS_LIST },
            recent: recentContacts.map(c => {
              const p = c.properties || {};
              const replyDate = p.hs_email_last_reply_date || p.hs_sales_email_last_replied || null;
              return {
                id: c.id, name: `${p.firstname||""} ${p.lastname||""}`.trim(),
                company: p.company || "", bdr: p.assigned_bdr || "",
                sent: p.hs_email_last_send_date || null,
                opened: p.hs_email_last_open_date || null,
                clicked: p.hs_email_last_click_date || null,
                replied: replyDate,
                emailName: p.hs_email_last_email_name || null,
                url: `${HS_BASE}/contacts/${PORTAL}/record/0-1/${c.id}`,
              };
            }),
          });
        }

        // ── MARKETING ─────────────────────────────────────────────────────────
        // /marketing/v3/emails returns email records (no stats).
        // Stats require a separate call to /marketing/v3/emails/{id}/statistics.
        // We fetch emails first, then batch-fetch stats for the ones in-period.
        if (section === "marketing") {

          // Owner ID → user ID map (same for Chris; may differ for others)
          // We match on createdById which equals userId in HubSpot
          const OWNER_TO_USER = {
            "78304576": "78304576", // Chris Knapp
            "87806380": "87806380", // Chiara Pate
          };
          const repUserId = rep ? (OWNER_TO_USER[
            // Look up owner ID from name
            Object.entries({ "Chris Knapp":"78304576","Chiara Pate":"87806380" })
              .find(([n]) => n === rep)?.[1] || ""
          ] || rep) : null;

          // Step 1: Fetch email list
          let allEmails = [];
          try {
            let after, fetched = 0;
            while (fetched < 200) {
              // Don't filter by state -- try fetching all and filter client-side
              // The v3 API state values are: DRAFT, SCHEDULED, PROCESSING, SENT, PUBLISHED, ARCHIVED
              const params = { limit: 50 };
              if (after) params.after = after;
              const d = await hsGet(user.userId, "/marketing/v3/emails", params);
              allEmails.push(...(d.results || []));
              fetched += (d.results || []).length;
              if (!d.paging?.next?.after || (d.results||[]).length < 50) break;
              after = d.paging.next.after;
            }
            console.log(`[reports mkt] fetched ${allEmails.length} sent emails`);
            if (allEmails.length > 0) {
              const s = allEmails[0];
              console.log("[reports mkt] sample fields:", Object.keys(s).join(", "));
              console.log("[reports mkt] sample:", JSON.stringify(s).slice(0,400));
            }
          } catch (e) {
            console.error("[reports mkt] email list error:", e.message);
          }

          // Filter to sent emails only, within period
          const SENT_STATES = ["SENT", "PUBLISHED"];
          const inPeriod = allEmails.filter(e => {
            // Only include sent/published emails
            if (e.state && !SENT_STATES.includes(e.state)) return false;
            const ts = e.publishDate || e.scheduledAt || e.sendDate || e.updatedAt || e.createdAt;
            if (sinceMs && ts && new Date(ts).getTime() < sinceMs) return false;
            return true;
          });
          console.log(`[reports mkt] ${inPeriod.length} sent emails in period (of ${allEmails.length} total)`);

          // Rep filter -- try createdById, authorId, userId, createdBy
          const inPeriodFiltered = repUserId
            ? inPeriod.filter(e => {
                const ids = [
                  String(e.createdById || ""),
                  String(e.authorId    || ""),
                  String(e.userId      || ""),
                  String(e.createdBy   || ""),
                  String(e.ownerId     || ""),
                ].filter(Boolean);
                return ids.some(id => id === repUserId);
              })
            : inPeriod;

          console.log(`[reports mkt] ${inPeriodFiltered.length} emails in period${rep ? ' for '+rep : ''}`);

          // Step 3: Fetch statistics via /email/public/v1/campaigns/{campaignId}
          // The /marketing/v3/emails/{id}/statistics endpoint returns 404 -- stats
          // live on the email campaign object. Each email has allEmailCampaignIds;
          // we use the first one to get send/open/click/reply counts.
          let totalSent = 0, totalOpened = 0, totalClicked = 0, totalReplied = 0;
          const campaigns = [];

          const emailsToStat = inPeriodFiltered.slice(0, 30);
          const statsResults = await Promise.all(
            emailsToStat.map(async e => {
              const campaignId = (e.allEmailCampaignIds || [])[0];
              if (!campaignId) return null;
              return hsGet(user.userId, `/email/public/v1/campaigns/${campaignId}`, {})
                .then(r => {
                  if (emailsToStat.indexOf(e) === 0) {
                    console.log("[reports mkt] campaign stats:", JSON.stringify(r).slice(0, 400));
                  }
                  return r;
                })
                .catch(err => {
                  if (emailsToStat.indexOf(e) === 0) {
                    console.error(`[reports mkt] campaign stats error:`, err.message);
                  }
                  return null;
                });
            })
          );

          for (let i = 0; i < emailsToStat.length; i++) {
            const e = emailsToStat[i];
            const stats = statsResults[i];

            // /email/public/v1/campaigns/{id} returns:
            // { counters: { sent, open, click, reply, unsubscribed, bounce, hardbounce, softbounce } }
            const counters = stats?.counters || {};

            const sent         = Number(counters.sent          || counters.delivered    || 0);
            const opened       = Number(counters.open          || counters.opens         || 0);
            const clicked      = Number(counters.click         || counters.clicks        || 0);
            const replied      = Number(counters.reply         || counters.replies       || 0);
            const unsubscribed = Number(counters.unsubscribed  || counters.unsubscribe   || 0);
            const hardbounced  = Number(counters.hardbounce    || counters.hardbounced   || 0);
            const softbounced  = Number(counters.softbounce    || counters.softbounced   || 0);
            const bounced      = Number(counters.bounce        || 0) || hardbounced + softbounced;

            totalSent    += sent;
            totalOpened  += opened;
            totalClicked += clicked;
            totalReplied += replied;

            campaigns.push({
              name:        e.name || e.subject || "Untitled",
              sent, opened, clicked, replied, unsubscribed, bounced, hardbounced, softbounced,
              openRate:        sent > 0 ? +((opened       / sent) * 100).toFixed(1) : 0,
              clickRate:       sent > 0 ? +((clicked      / sent) * 100).toFixed(1) : 0,
              replyRate:       sent > 0 ? +((replied      / sent) * 100).toFixed(1) : 0,
              unsubscribeRate: sent > 0 ? +((unsubscribed / sent) * 100).toFixed(1) : 0,
              bounceRate:      sent > 0 ? +((bounced      / sent) * 100).toFixed(1) : 0,
              publishDate: e.publishDate || e.publishedAt || e.scheduledAt || null,
              publishedBy: e.publishedByName || null,
              url: `${HS_BASE}/email/${PORTAL}/details/${e.id}/performance`,
            });
          }

          campaigns.sort((a, b) => {
            const tsA = a.publishDate ? new Date(a.publishDate).getTime() : 0;
            const tsB = b.publishDate ? new Date(b.publishDate).getTime() : 0;
            return tsB - tsA || b.sent - a.sent;
          });

          const openRate  = totalSent > 0 ? +((totalOpened  / totalSent) * 100).toFixed(1) : 0;
          const clickRate = totalSent > 0 ? +((totalClicked / totalSent) * 100).toFixed(1) : 0;
          const replyRate = totalSent > 0 ? +((totalReplied / totalSent) * 100).toFixed(1) : 0;

          // Per-rep breakdown
          const repData = [];
          for (const repName of targetReps) {
            const rUserId = OWNER_TO_USER[
              Object.entries({ "Chris Knapp":"78304576","Chiara Pate":"87806380" })
                .find(([n]) => n === repName)?.[1] || ""
            ] || "";
            const repEmails = rUserId
              ? inPeriod.filter(e => [
                  String(e.createdById || ""), String(e.authorId || ""),
                  String(e.userId || ""), String(e.createdBy || ""),
                ].some(id => id === rUserId))
              : [];
            let rSent = 0, rOpened = 0, rClicked = 0, rReplied = 0;
            for (let i = 0; i < emailsToStat.length; i++) {
              const e = emailsToStat[i];
              if (!repEmails.find(re => re.id === e.id)) continue;
              const counters = statsResults[i]?.counters || {};
              rSent    += Number(counters.sent   || counters.delivered || 0);
              rOpened  += Number(counters.open   || counters.opens     || 0);
              rClicked += Number(counters.click  || counters.clicks    || 0);
              rReplied += Number(counters.reply  || counters.replies   || 0);
            }
            repData.push({
              rep: repName, emailCount: repEmails.length,
              reached: rSent, opened: rOpened, clicked: rClicked, replied: rReplied,
              openRate:  rSent > 0 ? +((rOpened  / rSent) * 100).toFixed(1) : 0,
              clickRate: rSent > 0 ? +((rClicked / rSent) * 100).toFixed(1) : 0,
              replyRate: rSent > 0 ? +((rReplied / rSent) * 100).toFixed(1) : 0,
            });
          }

          // Only use fallback if we couldn't fetch ANY emails at all
          const usedFallback = allEmails.length === 0;
          let totals;
          if (usedFallback) {
            const [fbReached, fbOpened, fbClicked, fbReplied] = await Promise.all([
              count1(df("hs_email_last_send_date")),
              count1(df("hs_email_last_open_date")),
              count1(df("hs_email_last_click_date")),
              count1(df("hs_email_last_reply_date")),
            ]);
            totals = {
              totalReached: fbReached, totalOpened: fbOpened,
              totalClicked: fbClicked, totalReplied: fbReplied,
              openRate:  fbReached > 0 ? +((fbOpened  / fbReached) * 100).toFixed(1) : 0,
              clickRate: fbReached > 0 ? +((fbClicked / fbReached) * 100).toFixed(1) : 0,
              replyRate: fbReached > 0 ? +((fbReplied / fbReached) * 100).toFixed(1) : 0,
            };
          } else {
            totals = { totalReached: totalSent, totalOpened, totalClicked, totalReplied, openRate, clickRate, replyRate };
          }

          return ok({
            section: "marketing", period, rep: rep || "all",
            totals,
            byRep: repData,
            campaigns,
            usedFallback,
            links: { dashboard: DASHBOARD, manage: MKT_EMAIL },
          });
        }

        // ── SEQUENCES ─────────────────────────────────────────────────────────
        // Shows: Enrollment count, clicks, opens, replies, unsubscribes, bounces
        // matching HubSpot's "Sequence Enrollments - Sales Team" report.
        if (section === "sequences") {
          const bdr = bdrFilters();

          // Sequence aggregate counts via contact properties
          const [enrolled, seqReplied, seqOpened, seqClicked] = await Promise.all([
            count1([...bdr, ...df("hs_latest_sequence_enrolled_date")]),
            countOr("hs_email_last_reply_date", "hs_sales_email_last_replied", bdr),
            count1([...bdr, ...df("hs_email_last_open_date")]),
            count1([...bdr, ...df("hs_email_last_click_date")]),
          ]);

          const replyRate = enrolled > 0 ? +((seqReplied / enrolled) * 100).toFixed(1) : 0;
          const openRate  = enrolled > 0 ? +((seqOpened  / enrolled) * 100).toFixed(1) : 0;
          const clickRate = enrolled > 0 ? +((seqClicked / enrolled) * 100).toFixed(1) : 0;

          // Per-rep breakdown
          const repData = [];
          for (const repName of targetReps) {
            const rf = [{ propertyName: "assigned_bdr", operator: "EQ", value: repName }];
            const [rEnrolled, rReplied, rOpened, rClicked] = await Promise.all([
              count1([...rf, ...df("hs_latest_sequence_enrolled_date")]),
              countOr("hs_email_last_reply_date", "hs_sales_email_last_replied", rf),
              count1([...rf, ...df("hs_email_last_open_date")]),
              count1([...rf, ...df("hs_email_last_click_date")]),
            ]);
            repData.push({
              rep: repName, enrolled: rEnrolled, replied: rReplied, opened: rOpened, clicked: rClicked,
              replyRate: rEnrolled > 0 ? +((rReplied / rEnrolled) * 100).toFixed(1) : 0,
              openRate:  rEnrolled > 0 ? +((rOpened  / rEnrolled) * 100).toFixed(1) : 0,
              clickRate: rEnrolled > 0 ? +((rClicked / rEnrolled) * 100).toFixed(1) : 0,
            });
            await new Promise(r => setTimeout(r, 200));
          }

          // Per-sequence breakdown
          const bySequence = {};
          try {
            const seqContacts = await fetchC(
              [{ filters: [...bdr, ...df("hs_latest_sequence_enrolled_date")] }],
              ["assigned_bdr","hs_latest_sequence_enrolled","hs_latest_sequence_enrolled_date",
               "hs_email_last_reply_date","hs_sales_email_last_replied",
               "hs_email_last_open_date","hs_email_last_click_date"],
              "hs_latest_sequence_enrolled_date", 500
            );
            console.log(`[reports sequences] fetched ${seqContacts.length} contacts`);
            for (const c of seqContacts) {
              const p = c.properties || {};
              const seqId = p.hs_latest_sequence_enrolled || "Unknown";
              if (!bySequence[seqId]) bySequence[seqId] = { sequenceId: seqId, enrolled:0, replied:0, opened:0, clicked:0 };
              bySequence[seqId].enrolled++;
              if (p.hs_email_last_reply_date || p.hs_sales_email_last_replied) bySequence[seqId].replied++;
              if (p.hs_email_last_open_date)  bySequence[seqId].opened++;
              if (p.hs_email_last_click_date) bySequence[seqId].clicked++;
            }
            console.log(`[reports sequences] grouped into ${Object.keys(bySequence).length} sequences`);
          } catch (e) { console.error("[reports sequences]", e.message); }

          // Resolve sequence names
          const seqIds = [...new Set(Object.keys(bySequence))].filter(id => id !== "Unknown");
          const seqNames = {};
          if (seqIds.length > 0) {
            try {
              const seqBatch = await hsPost(user.userId, "/crm/v3/objects/sequences/batch/read", {
                properties: ["hs_name"],
                inputs: seqIds.slice(0, 50).map(id => ({ id })),
              });
              for (const s of (seqBatch.results || [])) {
                seqNames[s.id] = s.properties?.hs_name || null;
              }
            } catch (e) {
              console.log("[reports] sequences batch/read not available:", e.message);
              for (const id of seqIds.slice(0, 10)) {
                try {
                  const s = await hsGet(user.userId, `/crm/v3/objects/sequences/${id}`, { properties: "hs_name" });
                  if (s.properties?.hs_name) seqNames[id] = s.properties.hs_name;
                } catch { /* not available */ }
                await new Promise(r => setTimeout(r, 100));
              }
            }
          }

          const sequences = Object.values(bySequence).map(s => ({
            ...s,
            sequenceName: seqNames[s.sequenceId] || `Sequence #${s.sequenceId}`,
            sequenceUrl:  `https://app.hubspot.com/sequences/${PORTAL}/sequence/${s.sequenceId}`,
            replyRate: s.enrolled > 0 ? +((s.replied / s.enrolled) * 100).toFixed(1) : 0,
            openRate:  s.enrolled > 0 ? +((s.opened  / s.enrolled) * 100).toFixed(1) : 0,
            clickRate: s.enrolled > 0 ? +((s.clicked / s.enrolled) * 100).toFixed(1) : 0,
          })).sort((a,b) => b.enrolled - a.enrolled).slice(0, 30);

          return ok({
            section: "sequences", period, rep: rep || "all",
            totals: { enrolled, replied: seqReplied, opened: seqOpened, clicked: seqClicked, replyRate, openRate, clickRate },
            byRep: repData,
            sequences,
            links: { dashboard: DASHBOARD, sequences: SEQUENCES },
          });
        }

        // ── DEALS ─────────────────────────────────────────────────────────────
        if (section === "deals") {
          const ownerFilter = qp.owner ? [{ propertyName: "hubspot_owner_id", operator: "EQ", value: qp.owner }] : [];
          const dateFilters = sinceISO ? [{ propertyName: "createdate", operator: "GTE", value: sinceISO }] : [];

          const PIPELINES = {
            "679336808": "New Business Opportunity",
            "679502246": "Expansion Deal",
            "678610513": "New Business Deal",
          };
          const STAGES = {
            "995708483": { label:"Target Identified",              pipeline:"679336808", won:false, lost:false },
            "995708484": { label:"Initial Outreach/Reengaged",     pipeline:"679336808", won:false, lost:false },
            "1284036410":{ label:"Email Opened/No Response",       pipeline:"679336808", won:false, lost:false },
            "1288757038":{ label:"Reengagement Needed",            pipeline:"679336808", won:false, lost:false },
            "995708485": { label:"Engaged",                        pipeline:"679336808", won:false, lost:false },
            "995708486": { label:"Meeting Scheduled",              pipeline:"679336808", won:false, lost:false },
            "995708487": { label:"Meeting Completed",              pipeline:"679336808", won:false, lost:false },
            "995708488": { label:"Qualified",                      pipeline:"679336808", won:false, lost:false },
            "995708489": { label:"Unengaged",                      pipeline:"679336808", won:false, lost:false },
            "996311842": { label:"Trade Show Follow-Up",           pipeline:"679336808", won:false, lost:false },
            "1331037807":{ label:"Meeting Completed - Not A Fit",  pipeline:"679336808", won:false, lost:false },
            "1331034125":{ label:"Meeting Completed - Partnership", pipeline:"679336808", won:false, lost:false },
            "1347324753":{ label:"Closed/Lost",                    pipeline:"679336808", won:false, lost:true  },
            "995723921": { label:"Expansion Targets",              pipeline:"679502246", won:false, lost:false },
            "995723922": { label:"Engaged",                        pipeline:"679502246", won:false, lost:false },
            "995723923": { label:"Value Prop/Scoping",             pipeline:"679502246", won:false, lost:false },
            "995723924": { label:"Pricing Proposal",               pipeline:"679502246", won:false, lost:false },
            "995723926": { label:"Procurement/Contracting",        pipeline:"679502246", won:false, lost:false },
            "995723927": { label:"Closed Lost",                    pipeline:"679502246", won:false, lost:true  },
            "995739776": { label:"Closed Won",                     pipeline:"679502246", won:true,  lost:false },
            "1004627778":{ label:"Revisit",                        pipeline:"679502246", won:false, lost:false },
            "995756094": { label:"Qualified",                      pipeline:"678610513", won:false, lost:false },
            "995756095": { label:"Problem Solution Fit",           pipeline:"678610513", won:false, lost:false },
            "995756096": { label:"Value Prop/Scoping",             pipeline:"678610513", won:false, lost:false },
            "995756097": { label:"Pricing Proposal",               pipeline:"678610513", won:false, lost:false },
            "995756098": { label:"IT/Technical Review",            pipeline:"678610513", won:false, lost:false },
            "995756099": { label:"Contracting/Legal",              pipeline:"678610513", won:false, lost:false },
            "995756100": { label:"Closed - Lost",                  pipeline:"678610513", won:false, lost:true  },
            "995749999": { label:"Closed - Won",                   pipeline:"678610513", won:true,  lost:false },
            "995750000": { label:"Revisit",                        pipeline:"678610513", won:false, lost:false },
          };

          // Fetch all deals in period
          let allDeals = [], after;
          while (allDeals.length < 1000) {
            const body = {
              filterGroups: [{ filters: [...ownerFilter, ...dateFilters] }],
              properties: ["dealname","dealstage","pipeline","amount","closedate","createdate","hubspot_owner_id","hs_projected_amount","closed_lost_reason"],
              sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
              limit: 100,
            };
            if (after) body.after = after;
            const d = await hsPost(user.userId, "/crm/v3/objects/deals/search", body).catch(() => ({ results:[] }));
            allDeals.push(...(d.results || []));
            if (!d.paging?.next?.after || (d.results||[]).length < 100) break;
            after = d.paging.next.after;
            await new Promise(r => setTimeout(r, 150));
          }

          let totalValue=0, totalWeighted=0, wonCount=0, wonValue=0, lostCount=0, lostValue=0;
          const byStage={}, byPipeline={}, lostReasons={}, closedDays=[];

          for (const deal of allDeals) {
            const p = deal.properties || {};
            const amt = parseFloat(p.amount||0);
            const wt  = parseFloat(p.hs_projected_amount||0);
            const stage = STAGES[p.dealstage] || {};
            const pipeId = p.pipeline || "";

            totalValue    += amt;
            totalWeighted += wt;

            if (!byPipeline[pipeId]) byPipeline[pipeId] = { label: PIPELINES[pipeId]||pipeId, count:0, value:0, weighted:0 };
            byPipeline[pipeId].count++;
            byPipeline[pipeId].value    += amt;
            byPipeline[pipeId].weighted += wt;

            const sk = p.dealstage||"unknown";
            if (!byStage[sk]) byStage[sk] = { label: stage.label||sk, pipeline: PIPELINES[pipeId]||pipeId, count:0, value:0, won:stage.won||false, lost:stage.lost||false };
            byStage[sk].count++;
            byStage[sk].value += amt;

            if (stage.won)  { wonCount++;  wonValue  += amt; if (p.createdate && p.closedate) closedDays.push(Math.round((new Date(p.closedate)-new Date(p.createdate))/(86400000))); }
            if (stage.lost) { lostCount++; lostValue += amt; const r = p.closed_lost_reason||"No reason"; lostReasons[r]=(lostReasons[r]||0)+1; }
          }

          const winRate    = (wonCount+lostCount) > 0 ? +(wonCount/(wonCount+lostCount)*100).toFixed(1) : 0;
          const avgVelocity= closedDays.length > 0 ? Math.round(closedDays.reduce((a,b)=>a+b,0)/closedDays.length) : null;
          const avgDealSize= wonCount > 0 ? Math.round(wonValue/wonCount) : 0;

          return ok({
            section: "deals", period, owner: qp.owner || null,
            totals: { total: allDeals.length, totalValue, totalWeighted, wonCount, wonValue, lostCount, lostValue, winRate, avgVelocity, avgDealSize },
            byPipeline: Object.entries(byPipeline).map(([pipeId, p]) => ({
              ...p,
              pipelineId: pipeId,
              // HubSpot deal board filtered by pipeline
              url: `${HS_BASE}/contacts/${PORTAL}/deals/board/view/all?pipelineId=${pipeId}`,
            })).sort((a,b)=>b.count-a.count),
            byStage:    Object.values(byStage).sort((a,b)=>b.count-a.count),
            lostReasons: Object.entries(lostReasons).map(([reason,count])=>({reason,count})).sort((a,b)=>b.count-a.count),
            recentDeals: allDeals.slice(0,200).map(deal => {
              const p = deal.properties||{};
              const stage = STAGES[p.dealstage]||{};
              return {
                id: deal.id, name: p.dealname||"", stage: stage.label||p.dealstage||"",
                pipeline: PIPELINES[p.pipeline]||p.pipeline||"",
                amount: parseFloat(p.amount||0), weighted: parseFloat(p.hs_projected_amount||0),
                closeDate: p.closedate||null, createDate: p.createdate||null,
                ownerId: p.hubspot_owner_id||null, lostReason: p.closed_lost_reason||null,
                isWon: stage.won||false, isLost: stage.lost||false,
                url: `${HS_BASE}/contacts/${PORTAL}/record/0-3/${deal.id}`,
              };
            }),
            links: { dashboard: DASHBOARD, deals: DEALS_LIST },
          });
        }

        return error(400, `Unknown section: ${section}`);

      } catch (err) {
        console.error("[reports] Error:", err.message);
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
