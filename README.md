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
2. Delete the sample, paste in all of `Code.gs`. Confirm the 5 emails in `REVIEWERS` near the top, and set `FIREBASE_API_KEY` (see Part 1b).
3. In the function dropdown choose **`setup`** → **Run**. Authorize when prompted (*Advanced → Go to project → Allow*). This builds + styles the Productions / Installs / Approved tabs and the Drive folder.
4. **Deploy → New deployment → Web app:**
   - Execute as: **Me** (sign in as dash@ so login emails + uploaded files live under your account)
   - Who has access: **Anyone**  ← required so contractors can submit
5. **Deploy**, then **copy the Web app URL** (ends in `/exec`).

---

## Part 1b — Google sign-in for the staff console

Staff sign into `review.html` with **the same Google account they use for Limitless Pipeline** — no more waiting on a 6-digit code. The email-code flow is still there as a fallback (**"Sign in with an email code instead"**), and it's what shows if the Firebase key below is left unset.

How it works: the browser signs in with Google via Firebase → sends the resulting ID token to Apps Script → the backend validates that token against the Pipeline Firebase project, checks the email against `REVIEWERS`, and issues the same session token everything else already uses. A Google account that isn't on the allow-list gets nothing.

**To turn it on — one value in two places:**

1. Firebase console → project **`limitless-crm-336ee`** → **Project settings → General → Web API key**. Copy it.
2. Paste it into **both**:
   - `Code.gs` → `const FIREBASE_API_KEY = '…'`
   - `review.html` → `const FIREBASE = { apiKey: '…' }`

   It's safe in the repo — a Firebase Web API key is public by design; it identifies the project, it doesn't grant access.
3. Firebase console → **Authentication → Settings → Authorized domains** → **Add domain** → `limitlesslightsandsound.github.io` (plus `invoice.limitlesslightsandsound.com` if you set up the custom domain). **Without this, Google sign-in fails with "unauthorized domain."**

Google is already enabled as a sign-in provider (Pipeline uses it), so there's nothing to turn on there.

> **Popup here, redirect in Pipeline — on purpose.** Pipeline runs on Firebase Hosting, same origin as the auth domain, where a full-page redirect is the reliable option. This portal runs on GitHub Pages, a *different* origin, and that's exactly the case where Firebase's redirect flow breaks under Safari/Chrome third-party storage partitioning. So the console uses a popup, falling back to redirect only if the popup is blocked. Don't "fix" one to match the other.

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
- **"This site isn't an authorized domain"?** Part 1b step 3 — add the Pages domain under Firebase Authentication → Settings → Authorized domains.
- **No "Continue with Google" button?** The `apiKey` in `review.html` is still the placeholder, so the console fell back to email codes. See Part 1b.
- **Signed in with Google, told "not on the reviewer allow-list"?** That Google account's email isn't in `REVIEWERS` in `Code.gs`. Add it, then redeploy a new version.

---

## Workflow recap

**Production invoice** (index.html) → **Tony** reviews (Approve → billing, Escalate to Dash, or Reject).
**Install billing** (install.html) → **Gabe** reviews the same way.
**Dash (master admin)** can act on anything at any stage, including billing.
Approved items land on the **Approved** tab + the controllers' console (**Taryn / Accounting**) to bill → **Mark billed**. All data lives in your Sheet; uploaded files live in your Drive.
