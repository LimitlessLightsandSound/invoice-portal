# Limitless Invoice Portal — deploy packet

Public forms where contractors submit labor invoices and install billing. Submissions land in a Google Sheet, attachments in Google Drive. **Review and approval happen in the Limitless CRM**, not here.

**Stack:** static HTML on GitHub Pages → Google Apps Script web app → Google Sheet (data) + Google Drive (files). No build step, no monthly cost.

---

## What's in this folder

| File | What it is | Goes where |
|---|---|---|
| `index.html` | **Production invoice form** (event/labor). Branded, public. | GitHub Pages |
| `install.html` | **Install billing form** — same fields, routed to the Installs tab. | GitHub Pages (same repo) |
| `Code.gs` | Backend: saves submissions to the Sheet, files to Drive, styles the sheet. | Google Apps Script |
| `README.md` | This file. | — |

The **API URL** (`const API = '…/exec'`) appears near the top of the `<script>` block in **both** HTML files.

---

## Live URLs

- Production invoice form: `https://limitlesslightsandsound.github.io/invoice-portal/`
- Install billing form: `https://limitlesslightsandsound.github.io/invoice-portal/install.html`

**Updating:** edit a file → commit → push. Pages redeploys itself.

---

## Where submissions go

| Form | `billingType` | Sheet tab |
|---|---|---|
| `index.html` | `production` | **Productions** |
| `install.html` | `install` | **Installs** |

`setup()` builds and styles both tabs plus a combined **Approved** tab and the Drive folder. Run `restyle()` anytime to re-apply the theme.

The Drive folder is shared with the five staff emails in `REVIEWERS` (Dash, Tony, Gabe, Taryn, Accounting) so they can open attachments. Files are **not** public — a reviewer must be signed into that Google account.

---

## Attachments upload as they're picked

Submitting is near-instant even with large files, because the bytes are already gone by the time anyone presses Submit.

1. Contractor picks a file → the form immediately POSTs it (`action:'uploadFile'`) with a live progress bar, while they keep filling out the rest of the form.
2. It lands in Drive as `PENDING-xxxxxxxx.pdf` and the form holds onto the file id.
3. On submit, only the text fields + file ids go over the wire. The backend renames each file to the invoice ID (`INV-20260727-A1B4_invoice.pdf`).

**Leftover `PENDING-*` files are abandoned drafts** — someone attached a file and never submitted. They're safe to delete; nothing references them.

If a background upload fails, the attachment shows a **Retry** link and submit is blocked until it succeeds, so an invoice can't silently arrive without its paperwork. If a client somehow submits without pre-uploading, the backend still accepts inline file bytes as a fallback — slower, but nothing is lost.

Size cap is **10 MB per file** (`MAX_FILE_MB` in `Code.gs`, also checked client-side).

---

## Part 1 — Backend (Google Sheet + Apps Script)

1. Open the sheet **Limitless — Contractor Invoices** (owned by dash@). **Extensions → Apps Script.**
2. Select all, delete, paste in all of `Code.gs`. Confirm the 5 emails in `REVIEWERS` near the top.
3. Function dropdown → **`setup`** → **Run**. Authorize when prompted (*Advanced → Go to project → Allow*).
4. **Deploy → New deployment → Web app:**
   - Execute as: **Me** (sign in as dash@ so uploaded files live under your account)
   - Who has access: **Anyone**  ← required so contractors can submit
5. **Deploy**, then copy the **Web app URL** (ends in `/exec`).

---

## Part 2 — Wire the URL into the forms

In both `index.html` and `install.html`, set:

```js
const API = 'https://script.google.com/macros/s/…/exec';
```

Save, commit, push.

---

## Gotchas

- **Edited `Code.gs`, nothing changed?** Redeploy: *Deploy → Manage deployments → Edit → Version: **New version***. Apps Script serves the last *deployed* version, not the last save. This is the single most common cause of "I fixed it but it's still broken."
- **"Failed to fetch" / CORS?** The forms POST as plain text on purpose — that's a "simple" request, which skips the CORS preflight Apps Script cannot answer. Don't add a JSON `Content-Type` or an `Authorization` header, and don't switch the upload path off `XMLHttpRequest` without checking this still holds.
- **Attachment links won't open?** The Drive folder is shared only with the five staff emails; the reviewer must be signed into that Google account. Files aren't public by design.
- **Sheet not styled?** Run `restyle()` from the Apps Script editor.
- **Drive filling up with `PENDING-*` files?** Abandoned drafts. Delete freely.

---

## Note on the unused review endpoints

`Code.gs` still exposes `requestCode` / `verifyCode` / `list` / `act` — an email-code login and a review API left over from a standalone approval console that was removed (the CRM does that job now). **Nothing in this repo calls them.** They're harmless, and they'd be the natural way to let the CRM pull invoices from this Sheet. If that integration never happens, they can be deleted along with `REVIEWERS`' role/scope fields — but keep `REVIEWERS` itself, since `getFolder_()` uses it to share the Drive folder.
