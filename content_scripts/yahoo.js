/* ============================================================================
 * MailBoost — yahoo.js
 * ----------------------------------------------------------------------------
 * Runs on mail.yahoo.com. Same feature engine as Outlook (shared.js), just
 * pointed at Yahoo Mail's DOM.
 *
 * Yahoo tags almost everything with `data-test-id` attributes, which are far
 * more stable than its class names — so those are used first, with generic
 * ARIA fallbacks behind them.
 * ==========================================================================*/

(function () {
  'use strict';

  if (!window.MailBoost) {
    console.error('[MailBoost] shared.js did not load — yahoo.js cannot start.');
    return;
  }

  console.log('[MailBoost] yahoo.js starting on', location.hostname);

  window.MailBoost.init({
    name: 'Yahoo Mail',

    /* Yahoo has no "Reading Pane" aria-label, so the dark fix is scoped to
       its message-view container instead. */
    darkScope: '[data-test-id="message-view-body"]',

    composeUrl: 'https://mail.yahoo.com/d/folders/6',   // Yahoo's Drafts folder

    selectors: {
      readingPane: [
        '[data-test-id="message-view-body"]',
        '[data-test-id="message-group-view-scroller"]',
        '[data-test-id="message-view-container"]',
        'div[role="main"]',
      ],

      messageBody: [
        '[data-test-id="message-view-body-content"]',
        '[data-test-id="message-view-body"]',
        '.msg-body',
        'div[role="main"] [role="document"]',
      ],

      subject: [
        '[data-test-id="message-subject"]',
        '[data-test-id="message-group-subject"]',
        'div[role="main"] h1',
        'div[role="main"] [role="heading"]',
      ],

      sender: [
        '[data-test-id="message-from"] span[title*="@"]',
        '[data-test-id="message-from"] [data-test-id="email-pill"]',
        '[data-test-id="message-from"]',
        'div[role="main"] span[title*="@"]',
      ],

      /* Compose — Yahoo opens it as an overlay pane. */
      composeWindow: [
        '[data-test-id="compose-view"]',
        '[data-test-id="compose-container"]',
        'div[role="dialog"]',
      ],
      composeSend: [
        '[data-test-id="button-send"]',
        'button[aria-label="Send this email"]',
        'button[title="Send"]',
      ],
      composeSubject: [
        '[data-test-id="compose-subject"]',
        'input[placeholder="Subject"]',
        'input[aria-label*="ubject"]',
      ],
      composeTo: [
        '[data-test-id="compose-to"]',
        'input[aria-label="To"]',
        '[aria-label="To"] input',
      ],

      messageList: [
        '[data-test-id="virtual-list"]',
        '[data-test-id="message-list"]',
        'div[role="list"]',
      ],
      listItem: '[data-test-id="message-list-item"], a[data-test-id^="message-list"], div[role="listitem"]',
    },
  });
})();
