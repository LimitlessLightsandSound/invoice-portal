/*************************************************************************
 * LIMITLESS LIGHTS & SOUND — Contractor Invoice Backend (Google Apps Script)
 * -----------------------------------------------------------------------
 * Container-bound to a Google Sheet. Deploy as a Web App.
 *
 * SETUP (full steps in SETUP.md):
 *   1. Create a Google Sheet. Extensions > Apps Script. Paste this file.
 *   2. Edit the THREE emails in REVIEWERS below.
 *   3. Run setup() once (authorize when prompted).
 *   4. Deploy > New deployment > Web app:
 *        Execute as: Me
 *        Who has access: ANYONE   <-- required so contractors can submit
 *      Copy the /exec URL. Paste it into index.html and review.html (API const).
 *
 * CORS NOTE (do not "fix" this):
 *   Apps Script web apps cannot return CORS headers. The HTML clients POST
 *   with a TEXT/PLAIN body and NO custom headers, which is a "simple" request
 *   that skips the CORS preflight. The auth token travels in the body, never
 *   in an Authorization header. Keep it that way or cross-origin calls break.
 *************************************************************************/

/***** CONFIG — EDIT THESE THREE EMAILS *****/
const REVIEWERS = {
  'dash@limitlesslightsandsound.com'      : { role: 'owner',      name: 'Dash' },
  'tony@limitlesslightsandsound.com'      : { role: 'approver',   name: 'Tony' },
  'controller@limitlesslightsandsound.com': { role: 'controller', name: 'Accountant' }
};

const DRIVE_FOLDER_NAME = 'Limitless — Contractor Invoices';
const CODE_TTL_MIN      = 10;     // login code validity
const SESSION_TTL_DAYS  = 30;     // how long a login lasts
const MAX_CODE_ATTEMPTS = 5;      // brute-force guard
const MAX_FILE_MB       = 10;     // per uploaded file

const INVOICES_TAB = 'Invoices';
const APPROVED_TAB = 'Approved';
const HEADERS = ['Timestamp','InvoiceID','Status','Contractor','Company','Email','Phone',
  'Job','PM','WorkDates','EntryType','Amount','Ref/InvoiceNo','Description','LineItemsJSON',
  'Notes','InvoiceFileURL','ReceiptURLs',
  'Stage1By','Stage1At','Stage1Note','Stage2By','Stage2At','Stage2Note',
  'BilledBy','BilledAt','BillRef'];
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
      case 'requestCode': return requestCode(body);
      case 'verifyCode' : return verifyCode(body);
      case 'submit'     : return submitInvoice(body);   // PUBLIC (no token)
      case 'list'       : return listInvoices(body);    // token required
      case 'act'        : return actOnInvoice(body);    // token required
      default           : return json({ ok:false, error:'Unknown action' });
    }
  }catch(err){
    return json({ ok:false, error:String(err && err.message || err) });
  }
}

/***** AUTH *****/
function requestCode(b){
  var email = String(b.email||'').trim().toLowerCase();
  if (!REVIEWERS[email]) return json({ ok:false, error:'That email is not an authorized reviewer.' });
  var code = String(Math.floor(100000 + Math.random()*900000));
  var rec  = { code:code, exp: Date.now()+CODE_TTL_MIN*60000, tries:0 };
  PropertiesService.getScriptProperties().setProperty('code_'+email, JSON.stringify(rec));
  MailApp.sendEmail(
    email,
    'Your Limitless invoice portal code: ' + code,
    'Your one-time sign-in code is ' + code + '\n\nIt expires in ' + CODE_TTL_MIN + ' minutes.\n\n— Limitless Lights & Sound'
  );
  return json({ ok:true });
}

function verifyCode(b){
  var email = String(b.email||'').trim().toLowerCase();
  var code  = String(b.code||'').trim();
  var props = PropertiesService.getScriptProperties();
  var raw   = props.getProperty('code_'+email);
  if (!raw) return json({ ok:false, error:'No code requested. Request a new one.' });
  var rec = JSON.parse(raw);
  if (Date.now() > rec.exp){ props.deleteProperty('code_'+email); return json({ ok:false, error:'Code expired. Request a new one.' }); }
  if (rec.tries >= MAX_CODE_ATTEMPTS){ props.deleteProperty('code_'+email); return json({ ok:false, error:'Too many attempts. Request a new code.' }); }
  if (code !== rec.code){
    rec.tries++; props.setProperty('code_'+email, JSON.stringify(rec));
    return json({ ok:false, error:'Incorrect code.' });
  }
  props.deleteProperty('code_'+email);
  var who = REVIEWERS[email];
  var token = Utilities.getUuid();
  var sess = { email:email, role:who.role, name:who.name, exp: Date.now()+SESSION_TTL_DAYS*86400000 };
  props.setProperty('sess_'+token, JSON.stringify(sess));
  return json({ ok:true, token:token, role:who.role, name:who.name, email:email });
}

function session(token){
  if (!token) return null;
  var raw = PropertiesService.getScriptProperties().getProperty('sess_'+token);
  if (!raw) return null;
  var s = JSON.parse(raw);
  if (Date.now() > s.exp){ PropertiesService.getScriptProperties().deleteProperty('sess_'+token); return null; }
  return s;
}

/***** SUBMIT (public) *****/
function submitInvoice(b){
  ensureSheets_();
  var id = 'INV-' + Utilities.formatDate(new Date(),'GMT','yyyyMMdd') + '-' +
           Math.random().toString(36).slice(2,6).toUpperCase();

  // amount
  var entryType = b.entryType || 'file';   // file | hours | flat
  var amount = Number(b.amount)||0;
  var lineItemsJson = b.lineItems ? JSON.stringify(b.lineItems) : '';

  // files -> Drive
  var folder = getFolder_();
  var invoiceUrl = '';
  if (b.invoiceFile && b.invoiceFile.b64){ invoiceUrl = saveFile_(folder, b.invoiceFile, id+'_invoice'); }
  var receiptUrls = [];
  if (Array.isArray(b.receipts)){
    b.receipts.forEach(function(r,i){ if(r && r.b64) receiptUrls.push(saveFile_(folder, r, id+'_receipt'+(i+1))); });
  }

  var row = new Array(HEADERS.length).fill('');
  row[COL['Timestamp']]     = new Date();
  row[COL['InvoiceID']]     = id;
  row[COL['Status']]        = 'pending';
  row[COL['Contractor']]    = b.contractor||'';
  row[COL['Company']]       = b.company||'';
  row[COL['Email']]         = b.email||'';
  row[COL['Phone']]         = b.phone||'';
  row[COL['Job']]           = b.job||'';
  row[COL['PM']]            = b.pm||'';
  row[COL['WorkDates']]     = b.workDate||'';
  row[COL['EntryType']]     = entryType;
  row[COL['Amount']]        = amount;
  row[COL['Ref/InvoiceNo']] = b.invoiceNo||'';
  row[COL['Description']]   = b.description||'';
  row[COL['LineItemsJSON']] = lineItemsJson;
  row[COL['Notes']]         = b.notes||'';
  row[COL['InvoiceFileURL']]= invoiceUrl;
  row[COL['ReceiptURLs']]   = receiptUrls.join(' ; ');

  sheet_(INVOICES_TAB).appendRow(row);
  return json({ ok:true, id:id });
}

/***** LIST (token) *****/
function listInvoices(b){
  var s = session(b.token);
  if (!s) return json({ ok:false, error:'Not signed in.' });
  ensureSheets_();
  var sh = sheet_(INVOICES_TAB);
  var last = sh.getLastRow();
  var data = last>1 ? sh.getRange(2,1,last-1,HEADERS.length).getValues() : [];
  var out = data.map(rowToObj_).reverse();   // newest first

  // controller only needs the approved/billed pipeline
  if (s.role === 'controller'){
    out = out.filter(function(x){ return x.status==='approved' || x.status==='billed'; });
  }
  return json({ ok:true, role:s.role, name:s.name, invoices: out });
}

/***** ACT (token) *****/
function actOnInvoice(b){
  var s = session(b.token);
  if (!s) return json({ ok:false, error:'Not signed in.' });
  // NOTE: doPost routes on body.action ('act'); the verb (approve/escalate/reject/billed/reopen) is in b.verb
  var id = b.id, act = b.verb, note = b.note||'', billRef = b.billRef||'';
  if (!id || !act) return json({ ok:false, error:'Missing id or action.' });

  var sh = sheet_(INVOICES_TAB);
  var last = sh.getLastRow();
  var ids = sh.getRange(2, COL['InvoiceID']+1, Math.max(0,last-1), 1).getValues();
  var rowIdx = -1;
  for (var i=0;i<ids.length;i++){ if (ids[i][0]===id){ rowIdx = i+2; break; } }
  if (rowIdx<0) return json({ ok:false, error:'Invoice not found.' });

  var status = sh.getRange(rowIdx, COL['Status']+1).getValue();
  var now = new Date();
  var stamp = function(byCol,atCol,noteCol){
    sh.getRange(rowIdx, byCol+1).setValue(s.name);
    sh.getRange(rowIdx, atCol+1).setValue(now);
    if (noteCol!=null) sh.getRange(rowIdx, noteCol+1).setValue(note);
  };
  var setStatus = function(v){ sh.getRange(rowIdx, COL['Status']+1).setValue(v); };

  // permission matrix
  var allowed = false;
  if (act==='approve'){
    if (s.role==='approver' && status==='pending'){ stamp(COL['Stage1By'],COL['Stage1At'],COL['Stage1Note']); setStatus('approved'); allowed=true; }
    else if (s.role==='owner'){ // owner can approve at any stage
      if (status==='escalated' || status==='pending'){ stamp(COL['Stage2By'],COL['Stage2At'],COL['Stage2Note']); setStatus('approved'); allowed=true; }
    }
  } else if (act==='escalate'){
    if ((s.role==='approver' || s.role==='owner') && status==='pending'){ stamp(COL['Stage1By'],COL['Stage1At'],COL['Stage1Note']); setStatus('escalated'); allowed=true; }
  } else if (act==='reject'){
    if (s.role==='approver' && status==='pending'){ stamp(COL['Stage1By'],COL['Stage1At'],COL['Stage1Note']); setStatus('rejected'); allowed=true; }
    else if (s.role==='owner' && (status==='pending'||status==='escalated'||status==='approved')){ stamp(COL['Stage2By'],COL['Stage2At'],COL['Stage2Note']); setStatus('rejected'); allowed=true; }
  } else if (act==='billed'){
    if (s.role==='controller' && status==='approved'){
      sh.getRange(rowIdx, COL['BilledBy']+1).setValue(s.name);
      sh.getRange(rowIdx, COL['BilledAt']+1).setValue(now);
      sh.getRange(rowIdx, COL['BillRef']+1).setValue(billRef);
      setStatus('billed'); allowed=true;
    }
  } else if (act==='reopen'){
    if (s.role==='owner'){ setStatus('pending'); allowed=true; } // send back to Tony
  }

  if (!allowed) return json({ ok:false, error:'Not permitted for your role at this stage.' });
  return json({ ok:true });
}

/***** HELPERS *****/
function json(obj){
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function ss_(){ return SpreadsheetApp.getActiveSpreadsheet(); }
function sheet_(name){ var sh = ss_().getSheetByName(name); if(!sh) sh = ss_().insertSheet(name); return sh; }

function ensureSheets_(){
  var sh = sheet_(INVOICES_TAB);
  if (sh.getLastRow()===0){ sh.getRange(1,1,1,HEADERS.length).setValues([HEADERS]); sh.setFrozenRows(1); sh.getRange(1,1,1,HEADERS.length).setFontWeight('bold'); }
  var ap = sheet_(APPROVED_TAB);
  if (ap.getLastRow()===0){
    ap.getRange('A1:H1').setValues([['InvoiceID','Contractor','Job','PM','Amount','Invoice File','Status','Bill Ref']]);
    ap.getRange(1,1,1,8).setFontWeight('bold'); ap.setFrozenRows(1);
    // Auto-updating view of the approved/billed pipeline. Column letters map to the Invoices range.
    ap.getRange('A2').setFormula(
      "=IFERROR(QUERY('"+INVOICES_TAB+"'!A2:AA, \"select B,D,H,I,L,Q,C,AA where C='approved' or C='billed' order by A desc\", 0), )"
    );
  }
}
function rowToObj_(r){
  var o = {};
  HEADERS.forEach(function(h,i){ o[h]=r[i]; });
  // normalize for the client
  return {
    id:o['InvoiceID'], status:o['Status'], submitted: o['Timestamp'] ? new Date(o['Timestamp']).toISOString():'',
    contractor:o['Contractor'], company:o['Company'], email:o['Email'], phone:o['Phone'],
    job:o['Job'], pm:o['PM'], workDate:o['WorkDates'], entryType:o['EntryType'],
    amount:Number(o['Amount'])||0, invoiceNo:o['Ref/InvoiceNo'], description:o['Description'],
    lineItems: o['LineItemsJSON'] ? safeParse_(o['LineItemsJSON']) : null,
    notes:o['Notes'], invoiceFileUrl:o['InvoiceFileURL'],
    receiptUrls: o['ReceiptURLs'] ? String(o['ReceiptURLs']).split(' ; ').filter(Boolean) : [],
    stage1:{ by:o['Stage1By'], at: o['Stage1At']?new Date(o['Stage1At']).toISOString():'', note:o['Stage1Note'] },
    stage2:{ by:o['Stage2By'], at: o['Stage2At']?new Date(o['Stage2At']).toISOString():'', note:o['Stage2Note'] },
    billed:{ by:o['BilledBy'], at: o['BilledAt']?new Date(o['BilledAt']).toISOString():'', ref:o['BillRef'] }
  };
}
function safeParse_(s){ try{return JSON.parse(s);}catch(e){return null;} }

function getFolder_(){
  var it = DriveApp.getFoldersByName(DRIVE_FOLDER_NAME);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(DRIVE_FOLDER_NAME);
  // share with the three reviewers so they can open invoice files (no public links)
  Object.keys(REVIEWERS).forEach(function(em){
    try{ folder.addViewer(em); }catch(e){}
  });
  return folder;
}
function saveFile_(folder, f, baseName){
  var b64 = f.b64.indexOf(',')>=0 ? f.b64.split(',')[1] : f.b64; // tolerate data URLs
  var bytes = Utilities.base64Decode(b64);
  if (bytes.length > MAX_FILE_MB*1024*1024) throw new Error('File exceeds '+MAX_FILE_MB+'MB: '+(f.name||''));
  var ext = (f.name && f.name.indexOf('.')>=0) ? f.name.slice(f.name.lastIndexOf('.')) : '';
  var blob = Utilities.newBlob(bytes, f.type||'application/octet-stream', baseName+ext);
  var file = folder.createFile(blob);
  return file.getUrl();
}

/***** RUN ONCE *****/
function setup(){
  ensureSheets_();
  getFolder_();
  Logger.log('Setup complete. Now deploy as a Web App (Execute as: Me, Access: Anyone).');
}
