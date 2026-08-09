# ⚡ MailBoost — Outlook Power Tools

A Manifest V3 Chrome extension that fixes what Microsoft built badly in Outlook Web and adds what Microsoft never built at all.

| Feature | Tier | What it does |
|---|---|---|
| 🌙 **Dark Mode Fixer** | Free forever | Repairs Outlook's broken reading-pane dark mode — white boxes, unreadable black-on-black text, invisible links |
| 🚫 **One-Click Unsubscribe** | Free (5/mo) · unlimited on Basic | Finds the unsubscribe link, opens it in a background tab, closes the tab after 3s |
| 🔕 **Smart Snooze** | Basic | Time-based *and* reply-triggered snoozes, each with a context note |
| ✨ **AI Email Summariser** | Pro (5 free trial uses) | Three-bullet summary + action required + deadline + quick replies, powered by Claude |
| ⏰ **Send Later** | Pro | Schedules a reminder to send the draft you're writing |

Also works on Yahoo Mail (`mail.yahoo.com`).

---

## 1. Install as an unpacked extension

You do **not** need to build anything — the source is the extension.

1. Open Chrome and go to `chrome://extensions`
   *(Menu → Extensions → Manage Extensions works too.)*
2. **Turn on "Developer mode."** The toggle is in the **top-right corner** of the page. Three new buttons appear along the top-left: *Load unpacked*, *Pack extension*, *Update*.
3. Click **"Load unpacked."** A file picker opens.
4. Select the **`mailboost/` folder itself** — the one containing `manifest.json`. Do not select an individual file, and do not select the folder above it.
5. MailBoost appears as a card in the extensions grid: a blue ⚡ tile, the name "MailBoost — Outlook Power Tools", version 1.0.0, and an "Errors" button if anything failed to parse. The card should show **no** red error badge.
6. Click the **puzzle-piece icon** in Chrome's toolbar, find MailBoost in the dropdown, and click the **pin icon** next to it so the ⚡ icon stays visible in your toolbar.
7. Open <https://outlook.live.com/mail/> and open any email. You should see:
   - a **round blue 🌙 button** floating in the bottom-right corner of the window
   - a **dark navy toolbar** across the top of the reading pane with three buttons: `🚫 Unsubscribe`, `🔕 Smart Snooze (PRO)`, `✨ AI Summary (PRO)`

### If nothing appears

Open DevTools (`F12`) → **Console** and filter for `MailBoost`. Every step logs. The most common causes:

| Console message | Fix |
|---|---|
| Nothing at all | The content script didn't run — confirm the tab URL is `outlook.live.com`, `outlook.office.com` or `mail.yahoo.com` |
| `shared.js did not load` | File ordering in `manifest.json` was edited; `shared.js` must come first |
| `init on Outlook Web` but no toolbar | Outlook changed its DOM — update the selectors in `content_scripts/outlook.js` (see below) |

After editing any file, return to `chrome://extensions` and click the **circular reload arrow** on the MailBoost card, then reload the Outlook tab.

### When Outlook changes its DOM

All Outlook-specific selectors live in one place: `content_scripts/outlook.js`. Each entry is an **array tried in order**, so you can add a new selector at the top without removing the old one. Yahoo's live in `content_scripts/yahoo.js`. You should never need to edit `shared.js` for a selector break.

---

## 2. Get an Anthropic API key (for the AI Summariser)

The AI summariser calls Claude directly from your browser using **your own** API key. There is no MailBoost server and no proxy.

1. Go to <https://console.anthropic.com> and sign in or create an account.
2. Add a payment method under **Billing** — the API is pay-as-you-go and separate from a Claude.ai subscription. You can set a monthly spend cap here too.
3. Go to **Settings → API keys → Create key**, name it `MailBoost`, and copy it. It starts with `sk-ant-`. **You can only see it once.**
4. Click the MailBoost ⚡ toolbar icon → **AI Summariser** → paste the key → **Save Key**.
5. Optionally change the model:
   - **Claude Sonnet 5** *(default)* — the best balance of quality, speed and cost
   - **Claude Opus 5** — highest quality, for dense or high-stakes threads
   - **Claude Haiku 4.5** — fastest and cheapest

### What a summary costs

Each summary sends the email text (capped at 12,000 characters) and gets back at most 1,024 tokens. A typical email is well under 2,000 input tokens, so at Sonnet 5 pricing that's a fraction of a cent per summary. Extended thinking is switched off and effort is set to `low` in `background/service_worker.js` — summarising one email doesn't need deep reasoning, and that keeps both latency and cost down.

The request uses **structured outputs** (a JSON schema), so the sidebar never has to guess at prose formatting. If you want to change what the summary contains, edit `SUMMARY_SCHEMA` and the prompt in `background/service_worker.js`.

---

## 3. Set up Gumroad licence keys

MailBoost validates licences **offline** — there is no licence server to run or pay for. This is the right trade for an MVP: it can be bypassed by a determined user, and that is fine. You are selling to people who want to support the tool.

### How validation works

```js
const validateLicense = (key) =>
  key.startsWith('MAILBOOST-') && key.length === 20;
```

The character immediately after the dash picks the tier:

| Key shape | Tier unlocked |
|---|---|
| `MAILBOOST-B` + 9 more chars | **Basic** — unlimited unsubscribes, Smart Snooze |
| `MAILBOOST-P` + 9 more chars | **Pro** — everything, incl. AI Summariser and Send Later |

Example valid keys: `MAILBOOST-B7K2M9Q4XT`, `MAILBOOST-P3F8L1V6ZW` *(both exactly 20 characters — `MAILBOOST-`, the tier letter, then 9 more)*.

### Steps in Gumroad

1. Create a Gumroad account and two products:
   - **MailBoost Basic** — 3,49€/month, plus a 29,99€/year option
   - **MailBoost Pro** — 7,49€/month, plus a 64,99€/year option
2. In each product's **Content** tab, enable **"Generate a unique licence key per sale."** Gumroad's own key format won't match MailBoost's, so use the next step instead of Gumroad's keys directly.
3. Generate your own key pool and upload it as **Content → Custom fields / redemption codes**, or e-mail keys on purchase. Generate a batch with:

   ```bash
   # 100 Pro keys. 'MAILBOOST-' (10) + 'P' (1) + 9 random = 20 characters.
   python3 -c "
   import random, string
   pool = string.ascii_uppercase + string.digits
   for _ in range(100):
       print('MAILBOOST-P' + ''.join(random.choices(pool, k=9)))
   "
   ```

   Swap `P` for `B` to generate Basic keys. Keep the generated list — it is your record of what you sold.
4. Put the real product URLs into **both** of these files (they currently point at placeholders):
   - `content_scripts/shared.js` → `MB.LINKS`
   - `popup/popup.js` → `LINKS`

### When you outgrow offline keys

Move to server validation by replacing `MB.validateLicense` with a `fetch` to your endpoint and caching the result in `chrome.storage.local` with an expiry. Gumroad has a licence-verification API (`POST https://api.gumroad.com/v2/licenses/verify`) you can call from `background/service_worker.js`. That call must come from the service worker, not the content script, and you'll need to add your endpoint to `host_permissions`.

---

## 4. Submit to the Chrome Web Store

1. **Register as a developer.** Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole), sign in, and pay the one-time **$5** registration fee.
2. **Bump the version** in `manifest.json` for every upload — the store rejects a re-used version number.
3. **Zip the contents, not the folder:**

   ```bash
   cd mailboost
   zip -r ../mailboost-1.0.0.zip . -x '*.DS_Store' -x 'icons/generate_icons.py'
   ```

   `manifest.json` must sit at the **root** of the zip.
4. **Create the listing.** Click *Add new item*, upload the zip, then fill in the store listing from `STORE_LISTING.md` — title, short description, full description, category, and language.
5. **Upload assets:**
   - Icon: 128×128 PNG (already at `icons/icon128.png` — replace the placeholder with real artwork before launch)
   - Screenshots: at least one, ideally five, at **1280×800** or 640×400. The five to shoot are described in `STORE_LISTING.md`.
   - Optional: a 440×280 small promo tile
6. **Privacy tab — this is where most extensions get rejected.** You must justify every permission. Copy-paste-ready text for all five is in `PRIVACY.md`. You must also:
   - Host the privacy policy at a public URL and paste that URL in
   - Tick **"I do not sell or transfer user data to third parties"**
   - Declare data usage honestly: MailBoost collects nothing, but email text **is** sent to Anthropic when the user clicks *AI Summary*, and that must be disclosed
7. **Submit for review.** First reviews typically take a few business days; extensions with broad host permissions can take longer. If rejected, the e-mail names the specific policy — the common one here is an inadequate permission justification, which the `PRIVACY.md` text is written to satisfy.

---

## Project layout

```
mailboost/
├── manifest.json                  # MV3 manifest, minimal permissions
├── content_scripts/
│   ├── shared.js                  # storage, toasts, modals, feature engine
│   ├── outlook.js                 # Outlook Web DOM selectors
│   └── yahoo.js                   # Yahoo Mail DOM selectors
├── background/
│   └── service_worker.js          # alarms, tabs, notifications, Claude API
├── popup/
│   ├── popup.html                 # settings UI (380px)
│   ├── popup.css                  # dark theme
│   └── popup.js                   # settings logic
├── styles/
│   └── injected.css               # everything MailBoost injects into the page
├── icons/
│   ├── generate_icons.py          # regenerates the placeholders
│   └── icon{16,48,128}.png
├── README.md · PRIVACY.md · ROADMAP.md · STORE_LISTING.md
```

### Architecture notes

- **`shared.js` holds the engine, not just helpers.** Both mail providers run identical feature code; `outlook.js` and `yahoo.js` only supply selectors. Adding Gmail support means writing one ~60-line adapter file and one manifest entry.
- **The Anthropic call happens in the service worker.** A content script `fetch` to `api.anthropic.com` from a mail page is subject to that page's CORS rules, and it would expose the API key to the page context. The service worker has `host_permissions` for `api.anthropic.com` and neither problem.
- **Nothing is built with `innerHTML`.** Every injected node goes through the `MB.h()` DOM builder, so email content can never be interpreted as markup.
- **The MutationObserver is debounced to 300ms** and disconnects on `pagehide` — Outlook mutates its DOM continuously and an undebounced observer will visibly slow the page.

### Regenerating the icons

```bash
python3 icons/generate_icons.py
```

Pure standard library, no Pillow. These are placeholders — commission real artwork before you publish.
