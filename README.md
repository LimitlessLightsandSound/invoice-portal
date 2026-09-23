# Limitless Invoice Portal — deploy packet

Public forms where contractors submit labor invoices and install billing. Submissions land in a Google Sheet, attachments in Google Drive.

**Review and approval happen in the Limitless CRM**, whose invoices section reads and writes through this same Apps Script API — see [How the CRM reads these invoices](#how-the-crm-reads-these-invoices). This repo is the intake half only.

**Stack:** static HTML on GitHub Pages → Google Apps Script web app → Google Sheet (data) + Google Drive (files). No build step, no monthly cost.

---

## What's in this folder

| File | What it is | Goes where |
|---|---|---|
| `index.html` | **Production invoice form** (event/labor). Branded, public. | GitHub Pages |
| `install.html` | **Install billing form** — same fields minus overtime (no OT on install lines, straight hours × rate), routed to the Installs tab. | GitHub Pages (same repo) |
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

The Drive folder uses **domain link access** — anyone signed in at `limitlesslightsandsound.com` who has a link can view an attachment. It is **not** public: a signed-out visitor, or anyone outside the domain, gets nothing.

**Why not share it with the five reviewers individually?** Because a per-person grant is what makes Google send them mail. First a "shared with you" notice, then — for as long as the grant exists — an ongoing "files were added to a folder shared with you" activity feed and Drive Chat pings, every single time an invoice drops attachments in. None of that comes from this script; Drive generates it because the folder is explicitly shared. Link access gives the same read access with no per-user permission, so there is nobody for Drive to notify. `shareFolder_()` sets this and removes any leftover individual grants.

If domain sharing is ever refused (admin policy), `shareFolder_()` falls back to per-person grants and says so in the `setup()` log — reviewers keep access, but the notifications come back.

---

## Itemised expenses

Section 3 of both forms is a line-item grid, not a pile of receipt files. Each row is **category + amount + optional description + optional receipt image**.

Categories live in **two places that must stay in sync**: `EXPENSE_CATEGORIES` in `Code.gs` and `EXPENSE_CATS` in both HTML forms. Submit rejects any category not on the backend list, so adding an option to the form alone will bounce the submission with `Unknown expense category`.

> Rental car · Public transport · Mileage · Per diem (P/D) · Hospitality · Lodging · Small equipment purchase · Equipment rental · Parking

**The receipt is optional per row** — mileage and per diem normally have none. Category and a positive amount are required on any row the contractor touched; untouched rows are ignored, so a stray "+ Add an expense" click can't block a submission.

**Expenses are reimbursable and add to the billed total.** `Amount` is the grand total (labor + expenses) — that's the number the Approved tab and the CRM show, so accounting pays one figure. The breakdown is kept alongside it:

| Column | Meaning |
|---|---|
| `Amount` | **Grand total — what gets billed** (labor + expenses) |
| `LaborAmount` | Hours grid total, or the invoice total the contractor typed |
| `ExpensesTotal` | Sum of the expense rows |
| `ExpensesJSON` | Full itemisation: category, amount, description, receipt URL |

Totals are recomputed server-side; the client's arithmetic is never trusted. The form shows labor, expenses and total split out before submit, so a contractor who uploads an invoice that *already* includes expenses can see they'd be double-counting.

Rows created before this change have blank expense columns and read back as labor-only, so old invoices are unaffected.

**Adding a column later:** append to the END of `HEADERS` only. `COL` is index-based and the Approved tab's QUERY refers to columns positionally (`Col2`, `Col27`), so inserting in the middle silently rewires both. Then widen the range in `approvedFormula_()` (currently `A2:AH` = 34 columns) **if the Approved tab needs to read the new column** — `DocsJSON` (col 35 / `AI`, INV-026) deliberately sits outside it, since payment paperwork is not something the payment queue selects on — and run `setup()`, which rewrites the header row and refreshes the formula.

---

## Supporting documents (INV-026)

Both forms have a **Supporting documents** picker in section 3: multiple files at once, for a W9, payment/ACH details, or anything else the contractor should have on file. It exists so those stop being a separate email thread.

These are **not receipts** and are handled apart from them at every step:

| | Receipts | Supporting documents |
|---|---|---|
| Belongs to | one expense row | the invoice |
| Drive folder | `Limitless — Contractor Invoices` | `Limitless — Contractor Documents` |
| Sheet column | `ReceiptURLs` (+ `ExpensesJSON`) | `DocsJSON` — `[{name,url}]` |
| Affects the total | yes (reimbursable) | no |

The separate folder is why `uploadFile` takes `kind:'doc'`: the routing decision happens at upload time, not at submit, so a W9 never sits in the receipts folder even briefly. `adoptFile_`'s "is it really in our folder" guard is folder-aware for the same reason.

**The contractor's original filename is kept in `DocsJSON`.** Drive renames the stored copy to the invoice id (`INV-…_doc1.pdf`), so without the name a reviewer sees identical chips and has to open each one.

**Sharing: the same reviewers can open both folders** (Dash, 2026-09-08). The split is structural — it means that decision can change later without moving files. `setup()` shares both, and creating the documents folder is a side effect of the first run after this ships.

---

## Attachments upload as they're picked

Submitting is near-instant even with large files, because the bytes are already gone by the time anyone presses Submit.

1. Contractor picks a file → the form immediately POSTs it (`action:'uploadFile'`) with an indeterminate progress bar, while they keep filling out the rest of the form.
2. It lands in Drive as `PENDING-xxxxxxxx.pdf` and the form holds onto the file id.
3. On submit, only the text fields + file ids go over the wire — and **submit makes no Drive calls at all**. `uploadFile` records each id it minted in the script cache, so `claimFile_()` trusts that record instead of re-fetching the file to verify it, and builds the row's link straight from the id. Re-verifying cost ~1.3s *per attachment* on the button press.
4. Renaming `PENDING-xxxxxxxx.pdf` → `INV-20260729-A1B4_invoice.pdf` is cosmetic, so it's queued and done later by `sweepRenames_()` — off the hot path, a few at a time during subsequent uploads, or all at once from `setup()` / by running `sweepRenames()` in the editor. Drive links are id-based, so they work identically before and after the rename.

**Careful with `PENDING-*` files.** Most are abandoned drafts — someone attached a file and never submitted — and those are safe to delete. But a *just-submitted* file also stays `PENDING-*` until the sweep renames it. Before bulk-deleting, run `sweepRenames()` first: whatever is still `PENDING-*` after that is genuinely abandoned.

If a background upload fails, the attachment shows a **Retry** link and submit is blocked until it succeeds, so an invoice can't silently arrive without its paperwork. If a client somehow submits without pre-uploading, the backend still accepts inline file bytes as a fallback — slower, but nothing is lost.

Size cap is **10 MB per file** (`MAX_FILE_MB` in `Code.gs`, also checked client-side).

---

## Part 1 — Backend (Google Sheet + Apps Script)

1. Open the sheet **Limitless — Contractor Invoices** (owned by dash@). **Extensions → Apps Script.**
2. Select all, delete, paste in all of `Code.gs`. Confirm the emails in `REVIEWERS` near the top.
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
- **"Failed to fetch" / CORS?** The forms POST as plain text on purpose — that's a "simple" request, which skips the CORS preflight Apps Script cannot answer. Three ways to break it, all of which make *every* upload fail: adding a JSON `Content-Type`, adding an `Authorization` header, or **switching uploads to `XMLHttpRequest` with an `upload.onprogress` listener.**
- **Why is the upload bar indeterminate instead of showing a percentage?** Because a real percentage requires XHR's `upload.onprogress`, and per the CORS spec *merely registering* an upload listener makes the request non-simple — forcing a preflight `OPTIONS` that Apps Script cannot answer. This was shipped once and broke every attachment. Measured cross-origin in a browser: plain `fetch` → 200, XHR without the listener → 200, XHR **with** it → fails. The bar is indeterminate on purpose; don't "improve" it.
- **Attachment links won't open?** The Drive folder is shared only with the five staff emails; the reviewer must be signed into that Google account. Files aren't public by design.
- **Sheet not styled?** Run `restyle()` from the Apps Script editor.
- **Getting "shared with you" emails on every upload and submission?** That was `getFolder_()` re-adding all five reviewers as viewers on *every* call — a Drive permission write per reviewer per request, each one sending mail. Sharing now happens **only** in `setup()`, through `shareFolder_()`, which skips anyone who already has access. Don't move sharing back into `getFolder_()`. After adding someone to `REVIEWERS`, run `setup()` once to grant them folder access.
- **Uploads or submits feel slow?** Two things used to run on every single request and no longer do: the folder re-share above (~15 Drive writes for a two-file invoice) and a full re-application of the sheet theme — banding, conditional formats and column widths — inside `ensureSheets_()`. Both are now one-time. Keep the hot path (`uploadFile`, `submit`, `list`) free of Drive permission writes and formatting calls.
- **Drive filling up with `PENDING-*` files?** Abandoned drafts. Delete freely.

---

## How the CRM reads these invoices

The invoices section of **Limitless Pipeline** is a client of *this* backend — it does not have its own copy of the data. `src/invoices/api.ts` POSTs to the same `/exec` URL:

| CRM call | `Code.gs` action | Purpose |
|---|---|---|
| `firebaseLogin(idToken)` | `firebaseLogin` | Staff sign in with their normal CRM Google account; the ID token is validated against the `limitless-crm-336ee` Firebase project and the email checked against `REVIEWERS`. |
| `listInvoices(token)` | `list` | Fetch invoices, scoped server-side by role. |
| `act(token, …)` | `act` | approve / escalate / reject / billed / reopen. |

So the flow is: **contractor form → Apps Script → Sheet + Drive → CRM invoices page.** Nothing else is needed to "get invoices into the CRM" — do not build a second pipeline.

**These endpoints are load-bearing. Don't delete `firebaseLogin`, `list`, or `act`.**

### Two wires to connect it

1. **`FIREBASE_API_KEY` in `Code.gs`** — Firebase console → project `limitless-crm-336ee` → Project settings → General → **Web API key**. Without it `firebaseLogin` can't validate tokens and every reviewer is rejected. (Public by design — it identifies the project, it doesn't grant access.)
2. **`VITE_INVOICE_API_URL` in the CRM's build env** — set to this deployment's `/exec` URL, then redeploy the CRM.

**While `VITE_INVOICE_API_URL` is unset, the CRM invoices page runs on in-memory fixtures** (`src/invoices/fixtures.ts`) — it looks fully populated but none of it is real. That's deliberate: it keeps demo builds, unit tests, and the Playwright e2e suite off the live Apps Script. It also means "the invoices page works" is not evidence the connection is live. Check for a real invoice you submitted yourself.

**The email one-time-code sign-in has been removed.** It was a second, weaker way into the same data — a 6-digit code, plus a `requestCode` endpoint that let anyone on the internet fire sign-in mail at a reviewer's inbox. Reviewers reach this through the CRM, which already authenticates them with Google, so the codes bought nothing. Don't reinstate them: if Google sign-in breaks, fix that rather than adding a bypass.

---

## Internal adjustments (INV-022)

A verbally-agreed price change can be applied **from the CRM's invoice detail** ("Edit
amounts") instead of making the contractor resubmit. The rules, decided 2026-08-24:

- **Approvers only** — the same people who could approve the bill (`canReview_` coverage).
  Controllers pay; they do not reprice.
- The contractor's **submission is immutable**: `LineItemsJSON` / `LaborAmount` are never
  rewritten. Adjusted lines/labor live in `AdjLineItemsJSON` / `AdjLaborAmount`, every edit
  appends who/when/why + old→new to `AdjLogJSON`, and `Amount` becomes the current billed
  total so the Approved tab keeps paying one figure.
- Any edit sets the bill back to **Awaiting review**; a **paid** bill can't be edited
  (reopen first, owner-only).
- The **contractor is emailed** the adjusted lines and new total (`notifyAdjustment_`) —
  that email is the paper trail for the verbal agreement. **MailApp is a new OAuth scope:
  the next redeploy will ask for authorization once.**
- Hours bills take a replacement line set (totals recomputed server-side); uploaded-PDF
  bills take an amount override. A reason is always required.

## Who can review what

One review step. An invoice sits at **"Awaiting review"** and is never addressed to a named person — there is no stage-1/stage-2 chain. Escalating asks for a **cross review** (a second opinion); it does not advance the invoice to a second gate, so an escalated invoice is still awaiting review.

| | Reviews production | Reviews install | Marks paid |
|---|---|---|---|
| Dash (owner) | ✅ | ✅ | ✅ |
| Tony (approver, no scope) | ✅ | ✅ | — |
| Gabe (approver, `scope: 'install'`) | — | ✅ | — |
| Installs — installs@ (approver, `scope: 'install'`) | — | ✅ | — |
| Taryn / Accounting (controller) | — | — | ✅ |

Controllers deliberately can't approve — the person who pays isn't the person who approves. Reopening a **billed** invoice is owner-only, since it unwinds a payment record; anything else a reviewer can put back in the queue.

`canReview_(session, billingType)` is the single source of truth, and `listInvoices` mirrors it: a scoped approver sees only their tab, everyone else sees both.

Stamps are `ReviewedBy/At/Note` (whoever approved or rejected) and `EscalatedBy/At/Note` (whoever asked for the cross review).


## Contractor submission fixes (September 2026)

Both forms block Enter from implicitly submitting while typing in input fields. The
Submit invoice button remains keyboard accessible; notes retain multiline entry.
Each labor row has **Copy line**, which duplicates the date, description, hours,
rate, and production overtime settings. Focus moves to the copied date so the
contractor can update it for the next show day. Each copied row remains independent.

After the Sheet append succeeds, `submitInvoice` sends a plain-text invoice copy to
the submitted email address: reference, job, line items including OT rate, expenses,
notes, and totals. Uploaded invoices are acknowledged as on file; files and internal
Drive links are not included. Existing adjustment emails remain separate.
`emailSent` reports whether MailApp accepted the send, not final inbox delivery.
Mail failure leaves the invoice saved and the success screen tells the contractor
not to resubmit. The forms also handle an older backend without `emailSent` honestly.

Deployment requires **both** publishing the HTML files through GitHub Pages and
updating `Code.gs` in the existing Apps Script project, authorizing MailApp if needed,
and creating a new version of the existing web-app deployment (keep its URL).
Changes in this checkout alone do not update the running Apps Script backend.

### Regression tests

Run `npm ci` then `npm test`. Tests exercise both forms in jsdom and run `Code.gs`
with mocked Sheet and MailApp services, so no invoices are created and no real mail
is sent. They cover Enter handling, copied rows and OT, explicit submission,
email status reporting, save-before-mail ordering, and mail/write failures.


**Required receipt sender:** `accounting@limitlesslightsandsound.com` (September 23).
The invoice backend retains its existing Sheet, Drive, and deployment identity.
Receipt messages are sent through `accounting-mailer/Code.gs`, a separate Apps Script
owned by Accounting. It uses MailApp (send mail only, no inbox access), checks the
executing account, and requires a private shared key on every request. There is no
fallback to Dash. Existing adjustment emails are unchanged.

Accounting project: `158kGWuzfziYg1sjpG7hU16zedfjXx_dpAbYu3L7YSMOoOQ4FBbF1xM60`.
Activated September 23, 2026:
- Accounting mail service: version 1, execution identity Accounting, MailApp authorized.
- Existing invoice backend: version 8, same public URL and data-storage identity.
- Both HTML forms: Enter protection, Copy line, and receipt status published.
- Private connection values are stored in Script Properties, not Git or the forms.
- Verified both service responses, rejection of unauthenticated mail requests,
  the Accounting authorization/quota check, and 18 automated tests. No test invoices
  or real email messages were created during deployment.

Mailer deployment: `AKfycbzJHQ5Pug97fMcojmPEQH31G396mV_NhPwsK0xZhWaBTWPzjPA-gzq_Vs8vRjwNBpfF5Q`.
Invoice deployment: `AKfycbxx3HXJPa3qjQkiuB4JUP0VGX_qwGjLMx9W8-RY5qejLQ9pMlDfJiWrzPmFTnYwe91v`.
The pre-update live invoice source matched repository baseline `59818a8` exactly.

Deployment/recovery procedure:
1. Authorize `authorizeMailer` as Accounting (this checks quota; it sends no email).
2. Set a random `RECEIPT_SECRET` in the Accounting project's Script Properties.
3. Deploy the mailer as a web app, executing as Accounting, reachable by the backend.
   All email requests require the private key; keep it out of Git and the HTML forms.
4. Set the same `RECEIPT_SECRET` and the mailer's `/exec` URL as `RECEIPT_MAILER_URL`
   in the existing invoice backend's Script Properties.
5. Compare the live backend with this checkout, preserve any intervening changes,
   update its source, then publish a new version of its existing deployment.
6. Verify the mailer health response and that requests without its key fail closed.

The mailer serializes sends and caches receipt IDs for six hours to suppress
immediate repeated delivery requests. This is not a durable invoice deduplication
system. A mail failure still leaves the saved invoice intact and is reported to the
contractor. Tests mock both services and send no real mail.
