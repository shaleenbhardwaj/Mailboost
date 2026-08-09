# MailBoost Roadmap — v1.1

Ten features for the next release, ordered by *(value to a power user) ÷ (build cost)*. Every one is a thing Outlook Web either does badly or doesn't do.

---

### 1. 🧹 Bulk Unsubscribe Sweep — **Pro**
Scan the last 500 messages in the inbox, group them by sender, and show a single list: *"37 senders are mailing you. 12 you haven't opened in 90 days."* Tick the ones to kill, hit go, MailBoost runs the existing unsubscribe flow across all of them with a progress bar.

*Why first:* it's the highest-impact feature in the list and reuses `findUnsubscribeUrl` almost unchanged. This is the screenshot people share.
**Cost:** medium — needs message-list pagination and a new full-page UI.

---

### 2. 📝 Snippet Templates — **Pro**
Already promised on the Pro tier and not yet built. Save reusable replies, insert with `;;shortcut` while composing, with `{{firstName}}` / `{{subject}}` placeholders auto-filled from the open thread.

*Why:* it closes a gap between what the pricing page sells and what ships.
**Cost:** low — a compose-box keydown listener, a template store, and a manager tab in the popup.

---

### 3. 🌗 Per-Sender Dark Mode Overrides — **Free**
Some newsletters are designed dark and the fix makes them worse. Add a "keep original colours for this sender" button to the toolbar, stored per sender address.

*Why:* it's the top complaint any dark-mode fixer receives, and it costs almost nothing.
**Cost:** low — a sender allowlist plus one CSS scope check.

---

### 4. ⌨️ Command Palette (`Ctrl+K`) — **Free**
A fuzzy-search overlay over every MailBoost action plus Outlook's own common ones: snooze, unsubscribe, summarise, archive, jump to folder. No mouse.

*Why:* it's the single feature that makes power users evangelise a tool, and it makes every other feature more discoverable.
**Cost:** medium — the overlay is easy, mapping Outlook's own actions reliably is not.

---

### 5. 🧵 Thread Digest for Long Chains — **Pro**
Existing AI Summary reads one message. This reads the whole 40-reply thread and returns a timeline: who said what, what was decided, what's still open, and who is waiting on you.

*Why:* the pain scales with thread length, and this is where an LLM genuinely beats reading it yourself.
**Cost:** low-to-medium — the API plumbing exists; needs thread expansion and a bigger `max_tokens`.

---

### 6. ✍️ AI Reply Drafting — **Pro**
The quick-reply chips currently copy a word. Make them generate a full draft in your own voice — tone learned from a handful of your sent messages — and drop it straight into the compose box.

*Why:* it converts the summariser from a read-time tool into a write-time one, which is where the time actually goes.
**Cost:** medium — needs voice sampling, a review step, and a hard "never auto-send" rule.

---

### 7. 📊 Inbox Health Dashboard — **Basic**
A weekly local-only report: how many newsletters arrived, which senders dominate, time-of-day distribution, how many you actually opened, hours reclaimed by unsubscribing.

*Why:* it makes the value of a subscription visible every week, which is what stops churn.
**Cost:** medium — needs a durable local index of message metadata.

---

### 8. 🔁 Follow-Up Detector — **Basic**
Watch sent mail for messages that asked a question and got no reply in N days, then surface them: *"You asked Sarah about the invoice 6 days ago — no reply."* Reply-watch already does the hard half.

*Why:* it's the natural extension of Smart Snooze and the single most-requested feature in every email tool's forum.
**Cost:** low-to-medium — reuses the reply-scan plumbing against the Sent folder.

---

### 9. 📧 Gmail Support — **Free**
Add `content_scripts/gmail.js`. Because the feature engine lives in `shared.js`, this is one adapter file of selectors plus one manifest entry.

*Why:* it multiplies the addressable market for roughly a day of work. The architecture was built for it.
**Cost:** low — the adapter itself; Gmail's dark mode is better, so the hero feature is weaker there.

---

### 10. ☁️ Cross-Device Sync + Server Licences — **Pro**
Move snoozes and settings to `chrome.storage.sync`, and replace offline key validation with a real licence check against the Gumroad API (cached, with a grace period for offline use).

*Why:* offline keys are the right call for v1.0 and the wrong call once revenue is real. Sync also stops snoozes silently dying when someone switches laptops.
**Cost:** medium — `storage.sync` has an 8KB-per-item quota, so the snooze store needs restructuring.

---

## Explicitly not doing

- **Reading mail via the Microsoft Graph API.** It would make several of these easier, but it means OAuth, a server, and asking for full mailbox access. MailBoost's pitch is that it has no servers.
- **Actually sending scheduled mail.** Send Later reminds you; it does not hold and transmit your mail. Doing it properly requires exactly the server-side mailbox access above.
- **Auto-summarising every email on open.** It would burn the user's API budget without being asked. Summarisation stays a click.
