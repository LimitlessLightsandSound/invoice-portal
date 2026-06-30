# Limitless Invoice Portal — deploy packet

Custom contractor invoice form + multi-stage approval queue. Fully yours, no monthly cost.
**Stack:** static HTML on GitHub Pages → Google Apps Script web app → Google Sheet (data) + Google Drive (uploaded files).

---

## What's in this folder

| File | What it is | Goes where |
|---|---|---|
| `index.html` | **The contractor form** (public, branded). Deploy this. | GitHub Pages |
| `review.html` | Staff approval console — Tony / you / accountant. Optional. | GitHub Pages (same repo) |
| `Code.gs` | Backend: saves submissions to a Sheet, files to Drive, emails login codes. | Google Apps Script |
| `README.md` | This file. | — |

You can deploy just `index.html` if you only want the form. `review.html` adds the Tony → you → accountant approval queue.

There are **two placeholders you must fill in** (covered below):
- `Code.gs` → the three reviewer emails near the top.
- `index.html` **and** `review.html` → `const API = 'PASTE_YOUR_WEB_APP_URL_HERE'`.

---

## Part 1 — Backend (Google Sheet + Apps Script)

1. Go to **sheets.new** — a blank Google Sheet. Name it *Contractor Invoices*.
2. **Extensions → Apps Script.** Delete the sample, paste in all of `Code.gs`.
3. Edit the **three reviewer emails** in `REVIEWERS` (your email = `owner`, Tony = `approver`, accountant = `controller`). Save.
4. In the function dropdown choose **`setup`** → **Run**. Authorize when prompted (it's your own script: *Advanced → Go to project → Allow*).
5. **Deploy → New deployment → Web app:**
   - Execute as: **Me**
   - Who has access: **Anyone**  ← required so contractors can submit
6. **Deploy**, then **copy the Web app URL** (ends in `/exec`).

---

## Part 2 — Wire the URL into the form

In VS Code, open `index.html` and `review.html`. Near the top of the `<script>` block, replace the placeholder in **both** files:

```js
const API = 'PASTE_YOUR_WEB_APP_URL_HERE';   // → paste your /exec URL
```

Save both.

---

## Part 3 — Push to GitHub Pages (from VS Code)

**Create the repo**
1. On github.com → **New repository** (e.g. `invoice-portal`). Public (free GitHub Pages needs public; private Pages requires a paid plan).

**From VS Code**
2. **Source Control** panel → **Clone Repository** → paste the repo URL → pick a local folder. (Or terminal: `git clone https://github.com/<you>/invoice-portal.git`.)
3. Copy `index.html` and `review.html` into that folder.
4. Stage + commit + push — Source Control panel (`+` to stage, message, **Commit**, then **Sync/Push**). Terminal equivalent:
   ```bash
   git add .
   git commit -m "Add invoice portal"
   git push
   ```

**Turn on Pages**
5. On github.com → repo → **Settings → Pages** → Source: **Deploy from a branch**, Branch: **main**, folder **/ (root)** → **Save**.
6. A minute later your links are live:
   - Contractor form: `https://<you>.github.io/invoice-portal/`
   - Staff console: `https://<you>.github.io/invoice-portal/review.html`

**Updating later:** edit the file in VS Code → commit → push. Pages redeploys itself. No build step, no CLI tooling beyond git.

---

## Part 4 — Redirect the old Google Form

You can't make `docs.google.com` auto-bounce, but you can turn the old form into a one-click doorway:

1. Open the **old form** → edit.
2. Put the new link in the **form description** (URLs there are clickable):
   `We've moved — submit invoices here: https://<you>.github.io/invoice-portal/`
3. **Responses** tab → toggle **Accepting responses OFF**. Click **Message for respondents** and paste the new link there too — now anyone hitting the old link sees "no longer accepting responses" plus where to go.

**Cleaner long-term option — your own domain.** Instead of the `github.io` address, serve the form from e.g. `invoice.limitlesslightsandsound.com`:
1. Add a file named `CNAME` (no extension) to the repo containing one line: `invoice.limitlesslightsandsound.com`
2. In your DNS, add a **CNAME** record: `invoice` → `<you>.github.io`
3. github.com → Settings → Pages → **Custom domain** → enter it → **Enforce HTTPS**.

Then the canonical link is yours forever and you never depend on Google's URL again.

---

## Gotchas

- **Edited `Code.gs`, nothing changed?** Redeploy: *Deploy → Manage deployments → Edit → Version: New version.* Apps Script serves the last *deployed* version, not the last save.
- **"Failed to fetch" / CORS?** It's the content-type. The form POSTs as plain text on purpose (skips the CORS preflight Apps Script can't answer). Don't add a JSON or Authorization header — the token rides in the request body.
- **Invoice file links won't open?** The Drive folder is shared only with the three reviewer emails; the reviewer must be signed into that Google account. Files aren't public by design.
- **Pages 404 right after enabling?** Give it 1–2 minutes for the first build.

---

## Workflow recap

Contractor submits → **Tony** reviews (Approve → billing, Escalate to you, or Reject) → if escalated, **you** decide → approved invoices land on the **Approved** tab + the accountant's console to bill → **Mark billed**. All data lives in your Sheet; uploaded invoices live in your Drive.
