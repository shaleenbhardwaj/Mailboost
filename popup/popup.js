/* ============================================================================
 * MailBoost — popup/popup.js
 * ----------------------------------------------------------------------------
 * Wires up the settings panel. The popup can't import shared.js (that only
 * runs in mail tabs), so the few helpers it needs are re-declared here.
 *
 * Everything reads and writes chrome.storage.local, and the content scripts
 * pick changes up live via chrome.storage.onChanged — no page reload needed
 * for the dark-mode toggle.
 * ==========================================================================*/

'use strict';

const LOG = (...args) => console.log('[MailBoost popup]', ...args);
const ERR = (...args) => console.error('[MailBoost popup]', ...args);

const FREE_UNSUB_PER_MONTH = 5;
const FREE_AI_TRIAL_USES = 5;

const LINKS = {
  basic: 'https://gumroad.com/l/mailboost-basic',
  pro: 'https://gumroad.com/l/mailboost-pro',
  coffee: 'https://buymeacoffee.com/mailboost',
  apiKey: 'https://console.anthropic.com/settings/keys',
  privacy: 'https://mailboost.app/privacy',
  store: 'https://chromewebstore.google.com/detail/mailboost',
};

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

const PLAN_LABELS = { free: 'Free', basic: 'Basic ✓', pro: 'Pro ✓' };

const $ = (id) => document.getElementById(id);

/**
 * apiKey/licenseKey/plan follow the user's Chrome profile via
 * chrome.storage.sync; everything else (usage counters, the snooze list,
 * dark-mode preference) stays in .local. Must match the same list in
 * content_scripts/shared.js and background/service_worker.js — all three
 * keep an independent copy since they can't share a module.
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
 * full rationale. The popup is the most likely place a user notices a
 * "reverted to Free" plan, so this needs to run here too, not just in the
 * content scripts.
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

/* ==========================================================================
 * Storage helpers (try/catch per the safety rules)
 * ========================================================================*/

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
    LOG('saved', Object.keys(patch).join(', '));
    return true;
  } catch (err) {
    ERR('storage write failed:', err);
    return false;
  }
}

/* ==========================================================================
 * Licence
 * ========================================================================*/

function validateLicense(key) {
  const value = String(key || '').trim().toUpperCase();
  return value.startsWith('MAILBOOST-') && value.length === 20;
}

function planForLicense(key) {
  if (!validateLicense(key)) return 'free';
  return String(key).trim().toUpperCase()[10] === 'B' ? 'basic' : 'pro';
}

/* ==========================================================================
 * Formatting
 * ========================================================================*/

function formatWhen(ts) {
  try {
    return new Date(ts).toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  } catch (err) {
    return String(ts);
  }
}

function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function dayKey(d) {
  return `${monthKey(d)}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ==========================================================================
 * Rendering
 * ========================================================================*/

function renderPlan(state) {
  const badge = $('planBadge');
  badge.textContent = PLAN_LABELS[state.plan] || 'Free';
  badge.className = `mb-badge mb-badge-${state.plan}`;

  $('licenseStatus').textContent = `Current plan: ${PLAN_LABELS[state.plan]}`;
  $('licenseStatus').className = 'mb-note';
  $('licenseKey').value = state.licenseKey || '';
}

function renderDarkMode(state) {
  const on = state.darkModeEnabled !== false;
  $('darkToggle').checked = on;

  const today = dayKey(new Date());
  const fixedToday = state.darkFixDate === today ? Number(state.darkFixCount) || 0 : 0;

  $('darkStatus').textContent = on
    ? `Active — fixing ${fixedToday} email${fixedToday === 1 ? '' : 's'} today`
    : 'Off — Outlook’s own dark mode is showing';
  $('statDark').textContent = on ? 'Active' : 'Off';
}

function renderStats(state) {
  $('statUnsub').textContent = state.unsubTotal || 0;
  $('statAi').textContent = state.aiTotal || 0;
  $('statSnooze').textContent = state.snoozeTotal || 0;

  const lines = [];
  if (state.plan === 'free') {
    const period = monthKey(new Date());
    const used = state.unsubPeriod === period ? Number(state.unsubCount) || 0 : 0;
    lines.push(`${Math.max(0, FREE_UNSUB_PER_MONTH - used)} of ${FREE_UNSUB_PER_MONTH} free unsubscribes left this month.`);
  }
  if (state.plan !== 'pro') {
    const left = Math.max(0, FREE_AI_TRIAL_USES - (Number(state.freeAiUses) || 0));
    lines.push(`${left} of ${FREE_AI_TRIAL_USES} free AI summaries left.`);
  }
  $('quotaLine').textContent = lines.join(' ');
}

function renderAi(state) {
  $('apiKey').value = state.apiKey || '';
  $('model').value = state.model || DEFAULTS.model;
}

/** Section 6 — pending snoozes + pending "send later" reminders, newest first. */
function renderSnoozes(state) {
  const list = $('snoozeList');
  list.textContent = '';

  const rows = []
    .concat(
      (state.snoozes || [])
        .filter((s) => s.status === 'pending')
        .map((s) => ({
          kind: 'snooze',
          id: s.id,
          title: s.subject || '(no subject)',
          note: s.contextNote,
          when:
            s.snoozeType === 'reply'
              ? `💬 When ${s.senderEmail || 'they'} replies`
              : `⏰ ${formatWhen(s.snoozeUntil)}`,
          sort: s.snoozeType === 'reply' ? Infinity : s.snoozeUntil,
        }))
    )
    .concat(
      (state.scheduled || [])
        .filter((s) => s.status === 'pending')
        .map((s) => ({
          kind: 'send',
          id: s.id,
          title: `📤 ${s.draftSubject}`,
          note: `to ${s.recipient}`,
          when: `⏰ ${formatWhen(s.scheduledTime)}`,
          sort: s.scheduledTime,
        }))
    )
    .sort((a, b) => a.sort - b.sort);

  $('snoozeEmpty').style.display = rows.length ? 'none' : '';

  for (const row of rows) {
    const meta = document.createElement('div');

    const title = document.createElement('div');
    title.className = 'mb-item-title';
    title.textContent = row.title;
    meta.appendChild(title);

    if (row.note) {
      const note = document.createElement('div');
      note.className = 'mb-item-note';
      note.textContent = row.note;
      meta.appendChild(note);
    }

    const when = document.createElement('div');
    when.className = 'mb-item-when';
    when.textContent = row.when;
    meta.appendChild(when);

    const cancel = document.createElement('button');
    cancel.className = 'mb-btn-mini';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', async () => {
      try {
        await chrome.runtime.sendMessage({
          action: row.kind === 'snooze' ? 'cancelSnooze' : 'cancelScheduledSend',
          id: row.id,
        });
      } catch (err) {
        ERR('cancel failed:', err);
      }
      refresh();
    });

    const li = document.createElement('li');
    li.appendChild(meta);
    li.appendChild(cancel);
    list.appendChild(li);
  }
}

async function refresh() {
  const state = await readAll();
  renderPlan(state);
  renderDarkMode(state);
  renderStats(state);
  renderAi(state);
  renderSnoozes(state);
  return state;
}

/* ==========================================================================
 * Event wiring
 * ========================================================================*/

function wireLinks() {
  const map = {
    linkApiKey: LINKS.apiKey,
    linkBuy: LINKS.pro,
    linkPrivacy: LINKS.privacy,
    linkStore: LINKS.store,
  };
  for (const [id, url] of Object.entries(map)) {
    const el = $(id);
    if (el) el.href = url;
  }
  $('coffee').addEventListener('click', () => {
    chrome.tabs.create({ url: LINKS.coffee });
  });
}

function wireControls() {
  // 2. Dark mode toggle — content scripts react instantly via onChanged.
  $('darkToggle').addEventListener('change', async (event) => {
    await write({ darkModeEnabled: event.target.checked });
    refresh();
  });

  // 4. Save API key + model.
  $('saveKey').addEventListener('click', async () => {
    const key = $('apiKey').value.trim();
    const note = $('saveKey').parentElement.parentElement.querySelector('.mb-note');
    if (key && !key.startsWith('sk-ant-')) {
      note.textContent = '⚠️ Anthropic keys normally start with "sk-ant-". Saved anyway.';
      note.className = 'mb-note mb-bad';
    } else {
      note.textContent = key
        ? '✅ Key saved. Your key stays in your browser. Never sent to our servers.'
        : 'Key cleared. Your key stays in your browser. Never sent to our servers.';
      note.className = 'mb-note mb-ok';
    }
    await write({ apiKey: key });
  });

  $('model').addEventListener('change', async (event) => {
    await write({ model: event.target.value });
  });

  // 5. Activate licence.
  const activate = async () => {
    const key = $('licenseKey').value.trim().toUpperCase();
    const status = $('licenseStatus');

    if (!key) {
      await write({ licenseKey: '', plan: 'free' });
      refresh();
      return;
    }
    if (!validateLicense(key)) {
      status.textContent = '❌ Invalid key. Expected MAILBOOST- followed by 10 characters.';
      status.className = 'mb-note mb-bad';
      return;
    }

    const plan = planForLicense(key);
    await write({ licenseKey: key, plan });
    await refresh();
    status.textContent = `✅ Activated — ${PLAN_LABELS[plan]}`;
    status.className = 'mb-note mb-ok';
  };

  $('activate').addEventListener('click', activate);
  $('licenseKey').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') activate();
  });
}

/* ==========================================================================
 * Boot
 * ========================================================================*/

document.addEventListener('DOMContentLoaded', async () => {
  LOG('opening');
  wireLinks();
  wireControls();
  await refresh();

  // Keep the panel live if a snooze fires while it is open, or if apiKey/
  // licenseKey/plan sync in from another device.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' || area === 'sync') refresh();
    });
  } catch (err) {
    ERR('could not watch storage:', err);
  }
});
