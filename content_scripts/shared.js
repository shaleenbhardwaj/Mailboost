/* ============================================================================
 * MailBoost — shared.js
 * ----------------------------------------------------------------------------
 * Loaded FIRST on every supported mail site. Provides:
 *   1. Storage helpers (all wrapped in try/catch)
 *   2. Plan / licence / usage-limit logic
 *   3. The toast notification system
 *   4. Reusable modals (upgrade, snooze, date-time picker)
 *   5. MailBoost.init(adapter) — the feature engine that outlook.js and
 *      yahoo.js drive with their own site-specific CSS selectors.
 *
 * SAFETY RULES honoured throughout this file:
 *   - every injected class name is prefixed "mailboost-"
 *   - we only ADD DOM nodes, we never modify or delete the mail app's own
 *   - every chrome.* call is wrapped in try/catch
 *   - the MutationObserver disconnects on pagehide/unload
 *   - no email content is ever written to extension storage
 * ==========================================================================*/

(function () {
  'use strict';

  // Guard against the script being injected twice (SPA navigations, reloads).
  if (window.MailBoost) {
    console.log('[MailBoost] shared.js already loaded — skipping.');
    return;
  }

  const MB = {};
  window.MailBoost = MB;

  /* ==========================================================================
   * 0. Constants
   * ========================================================================*/

  MB.VERSION = '1.0.0';

  /** How many unsubscribes a free user gets per calendar month. */
  MB.FREE_UNSUB_PER_MONTH = 5;
  /** How many AI summaries a free user gets, ever (a trial, not a monthly quota). */
  MB.FREE_AI_TRIAL_USES = 5;

  /** Placeholder checkout links — swap these for your real Gumroad products. */
  MB.LINKS = {
    basic: 'https://gumroad.com/l/mailboost-basic',
    pro: 'https://gumroad.com/l/mailboost-pro',
    coffee: 'https://buymeacoffee.com/mailboost',
    apiKey: 'https://console.anthropic.com/settings/keys',
    privacy: 'https://shaleenbhardwaj.github.io/Mailboost/privacy.html',
    store: 'https://chromewebstore.google.com/detail/mailboost',
  };

  /** Everything we persist, with its default value. */
  MB.DEFAULTS = {
    darkModeEnabled: true,     // Feature 1 — on by default
    plan: 'free',              // 'free' | 'basic' | 'pro'
    licenseKey: '',
    apiKey: '',                // Anthropic API key
    model: 'claude-sonnet-5',  // which Claude model the summariser calls
    unsubCount: 0,             // unsubscribes used in the current month
    unsubPeriod: '',           // 'YYYY-MM' the counter above belongs to
    unsubTotal: 0,             // lifetime counter, for the stats panel
    freeAiUses: 0,             // AI summaries burned from the free trial
    aiTotal: 0,                // lifetime counter
    snoozeTotal: 0,            // lifetime counter
    darkFixDate: '',           // 'YYYY-MM-DD'
    darkFixCount: 0,           // emails restyled today
    snoozes: [],               // pending + fired snooze records
    scheduled: [],             // pending "send later" reminders
    notifyOnProLaunch: false,  // opted in via the "coming soon" upgrade modal
  };

  /**
   * Keys that follow the user across devices via chrome.storage.sync
   * (their Anthropic key, licence, and plan/pro status). Everything else
   * — usage counters, the snooze list, per-device preferences — stays in
   * chrome.storage.local. sync has small per-item/total quotas, so only
   * put small, low-frequency-write values here.
   */
  MB.SYNC_KEYS = ['apiKey', 'licenseKey', 'plan'];

  /** Split any {key: value} object into { sync: {...}, local: {...} }. */
  MB.splitByStorageArea = function (obj) {
    const sync = {};
    const local = {};
    for (const [key, value] of Object.entries(obj)) {
      (MB.SYNC_KEYS.includes(key) ? sync : local)[key] = value;
    }
    return { sync, local };
  };

  /* ==========================================================================
   * 1. Small utilities
   * ========================================================================*/

  MB.log = (...args) => console.log('[MailBoost]', ...args);
  MB.warn = (...args) => console.warn('[MailBoost]', ...args);
  MB.error = (...args) => console.error('[MailBoost]', ...args);

  /** RFC-4122-ish v4 id. crypto.randomUUID isn't on every Chrome we support. */
  MB.uuid = function () {
    if (crypto && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  };

  /**
   * Tiny DOM builder. Everything MailBoost injects is built with this rather
   * than innerHTML, so email content can never be interpreted as markup.
   */
  MB.h = function (tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (key === 'class') el.className = value;
      else if (key === 'style') el.style.cssText = value;
      else if (key === 'text') el.textContent = value;
      else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value !== null && value !== undefined) {
        el.setAttribute(key, value);
      }
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return el;
  };

  /** Debounce — MutationObservers on mail apps fire constantly. */
  MB.debounce = function (fn, wait) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  };

  /** Try each selector in order, return the first element that matches. */
  MB.pick = function (selectors, root) {
    const scope = root || document;
    for (const selector of selectors) {
      try {
        const found = scope.querySelector(selector);
        if (found) return found;
      } catch (err) {
        MB.warn('Bad selector skipped:', selector, err);
      }
    }
    return null;
  };

  MB.monthKey = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  MB.dayKey = (d) => `${MB.monthKey(d)}-${String(d.getDate()).padStart(2, '0')}`;

  MB.formatWhen = function (timestamp) {
    try {
      return new Date(timestamp).toLocaleString(undefined, {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
      });
    } catch (err) {
      return String(timestamp);
    }
  };

  /* ==========================================================================
   * 2. Storage — split across chrome.storage.sync / .local, always try/catch'd
   * --------------------------------------------------------------------------
   * apiKey, licenseKey and plan live in .sync (they follow the user's signed-
   * in Chrome profile across devices). Everything else — usage counters, the
   * snooze list, dark-mode preference — lives in .local, since sync has a
   * small per-item/total quota and no reason to leave this device.
   * ========================================================================*/

  let _syncMigrationChecked = false;

  /**
   * One-time migration for installs from before apiKey/licenseKey/plan moved
   * to chrome.storage.sync. Without this, anyone who had already activated a
   * licence or saved an API key would see it silently vanish — the old value
   * sits orphaned in .local, and the new code only reads .sync for those
   * keys. Idempotent: gated by both an in-memory flag (skip repeat checks in
   * this script's lifetime) and a storage-level `_syncMigrationDone` marker
   * (skip on every future load, including in other tabs/the popup/the
   * service worker, since each of those runs this same check independently).
   */
  async function migrateLegacyLocalKeys() {
    if (_syncMigrationChecked) return;
    _syncMigrationChecked = true;
    try {
      const localCheck = await chrome.storage.local.get(['_syncMigrationDone', ...MB.SYNC_KEYS]);
      if (localCheck._syncMigrationDone) return;

      const existingSync = await chrome.storage.sync.get(MB.SYNC_KEYS);
      const toMigrate = {};
      for (const key of MB.SYNC_KEYS) {
        const localValue = localCheck[key];
        const hasLocalValue = localValue !== undefined && localValue !== '' && localValue !== MB.DEFAULTS[key];
        const syncAlreadyHasIt = existingSync[key] !== undefined && existingSync[key] !== '' && existingSync[key] !== MB.DEFAULTS[key];
        if (hasLocalValue && !syncAlreadyHasIt) toMigrate[key] = localValue;
      }

      if (Object.keys(toMigrate).length) {
        await chrome.storage.sync.set(toMigrate);
        MB.log('migrated legacy local values to sync:', Object.keys(toMigrate).join(', '));
      }
      await chrome.storage.local.remove(MB.SYNC_KEYS);
      await chrome.storage.local.set({ _syncMigrationDone: true });
    } catch (err) {
      MB.error('sync migration failed (non-fatal):', err);
    }
  }

  MB.storage = {
    /** Read the whole settings object, filling in defaults for missing keys. */
    async getAll() {
      await migrateLegacyLocalKeys();
      try {
        const { sync: syncDefaults, local: localDefaults } = MB.splitByStorageArea(MB.DEFAULTS);
        const [syncStored, localStored] = await Promise.all([
          chrome.storage.sync.get(syncDefaults),
          chrome.storage.local.get(localDefaults),
        ]);
        return Object.assign({}, MB.DEFAULTS, syncStored, localStored);
      } catch (err) {
        MB.error('storage.getAll failed, using defaults:', err);
        return Object.assign({}, MB.DEFAULTS);
      }
    },

    async get(key) {
      const all = await MB.storage.getAll();
      return all[key];
    },

    async set(patch) {
      try {
        const { sync: syncPatch, local: localPatch } = MB.splitByStorageArea(patch);
        const writes = [];
        if (Object.keys(syncPatch).length) writes.push(chrome.storage.sync.set(syncPatch));
        if (Object.keys(localPatch).length) writes.push(chrome.storage.local.set(localPatch));
        await Promise.all(writes);
        MB.log('storage.set', Object.keys(patch).join(', '));
        return true;
      } catch (err) {
        MB.error('storage.set failed:', err, patch);
        return false;
      }
    },

    /** Read-modify-write helper so callers don't race each other as often. */
    async bump(key, by) {
      const all = await MB.storage.getAll();
      const next = (Number(all[key]) || 0) + (by === undefined ? 1 : by);
      await MB.storage.set({ [key]: next });
      return next;
    },
  };

  /** Fire-and-forget message to the service worker. */
  MB.send = async function (message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (err) {
      MB.error('sendMessage failed:', message.action, err);
      return { ok: false, error: String(err) };
    }
  };

  /* ==========================================================================
   * 3. Plans, licences and usage limits
   * ========================================================================*/

  /**
   * MVP licence validation — deliberately offline, no server required.
   * A key is valid when it starts with "MAILBOOST-" and is exactly 20 chars.
   * The character right after the dash selects the tier:
   *     MAILBOOST-B123456789   -> Basic
   *     MAILBOOST-P123456789   -> Pro   (anything that isn't "B" is treated as Pro)
   */
  MB.validateLicense = function (key) {
    const value = String(key || '').trim().toUpperCase();
    return value.startsWith('MAILBOOST-') && value.length === 20;
  };

  MB.planForLicense = function (key) {
    if (!MB.validateLicense(key)) return 'free';
    return String(key).trim().toUpperCase()[10] === 'B' ? 'basic' : 'pro';
  };

  MB.PLAN_LABELS = { free: 'Free', basic: 'Basic ✓', pro: 'Pro ✓' };

  /** Which plan unlocks which feature. */
  MB.FEATURE_PLAN = {
    darkMode: 'free',
    unsubscribe: 'free',   // free but metered — see canUseUnsubscribe()
    snooze: 'basic',
    aiSummary: 'pro',      // pro but with a 5-use free trial
    sendLater: 'pro',
  };

  MB.FEATURE_LABELS = {
    darkMode: '🌙 Dark Mode Fix',
    unsubscribe: '🚫 One-Click Unsubscribe',
    snooze: '🔕 Smart Snooze',
    aiSummary: '✨ AI Email Summary',
    sendLater: '⏰ Send Later',
  };

  const PLAN_RANK = { free: 0, basic: 1, pro: 2 };

  MB.planAllows = function (plan, feature) {
    const needed = MB.FEATURE_PLAN[feature] || 'pro';
    return PLAN_RANK[plan || 'free'] >= PLAN_RANK[needed];
  };

  /**
   * Unsubscribe budget. Free users get 5 per calendar month; the counter
   * resets itself the first time it is read in a new month.
   */
  MB.canUseUnsubscribe = async function () {
    const state = await MB.storage.getAll();
    if (state.plan !== 'free') return { allowed: true, remaining: Infinity };

    const period = MB.monthKey(new Date());
    if (state.unsubPeriod !== period) {
      await MB.storage.set({ unsubPeriod: period, unsubCount: 0 });
      return { allowed: true, remaining: MB.FREE_UNSUB_PER_MONTH };
    }
    const used = Number(state.unsubCount) || 0;
    return {
      allowed: used < MB.FREE_UNSUB_PER_MONTH,
      remaining: Math.max(0, MB.FREE_UNSUB_PER_MONTH - used),
    };
  };

  /** AI summary budget: unlimited on Pro, otherwise a 5-use lifetime trial. */
  MB.canUseAi = async function () {
    const state = await MB.storage.getAll();
    if (state.plan === 'pro') return { allowed: true, remaining: Infinity };
    const used = Number(state.freeAiUses) || 0;
    return {
      allowed: used < MB.FREE_AI_TRIAL_USES,
      remaining: Math.max(0, MB.FREE_AI_TRIAL_USES - used),
    };
  };

  /* ==========================================================================
   * 4. Toast notifications (Feature 8)
   * ========================================================================*/

  MB.showToast = function (message, type) {
    const colors = {
      success: '#2e7d32',
      error: '#c62828',
      info: '#1565c0',
      warning: '#e65100',
    };
    const background = colors[type || 'info'] || colors.info;
    const stacked = document.querySelectorAll('.mailboost-toast').length;

    const toast = document.createElement('div');
    toast.className = 'mailboost-toast';
    toast.style.cssText = `
      position: fixed;
      bottom: ${20 + stacked * 60}px;
      right: 20px;
      background: ${background};
      color: white;
      padding: 12px 20px;
      border-radius: 8px;
      font-family: 'Segoe UI', sans-serif;
      font-size: 13px;
      z-index: 9999999;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      animation: mailboost-slidein 0.3s ease;
      max-width: 320px;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, 3000);

    MB.log('toast:', type || 'info', message);
  };

  /* ==========================================================================
   * 5. Modal shell + the three modals we need
   * ========================================================================*/

  /** Builds the dark overlay and returns { overlay, card, close }. */
  MB.buildModal = function (titleText) {
    // Only one MailBoost modal at a time.
    document.querySelectorAll('.mailboost-overlay').forEach((n) => n.remove());

    const card = MB.h('div', { class: 'mailboost-modal', role: 'dialog', 'aria-modal': 'true' });
    const overlay = MB.h('div', { class: 'mailboost-overlay' }, card);

    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };

    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);

    if (titleText) {
      card.appendChild(
        MB.h('div', { class: 'mailboost-modal-head' },
          MB.h('h2', { class: 'mailboost-modal-title', text: titleText }),
          MB.h('button', {
            class: 'mailboost-modal-x', 'aria-label': 'Close', text: '×', onclick: close,
          })
        )
      );
    }

    document.body.appendChild(overlay);
    return { overlay, card, close };
  };

  /**
   * Feature 6 — the upgrade wall. Shown whenever a gated feature is reached.
   *
   * PRE-LAUNCH MODE: real Basic/Pro purchasing isn't live yet (no payment
   * platform wired up), so this deliberately does NOT try to sell a plan —
   * it says Pro is coming, points at the Buy Me a Coffee tip jar in the
   * meantime, and offers a local "notify me" opt-in. `feature`/`reason` are
   * kept as parameters (existing callers pass them) but aren't rendered —
   * once real purchasing exists, restore per-feature Basic/Pro copy here.
   * Licence-key activation still works — it just lives in the popup now,
   * not duplicated into this modal.
   */
  MB.showUpgradeModal = async function (feature, reason) {
    MB.log('upgrade modal shown, triggered by:', feature, reason);
    const alreadyOptedIn = await MB.storage.get('notifyOnProLaunch');

    const { card, close } = MB.buildModal(null);

    card.appendChild(
      MB.h('button', { class: 'mailboost-modal-x', 'aria-label': 'Close', text: '×', onclick: close })
    );
    card.appendChild(
      MB.h('h2', { class: 'mailboost-modal-title', text: '⚡ MailBoost Pro — Coming Soon!' })
    );
    card.appendChild(
      MB.h('p', {
        class: 'mailboost-modal-copy',
        text: 'Unlimited AI summaries, Smart Snooze & Send Later launching very soon.',
      })
    );
    card.appendChild(
      MB.h('p', {
        class: 'mailboost-modal-copy',
        text: 'While we set up payments, support development with a coffee ☕',
      })
    );

    const notifyBtn = MB.h('button', {
      class: 'mailboost-btn mailboost-btn-ghost mailboost-full',
      text: alreadyOptedIn ? "🔔 You're on the list!" : '🔔 Notify me when Pro launches',
    });
    if (alreadyOptedIn) notifyBtn.disabled = true;
    notifyBtn.addEventListener('click', async () => {
      await MB.storage.set({ notifyOnProLaunch: true });
      notifyBtn.textContent = "🔔 You're on the list!";
      notifyBtn.disabled = true;
      MB.showToast("🔔 We'll notify you right here when Pro launches!", 'success');
    });

    card.appendChild(
      MB.h('button', {
        class: 'mailboost-btn mailboost-btn-coffee mailboost-full',
        text: '☕ Buy Me a Coffee — €3-5',
        onclick: () => window.open(MB.LINKS.coffee, '_blank', 'noopener'),
      })
    );
    card.appendChild(notifyBtn);
  };

  /**
   * Gate helper. Returns true when the feature may run; otherwise shows the
   * upgrade modal and returns false. Callers just do:
   *     if (!(await MB.requireFeature('snooze'))) return;
   */
  MB.requireFeature = async function (feature) {
    const plan = await MB.storage.get('plan');
    if (MB.planAllows(plan, feature)) return true;
    // Name the tier this specific feature actually needs (Snooze is Basic,
    // AI Summary/Send Later are Pro) — don't blanket-label everything "Pro".
    const neededPlan = MB.FEATURE_PLAN[feature] || 'pro';
    const neededLabel = neededPlan === 'basic' ? 'Basic' : 'Pro';
    MB.showUpgradeModal(feature, `This is a MailBoost ${neededLabel} tool 🔒`);
    return false;
  };

  /**
   * Feature 3 — the Smart Snooze modal.
   * Calls back with { snoozeType, snoozeUntil, contextNote }.
   */
  MB.showSnoozeModal = function (context, onConfirm) {
    const { card, close } = MB.buildModal('🔕 Smart Snooze');

    card.appendChild(
      MB.h('p', { class: 'mailboost-modal-copy', text: context.subject || '(no subject)' })
    );

    const note = MB.h('input', {
      class: 'mailboost-input',
      type: 'text',
      placeholder: 'e.g. Follow up about invoice #447',
      'aria-label': 'Context note',
    });

    const custom = MB.h('input', {
      class: 'mailboost-input',
      type: 'datetime-local',
      'aria-label': 'Custom snooze time',
    });

    const finish = (snoozeType, snoozeUntil) => {
      close();
      onConfirm({
        snoozeType,
        snoozeUntil,
        contextNote: note.value.trim(),
      });
    };

    const now = new Date();
    const tomorrow9 = new Date(now);
    tomorrow9.setDate(now.getDate() + 1);
    tomorrow9.setHours(9, 0, 0, 0);

    const nextMonday9 = new Date(now);
    // getDay(): 0 = Sunday, 1 = Monday.
    const daysUntilMonday = ((8 - nextMonday9.getDay()) % 7) || 7;
    nextMonday9.setDate(now.getDate() + daysUntilMonday);
    nextMonday9.setHours(9, 0, 0, 0);

    const options = [
      ['⏰ In 3 hours', () => finish('time', Date.now() + 3 * 60 * 60 * 1000)],
      ['⏰ Tomorrow 9am', () => finish('time', tomorrow9.getTime())],
      ['⏰ Next Monday 9am', () => finish('time', nextMonday9.getTime())],
      ['💬 When they reply', () => finish('reply', 0)],
    ];

    const list = MB.h('div', { class: 'mailboost-option-list' });
    for (const [label, handler] of options) {
      list.appendChild(MB.h('button', { class: 'mailboost-option', text: label, onclick: handler }));
    }

    card.appendChild(MB.h('label', { class: 'mailboost-label', text: '📝 Context note (optional)' }));
    card.appendChild(note);
    card.appendChild(list);
    card.appendChild(MB.h('label', { class: 'mailboost-label', text: '📅 Or pick a custom time' }));
    card.appendChild(
      MB.h('div', { class: 'mailboost-inline-row' },
        custom,
        MB.h('button', {
          class: 'mailboost-btn mailboost-btn-primary',
          text: 'Snooze',
          onclick: () => {
            const when = new Date(custom.value).getTime();
            if (!custom.value || Number.isNaN(when)) {
              MB.showToast('⚠️ Pick a date and time first', 'warning');
              return;
            }
            if (when <= Date.now()) {
              MB.showToast('⚠️ That time is already in the past', 'warning');
              return;
            }
            finish('time', when);
          },
        })
      )
    );
  };

  /** Generic date-time picker, used by Send Later. */
  MB.showDateTimeModal = function (title, confirmLabel, onConfirm) {
    const { card, close } = MB.buildModal(title);
    const input = MB.h('input', {
      class: 'mailboost-input',
      type: 'datetime-local',
      'aria-label': 'Scheduled time',
    });

    card.appendChild(input);
    card.appendChild(
      MB.h('div', { class: 'mailboost-inline-row' },
        MB.h('button', {
          class: 'mailboost-btn mailboost-btn-primary',
          text: confirmLabel,
          onclick: () => {
            const when = new Date(input.value).getTime();
            if (!input.value || Number.isNaN(when)) {
              MB.showToast('⚠️ Pick a date and time first', 'warning');
              return;
            }
            if (when <= Date.now()) {
              MB.showToast('⚠️ That time is already in the past', 'warning');
              return;
            }
            close();
            onConfirm(when);
          },
        }),
        MB.h('button', { class: 'mailboost-btn mailboost-btn-ghost', text: 'Cancel', onclick: close })
      )
    );
  };

  /* ==========================================================================
   * 6. The feature engine
   * --------------------------------------------------------------------------
   * outlook.js and yahoo.js each build an "adapter" describing where things
   * live in their DOM, then call MB.init(adapter). Everything below is
   * provider-agnostic.
   *
   * adapter = {
   *   name, selectors: {
   *     readingPane[], messageBody[], subject[], sender[], senderEmail[],
   *     composeWindow[], composeSend[], messageList[], listItem, listItemText[]
   *   },
   *   composeUrl
   * }
   * ========================================================================*/

  MB.init = function (adapter) {
    MB.adapter = adapter;
    MB.log(`init on ${adapter.name} (v${MB.VERSION})`);

    const S = adapter.selectors;
    let observer = null;
    let lastEmailFingerprint = '';

    /* ---------------------------------------------------------------------
     * FEATURE 1 — Dark Mode Fixer
     * -------------------------------------------------------------------*/

    const DARK_STYLE_ID = 'mailboost-darkmode-style';

    const injectDarkModeFix = () => {
      if (document.getElementById(DARK_STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = DARK_STYLE_ID;
      // The reading-pane selector differs per provider, so it is templated in.
      const pane = adapter.darkScope || '[aria-label="Reading Pane"]';
      style.textContent = `
        /* Fix ${adapter.name} reading pane dark mode */
        ${pane} {
          background-color: #121212 !important;
          color: #e0e0e0 !important;
        }
        /* Fix broken nested white containers */
        ${pane} div,
        ${pane} table,
        ${pane} td,
        ${pane} p,
        ${pane} span {
          background-color: transparent !important;
          color: inherit !important;
        }
        /* Fix bright white inline backgrounds */
        ${pane} [style*="background-color: white"],
        ${pane} [style*="background-color: #ffffff"],
        ${pane} [style*="background-color:#ffffff"],
        ${pane} [style*="background: white"],
        ${pane} [style*="background:#ffffff"] {
          background-color: #1e1e1e !important;
        }
        /* Fix unreadable black text on dark background */
        ${pane} [style*="color: black"],
        ${pane} [style*="color: #000000"],
        ${pane} [style*="color:#000000"],
        ${pane} [style*="color: #000"],
        ${pane} [style*="color:#000"] {
          color: #e0e0e0 !important;
        }
        /* Fix email links */
        ${pane} a {
          color: #60b4ff !important;
        }
        /* Never repaint MailBoost's own UI */
        ${pane} .mailboost-toolbar,
        ${pane} .mailboost-toolbar * {
          background-color: revert !important;
          color: revert !important;
        }
      `;
      document.head.appendChild(style);
      MB.log('dark mode fix injected');
    };

    const removeDarkModeFix = () => {
      const existing = document.getElementById(DARK_STYLE_ID);
      if (existing) {
        existing.remove();
        MB.log('dark mode fix removed');
      }
    };

    /** Bump the "fixing N emails today" counter shown in the popup. */
    const countDarkFix = async () => {
      const state = await MB.storage.getAll();
      if (!state.darkModeEnabled) return;
      const today = MB.dayKey(new Date());
      if (state.darkFixDate !== today) {
        await MB.storage.set({ darkFixDate: today, darkFixCount: 1 });
      } else {
        await MB.storage.set({ darkFixCount: (Number(state.darkFixCount) || 0) + 1 });
      }
    };

    /** The floating 🌙 button, bottom-right. */
    const createFloatingToggle = async () => {
      if (document.getElementById('mailboost-dark-toggle')) return;
      const enabled = await MB.storage.get('darkModeEnabled');

      const button = MB.h('button', {
        id: 'mailboost-dark-toggle',
        class: 'mailboost-fab',
        title: 'MailBoost — toggle dark mode fix',
        'aria-label': 'Toggle MailBoost dark mode fix',
        text: '🌙',
      });
      button.dataset.on = String(enabled !== false);

      button.addEventListener('click', async () => {
        const next = !(await MB.storage.get('darkModeEnabled'));
        await MB.storage.set({ darkModeEnabled: next });
        button.dataset.on = String(next);
        if (next) {
          injectDarkModeFix();
          MB.showToast('🌙 Dark mode fix ON', 'success');
        } else {
          removeDarkModeFix();
          MB.showToast('☀️ Dark mode fix OFF', 'info');
        }
      });

      document.body.appendChild(button);
      MB.log('floating toggle added');
    };

    /* ---------------------------------------------------------------------
     * Reading-pane helpers
     * -------------------------------------------------------------------*/

    const getReadingPane = () => MB.pick(S.readingPane);

    const getEmailBody = () => MB.pick(S.messageBody) || getReadingPane();

    /**
     * Some providers can't be reliably targeted with plain CSS selectors
     * (e.g. Outlook's Fluent2 reading pane has no stable landmark to scope
     * a subject/sender query to — see content_scripts/outlook.js). Those
     * adapters supply `findSubject(doc)` / `findSender(doc)` finder
     * functions that do the smarter DOM scan; adapters that don't need
     * that (Yahoo, which already has stable data-test-id selectors) fall
     * through to the plain selector-array lookup below unchanged.
     */
    const getSubject = () => {
      if (typeof adapter.findSubject === 'function') {
        try {
          const text = adapter.findSubject(document);
          if (text) return String(text).trim().slice(0, 200);
        } catch (err) {
          MB.warn('adapter.findSubject failed:', err);
        }
      }
      const el = MB.pick(S.subject);
      return el ? el.textContent.trim().slice(0, 200) : '';
    };

    const getSender = () => {
      if (typeof adapter.findSender === 'function') {
        try {
          const found = adapter.findSender(document);
          if (found && (found.email || found.name)) {
            return {
              name: String(found.name || '').trim().slice(0, 120),
              email: String(found.email || '').trim().toLowerCase(),
            };
          }
        } catch (err) {
          MB.warn('adapter.findSender failed:', err);
        }
      }
      const el = MB.pick(S.sender);
      if (!el) return { name: '', email: '' };
      const name = (el.getAttribute('title') || el.textContent || '').trim();
      // The e-mail address is often in the title attribute or the text itself.
      const haystack = `${el.getAttribute('title') || ''} ${el.textContent || ''}`;
      const match = haystack.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
      return {
        name: name.slice(0, 120),
        email: match ? match[0].toLowerCase() : '',
      };
    };

    /** Cheap identity for "has the open email changed?". */
    const emailFingerprint = () => {
      const sender = getSender();
      return `${getSubject()}::${sender.email || sender.name}`;
    };

    /* ---------------------------------------------------------------------
     * FEATURE 2 — One-click unsubscribe
     * -------------------------------------------------------------------*/

    // Pass 1 — explicit, high-confidence: the link's own text or href says
    // "unsubscribe" directly (English + German).
    const UNSUB_KEYWORDS = [
      'unsubscribe', 'opt-out', 'opt_out', 'optout',
      'remove', 'manage-preferences', 'email-preferences',
      'manage-subscription', 'update-preferences',
      'abbestellen', 'abmelden', 'austragen', 'abo-kuendigen',
      'newsletter-abmelden', 'newsletter-abbestellen',
    ];

    // Pass 2 — a LOT of marketing emails (German ones especially) bury the
    // actual "stop emailing me" sentence in surrounding prose and use a
    // generic "click here" as the link text itself, e.g.:
    //   "Wenn du keine weiteren E-Mails von uns erhalten möchtest,
    //    klicke bitte hier."
    // No amount of link-level keyword matching catches that — the intent is
    // in the SENTENCE, not the link. So for generic-looking links only, we
    // also read the sentence around them for two independent signals (a
    // "stop" word and an "email" word) rather than one rigid phrase, since
    // German clause structure varies too much for a fixed regex to match
    // reliably (e.g. "keine weiteren E-Mails VON UNS erhalten" — words
    // intervene between "keine" and "erhalten").
    const GENERIC_LINK_TEXT = ['hier', 'here', 'click here', 'klicke hier', 'click', 'link', 'jetzt'];
    const UNSUB_STOP_SIGNALS = [
      'keine weiteren', 'keine e-mails mehr', 'nicht mehr erhalten', 'nicht mehr erhalte',
      'no longer wish', 'no longer want', "don't want to receive", 'stop receiving',
      'opt out', 'opt-out',
    ];
    const UNSUB_EMAIL_SIGNALS = ['e-mail', 'email', 'newsletter', 'nachricht'];

    /** Read a short amount of context around a link — the sentence it sits in. */
    const nearbyText = (link) => {
      let node = link.parentElement;
      for (let hop = 0; hop < 3 && node; hop++) {
        const text = (node.textContent || '').trim();
        if (text.length >= 20) return text.toLowerCase();
        node = node.parentElement;
      }
      return (link.parentElement && link.parentElement.textContent || '').trim().toLowerCase();
    };

    const findUnsubscribeUrl = (emailContainer) => {
      if (!emailContainer) return null;
      const links = Array.from(emailContainer.querySelectorAll('a')).filter(
        (link) => (link.href || '').toLowerCase().startsWith('http')   // skip mailto:/javascript:
      );

      for (const link of links) {
        const href = link.href.toLowerCase();
        const text = (link.textContent || '').toLowerCase();
        if (UNSUB_KEYWORDS.some((k) => href.includes(k) || text.includes(k))) {
          return link.href;
        }
      }

      for (const link of links) {
        const text = (link.textContent || '').trim().toLowerCase();
        if (!GENERIC_LINK_TEXT.includes(text)) continue;
        const context = nearbyText(link);
        const hasStop = UNSUB_STOP_SIGNALS.some((s) => context.includes(s));
        const hasEmail = UNSUB_EMAIL_SIGNALS.some((s) => context.includes(s));
        if (hasStop && hasEmail) return link.href;
      }

      return null;
    };

    const handleUnsubscribe = async () => {
      const budget = await MB.canUseUnsubscribe();
      if (!budget.allowed) {
        MB.showUpgradeModal(
          'unsubscribe',
          `You've used all ${MB.FREE_UNSUB_PER_MONTH} free unsubscribes this month! 🎉`
        );
        return;
      }

      const url = findUnsubscribeUrl(getEmailBody());
      if (!url) {
        MB.showToast('⚠️ No unsubscribe link found in this email', 'warning');
        return;
      }

      MB.log('unsubscribing via', url);
      // The URL goes straight to a background tab. It is never sent anywhere else.
      const result = await MB.send({ action: 'openBackgroundTab', url });
      if (!result || result.ok === false) {
        MB.showToast('❌ Could not open the unsubscribe link', 'error');
        return;
      }

      const state = await MB.storage.getAll();
      await MB.storage.set({
        unsubPeriod: MB.monthKey(new Date()),
        unsubCount: (Number(state.unsubCount) || 0) + 1,
        unsubTotal: (Number(state.unsubTotal) || 0) + 1,
      });

      MB.showToast('✅ Unsubscribed silently! Tab auto-closed.', 'success');
      if (state.plan === 'free' && budget.remaining - 1 <= 2) {
        setTimeout(
          () => MB.showToast(`ℹ️ ${budget.remaining - 1} free unsubscribes left this month`, 'info'),
          1200
        );
      }
    };

    /* ---------------------------------------------------------------------
     * FEATURE 3 — Smart Snooze
     * -------------------------------------------------------------------*/

    const handleSnooze = async () => {
      if (!(await MB.requireFeature('snooze'))) return;

      const sender = getSender();
      const subject = getSubject();

      MB.showSnoozeModal({ subject }, async (choice) => {
        if (choice.snoozeType === 'reply' && !sender.email) {
          MB.showToast('⚠️ Could not read the sender address for reply-watch', 'warning');
          return;
        }

        const record = {
          id: MB.uuid(),
          emailId: emailFingerprint(),
          subject,
          sender: sender.name,
          senderEmail: sender.email,
          snoozeType: choice.snoozeType,
          snoozeUntil: choice.snoozeUntil,
          watchSenderEmail: choice.snoozeType === 'reply' ? sender.email : '',
          contextNote: choice.contextNote,
          createdAt: Date.now(),
          status: 'pending',
        };

        const state = await MB.storage.getAll();
        await MB.storage.set({
          snoozes: state.snoozes.concat([record]),
          snoozeTotal: (Number(state.snoozeTotal) || 0) + 1,
        });
        await MB.send({ action: 'scheduleSnooze', snooze: record });

        MB.showToast(
          choice.snoozeType === 'reply'
            ? `💬 Watching for a reply from ${sender.email}`
            : `🔕 Snoozed until ${MB.formatWhen(choice.snoozeUntil)}`,
          'success'
        );
      });
    };

    /* ---------------------------------------------------------------------
     * FEATURE 4 — AI email summariser
     * -------------------------------------------------------------------*/

    const SIDEBAR_ID = 'mailboost-sidebar';

    const closeSidebar = () => {
      const panel = document.getElementById(SIDEBAR_ID);
      if (panel) panel.remove();
    };

    const openSidebar = () => {
      closeSidebar();
      const body = MB.h('div', { class: 'mailboost-sidebar-body' });
      const panel = MB.h('aside', { id: SIDEBAR_ID, class: 'mailboost-sidebar' },
        MB.h('div', { class: 'mailboost-sidebar-head' },
          MB.h('span', { class: 'mailboost-sidebar-title', text: '✨ MailBoost AI Summary' }),
          MB.h('button', {
            class: 'mailboost-modal-x', 'aria-label': 'Close summary', text: '×', onclick: closeSidebar,
          })
        ),
        body
      );
      document.body.appendChild(panel);
      // Next frame so the CSS transition actually runs.
      requestAnimationFrame(() => panel.classList.add('mailboost-sidebar-open'));
      return body;
    };

    const renderSummary = (body, data) => {
      body.textContent = '';

      const bullets = MB.h('ul', { class: 'mailboost-bullets' });
      (data.summary || []).slice(0, 3).forEach((point) => {
        bullets.appendChild(MB.h('li', { text: point }));
      });
      body.appendChild(MB.h('h3', { class: 'mailboost-sidebar-h3', text: 'Summary' }));
      body.appendChild(bullets);

      if (data.action_required) {
        body.appendChild(MB.h('h3', { class: 'mailboost-sidebar-h3', text: '✅ Action required' }));
        body.appendChild(MB.h('p', { class: 'mailboost-sidebar-p', text: data.action_required }));
      }
      if (data.deadline) {
        body.appendChild(MB.h('h3', { class: 'mailboost-sidebar-h3', text: '⏳ Deadline' }));
        body.appendChild(MB.h('p', { class: 'mailboost-sidebar-p mailboost-deadline', text: data.deadline }));
      }

      const replies = (data.quick_replies || []).slice(0, 3);
      if (replies.length) {
        body.appendChild(MB.h('h3', { class: 'mailboost-sidebar-h3', text: 'Quick replies' }));
        const row = MB.h('div', { class: 'mailboost-quick-replies' });
        const presets = ["✅ I'll handle it", '⏰ Need more time', '❓ Have questions'];
        replies.forEach((reply, index) => {
          const label = presets[index] || reply;
          row.appendChild(
            MB.h('button', {
              class: 'mailboost-chip',
              title: `Copy: ${reply}`,
              text: label,
              onclick: async () => {
                await navigator.clipboard.writeText(reply);
                MB.showToast(`📋 Copied "${reply}"`, 'success');
              },
            })
          );
        });
        body.appendChild(row);
      }

      const plain = [
        'MailBoost AI Summary',
        ...(data.summary || []).map((s) => `• ${s}`),
        data.action_required ? `Action required: ${data.action_required}` : '',
        data.deadline ? `Deadline: ${data.deadline}` : '',
      ].filter(Boolean).join('\n');

      body.appendChild(
        MB.h('button', {
          class: 'mailboost-btn mailboost-btn-primary mailboost-full',
          text: 'Copy Summary',
          onclick: async () => {
            await navigator.clipboard.writeText(plain);
            MB.showToast('📋 Summary copied to clipboard', 'success');
          },
        })
      );
    };

    const handleSummarize = async () => {
      const pane = getReadingPane();
      if (!pane) {
        MB.showToast('⚠️ Please open an email first', 'warning');
        return;
      }

      const state = await MB.storage.getAll();
      if (!state.apiKey) {
        MB.showToast('🔑 Add your Anthropic API key in MailBoost settings', 'warning');
        return;
      }

      const budget = await MB.canUseAi();
      if (!budget.allowed) {
        MB.showUpgradeModal(
          'aiSummary',
          `Your ${MB.FREE_AI_TRIAL_USES} free AI summaries are used up! 🎉`
        );
        return;
      }

      const emailText = (getEmailBody().innerText || '').trim().slice(0, 12000);
      if (emailText.length < 20) {
        MB.showToast('⚠️ Please open an email first', 'warning');
        return;
      }

      const body = openSidebar();
      body.appendChild(
        MB.h('div', { class: 'mailboost-loading' },
          MB.h('div', { class: 'mailboost-spinner' }),
          MB.h('p', { class: 'mailboost-sidebar-p', text: 'Reading the thread…' })
        )
      );

      // The email text goes to Anthropic and nowhere else — see PRIVACY.md.
      const result = await MB.send({
        action: 'summarizeEmail',
        emailText,
        apiKey: state.apiKey,
        model: state.model,
      });

      if (!result || !result.ok) {
        body.textContent = '';
        body.appendChild(
          MB.h('p', {
            class: 'mailboost-sidebar-p mailboost-err',
            text: 'Summary failed. Check your API key in settings.',
          })
        );
        if (result && result.error) {
          body.appendChild(MB.h('p', { class: 'mailboost-fineprint', text: result.error }));
        }
        MB.showToast('❌ Summary failed. Check your API key in settings.', 'error');
        return;
      }

      renderSummary(body, result.data);
      await MB.storage.set({
        freeAiUses: (Number(state.freeAiUses) || 0) + (state.plan === 'pro' ? 0 : 1),
        aiTotal: (Number(state.aiTotal) || 0) + 1,
      });
      MB.showToast('✨ Summary ready', 'success');
    };

    /* ---------------------------------------------------------------------
     * FEATURE 5 — Send Later
     * -------------------------------------------------------------------*/

    const handleSendLater = async () => {
      if (!(await MB.requireFeature('sendLater'))) return;

      const compose = MB.pick(S.composeWindow) || document;
      const subjectField = MB.pick(S.composeSubject, compose);
      const toField = MB.pick(S.composeTo, compose);

      const draftSubject =
        (subjectField && (subjectField.value || subjectField.textContent || '').trim()) ||
        '(no subject)';
      const recipient =
        (toField && (toField.value || toField.textContent || '').trim()) ||
        'your recipient';

      MB.showDateTimeModal('⏰ Send Later', 'Schedule reminder', async (when) => {
        const record = {
          id: MB.uuid(),
          draftSubject: draftSubject.slice(0, 200),
          recipient: recipient.slice(0, 200),
          scheduledTime: when,
          createdAt: Date.now(),
          status: 'pending',
        };
        const state = await MB.storage.getAll();
        await MB.storage.set({ scheduled: state.scheduled.concat([record]) });
        await MB.send({ action: 'scheduleSend', scheduled: record });
        MB.showToast(`⏰ You'll be reminded at ${MB.formatWhen(when)}`, 'success');
      });
    };

    /* ---------------------------------------------------------------------
     * Toolbar injection (Features 2/3/4 live here)
     * -------------------------------------------------------------------*/

    const buildToolbar = (plan) => {
      const bar = MB.h('div', { class: 'mailboost-toolbar', 'data-mailboost': 'toolbar' });

      bar.appendChild(MB.h('span', { class: 'mailboost-brand', text: '⚡ MailBoost' }));

      bar.appendChild(
        MB.h('button', {
          class: 'mailboost-btn mailboost-btn-unsub',
          title: 'Find and open the unsubscribe link in a background tab',
          onclick: handleUnsubscribe,
        }, '🚫 Unsubscribe')
      );

      const snoozeBtn = MB.h('button', {
        class: 'mailboost-btn mailboost-btn-snooze',
        title: 'Context-aware snooze, including "when they reply"',
        onclick: handleSnooze,
      }, '🔕 Smart Snooze');
      if (!MB.planAllows(plan, 'snooze')) {
        snoozeBtn.appendChild(MB.h('span', { class: 'mailboost-pro-badge', text: 'PRO' }));
      }
      bar.appendChild(snoozeBtn);

      const aiBtn = MB.h('button', {
        class: 'mailboost-btn mailboost-btn-summarize',
        title: 'Summarise this thread with Claude',
        onclick: handleSummarize,
      }, '✨ AI Summary');
      if (!MB.planAllows(plan, 'aiSummary')) {
        aiBtn.appendChild(MB.h('span', { class: 'mailboost-pro-badge', text: 'PRO' }));
      }
      bar.appendChild(aiBtn);

      return bar;
    };

    const ensureToolbar = async () => {
      const pane = getReadingPane();
      if (!pane) return;

      const fingerprint = emailFingerprint();
      const existing = pane.querySelector('[data-mailboost="toolbar"]');

      if (existing && fingerprint === lastEmailFingerprint) return;
      if (existing) existing.remove();   // different email → rebuild

      lastEmailFingerprint = fingerprint;
      const plan = await MB.storage.get('plan');
      // We only ever *insert* a node. The mail app's own DOM is untouched.
      pane.insertBefore(buildToolbar(plan), pane.firstChild);
      countDarkFix();
      MB.log('toolbar injected for:', fingerprint);
    };

    const ensureSendLaterButton = async () => {
      const sendButton = MB.pick(S.composeSend);
      if (!sendButton || !sendButton.parentElement) return;
      if (sendButton.parentElement.querySelector('[data-mailboost="sendlater"]')) return;

      const plan = await MB.storage.get('plan');
      const button = MB.h('button', {
        class: 'mailboost-btn mailboost-btn-snooze',
        'data-mailboost': 'sendlater',
        title: 'Get reminded to send this draft later',
        onclick: handleSendLater,
      }, '⏰ Send Later');
      if (!MB.planAllows(plan, 'sendLater')) {
        button.appendChild(MB.h('span', { class: 'mailboost-pro-badge', text: 'PRO' }));
      }

      sendButton.parentElement.insertBefore(button, sendButton.nextSibling);
      MB.log('send later button added');
    };

    /* ---------------------------------------------------------------------
     * Reply-watch support: the service worker asks us to scan the message
     * list, because only the page can see the mailbox.
     * -------------------------------------------------------------------*/

    const scanForSenders = (emails) => {
      const list = MB.pick(S.messageList);
      if (!list) return [];
      const rows = list.querySelectorAll(S.listItem);
      const seen = new Set();
      const wanted = emails.map((e) => String(e).toLowerCase());

      // Only look at the newest ~25 rows; a reply lands at the top.
      Array.prototype.slice.call(rows, 0, 25).forEach((row) => {
        const haystack = `${row.getAttribute('aria-label') || ''} ${row.innerText || ''}`.toLowerCase();
        wanted.forEach((email) => {
          if (!email) return;
          const localPart = email.split('@')[0];
          if (haystack.includes(email) || (localPart.length > 3 && haystack.includes(localPart))) {
            seen.add(email);
          }
        });
      });
      return Array.from(seen);
    };

    try {
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message && message.action === 'scanForSenders') {
          try {
            sendResponse({ ok: true, found: scanForSenders(message.emails || []) });
          } catch (err) {
            MB.error('scanForSenders failed:', err);
            sendResponse({ ok: false, found: [] });
          }
          return true;
        }
        if (message && message.action === 'settingsChanged') {
          applyDarkModePreference();
        }
        return false;
      });
    } catch (err) {
      MB.error('could not register message listener:', err);
    }

    /* ---------------------------------------------------------------------
     * Boot
     * -------------------------------------------------------------------*/

    async function applyDarkModePreference() {
      const enabled = await MB.storage.get('darkModeEnabled');
      if (enabled === false) removeDarkModeFix();
      else injectDarkModeFix();
      const fab = document.getElementById('mailboost-dark-toggle');
      if (fab) fab.dataset.on = String(enabled !== false);
    }

    const tick = MB.debounce(() => {
      try {
        // Re-assert the dark fix: Outlook re-renders the pane constantly and
        // some builds strip injected <style> tags on navigation.
        MB.storage.get('darkModeEnabled').then((enabled) => {
          if (enabled !== false) injectDarkModeFix();
        });
        ensureToolbar();
        ensureSendLaterButton();
      } catch (err) {
        MB.error('observer tick failed:', err);
      }
    }, 300);

    const start = async () => {
      await applyDarkModePreference();
      await createFloatingToggle();
      tick();

      observer = new MutationObserver(tick);
      observer.observe(document.body, { childList: true, subtree: true });
      MB.log('MutationObserver watching for opened emails');
    };

    const stop = () => {
      if (observer) {
        observer.disconnect();
        observer = null;
        MB.log('MutationObserver disconnected');
      }
    };

    // Required by the safety rules: never leave an observer running.
    window.addEventListener('pagehide', stop);
    window.addEventListener('beforeunload', stop);

    // React live to popup changes (dark mode toggle, licence activation).
    // plan/apiKey/licenseKey live in 'sync', everything else in 'local' —
    // watch both areas rather than filtering one out.
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' && area !== 'sync') return;
        if (changes.darkModeEnabled) applyDarkModePreference();
        if (changes.plan) { lastEmailFingerprint = ''; tick(); }
      });
    } catch (err) {
      MB.error('could not watch storage:', err);
    }

    start();
  };
})();
