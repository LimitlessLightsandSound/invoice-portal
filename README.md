# Limitless Invoice Portal — deploy packet

Custom contractor invoice + install-billing forms with a multi-stage approval queue. Fully yours, no monthly cost.
**Stack:** static HTML on GitHub Pages → Google Apps Script web app → Google Sheet (data) + Google Drive (uploaded files).

---

## What's in this folder

| File | What it is | Goes where |
|---|---|---|
| `index.html` | **Production invoice form** (event/labor). Branded, public. | GitHub Pages |
| `install.html` | **Install billing form** — same fields, routed to Gabe. | GitHub Pages (same repo) |
| `review.html` | Staff approval console (role-aware). | GitHub Pages (same repo) |
| `Code.gs` | Backend: saves submissions to the Sheet, files to Drive, emails login codes, styles the sheet. | Google Apps Script |
| `README.md` | This file. | — |

The **API URL placeholder** (`const API = 'PASTE_YOUR_WEB_APP_URL_HERE'`) appears in **all three** HTML files — `index.html`, `install.html`, `review.html`.

---

## Who's who (already configured in `Code.gs`)

| Email | Role | Sees / can do |
|---|---|---|
| `dash@limitlesslightsandsound.com` | **owner — master admin** | Everything, both types, any stage: approve / escalate / reject / reopen / bill |
| `tony@limitlesslightsandsound.com` | approver (productions) | Approve / escalate / reject **production** invoices only |
| `gabe@limitlesslightsandsound.com` | approver (installs) | Approve / escalate / reject **install** billing only |
| `taryn@limitlesslightsandsound.com` | controller | Bill approved items (both types) |
| `accounting@limitlesslightsandsound.com` | controller | Bill approved items (both types) |

**Two forms → two tabs:** `index.html` lands on the **Productions** tab (Tony), `install.html` lands on the **Installs** tab (Gabe). Approved items from both flow into a combined **Approved** billing tab for the controllers. `setup()` builds and styles all three tabs (glossy header bands, zebra rows, status color-coding).

---

## Part 1 — Backend (Google Sheet + Apps Script)

1. Open the sheet **Limitless — Contractor Invoices** (owned by dash@). **Extensions → Apps Script.**
2. Delete the sample, paste in all of `Code.gs`. Confirm the 5 emails in `REVIEWERS` near the top.
3. In the function dropdown choose **`setup`** → **Run**. Authorize when prompted (*Advanced → Go to project → Allow*). This builds + styles the Productions / Installs / Approved tabs and the Drive folder.
4. **Deploy → New deployment → Web app:**
   - Execute as: **Me** (sign in as dash@ so login emails + uploaded files live under your account)
   - Who has access: **Anyone**  ← required so contractors can submit
5. **Deploy**, then **copy the Web app URL** (ends in `/exec`).

---

## Part 2 — Wire the URL into the forms

In all three files — `index.html`, `install.html`, `review.html` — replace the placeholder near the top of the `<script>` block:

```js
const API = 'PASTE_YOUR_WEB_APP_URL_HERE';   // → paste your /exec URL
```

Save, commit, push. (Or hand the `/exec` URL back and it gets wired + pushed for you.)

---

## Part 3 — GitHub Pages

Already live at:
- Production invoice form: `https://limitlesslightsandsound.github.io/invoice-portal/`
- Install billing form: `https://limitlesslightsandsound.github.io/invoice-portal/install.html`
- Staff console: `https://limitlesslightsandsound.github.io/invoice-portal/review.html`

**Updating later:** edit a file → commit → push. Pages redeploys itself. No build step.

**Custom domain (optional):** add a `CNAME` file containing `invoice.limitlesslightsandsound.com`, point a DNS CNAME `invoice → limitlesslightsandsound.github.io`, then set it under Settings → Pages → Custom domain → Enforce HTTPS.

---

## Gotchas

- **Edited `Code.gs`, nothing changed?** Redeploy: *Deploy → Manage deployments → Edit → Version: New version.* Apps Script serves the last *deployed* version, not the last save.
- **"Failed to fetch" / CORS?** The forms POST as plain text on purpose (skips the CORS preflight Apps Script can't answer). Don't add a JSON or Authorization header — the token rides in the request body.
- **Invoice file links won't open?** The Drive folder is shared only with the five reviewer emails; the reviewer must be signed into that Google account. Files aren't public by design.
- **Sheet not styled?** Run `restyle()` from the Apps Script editor — it re-applies the glossy theme anytime.

---

## Workflow recap

**Production invoice** (index.html) → **Tony** reviews (Approve → billing, Escalate to Dash, or Reject).
**Install billing** (install.html) → **Gabe** reviews the same way.
**Dash (master admin)** can act on anything at any stage, including billing.
Approved items land on the **Approved** tab + the controllers' console (**Taryn / Accounting**) to bill → **Mark billed**. All data lives in your Sheet; uploaded files live in your Drive.
