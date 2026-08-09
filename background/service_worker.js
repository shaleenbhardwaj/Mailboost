/* ============================================================================
 * MailBoost — background/service_worker.js  (Manifest V3)
 * ----------------------------------------------------------------------------
 * The service worker owns everything the page cannot do:
 *   - opening (and auto-closing) the silent unsubscribe tab
 *   - chrome.alarms for time-based snoozes and "send later" reminders
 *   - the periodic reply-watch that powers "snooze until they reply"
 *   - chrome.notifications when a snooze fires
 *   - the Anthropic API call for the AI summariser
 *
 * The API call happens HERE, not in the content script, for two reasons:
 *   1. an extension service worker with host_permissions for api.anthropic.com
 *      isn't subject to the page's CORS restrictions;
 *   2. the user's API key never has to enter the mail site's page context.
 *
 * MV3 service workers are killed when idle, so this file keeps no state in
 * memory — everything durable lives in chrome.storage.local.
 * ==========================================================================*/

'use strict';

const LOG = (...args) => console.log('[MailBoost SW]', ...args);
const ERR = (...args) => console.error('[MailBoost SW]', ...args);

/** Alarm names. Snooze alarms are `mailboost-snooze-<uuid>`. */
const REPLY_ALARM = 'mailboost-reply-check';
const SNOOZE_PREFIX = 'mailboost-snooze-';
const SEND_PREFIX = 'mailboost-send-';

/** How long the silent unsubscribe tab is allowed to live. */
const UNSUB_TAB_MS = 3000;

const DEFAULTS = {
  darkModeEnabled: true,
  plan: 'free',
  licenseKey: '',
  apiKey: '',
  model: 'claude-sonnet-5',
  unsubCount: 0,
  unsubPeriod: '',
  unsubTotal: 0,
  freeAiUses: 0,
  aiTotal: 0,
  snoozeTotal: 0,
  darkFixDate: '',
  darkFixCount: 0,
  snoozes: [],
  scheduled: [],
  notifyOnProLaunch: false,
};

/**
 * apiKey/licenseKey/plan follow the user's Chrome profile via
 * chrome.storage.sync; everything else (usage counters, the snooze list,
 * dark-mode preference) stays in .local. Must match the same list in
 * content_scripts/shared.js and popup/popup.js — all three keep an
 * independent copy of this split since they can't share a module.
 */
const SYNC_KEYS = ['apiKey', 'licenseKey', 'plan'];

function splitByStorageArea(obj) {
  const sync = {};
  const local = {};
  for (const [key, value] of Object.entries(obj)) {
    (SYNC_KEYS.includes(key) ? sync : local)[key] = value;
  }
  return { sync, local };
}

let _syncMigrationChecked = false;

/**
 * One-time migration for installs from before apiKey/licenseKey/plan moved
 * to chrome.storage.sync — see the matching function in shared.js for the
 * full rationale. Runs independently here too since the service worker may
 * read storage before any content script or the popup has had a chance to;
 * the storage-level `_syncMigrationDone` marker keeps all three from
 * re-doing the work.
 */
async function migrateLegacyLocalKeys() {
  if (_syncMigrationChecked) return;
  _syncMigrationChecked = true;
  try {
    const localCheck = await chrome.storage.local.get(['_syncMigrationDone', ...SYNC_KEYS]);
    if (localCheck._syncMigrationDone) return;

    const existingSync = await chrome.storage.sync.get(SYNC_KEYS);
    const toMigrate = {};
    for (const key of SYNC_KEYS) {
      const localValue = localCheck[key];
      const hasLocalValue = localValue !== undefined && localValue !== '' && localValue !== DEFAULTS[key];
      const syncAlreadyHasIt = existingSync[key] !== undefined && existingSync[key] !== '' && existingSync[key] !== DEFAULTS[key];
      if (hasLocalValue && !syncAlreadyHasIt) toMigrate[key] = localValue;
    }

    if (Object.keys(toMigrate).length) {
      await chrome.storage.sync.set(toMigrate);
      LOG('migrated legacy local values to sync:', Object.keys(toMigrate).join(', '));
    }
    await chrome.storage.local.remove(SYNC_KEYS);
    await chrome.storage.local.set({ _syncMigrationDone: true });
  } catch (err) {
    ERR('sync migration failed (non-fatal):', err);
  }
}

async function readAll() {
  await migrateLegacyLocalKeys();
  try {
    const { sync: syncDefaults, local: localDefaults } = splitByStorageArea(DEFAULTS);
    const [syncStored, localStored] = await Promise.all([
      chrome.storage.sync.get(syncDefaults),
      chrome.storage.local.get(localDefaults),
    ]);
    return Object.assign({}, DEFAULTS, syncStored, localStored);
  } catch (err) {
    ERR('storage read failed:', err);
    return Object.assign({}, DEFAULTS);
  }
}

async function write(patch) {
  try {
    const { sync: syncPatch, local: localPatch } = splitByStorageArea(patch);
    const writes = [];
    if (Object.keys(syncPatch).length) writes.push(chrome.storage.sync.set(syncPatch));
    if (Object.keys(localPatch).length) writes.push(chrome.storage.local.set(localPatch));
    await Promise.all(writes);
    return true;
  } catch (err) {
    ERR('storage write failed:', err);
    return false;
  }
}

/* ==========================================================================
 * Install / startup
 * ========================================================================*/

chrome.runtime.onInstalled.addListener(async (details) => {
  LOG('installed:', details.reason);

  // Seed defaults without clobbering anything the user already set. Must
  // check BOTH storage areas — apiKey/licenseKey/plan live in .sync, so an
  // update-triggered reseed that only looked at .local would find them
  // "missing" and wipe a user's saved key/licence back to defaults.
  const [existingSync, existingLocal] = await Promise.all([
    chrome.storage.sync.get(null),
    chrome.storage.local.get(null),
  ]);
  const existing = Object.assign({}, existingSync, existingLocal);
  const seed = {};
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (existing[key] === undefined) seed[key] = value;
  }
  if (Object.keys(seed).length) await write(seed);

  ensureReplyAlarm();
  rebuildAlarms();
});

chrome.runtime.onStartup.addListener(() => {
  LOG('browser started — restoring alarms');
  ensureReplyAlarm();
  rebuildAlarms();
});

/** The reply-watch poll. 30 minutes, per spec. */
function ensureReplyAlarm() {
  try {
    chrome.alarms.create(REPLY_ALARM, { periodInMinutes: 30 });
    LOG('reply-check alarm armed (every 30 min)');
  } catch (err) {
    ERR('could not create reply alarm:', err);
  }
}

/**
 * Alarms don't survive an extension update, so re-create one for every
 * still-pending snooze / scheduled send. Anything already overdue fires now.
 */
async function rebuildAlarms() {
  const state = await readAll();

  for (const snooze of state.snoozes) {
    if (snooze.status !== 'pending' || snooze.snoozeType !== 'time') continue;
    if (snooze.snoozeUntil <= Date.now()) {
      fireSnooze(snooze.id);
    } else {
      chrome.alarms.create(SNOOZE_PREFIX + snooze.id, { when: snooze.snoozeUntil });
    }
  }

  for (const item of state.scheduled) {
    if (item.status !== 'pending') continue;
    if (item.scheduledTime <= Date.now()) {
      fireScheduledSend(item.id);
    } else {
      chrome.alarms.create(SEND_PREFIX + item.id, { when: item.scheduledTime });
    }
  }

  LOG('alarms rebuilt');
}

/* ==========================================================================
 * Messages from content scripts and the popup
 * ========================================================================*/

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) return false;
  LOG('message:', message.action);

  // Each handler is async, so we always return true to keep the port open.
  switch (message.action) {
    case 'openBackgroundTab':
      openBackgroundTab(message.url).then(sendResponse);
      return true;

    case 'summarizeEmail':
      summarizeEmail(message).then(sendResponse);
      return true;

    case 'scheduleSnooze':
      scheduleSnooze(message.snooze).then(sendResponse);
      return true;

    case 'cancelSnooze':
      cancelSnooze(message.id).then(sendResponse);
      return true;

    case 'scheduleSend':
      scheduleSend(message.scheduled).then(sendResponse);
      return true;

    case 'cancelScheduledSend':
      cancelScheduledSend(message.id).then(sendResponse);
      return true;

    default:
      sendResponse({ ok: false, error: `Unknown action: ${message.action}` });
      return false;
  }
});

/* ==========================================================================
 * FEATURE 2 — silent unsubscribe tab
 * ========================================================================*/

async function openBackgroundTab(url) {
  try {
    if (!/^https?:\/\//i.test(String(url || ''))) {
      return { ok: false, error: 'Refusing to open a non-http(s) URL' };
    }
    const tab = await chrome.tabs.create({ url, active: false });
    LOG('opened background tab', tab.id, '→ closing in', UNSUB_TAB_MS, 'ms');

    // Give the unsubscribe endpoint a moment to register the request,
    // then close the tab so the user never sees it.
    setTimeout(() => {
      chrome.tabs.remove(tab.id).catch((err) => LOG('tab already closed:', err.message));
    }, UNSUB_TAB_MS);

    return { ok: true, tabId: tab.id };
  } catch (err) {
    ERR('openBackgroundTab failed:', err);
    return { ok: false, error: String(err) };
  }
}

/* ==========================================================================
 * FEATURE 4 — Anthropic API call
 * ========================================================================*/

/**
 * JSON shape we ask Claude for, so the sidebar never has to parse prose.
 * Field `description`s are sent to the model as part of the schema and
 * directly shape output quality — kept in sync with the prompt below.
 * Deliberately actionable, not just descriptive: the whole point of this
 * feature over a generic "summarize this" is that it tells the reader
 * exactly what to DO, not just what the email SAYS — Outlook's own native
 * Copilot summary already covers the generic recap, so that's not where
 * MailBoost needs to win.
 */
const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Exactly three bullet points — only the facts that change what the reader does next ' +
        '(numbers, names, commitments, decisions made). Skip pleasantries, boilerplate, and ' +
        'anything a generic recap would already say.',
    },
    action_required: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description:
        'The single next physical action the reader must take, as a concrete imperative ' +
        'sentence starting with a verb (e.g. "Approve the invoice by replying yes" or ' +
        '"Send the signed contract back"). Null if nothing is genuinely required — never invent a task.',
    },
    deadline: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description:
        'The exact date/time if one is stated, or a specific urgency word ("today", "this week"). ' +
        'Null if the email states no deadline — never guess one.',
    },
    quick_replies: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Exactly three short reply drafts (max ~12 words each) the reader could copy and send ' +
        'almost as-is — not single-word labels. Cover three angles: (1) an acceptance/' +
        'confirmation, (2) a decline or pushback, (3) a genuine clarifying question about ' +
        'something the email leaves UNSTATED (e.g. a missing date, location, or amount) — ' +
        'never ask about something the email already answered. If one of these three angles ' +
        'genuinely does not fit this email (e.g. nothing to push back on, or nothing left ' +
        'unstated to ask about), replace it with a sensible alternative rather than forcing it.',
    },
  },
  required: ['summary', 'action_required', 'deadline', 'quick_replies'],
  additionalProperties: false,
};

/**
 * Older models (Haiku 4.5) don't accept `effort` or the adaptive/disabled
 * thinking config, so the request body is built per model.
 */
function buildRequestBody(model, emailText) {
  const prompt =
    'You are triaging this email for someone who has about 10 seconds to decide what to do ' +
    'with it. Be concrete and specific — never restate the schema field descriptions back in ' +
    'vaguer language, and never invent an action or deadline that is not actually there.\n\n' +
    'Email thread:\n' +
    emailText;

  const body = {
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
    output_config: { format: { type: 'json_schema', schema: SUMMARY_SCHEMA } },
  };

  // Summarising a single email doesn't need extended reasoning, and thinking
  // tokens count against max_tokens — so keep it off on models that support
  // the switch, and keep effort low.
  if (!/haiku/.test(model)) {
    body.thinking = { type: 'disabled' };
    body.output_config.effort = 'low';
  }

  return body;
}

async function summarizeEmail({ emailText, apiKey, model }) {
  if (!apiKey) {
    return { ok: false, error: 'Add your Anthropic API key in MailBoost settings' };
  }
  if (!emailText || emailText.trim().length < 20) {
    return { ok: false, error: 'Please open an email first' };
  }

  const chosenModel = model || DEFAULTS.model;
  LOG('summarising', emailText.length, 'chars with', chosenModel);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        // Required when calling the API from a browser extension context.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(buildRequestBody(chosenModel, emailText)),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      ERR('API error', response.status, detail);
      return {
        ok: false,
        error:
          response.status === 401
            ? 'Invalid API key — check it in MailBoost settings.'
            : `Anthropic API returned ${response.status}.`,
      };
    }

    const payload = await response.json();

    // A refusal is a successful HTTP 200 with an empty/partial content array,
    // so check stop_reason before reading content.
    if (payload.stop_reason === 'refusal') {
      return { ok: false, error: 'Claude declined to summarise this email.' };
    }

    const textBlock = (payload.content || []).find((block) => block.type === 'text');
    if (!textBlock) {
      return { ok: false, error: 'Empty response from the API.' };
    }

    let data;
    try {
      data = JSON.parse(textBlock.text);
    } catch (parseErr) {
      ERR('could not parse structured output:', parseErr, textBlock.text);
      // Fall back to showing the raw text as a single bullet rather than failing.
      data = {
        summary: [textBlock.text.slice(0, 600)],
        action_required: null,
        deadline: null,
        quick_replies: [],
      };
    }

    LOG('summary ok; usage:', payload.usage);
    return { ok: true, data };
  } catch (err) {
    ERR('summarizeEmail failed:', err);
    return { ok: false, error: 'Network error calling the Anthropic API.' };
  }
}

/* ==========================================================================
 * FEATURE 3 — snooze scheduling
 * ========================================================================*/

async function scheduleSnooze(snooze) {
  try {
    if (snooze.snoozeType === 'time') {
      chrome.alarms.create(SNOOZE_PREFIX + snooze.id, { when: snooze.snoozeUntil });
      LOG('time snooze armed for', new Date(snooze.snoozeUntil).toISOString());
    } else {
      // Reply-watch is handled by the shared 30-minute poll.
      ensureReplyAlarm();
      LOG('reply watch registered for', snooze.watchSenderEmail);
    }
    return { ok: true };
  } catch (err) {
    ERR('scheduleSnooze failed:', err);
    return { ok: false, error: String(err) };
  }
}

async function cancelSnooze(id) {
  try {
    await chrome.alarms.clear(SNOOZE_PREFIX + id);
    const state = await readAll();
    await write({
      snoozes: state.snoozes.map((s) =>
        s.id === id ? Object.assign({}, s, { status: 'cancelled' }) : s
      ),
    });
    LOG('snooze cancelled:', id);
    return { ok: true };
  } catch (err) {
    ERR('cancelSnooze failed:', err);
    return { ok: false, error: String(err) };
  }
}

/* ==========================================================================
 * FEATURE 5 — send later scheduling
 * ========================================================================*/

async function scheduleSend(item) {
  try {
    chrome.alarms.create(SEND_PREFIX + item.id, { when: item.scheduledTime });
    LOG('send-later reminder armed for', new Date(item.scheduledTime).toISOString());
    return { ok: true };
  } catch (err) {
    ERR('scheduleSend failed:', err);
    return { ok: false, error: String(err) };
  }
}

async function cancelScheduledSend(id) {
  try {
    await chrome.alarms.clear(SEND_PREFIX + id);
    const state = await readAll();
    await write({
      scheduled: state.scheduled.map((s) =>
        s.id === id ? Object.assign({}, s, { status: 'cancelled' }) : s
      ),
    });
    return { ok: true };
  } catch (err) {
    ERR('cancelScheduledSend failed:', err);
    return { ok: false, error: String(err) };
  }
}

/* ==========================================================================
 * Alarm dispatch
 * ========================================================================*/

chrome.alarms.onAlarm.addListener(async (alarm) => {
  LOG('alarm fired:', alarm.name);
  try {
    if (alarm.name === REPLY_ALARM) {
      await runReplyCheck();
    } else if (alarm.name.startsWith(SNOOZE_PREFIX)) {
      await fireSnooze(alarm.name.slice(SNOOZE_PREFIX.length));
    } else if (alarm.name.startsWith(SEND_PREFIX)) {
      await fireScheduledSend(alarm.name.slice(SEND_PREFIX.length));
    }
  } catch (err) {
    ERR('alarm handler failed:', err);
  }
});

async function fireSnooze(id) {
  const state = await readAll();
  const snooze = state.snoozes.find((s) => s.id === id);
  if (!snooze || snooze.status !== 'pending') return;

  const headline = snooze.contextNote || snooze.subject || 'Snoozed email';
  notify(`mailboost-snooze-${id}`, {
    title: `⏰ ${headline}`,
    message: `from ${snooze.sender || snooze.senderEmail || 'unknown sender'}`,
  });

  await write({
    snoozes: state.snoozes.map((s) =>
      s.id === id ? Object.assign({}, s, { status: 'fired' }) : s
    ),
  });
}

async function fireScheduledSend(id) {
  const state = await readAll();
  const item = state.scheduled.find((s) => s.id === id);
  if (!item || item.status !== 'pending') return;

  notify(`mailboost-send-${id}`, {
    title: `⏰ Time to send: ${item.draftSubject}`,
    message: `Send your email to ${item.recipient} now — click to open your drafts.`,
  });

  await write({
    scheduled: state.scheduled.map((s) =>
      s.id === id ? Object.assign({}, s, { status: 'fired' }) : s
    ),
  });
}

/**
 * Reply-watch. The service worker cannot read the mailbox, so it asks any
 * open mail tab to scan its own message list for the watched senders.
 */
async function runReplyCheck() {
  const state = await readAll();
  const watching = state.snoozes.filter(
    (s) => s.status === 'pending' && s.snoozeType === 'reply' && s.watchSenderEmail
  );
  if (!watching.length) {
    LOG('reply check: nothing to watch');
    return;
  }

  const emails = Array.from(new Set(watching.map((s) => s.watchSenderEmail)));
  const tabs = await chrome.tabs.query({
    url: [
      '*://outlook.live.com/*',
      '*://outlook.office.com/*',
      '*://mail.yahoo.com/*',
    ],
  });

  if (!tabs.length) {
    LOG('reply check: no mail tab open, will retry in 30 min');
    return;
  }

  const found = new Set();
  for (const tab of tabs) {
    try {
      const reply = await chrome.tabs.sendMessage(tab.id, { action: 'scanForSenders', emails });
      (reply && reply.found ? reply.found : []).forEach((e) => found.add(e));
    } catch (err) {
      // Tab exists but the content script isn't ready — normal, skip it.
      LOG('could not scan tab', tab.id, '-', err.message);
    }
  }

  if (!found.size) {
    LOG('reply check: no replies yet from', emails.join(', '));
    return;
  }

  const updated = state.snoozes.map((s) => {
    if (s.status !== 'pending' || s.snoozeType !== 'reply') return s;
    if (!found.has(s.watchSenderEmail)) return s;

    notify(`mailboost-reply-${s.id}`, {
      title: `💬 ${s.senderEmail} replied!`,
      message: s.contextNote ? `Context: ${s.contextNote}` : (s.subject || 'Open your inbox to read it.'),
    });
    return Object.assign({}, s, { status: 'fired' });
  });

  await write({ snoozes: updated });
}

/* ==========================================================================
 * Notifications
 * ========================================================================*/

function notify(id, { title, message }) {
  try {
    chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message,
      priority: 2,
    });
    LOG('notification:', title);
  } catch (err) {
    ERR('notification failed:', err);
  }
}

/** Clicking a "send later" notification opens the drafts folder. */
chrome.notifications.onClicked.addListener(async (notificationId) => {
  LOG('notification clicked:', notificationId);
  try {
    chrome.notifications.clear(notificationId);
    const url = notificationId.startsWith('mailboost-send-')
      ? 'https://outlook.live.com/mail/0/drafts'
      : 'https://outlook.live.com/mail/0/';

    // Focus an existing Outlook tab if there is one, otherwise open a new one.
    const [existing] = await chrome.tabs.query({ url: '*://outlook.live.com/*' });
    if (existing) {
      await chrome.tabs.update(existing.id, { active: true, url });
      await chrome.windows.update(existing.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url });
    }
  } catch (err) {
    ERR('notification click handler failed:', err);
  }
});

LOG('service worker loaded');
