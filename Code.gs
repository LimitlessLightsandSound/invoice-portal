/*************************************************************************
 * LIMITLESS LIGHTS & SOUND — Contractor Invoice Backend (Google Apps Script)
 * -----------------------------------------------------------------------
 * Container-bound to a Google Sheet. Deploy as a Web App.
 *
 * SETUP:
 *   1. Open the Sheet "Limitless — Contractor Invoices". Extensions > Apps Script.
 *      Delete the sample, paste this whole file.
 *   2. Confirm the REVIEWERS map below (5 people).
 *   3. Run setup() once (authorize when prompted). It builds + styles the tabs.
 *   4. Deploy > New deployment > Web app:
 *        Execute as: Me
 *        Who has access: ANYONE   <-- required so contractors can submit
 *      Copy the /exec URL. Paste it into index.html and install.html (API const).
 *
 * TWO FORMS, TWO TABS:
 *   - index.html   -> billingType 'production' -> "Productions" tab
 *   - install.html -> billingType 'install'    -> "Installs"    tab
 *   Review and approval happen in the Limitless CRM, not here. This backend's job
 *   is to capture submissions into the Sheet and attachments into Drive.
 *
 * ATTACHMENTS ARE UPLOADED BEFORE SUBMIT:
 *   The forms POST each file via 'uploadFile' the moment it's picked, so it lands
 *   in Drive named PENDING-xxxx. 'submit' then claims those ids and renames them
 *   to the invoice ID. Leftover PENDING-* files are abandoned drafts — safe to
 *   delete. This is why submitting feels instant even with big attachments.
 *
 * CORS NOTE (do not "fix" this):
 *   Apps Script web apps cannot return CORS headers. The HTML clients POST
 *   with a TEXT/PLAIN body and NO custom headers, which is a "simple" request
 *   that skips the CORS preflight. The auth token travels in the body, never
 *   in an Authorization header. Keep it that way or cross-origin calls break.
 *************************************************************************/

/***** CONFIG — REVIEWERS *****/
/* There is ONE review step, not a stage-1/stage-2 chain. An invoice sits at
 * "Awaiting review" — it is never addressed to a named person — and any reviewer
 * who covers its billing type can approve, reject, or escalate it for a cross
 * review. Escalating is a request for a second opinion, not a handoff up a ladder.
 *
 *   owner      — Dash. Reviews either type, and can also mark paid and reopen.
 *   approver   — reviews. `scope` limits which billing type:
 *                  Tony  : no scope  -> BOTH production and install
 *                  Gabe  : 'install' -> install billing only
 *   controller — Taryn / Accounting. Marks approved invoices paid, never reviews.
 *
 * `pay: true` grants marking-paid on top of a role. Tony has it (Dash's call), so he
 * can both approve an invoice and pay it — there is deliberately no separation of
 * duties for him. Everyone else who pays (the controllers) cannot approve. */
const REVIEWERS = {
  'dash@limitlesslightsandsound.com'       : { role: 'owner',      name: 'Dash' },
  'tony@limitlesslightsandsound.com'       : { role: 'approver',   name: 'Tony',       pay: true },
  'gabe@limitlesslightsandsound.com'       : { role: 'approver',   name: 'Gabe',       scope: 'install' },
  'taryn@limitlesslightsandsound.com'      : { role: 'controller', name: 'Taryn' },
  'accounting@limitlesslightsandsound.com' : { role: 'controller', name: 'Accounting' }
};

/* Can this session mark an approved invoice paid? Controllers and the owner always
 * can; anyone else needs an explicit `pay: true` in REVIEWERS. */
function canPay_(s){
  return !!s && (s.role === 'owner' || s.role === 'controller' || !!s.pay);
}

/* Can this session review an invoice of `billingType`? Controllers never can —
 * they only mark paid. An approver with no scope covers everything. */
function canReview_(s, billingType){
  if (!s) return false;
  if (s.role === 'owner') return true;
  if (s.role !== 'approver') return false;
  return !s.scope || s.scope === billingType;
}

const DRIVE_FOLDER_NAME = 'Limitless — Contractor Invoices';
const SESSION_TTL_DAYS  = 30;     // how long a login lasts
const MAX_FILE_MB       = 10;     // per uploaded file

/***** FIREBASE AUTH (used by the CRM invoices console) *****/
// Web API key from your Firebase project: Project settings > General > "Web API key".
// This is PUBLIC by design — it only lets the backend VALIDATE ID tokens for this one project.
const FIREBASE_API_KEY = 'AIzaSyCkLXrpphHLsxcwQTTeylDMFlh-OGE31lE';

/***** TABS *****/
const PRODUCTIONS_TAB = 'Productions';
const INSTALLS_TAB    = 'Installs';
const APPROVED_TAB    = 'Approved';
const DATA_TABS       = [PRODUCTIONS_TAB, INSTALLS_TAB];

/***** ACCENT COLORS (glossy theme) *****/
const ACCENT = {
  production: '#0D3A6E',   // navy
  install:    '#0F6E63',   // teal
  approved:   '#1F7A4D'    // green
};

/* NOTE: 'Amount' is the GRAND TOTAL that gets billed — labor plus reimbursable
   expenses. 'LaborAmount' and 'ExpensesTotal' are the breakdown, kept as their own
   columns so a human reading the sheet doesn't have to do subtraction.
   APPEND new columns at the END ONLY: COL is index-based, and the Approved tab's
   QUERY refers to columns positionally (Col2, Col27, …), so inserting in the middle
   silently rewires both. Adding at the end also means old rows just read blank. */
const HEADERS = ['Timestamp','InvoiceID','Status','BillingType','Contractor','Company','Email','Phone',
  'Job','PM','EntryType','Amount','Ref/InvoiceNo','Description','LineItemsJSON',
  'Notes','InvoiceFileURL','ReceiptURLs',
  'ReviewedBy','ReviewedAt','ReviewNote','EscalatedBy','EscalatedAt','EscalationNote',
  'BilledBy','BilledAt','BillRef',
  'LaborAmount','ExpensesTotal','ExpensesJSON'];

/* Reimbursable expense categories. The form's dropdown is built from this list, and
   submit rejects anything not on it — otherwise the categories drift and the whole
   point of itemising is lost. Keep in sync with EXPENSE_CATS in index/install.html. */
const EXPENSE_CATEGORIES = ['Rental car','Public transport','Mileage','Per diem (P/D)',
  'Hospitality','Lodging','Small equipment purchase','Equipment rental','Parking'];
const COL = {}; HEADERS.forEach((h,i)=>COL[h]=i); // name -> 0-based index

/***** WEB APP ENTRYPOINTS *****/
function doGet(e){
  // Visiting the URL in a browser shows a heartbeat. Real calls are POST.
  return json({ ok:true, service:'Limitless Invoice API', time:new Date().toISOString() });
}
function doPost(e){
  try{
    var body = {};
    if (e && e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);
    var action = body.action || '';
    switch(action){
      case 'firebaseLogin': return firebaseLogin(body); // CRM console sign-in
      case 'uploadFile' : return uploadFile(body);      // PUBLIC (no token)
      case 'submit'     : return submitInvoice(body);   // PUBLIC (no token)
      case 'list'       : return listInvoices(body);    // token required
      case 'act'        : return actOnInvoice(body);    // token required
      default           : return json({ ok:false, error:'Unknown action' });
    }
  }catch(err){
    return json({ ok:false, error:String(err && err.message || err) });
  }
}

/***** SIGN-IN — GOOGLE ONLY *****/
/* There is deliberately NO email-code fallback. It was a second, weaker way into the
 * same data: a 6-digit code, and a requestCode endpoint that let anyone on the internet
 * fire sign-in mail at a reviewer's inbox. Reviewers reach this through the CRM, which
 * already authenticates them with Google, so the codes bought nothing. Do not reinstate
 * them — if Google sign-in ever breaks, fix that rather than adding a bypass. */
/***** FIREBASE SIGN-IN (CRM invoices console) *****/
// Client signs in with Google via Firebase, sends us the resulting ID token.
// We validate it against THIS Firebase project, confirm the email is an allow-listed
// reviewer, and issue the same session token the rest of the app already uses.
function firebaseLogin(b){
  var idToken = String(b.idToken||'');
  if (!idToken) return json({ ok:false, error:'Missing sign-in token.' });
  var info = verifyFirebaseToken_(idToken);
  if (!info || !info.email) return json({ ok:false, error:'Could not verify your Google sign-in.' });
  if (!info.emailVerified) return json({ ok:false, error:'Your Google email is not verified.' });
  var email = String(info.email).trim().toLowerCase();
  var who = REVIEWERS[email];
  if (!who) return json({ ok:false, error:'That account is not on the reviewer allow-list.' });
  var token = Utilities.getUuid();
  var sess = { email:email, role:who.role, name:who.name, scope: who.scope||'', pay: !!who.pay, exp: Date.now()+SESSION_TTL_DAYS*86400000 };
  PropertiesService.getScriptProperties().setProperty('sess_'+token, JSON.stringify(sess));
  return json({ ok:true, token:token, role:who.role, name:who.name, scope: who.scope||'', pay: !!who.pay, email:email });
}

// Validate a Firebase ID token via Identity Toolkit. Returns {email, emailVerified} or null.
// A token for any other project (or an expired one) fails here, so this both authenticates
// and confirms the token was minted by OUR project.
function verifyFirebaseToken_(idToken){
  try{
    var url = 'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(FIREBASE_API_KEY);
    var res = UrlFetchApp.fetch(url, {
      method:'post', contentType:'application/json',
      payload: JSON.stringify({ idToken: idToken }), muteHttpExceptions:true
    });
    if (res.getResponseCode() !== 200) return null;
    var data = JSON.parse(res.getContentText());
    var u = data && data.users && data.users[0];
    if (!u || !u.email) return null;
    return { email: u.email, emailVerified: !!u.emailVerified };
  }catch(e){ return null; }
}

function session(token){
  if (!token) return null;
  var raw = PropertiesService.getScriptProperties().getProperty('sess_'+token);
  if (!raw) return null;
  var s = JSON.parse(raw);
  if (Date.now() > s.exp){ PropertiesService.getScriptProperties().deleteProperty('sess_'+token); return null; }
  return s;
}

/***** ATTACHMENT UPLOAD (public) *****/
/* The form uploads each file the moment it's picked, while the contractor is still
   typing. By the time they hit Submit the bytes are already in Drive, so submit
   sends only the small text fields plus the file ids — which is what makes it
   return instantly instead of stalling on a multi-MB base64 payload. */
function uploadFile(b){
  var f = b.file;
  if (!f || !f.b64) return json({ ok:false, error:'No file received.' });
  try{
    var file = writeFile_(getFolder_(), f, 'PENDING-' + Utilities.getUuid().slice(0,8));
    var id = file.getId();
    /* Remember that WE minted this id. submit then trusts this record instead of
       re-fetching the file from Drive to verify it — that verification cost ~1.3s
       per attachment on the button press the contractor actually waits on. */
    try { CacheService.getScriptCache().put('pend_'+id, '1', 21600); } catch(e){}
    /* Uploads happen in the background while the contractor is still filling in the
       form, so this is the one path that can absorb spare work. Drain a few queued
       renames here rather than on submit. */
    try { sweepRenames_(3); } catch(e){}
    return json({ ok:true, fileId:id, name:f.name||'' });
  }catch(e){
    return json({ ok:false, error:String((e && e.message) || e) });
  }
}

/***** SUBMIT (public) *****/
function submitInvoice(b){
  ensureSheets_();
  var billingType = (b.billingType==='install') ? 'install' : 'production';
  var id = 'INV-' + (billingType==='install'?'INST-':'') +
           Utilities.formatDate(new Date(),'GMT','yyyyMMdd') + '-' +
           Math.random().toString(36).slice(2,6).toUpperCase();

  var entryType = b.entryType || 'hours';   // hours | file
  var lineItemsJson = b.lineItems ? JSON.stringify(b.lineItems) : '';

  /* Expenses are itemised by category and REIMBURSABLE, so they add to what gets
     billed. Totals are recomputed here rather than trusting the client's arithmetic.
     Unknown categories are rejected — a free-text category defeats the itemising.
     b.laborAmount is absent on older clients, which send only b.amount; falling back
     to it keeps a stale cached form working (it just submits no expenses). */
  var expenses = [];
  var expensesTotal = 0;
  if (Array.isArray(b.expenses)){
    for (var ei=0; ei<b.expenses.length; ei++){
      var e = b.expenses[ei] || {};
      var cat = String(e.category||'').trim();
      var amt = Number(e.amount)||0;
      if (!cat && amt <= 0) continue;                       // blank row — ignore
      if (EXPENSE_CATEGORIES.indexOf(cat) < 0){
        return json({ ok:false, error:'Unknown expense category: ' + cat });
      }
      if (amt <= 0) return json({ ok:false, error:'Expense "' + cat + '" needs an amount.' });
      expenses.push({ category:cat, amount:amt, desc:String(e.desc||''), fileId:String(e.fileId||''), url:'' });
      expensesTotal += amt;
    }
  }
  var laborAmount = (b.laborAmount != null) ? (Number(b.laborAmount)||0) : (Number(b.amount)||0);
  var amount = laborAmount + expensesTotal;   // grand total — this is what gets billed

  /* Files: normally already in Drive via uploadFile, so we just claim them by id.
     The inline-b64 path stays as a fallback for a client whose background upload
     failed — better a slow submit than a lost invoice. */
  var invoiceUrl = '';
  if (b.invoiceFileId){ invoiceUrl = claimFile_(b.invoiceFileId, id+'_invoice'); }
  if (!invoiceUrl && b.invoiceFile && b.invoiceFile.b64){ invoiceUrl = saveFile_(getFolder_(), b.invoiceFile, id+'_invoice'); }

  /* Each expense may carry its own receipt image. The url is stored ON the expense
     (so the category, amount and its receipt travel together) and also collected
     into ReceiptURLs, which is what the CRM console already reads. */
  var receiptUrls = [];
  expenses.forEach(function(e){
    if (!e.fileId) return;
    var u = claimFile_(e.fileId, id+'_receipt'+(receiptUrls.length+1));
    if (u){ e.url = u; receiptUrls.push(u); }
  });
  if (Array.isArray(b.receiptFileIds)){          // legacy clients: bare receipts, no categories
    b.receiptFileIds.forEach(function(fid){
      var u = claimFile_(fid, id+'_receipt'+(receiptUrls.length+1));
      if (u) receiptUrls.push(u);
    });
  }
  if (Array.isArray(b.receipts)){
    b.receipts.forEach(function(r){
      if (r && r.b64) receiptUrls.push(saveFile_(getFolder_(), r, id+'_receipt'+(receiptUrls.length+1)));
    });
  }

  var row = new Array(HEADERS.length).fill('');
  row[COL['Timestamp']]     = new Date();
  row[COL['InvoiceID']]     = id;
  row[COL['Status']]        = 'pending';
  row[COL['BillingType']]   = billingType;
  row[COL['Contractor']]    = b.contractor||'';
  row[COL['Company']]       = b.company||'';
  row[COL['Email']]         = b.email||'';
  row[COL['Phone']]         = b.phone||'';
  row[COL['Job']]           = b.job||'';
  row[COL['PM']]            = b.pm||'';
  row[COL['EntryType']]     = entryType;
  row[COL['Amount']]        = amount;
  row[COL['Ref/InvoiceNo']] = b.invoiceNo||'';
  row[COL['Description']]   = b.description||'';
  row[COL['LineItemsJSON']] = lineItemsJson;
  row[COL['Notes']]         = b.notes||'';
  row[COL['InvoiceFileURL']]= invoiceUrl;
  row[COL['ReceiptURLs']]   = receiptUrls.join(' ; ');
  row[COL['LaborAmount']]   = laborAmount;
  row[COL['ExpensesTotal']] = expensesTotal;
  row[COL['ExpensesJSON']]  = expenses.length ? JSON.stringify(expenses) : '';

  sheet_(tabForType_(billingType)).appendRow(row);
  return json({ ok:true, id:id });
}

/***** LIST (token) *****/
function listInvoices(b){
  var s = session(b.token);
  if (!s) return json({ ok:false, error:'Not signed in.' });
  ensureSheets_();

  /* Scope mirrors canReview_: a controller sees only the billable pipeline, a SCOPED
     approver (Gabe) sees just their type, and everyone else — the owner and an
     unscoped approver like Tony — sees both. Checking `s.scope` for truth rather
     than comparing it to 'install' matters: Tony has no scope, and the old
     comparison quietly fell through to Productions-only for him. */
  var rows;
  if (s.role === 'controller'){
    rows = readData_(PRODUCTIONS_TAB).concat(readData_(INSTALLS_TAB))
             .filter(function(x){ return x.status==='approved' || x.status==='billed'; });
  } else if (s.role === 'approver' && s.scope){
    rows = readData_(s.scope === 'install' ? INSTALLS_TAB : PRODUCTIONS_TAB);
  } else {
    rows = readData_(PRODUCTIONS_TAB).concat(readData_(INSTALLS_TAB));
  }
  rows.sort(function(a,c){ return String(c.submitted||'').localeCompare(String(a.submitted||'')); }); // newest first
  return json({ ok:true, role:s.role, name:s.name, scope:s.scope||'', pay: !!s.pay, invoices: rows });
}

function readData_(tab){
  var sh = sheet_(tab);
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2,1,last-1,HEADERS.length).getValues().map(rowToObj_);
}

/***** ACT (token) *****/
/* ONE read and ONE write.
 *
 * This used to do ~8 separate Sheets round trips per action — two getValue()s, up to
 * four setValue()s, plus findInvoice_ scanning the ID column of both tabs — and the
 * client then refetched the WHOLE list before the UI moved. Measured end to end that
 * was ~4s for anything and ~7s for a reject. Now: fetch the row once, mutate the
 * array in memory, write it back once, and RETURN the updated invoice so the client
 * has no reason to refetch at all.
 *
 * Review model: a single review step. Anyone who covers the billing type
 * (canReview_) can approve / reject / escalate whatever is still open. Escalate
 * flags it for a cross review; it does not hand it to a particular person. */
function actOnInvoice(b){
  var s = session(b.token);
  if (!s) return json({ ok:false, error:'Not signed in.' });
  var id = b.id, act = b.verb, note = b.note||'', billRef = b.billRef||'';
  if (!id || !act) return json({ ok:false, error:'Missing id or action.' });

  var found = findInvoice_(id);
  if (!found) return json({ ok:false, error:'Invoice not found.' });
  var sh = found.sh, rowIdx = found.rowIdx;

  var range = sh.getRange(rowIdx, 1, 1, HEADERS.length);
  var row = range.getValues()[0];                      // <-- the ONLY read
  var billingType = row[COL['BillingType']] || 'production';
  var status = String(row[COL['Status']]||'');
  var now = new Date();

  var reviewer = canReview_(s, billingType);
  var isOpen = (status === 'pending' || status === 'escalated');

  function stampReview(next){
    row[COL['ReviewedBy']] = s.name; row[COL['ReviewedAt']] = now; row[COL['ReviewNote']] = note;
    row[COL['Status']] = next;
  }

  var allowed = false;
  if (act === 'approve'){
    if (reviewer && isOpen){ stampReview('approved'); allowed = true; }
  } else if (act === 'reject'){
    // an approved-but-unpaid invoice can still be pulled back
    if (reviewer && (isOpen || status === 'approved')){ stampReview('rejected'); allowed = true; }
  } else if (act === 'escalate'){
    if (reviewer && status === 'pending'){
      row[COL['EscalatedBy']] = s.name; row[COL['EscalatedAt']] = now; row[COL['EscalationNote']] = note;
      row[COL['Status']] = 'escalated'; allowed = true;
    }
  } else if (act === 'billed'){
    if (canPay_(s) && status === 'approved'){
      row[COL['BilledBy']] = s.name; row[COL['BilledAt']] = now; row[COL['BillRef']] = billRef;
      row[COL['Status']] = 'billed'; allowed = true;
    }
  } else if (act === 'reopen'){
    /* Reopening a BILLED invoice unwinds a payment record, so that stays with the
       owner. Anything else a reviewer can put back in the queue. */
    if (status === 'billed' ? (s.role === 'owner') : reviewer){
      row[COL['Status']] = 'pending'; allowed = true;
    }
  }

  if (!allowed){
    if (!reviewer && act !== 'billed'){
      return json({ ok:false, error: s.role === 'controller'
        ? 'Controllers mark invoices paid; they do not approve them.'
        : 'That billing type is outside your queue.' });
    }
    return json({ ok:false, error:'That action is not available at this stage.' });
  }

  range.setValues([row]);                              // <-- the ONLY write
  return json({ ok:true, invoice: rowToObj_(row) });    // client updates in place; no refetch
}

/* Locate an invoice by id. Returns {sh, rowIdx} (1-based) or null.
 *
 * The scan reads the whole InvoiceID column of BOTH tabs, so it's cached: a hit
 * costs one single-cell read instead. The cached row is always re-verified, because
 * deleting a row above shifts every index below it — on a mismatch we fall back to
 * the scan and re-cache. The cache is a speed-up, never a source of truth. */
function findInvoice_(id){
  var cache = null, key = 'row_' + id;
  try { cache = CacheService.getScriptCache(); } catch(e){}

  if (cache){
    var hit = cache.get(key);
    if (hit){
      var parts = String(hit).split('|');
      try{
        var csh = sheet_(parts[0]), crow = Number(parts[1]);
        if (crow >= 2 && csh.getRange(crow, COL['InvoiceID']+1).getValue() === id){
          return { sh:csh, rowIdx:crow };
        }
      }catch(e){ /* tab renamed or row gone — fall through to the scan */ }
    }
  }

  for (var t=0; t<DATA_TABS.length; t++){
    var sh = sheet_(DATA_TABS[t]);
    var last = sh.getLastRow();
    if (last < 2) continue;
    var ids = sh.getRange(2, COL['InvoiceID']+1, last-1, 1).getValues();
    for (var i=0;i<ids.length;i++){
      if (ids[i][0]===id){
        if (cache){ try { cache.put(key, DATA_TABS[t]+'|'+(i+2), 21600); } catch(e){} }
        return { sh:sh, rowIdx:i+2 };
      }
    }
  }
  return null;
}

/***** HELPERS *****/
function json(obj){
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function ss_(){ return SpreadsheetApp.getActiveSpreadsheet(); }
function sheet_(name){ var sh = ss_().getSheetByName(name); if(!sh) sh = ss_().insertSheet(name); return sh; }
function tabForType_(t){ return t==='install' ? INSTALLS_TAB : PRODUCTIONS_TAB; }

function ensureSheets_(){
  // Data tabs
  ensureDataTab_(PRODUCTIONS_TAB, ACCENT.production);
  ensureDataTab_(INSTALLS_TAB,    ACCENT.install);

  // Approved (combined billing view across BOTH data tabs)
  var ap = sheet_(APPROVED_TAB);
  if (ap.getLastRow()===0){
    ap.getRange('A1:I1').setValues([['InvoiceID','Type','Contractor','Job','PM','Amount','Invoice File','Status','Bill Ref']]);
    ap.getRange('A2').setFormula(approvedFormula_());
    styleApprovedTab_(ap);
  }
}

/* HOT PATH — runs on every submit and every list. It must only ENSURE the tab
 * exists with headers. The glossy theme is expensive (row banding, conditional
 * format rules and column widths over whole columns) and used to be re-applied on
 * every single submission. It now runs once at creation; use restyle() to
 * re-apply it on demand. */
/* The Approved tab is a live QUERY stacking both data tabs. The source range must
   span ALL of HEADERS — A..AD is 30 columns. If HEADERS grows again, widen this to
   match, or the trailing columns are silently dropped from the stack. The projected
   Col numbers are positional: Col2=InvoiceID, Col3=Status, Col27=BillRef. */
function approvedFormula_(){
  return "=IFERROR(QUERY({'"+PRODUCTIONS_TAB+"'!A2:AD;'"+INSTALLS_TAB+"'!A2:AD}, " +
         "\"select Col2,Col4,Col5,Col9,Col10,Col12,Col17,Col3,Col27 " +
         "where Col3='approved' or Col3='billed' order by Col1 desc\", 0), )";
}

/* HEADERS gains columns over time (the expense columns landed after launch). Rewrite
   the header row so an already-built sheet picks them up. Run from setup() only —
   it's a write per data tab, and the hot path must stay free of them. */
function ensureHeaders_(){
  DATA_TABS.forEach(function(name){
    sheet_(name).getRange(1,1,1,HEADERS.length).setValues([HEADERS]);
  });
}

function ensureDataTab_(name, accent){
  var sh = sheet_(name);
  if (sh.getLastRow()===0){
    sh.getRange(1,1,1,HEADERS.length).setValues([HEADERS]);
    styleDataTab_(sh, accent);
  }
  return sh;
}

/***** GLOSSY THEME *****/
function styleDataTab_(sh, accent){
  var cols = HEADERS.length;
  sh.setFrozenRows(1);
  sh.setFrozenColumns(2);                 // keep Timestamp + InvoiceID in view
  sh.setTabColor(accent);

  // header band
  var hdr = sh.getRange(1,1,1,cols);
  hdr.setBackground(accent).setFontColor('#FFFFFF').setFontWeight('bold').setFontSize(11)
     .setVerticalAlignment('middle').setHorizontalAlignment('left');
  sh.setRowHeight(1, 36);

  // zebra body banding (refresh)
  sh.getBandings().forEach(function(b){ b.remove(); });
  var maxRows = sh.getMaxRows();
  if (maxRows > 1){
    sh.getRange(2,1,maxRows-1,cols)
      .applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false);
  }

  // number / date formats (whole columns so appended rows inherit)
  sh.getRange('A:A').setNumberFormat('m/d/yyyy  h:mm');
  ['Amount','LaborAmount','ExpensesTotal'].forEach(function(h){
    sh.getRange(1, COL[h]+1, maxRows, 1).setNumberFormat('$#,##0.00');
  });
  [ 'ReviewedAt','EscalatedAt','BilledAt' ].forEach(function(h){
    sh.getRange(1, COL[h]+1, maxRows, 1).setNumberFormat('m/d/yyyy  h:mm');
  });
  // re-bold the header amount/date cells that the number-format pass left plain
  hdr.setBackground(accent).setFontColor('#FFFFFF').setFontWeight('bold');

  applyStatusColors_(sh);
  setColWidths_(sh);
}

function styleApprovedTab_(sh){
  var cols = 9;
  sh.setFrozenRows(1);
  sh.setTabColor(ACCENT.approved);
  var hdr = sh.getRange(1,1,1,cols);
  hdr.setBackground(ACCENT.approved).setFontColor('#FFFFFF').setFontWeight('bold').setFontSize(11)
     .setVerticalAlignment('middle');
  sh.setRowHeight(1, 36);
  sh.getBandings().forEach(function(b){ b.remove(); });
  var maxRows = sh.getMaxRows();
  if (maxRows > 1){
    sh.getRange(2,1,maxRows-1,cols).applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREEN, false, false);
  }
  sh.getRange(1,6,maxRows,1).setNumberFormat('$#,##0.00'); // Amount col F
  hdr.setBackground(ACCENT.approved).setFontColor('#FFFFFF').setFontWeight('bold');
  var widths = [150,90,150,180,120,110,220,100,140];
  widths.forEach(function(w,i){ sh.setColumnWidth(i+1, w); });
}

// Color the Status (and Type) columns by value — whole-column ranges so new rows inherit.
function applyStatusColors_(sh){
  var statusRange = sh.getRange('C:C');
  var typeRange   = sh.getRange('D:D');
  var mk = function(rng,val,bg,fg){
    return SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(val).setBackground(bg).setFontColor(fg).setBold(true)
      .setRanges([rng]).build();
  };
  sh.setConditionalFormatRules([
    mk(statusRange,'pending',  '#FDF3DF','#7A5B00'),
    mk(statusRange,'escalated','#FFE6CC','#8A4B00'),
    mk(statusRange,'approved', '#E6F5ED','#1B6B43'),
    mk(statusRange,'billed',   '#E9F1FA','#114A86'),
    mk(statusRange,'rejected', '#FBE9E5','#9B2C1A'),
    mk(typeRange,  'production','#E9F1FA','#114A86'),
    mk(typeRange,  'install',   '#E3F4F1','#0F6E63')
  ]);
}

function setColWidths_(sh){
  var w = {
    'Timestamp':150,'InvoiceID':155,'Status':100,'BillingType':95,'Contractor':150,
    'Company':140,'Email':210,'Phone':120,'Job':190,'PM':130,'EntryType':100,'Amount':110,
    'Ref/InvoiceNo':120,'Description':260,'LineItemsJSON':240,'Notes':220,
    'InvoiceFileURL':150,'ReceiptURLs':150,
    'ReviewedBy':115,'ReviewedAt':150,'ReviewNote':200,'EscalatedBy':115,'EscalatedAt':150,'EscalationNote':200,
    'BilledBy':110,'BilledAt':150,'BillRef':130,
    'LaborAmount':110,'ExpensesTotal':115,'ExpensesJSON':260
  };
  HEADERS.forEach(function(h){ if (w[h]) sh.setColumnWidth(COL[h]+1, w[h]); });
}

function rowToObj_(r){
  var o = {};
  HEADERS.forEach(function(h,i){ o[h]=r[i]; });
  return {
    id:o['InvoiceID'], status:o['Status'], billingType:o['BillingType']||'production',
    submitted: o['Timestamp'] ? new Date(o['Timestamp']).toISOString():'',
    contractor:o['Contractor'], company:o['Company'], email:o['Email'], phone:o['Phone'],
    job:o['Job'], pm:o['PM'], entryType:o['EntryType'],
    amount:Number(o['Amount'])||0, invoiceNo:o['Ref/InvoiceNo'], description:o['Description'],
    lineItems: o['LineItemsJSON'] ? safeParse_(o['LineItemsJSON']) : null,
    notes:o['Notes'], invoiceFileUrl:o['InvoiceFileURL'],
    receiptUrls: o['ReceiptURLs'] ? String(o['ReceiptURLs']).split(' ; ').filter(Boolean) : [],
    /* amount above is the grand total; these are the breakdown. Rows predating the
       itemised-expenses change have blank cells, so they read as labor-only. */
    laborAmount: o['LaborAmount']===''||o['LaborAmount']==null ? (Number(o['Amount'])||0) : (Number(o['LaborAmount'])||0),
    expensesTotal: Number(o['ExpensesTotal'])||0,
    expenses: o['ExpensesJSON'] ? (safeParse_(o['ExpensesJSON'])||[]) : [],
    /* One review stamp, not a stage-1/stage-2 chain: whoever approved or rejected it.
       `escalated` records who asked for a cross review, if anyone did. stage1/stage2 are
       kept as aliases so an older cached CRM bundle doesn't render blanks mid-rollout. */
    reviewed:{ by:o['ReviewedBy'], at: o['ReviewedAt']?new Date(o['ReviewedAt']).toISOString():'', note:o['ReviewNote'] },
    escalated:{ by:o['EscalatedBy'], at: o['EscalatedAt']?new Date(o['EscalatedAt']).toISOString():'', note:o['EscalationNote'] },
    stage1:{ by:o['ReviewedBy'], at: o['ReviewedAt']?new Date(o['ReviewedAt']).toISOString():'', note:o['ReviewNote'] },
    stage2:{ by:o['EscalatedBy'], at: o['EscalatedAt']?new Date(o['EscalatedAt']).toISOString():'', note:o['EscalationNote'] },
    billed:{ by:o['BilledBy'], at: o['BilledAt']?new Date(o['BilledAt']).toISOString():'', ref:o['BillRef'] }
  };
}
function safeParse_(s){ try{return JSON.parse(s);}catch(e){return null;} }

/* Resolve the Drive folder, cheaply.
 *
 * This used to run a getFoldersByName SEARCH and re-add all five reviewers as
 * viewers on EVERY call — five Drive permission writes per request, each firing a
 * "shared with you" email. getFolder_ runs for every attachment upload and again
 * for every file claimed on submit, so a two-file invoice meant ~15 permission
 * writes and a burst of notification mail. That was BOTH the slowness and the
 * email spam. Sharing now happens once, in setup(), via shareFolder_().
 *
 * Cached two ways: the id survives in ScriptProperties across executions, and
 * FOLDER_CACHE avoids repeat lookups within a single execution (submit claims
 * several files in a row). */
var FOLDER_CACHE = null;
function getFolder_(){
  if (FOLDER_CACHE) return FOLDER_CACHE;
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('folderId');
  if (id){
    try { FOLDER_CACHE = DriveApp.getFolderById(id); return FOLDER_CACHE; }
    catch(e){ /* deleted or stale id — fall through and re-resolve */ }
  }
  var it = DriveApp.getFoldersByName(DRIVE_FOLDER_NAME);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(DRIVE_FOLDER_NAME);
  props.setProperty('folderId', folder.getId());
  FOLDER_CACHE = folder;
  return folder;
}

/* Share the folder with the reviewers so they can open attachments (no public
 * links). Idempotent: only adds someone who isn't already on the folder, so
 * re-running setup() doesn't re-notify everyone. Run setup() again after editing
 * REVIEWERS — that is the ONLY place sharing should happen. */
function shareFolder_(){
  var folder = getFolder_();

  /* Per-person viewer grants are what make Google notify people. First the
     "shared with you" mail, and then — for as long as the grant exists — an
     ongoing "files were added to a folder shared with you" activity feed plus
     Drive Chat pings, fired every time an invoice drops attachments in here.
     None of that comes from this script; Drive generates it because the folder is
     explicitly shared. Domain link access gives the reviewers the same read
     access with NO per-user permission, so Drive has nobody to notify. */
  var domainOk = false;
  try {
    folder.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);
    domainOk = true;
  } catch(e){ domainOk = false; }

  if (!domainOk){
    /* Domain sharing refused — not a Workspace domain, or an admin policy blocks
       it. Fall back to per-person grants: reviewers losing access to invoice
       attachments is a worse outcome than some notification mail. */
    var have = {};
    folder.getViewers().forEach(function(u){ have[String(u.getEmail()).toLowerCase()] = 1; });
    folder.getEditors().forEach(function(u){ have[String(u.getEmail()).toLowerCase()] = 1; });
    try { var o = folder.getOwner(); if (o) have[String(o.getEmail()).toLowerCase()] = 1; } catch(e){}
    var added = 0;
    Object.keys(REVIEWERS).forEach(function(em){
      if (!have[em]){ try { folder.addViewer(em); added++; } catch(e){} }
    });
    return 'DOMAIN SHARING UNAVAILABLE — fell back to per-person grants (added ' + added +
           '). Notifications will continue; each reviewer must mute Drive notifications themselves.';
  }

  /* Drop the individual grants earlier versions left behind. While they exist,
     those people keep getting the activity notifications this is meant to end. */
  var present = {};
  folder.getViewers().forEach(function(u){ present[String(u.getEmail()).toLowerCase()] = 1; });
  var removed = 0;
  Object.keys(REVIEWERS).forEach(function(em){
    if (present[em]){ try { folder.removeViewer(em); removed++; } catch(e){} }
  });
  return 'Domain link access set; removed ' + removed + ' individual grant(s). No more Drive notifications.';
}
function writeFile_(folder, f, baseName){
  var b64 = f.b64.indexOf(',')>=0 ? f.b64.split(',')[1] : f.b64; // tolerate data URLs
  var bytes = Utilities.base64Decode(b64);
  if (bytes.length > MAX_FILE_MB*1024*1024) throw new Error('File exceeds '+MAX_FILE_MB+'MB: '+(f.name||''));
  var ext = (f.name && f.name.indexOf('.')>=0) ? f.name.slice(f.name.lastIndexOf('.')) : '';
  var blob = Utilities.newBlob(bytes, f.type||'application/octet-stream', baseName+ext);
  return folder.createFile(blob);
}
function saveFile_(folder, f, baseName){ return writeFile_(folder, f, baseName).getUrl(); }

/* Build a Drive view link from a file id WITHOUT a Drive round trip. getUrl()
   needs the File object, and fetching it costs an API call per attachment on the
   submit path — exactly the cost we're removing. This link form is stable and
   keeps working after the file is later renamed, because it's keyed on the id. */
function driveUrl_(id){ return 'https://drive.google.com/file/d/' + id + '/view'; }

/* Claim a file that uploadFile already put in Drive.
 *
 * FAST PATH (the normal one): uploadFile recorded this id in the script cache, so
 * we know we minted it without asking Drive. Build the link from the id and queue
 * the rename for later — zero Drive calls, which is what keeps submit responsive.
 *
 * SLOW PATH: cache miss — expired, evicted, or a submit long after the upload.
 * Fall back to the fully verified route (fetch the file, confirm it is still named
 * PENDING-* and really lives in our folder). The cache is only ever a speed-up; it
 * is never the security boundary, so a caller still cannot get an arbitrary file
 * id renamed and linked into an invoice row. */
function claimFile_(fileId, baseName){
  var id = String(fileId||''); if (!id) return '';
  var known = false;
  try { known = !!CacheService.getScriptCache().get('pend_'+id); } catch(e){}
  if (known){
    queueRename_(id, baseName);
    return driveUrl_(id);
  }
  return adoptFile_(id, baseName);
}

/* Renaming PENDING-xxxx to the invoice id is cosmetic — it keeps the Drive folder
   readable. It is not worth a Drive round trip while the contractor watches a
   spinner, so record the intent and let sweepRenames_() do it off the hot path. */
function queueRename_(fileId, baseName){
  try { PropertiesService.getScriptProperties().setProperty('rn_'+fileId, baseName); }catch(e){}
}

/* Bounded, best-effort rename sweep. Called from uploadFile (background) and from
   setup(); never from submit. A cosmetic filename must never break a request, so
   every failure just drops the entry — the row's link is id-based and unaffected. */
function sweepRenames_(max){
  var props = PropertiesService.getScriptProperties(), keys, done = 0;
  try { keys = props.getKeys(); } catch(e){ return 0; }
  for (var i=0; i<keys.length && done<max; i++){
    if (keys[i].indexOf('rn_') !== 0) continue;
    var id = keys[i].slice(3), base = props.getProperty(keys[i]);
    try{
      var f  = DriveApp.getFileById(id);
      var nm = f.getName();
      if (nm.indexOf('PENDING-') === 0){
        var ext = nm.indexOf('.')>=0 ? nm.slice(nm.lastIndexOf('.')) : '';
        f.setName(base + ext);
      }
    }catch(e){ /* file deleted — drop the entry below */ }
    try { props.deleteProperty(keys[i]); } catch(e){}
    done++;
  }
  return done;
}

/* Run from the editor to flush the whole rename backlog at once. */
function sweepRenames(){ Logger.log('Renamed ' + sweepRenames_(200) + ' file(s).'); }

/* A file uploaded as-you-go landed as PENDING-xxxx while the contractor was still
   filling out the form. Once they actually submit, rename it to the invoice ID so
   the Drive folder stays readable — and so anything still called PENDING-* is
   obviously an abandoned draft you can sweep up. */
function adoptFile_(fileId, baseName){
  try{
    var file = DriveApp.getFileById(String(fileId));
    /* Only ever touch files THIS flow created. Without these two checks a caller
       could hand us any file id the script account can reach and have it renamed
       and linked into an invoice row. */
    if (file.getName().indexOf('PENDING-') !== 0) return '';
    var target = getFolder_().getId(), inFolder = false, parents = file.getParents();
    while (parents.hasNext()){ if (parents.next().getId() === target){ inFolder = true; break; } }
    if (!inFolder) return '';

    var nm = file.getName();
    var ext = nm.indexOf('.')>=0 ? nm.slice(nm.lastIndexOf('.')) : '';
    file.setName(baseName+ext);
    return file.getUrl();
  }catch(e){ return ''; }
}

/***** RUN ONCE *****/
function setup(){
  ensureSheets_();
  ensureHeaders_();                                              // pick up columns added since launch
  sheet_(APPROVED_TAB).getRange('A2').setFormula(approvedFormula_());  // widen the QUERY to match
  restyle();                    // style existing tabs too, not just freshly created ones
  var sharing = shareFolder_();  // the ONLY place the folder gets shared — see getFolder_()
  var renamed = sweepRenames_(200);
  Logger.log('Setup complete. Tabs built + styled.\nDrive sharing: ' + sharing +
             '\nPENDING files renamed: ' + renamed +
             '\nNow deploy as a Web App (Execute as: Me, Access: Anyone).');
}

// Re-apply the glossy theme any time (safe to run repeatedly).
function restyle(){
  styleDataTab_(sheet_(PRODUCTIONS_TAB), ACCENT.production);
  styleDataTab_(sheet_(INSTALLS_TAB),    ACCENT.install);
  styleApprovedTab_(sheet_(APPROVED_TAB));
}
