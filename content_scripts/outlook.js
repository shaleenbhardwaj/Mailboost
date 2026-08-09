/* ============================================================================
 * MailBoost — outlook.js
 * ----------------------------------------------------------------------------
 * Runs on outlook.live.com and outlook.office.com.
 *
 * All the feature logic (dark mode fixer, unsubscribe, smart snooze, AI
 * summary, send later, toolbar, toasts) lives in shared.js. This file's only
 * job is to tell that engine WHERE things are in the Outlook Web DOM.
 *
 * Outlook ships DOM changes often, so every selector below is a *list* and
 * MailBoost falls back down the list until something matches. If a feature
 * stops appearing after an Outlook update, this is the file to fix — you
 * should not need to touch shared.js.
 * ==========================================================================*/

(function () {
  'use strict';

  if (!window.MailBoost) {
    console.error('[MailBoost] shared.js did not load — outlook.js cannot start.');
    return;
  }

  console.log('[MailBoost] outlook.js starting on', location.hostname);

  /* ---------------------------------------------------------------------
   * Subject / sender finders — Outlook's Fluent2 reading pane
   * -----------------------------------------------------------------------
   * Confirmed against a real German outlook.live.com account (Aug 2026):
   * there is no stable "Reading Pane" landmark or data-app-section
   * attribute wrapping the open email's header block. Instead, subject,
   * sender (as "Display Name<email>"), recipient ("An:"/"To:"), and date
   * each render as their own `[role="heading"][aria-level="3"]` element,
   * in that order, as siblings.
   *
   * Plain CSS selectors can't express "the first heading that contains an
   * @ but isn't the recipient line", so these two finders walk that
   * sequence in DOM order instead of relying on a single querySelector.
   * They are locale-independent — no English/German text matching — which
   * matters because Outlook's own button/field labels are translated but
   * these structural roles are not.
   * ------------------------------------------------------------------- */

  const HEADING_LEVEL_3 = '[role="heading"][aria-level="3"]';
  const RECIPIENT_PREFIX = /^(to|an|cc|bcc)\s*:/i;   // EN "To:" / DE "An:"
  const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;

  /** First level-3 heading that has no email in it and isn't a recipient row. */
  function findSubject(doc) {
    for (const heading of doc.querySelectorAll(HEADING_LEVEL_3)) {
      const text = (heading.textContent || '').trim();
      if (!text) continue;
      if (RECIPIENT_PREFIX.test(text)) continue;
      if (EMAIL_RE.test(text)) continue;   // sender/recipient rows carry an @
      return text;
    }
    return '';
  }

  /** First level-3 heading with an email in it that ISN'T the recipient row. */
  function findSender(doc) {
    for (const heading of doc.querySelectorAll(HEADING_LEVEL_3)) {
      const text = (heading.textContent || '').trim();
      if (!text || RECIPIENT_PREFIX.test(text)) continue;
      const match = text.match(EMAIL_RE);
      if (!match) continue;
      return {
        name: text.replace(match[0], '').replace(/[<>]/g, '').trim(),
        email: match[0],
      };
    }
    return null;
  }

  window.MailBoost.init({
    name: 'Outlook Web',
    findSubject,
    findSender,

    /**
     * CSS scope the dark-mode fix is written against. Kept as a plain string
     * because it is templated into the injected stylesheet.
     */
    darkScope: '[aria-label="Reading Pane"]',

    /** Where MailBoost sends you when a "send later" reminder fires. */
    composeUrl: 'https://outlook.live.com/mail/0/drafts',

    selectors: {
      /* The reading pane — where an opened email is displayed. */
      readingPane: [
        '[aria-label="Reading Pane"]',
        '[data-app-section="ConversationContainer"]',
        'div[role="main"] [role="region"]',
        'div[role="main"]',
      ],

      /* The rendered email body inside the reading pane. */
      messageBody: [
        '[aria-label="Message body"]',
        '[data-app-section="MessageBody"]',
        '.rps_ea3d',                      // Outlook's rendered-HTML wrapper
        '[aria-label="Reading Pane"] [role="document"]',
      ],

      /* Subject line of the open email. */
      subject: [
        '[aria-label="Reading Pane"] [role="heading"][aria-level="2"]',
        '[data-app-section="ConversationContainer"] [role="heading"]',
        '[aria-label="Reading Pane"] [role="heading"]',
        'div[role="main"] [role="heading"]',
      ],

      /* Sender chip. The address is usually in the title attribute. */
      sender: [
        '[aria-label="Reading Pane"] span[title*="@"]',
        '[data-app-section="ConversationContainer"] span[title*="@"]',
        '[aria-label="Reading Pane"] [aria-label*="@"]',
        'div[role="main"] span[title*="@"]',
      ],

      /* Compose window and its fields — used by Send Later. */
      composeWindow: [
        '[aria-label="Message body"]',
        'div[role="dialog"][aria-label*="ompose"]',
        'div[role="main"]',
      ],
      composeSend: [
        // Outlook's newer Fluent UI compose uses a SplitButton (Send + a
        // "more send options" dropdown). This class is added by the Fluent
        // UI framework itself and holds across locales — confirmed against
        // a German ("Senden") build. Prefer it over any text match.
        '.fui-SplitButton__primaryActionButton',
        'button[class*="SplitButton__primaryActionButton"]',
        // Text fallbacks for older/non-Fluent Outlook builds, EN + DE.
        'button[aria-label="Send"]',
        'button[aria-label="Senden"]',
        'button[title="Send"]',
        'button[title^="Send"]',
        'button[title^="Senden"]',
        'button[aria-label^="Send "]',
      ],
      composeSubject: [
        'input[aria-label="Add a subject"]',
        'input[aria-label="Betreff hinzufügen"]',   // DE
        'input[placeholder="Add a subject"]',
        'input[aria-label*="ubject"]',
        'input[aria-label*="etreff"]',                // DE: "Betreff"
      ],
      composeTo: [
        'div[aria-label="To"]',
        'div[aria-label="An"]',                        // DE
        'input[aria-label="To"]',
        'input[aria-label="An"]',                       // DE
        '[aria-label="To"] input',
      ],

      /* Message list — scanned for "when they reply" snoozes. */
      messageList: [
        '[aria-label="Message list"]',
        'div[role="list"]',
        '[data-app-section="MessageList"]',
      ],
      listItem: 'div[role="option"], div[role="listitem"]',
    },
  });
})();
