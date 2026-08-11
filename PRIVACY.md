# MailBoost — Privacy Policy

**Last updated:** 9 August 2026
**Applies to:** MailBoost — Outlook Power Tools, version 1.0.0

## The short version

MailBoost has no servers. There is no MailBoost account, no analytics, no telemetry, no crash reporting, and no advertising. Nothing you read, write, click, or unsubscribe from is transmitted to the developer — because there is nowhere for it to be transmitted to.

The single exception is the AI Summariser: when **you click "✨ AI Summary"**, the text of that one open email is sent to Anthropic's API using **your own** API key, and the summary comes back. That's it.

---

## What data is collected

**None is collected by the developer.** MailBoost stores a small amount of data using Chrome's own built-in storage APIs. Most of it is `chrome.storage.local` — device-only, never uploaded anywhere. Three values (`apiKey`, `licenseKey`, `plan`) use `chrome.storage.sync` instead, so that unlocking Pro or saving your API key on one computer carries over to your other computers — this goes through **Google's Chrome Sync**, tied to your Chrome sign-in, exactly like your bookmarks or browser settings do. It does not go to the developer or to any third party; it is the same mechanism Chrome itself uses to sync your settings.

| Stored | Where | Why | Contains email content? |
|---|---|---|---|
| `apiKey` | **Chrome Sync** | Your Anthropic key, carried across your signed-in devices | No |
| `licenseKey`, `plan` | **Chrome Sync** | Which tier you've unlocked, carried across your signed-in devices | No |
| `darkModeEnabled` | Local (this device) | Remembers the 🌙 toggle | No |
| `model` | Local (this device) | Which Claude model you picked | No |
| `unsubCount`, `unsubPeriod`, `unsubTotal` | Local (this device) | Enforces the free monthly quota; drives the stats panel | No |
| `freeAiUses`, `aiTotal`, `snoozeTotal` | Local (this device) | Trial quota and stats counters | No |
| `darkFixDate`, `darkFixCount` | Local (this device) | "fixing N emails today" counter | No |
| `snoozes[]` | Local (this device) | Your pending snoozes | **Subject line, sender name and address, and your own context note** |
| `scheduled[]` | Local (this device) | Your pending Send Later reminders | **Draft subject and recipient** |

### Why the split

Your API key and licence are worth carrying between your own devices, so unlocking Pro on your laptop doesn't mean re-entering everything on your desktop. Everything else — usage counters, the snooze list, your dark-mode preference — has no reason to leave the device it's on, and `chrome.storage.sync` has small size limits that aren't a good fit for a growing list of snoozes anyway. Neither storage area is ever readable by the developer; both are private to your browser profile.

### About the snooze/reminder rows

A snooze reminder is useless without a subject line to show you, so MailBoost stores the **subject, sender, and your context note** — never the message body, never attachments, never the thread. These records live only on your device (local storage, not synced), and you can delete any of them from the popup's *Snoozed & scheduled* list, or all of them by removing the extension.

Everything else — the body of every email you read, every link in it, every address in the thread — is read in-page and immediately discarded. It is never written to storage.

---

## What triggers a network request

MailBoost makes exactly two kinds of outbound request, both only in direct response to something you clicked.

### 1. The unsubscribe tab — you click 🚫 Unsubscribe

MailBoost scans the open email for a link matching known unsubscribe patterns, opens **that link** in a background tab, and closes the tab after three seconds. The request goes from your browser to the sender's own unsubscribe endpoint, exactly as it would if you had clicked the link yourself. The URL is **not** logged, stored, or transmitted anywhere else.

### 2. The AI summary — you click ✨ AI Summary

The visible text of the open email (truncated at 12,000 characters) is sent to `https://api.anthropic.com/v1/messages`, authenticated with the API key you supplied. Requests are made from the extension's service worker, so your key is never exposed to the mail website's page context.

Anthropic's handling of that text is governed by [Anthropic's Privacy Policy](https://www.anthropic.com/legal/privacy) and [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) — your API key means it is **your** account and **your** relationship with Anthropic, not the developer's. Anthropic does not train on API inputs by default.

**No request is ever made in the background, on a timer, or on page load.** If you never click those two buttons, MailBoost never talks to the network at all. Dark mode, snooze, and Send Later are entirely local.

### What the 30-minute alarm does

Reply-triggered snooze runs a check every 30 minutes. This is **not** a network request. The extension asks any open mail tab to look at the message list already rendered on your screen for the sender you're waiting on. Nothing leaves your browser.

---

## Chrome Web Store justification text

Copy-paste ready for the **Privacy practices** tab of the developer dashboard.

### Single purpose description

> MailBoost enhances the Outlook Web and Yahoo Mail reading experience by correcting the broken dark-mode rendering of the reading pane and adding inbox-management tools: one-click unsubscribe, context-aware email snoozing, AI-assisted email summarisation, and send-later reminders.

### Permission: `storage`

> Required to save the user's own settings. Dark-mode preference, monthly usage counters for free-tier limits, and the list of pending snoozes and send-later reminders are stored locally via chrome.storage.local and never leave the device. The user's Anthropic API key, licence key, and plan tier are stored via chrome.storage.sync so they carry over to the user's other Chrome-signed-in devices, using Chrome's own built-in sync — the same mechanism Chrome uses for bookmarks and settings. In neither case is data transmitted to the developer or any third party.

### Permission: `alarms`

> Required to deliver snooze and send-later reminders at the time the user chose. Time-based snoozes create a one-shot alarm at the requested moment; reply-triggered snoozes use a single recurring 30-minute alarm to check whether the awaited sender has replied. Without this permission, reminders cannot fire while the extension's service worker is suspended.

### Permission: `notifications`

> Required to show the user their own snooze and send-later reminders when they come due. Notifications are only ever created in response to a reminder the user explicitly scheduled. The extension sends no promotional, marketing, or unsolicited notifications.

### Permission: `tabs`

> Required for three user-initiated actions: (1) opening the unsubscribe link found in an email in a background tab and closing that tab automatically three seconds later, so the user is not interrupted; (2) locating an already-open mail tab to check for a reply when a reply-triggered snooze is active; (3) focusing the user's existing Outlook tab when they click a reminder notification. The extension does not read, log, or transmit browsing history or the contents of any tab outside the mail sites listed in host permissions.

### Host permission: `outlook.live.com`, `outlook.office.com`, `mail.yahoo.com`

> These are the mail services the extension enhances. Access is required to inject the corrected dark-mode stylesheet into the reading pane, to add the MailBoost toolbar above the open email, to locate the unsubscribe link inside the currently open message, and to read the subject and sender of an email the user chooses to snooze. The extension only adds elements to the page; it never modifies or removes the mail application's own content.

### Host permission: `api.anthropic.com`

> Required for the optional AI Summariser feature. When — and only when — the user clicks the "AI Summary" button on an open email, the extension sends that email's text to the Anthropic API using an API key the user supplies themselves, and displays the returned summary. The request is made from the extension's service worker so that the user's API key is never exposed to the mail website. No summarisation request is ever made automatically.

### Are you using remote code?

> No. All code is included in the extension package. The extension makes API requests to a remote service (api.anthropic.com) but does not load, evaluate, or execute any remotely-hosted code.

### Data usage disclosures to tick

| Category | Declare | Note |
|---|---|---|
| Personally identifiable information | **No** | |
| Health information | **No** | |
| Financial and payment information | **No** | |
| Authentication information | **Yes** | The user's own Anthropic API key, stored locally only |
| Personal communications | **Yes** | Email text is transmitted to Anthropic on explicit user action |
| Location, web history, user activity | **No** | |
| Website content | **No** | Read in-page and discarded; not collected |

And all three certifications:

- ✅ I do not sell or transfer user data to third parties, outside of the approved use cases
- ✅ I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- ✅ I do not use or transfer user data to determine creditworthiness or for lending purposes

---

## Your control

- **Revoke the AI feature** — clear the API key field in the popup and press Save. No further requests are possible.
- **Delete a stored reminder** — press *Cancel* next to it in the popup.
- **Delete everything** — remove the extension at `chrome://extensions`. Chrome erases all `chrome.storage.local` data for it immediately.
- **Read the source** — MailBoost is unminified and unobfuscated. Every network call is in `background/service_worker.js`; every storage write goes through `MB.storage.set`.

## Children

MailBoost is not directed at children under 13 and collects no data from anyone.

## Changes

Material changes to this policy will be noted in the extension's changelog and this document's "Last updated" date. Continued use after an update constitutes acceptance.

## Contact

Questions about privacy: **mailboost.extension@gmail.com**
