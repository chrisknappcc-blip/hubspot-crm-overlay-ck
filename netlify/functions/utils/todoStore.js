// netlify/functions/utils/todoStore.js
// Per-user To-Do list stored in Azure Blob.
// Blob key: todo--{userId}.json
//
// Item schema:
//   id          string   -- nanoid
//   type        string   -- "manual" | "reply" | "meeting" | "sequence" | "task"
//   text        string   -- display text
//   subtext     string   -- secondary context (company, email name, meeting time etc.)
//   contactId   string   -- HubSpot contact ID if applicable
//   hubspotUrl  string   -- deep link into HubSpot
//   completed   boolean
//   completedAt string   -- ISO timestamp
//   createdAt   string   -- ISO timestamp
//   date        string   -- YYYY-MM-DD date this item belongs to
//   autoDetected boolean -- true = pulled from HubSpot, false = manual
//   sourceId    string   -- HubSpot object ID used for passive completion checks

const AZURE_ACCOUNT   = process.env.AZURE_STORAGE_ACCOUNT_NAME || process.env.AZURE_STORAGE_ACCOUNT || "carepathiqdata";
const AZURE_SAS       = process.env.AZURE_STORAGE_SAS_TOKEN    || process.env.AZURE_STORAGE_KEY     || "";
const AZURE_CONTAINER = process.env.AZURE_STORAGE_CONTAINER    || "crm-tokens";
const ARCHIVE_DAYS    = 7;

function blobUrl(blobName) {
  const sas = AZURE_SAS.startsWith("?") ? AZURE_SAS : `?${AZURE_SAS}`;
  return `https://${AZURE_ACCOUNT}.blob.core.windows.net/${AZURE_CONTAINER}/${blobName}${sas}`;
}

function todoBlobName(userId) {
  return `todo--${userId.replace(/[^a-zA-Z0-9]/g, "_")}.json`;
}

async function readTodos(userId) {
  try {
    const res = await fetch(blobUrl(todoBlobName(userId)));
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`Azure GET failed: ${res.status}`);
    const text = await res.text();
    return JSON.parse(text);
  } catch {
    return [];
  }
}

async function writeTodos(userId, items) {
  const body = JSON.stringify(items, null, 2);
  const res  = await fetch(blobUrl(todoBlobName(userId)), {
    method: "PUT",
    headers: { "Content-Type": "application/json", "x-ms-blob-type": "BlockBlob" },
    body,
  });
  if (!res.ok) throw new Error(`Azure PUT failed: ${res.status} ${await res.text()}`);
}

// Auto-archive items older than ARCHIVE_DAYS
function applyArchive(items) {
  const cutoff = Date.now() - ARCHIVE_DAYS * 24 * 60 * 60 * 1000;
  return items.filter(item => new Date(item.createdAt).getTime() > cutoff);
}

// Today's date string YYYY-MM-DD in UTC
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export async function getTodos(userId) {
  const raw  = await readTodos(userId);
  const live = applyArchive(raw);
  if (live.length !== raw.length) {
    await writeTodos(userId, live).catch(() => {});
  }
  // Manual items always first, then auto-detected by priority
  return [
    ...live.filter(t => !t.autoDetected),
    ...live.filter(t =>  t.autoDetected).sort((a, b) => (a.priority || 9) - (b.priority || 9)),
  ];
}

export async function addTodo(userId, item) {
  const items = await readTodos(userId);
  const now   = new Date().toISOString();
  const newItem = {
    id:           Math.random().toString(36).slice(2, 10),
    type:         item.type         || "manual",
    text:         (item.text        || "").trim().slice(0, 200),
    subtext:      (item.subtext     || "").trim().slice(0, 200),
    contactId:    item.contactId    || null,
    hubspotUrl:   item.hubspotUrl   || null,
    completed:    false,
    completedAt:  null,
    createdAt:    now,
    date:         item.date         || todayStr(),
    autoDetected: item.autoDetected || false,
    sourceId:     item.sourceId     || null,
  };
  const updated = applyArchive([...items, newItem]);
  await writeTodos(userId, updated);
  return newItem;
}

export async function updateTodo(userId, itemId, changes) {
  const items   = await readTodos(userId);
  const idx     = items.findIndex(i => i.id === itemId);
  if (idx < 0) throw new Error("Todo not found");
  items[idx] = { ...items[idx], ...changes };
  if (changes.completed && !items[idx].completedAt) {
    items[idx].completedAt = new Date().toISOString();
  }
  await writeTodos(userId, items);
  return items[idx];
}

export async function deleteTodo(userId, itemId) {
  const items   = await readTodos(userId);
  const updated = items.filter(i => i.id !== itemId);
  await writeTodos(userId, updated);
}

export async function bulkUpsertAutoDetected(userId, autoItems) {
  // On each sync, REPLACE all auto-detected items with the fresh list.
  // This ensures stale items (e.g. Gong meetings no longer qualifying) are removed.
  // Manual items are always preserved regardless.
  // Completion state is preserved for items that still appear in the new list.
  const items = applyArchive(await readTodos(userId));
  const now   = new Date().toISOString();
  const today = todayStr();

  // Keep all manual items
  const manualItems = items.filter(i => !i.autoDetected);

  // Build completion state map from existing auto-detected items
  const completionMap = {};
  for (const item of items) {
    if (item.autoDetected && item.sourceId) {
      completionMap[item.sourceId] = {
        completed:   item.completed,
        completedAt: item.completedAt,
      };
    }
  }

  // Build fresh auto-detected list, preserving completion state
  const freshAutoItems = autoItems.map(incoming => ({
    id:           Math.random().toString(36).slice(2, 10),
    type:         incoming.type      || "task",
    text:         (incoming.text     || "").trim().slice(0, 200),
    subtext:      (incoming.subtext  || "").trim().slice(0, 200),
    contactId:    incoming.contactId  || null,
    hubspotUrl:   incoming.hubspotUrl || null,
    completed:    completionMap[incoming.sourceId]?.completed    || false,
    completedAt:  completionMap[incoming.sourceId]?.completedAt  || null,
    createdAt:    now,
    date:         today,
    autoDetected: true,
    sourceId:     incoming.sourceId || null,
    priority:     incoming.priority || 9,
  }));

  // Sort: manual items first (pinned), then auto-detected by priority
  const updated = [
    ...manualItems,
    ...freshAutoItems.sort((a, b) => (a.priority || 9) - (b.priority || 9)),
  ];
  await writeTodos(userId, updated);
  return updated;
}
