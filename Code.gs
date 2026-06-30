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
 *      Copy the /exec URL. Paste it into index.html, install.html, review.html (API const).
 *
 * TWO FORMS, TWO TABS, TWO APPROVERS:
 *   - index.html   -> billingType 'production' -> "Productions" tab -> Tony approves
 *   - install.html -> billingType 'install'    -> "Installs"    tab -> Gabe approves
 *   Dash (owner) can act on either. Taryn & Accounting (controllers) bill both.
 *
 * CORS NOTE (do not "fix" this):
 *   Apps Script web apps cannot return CORS headers. The HTML clients POST
 *   with a TEXT/PLAIN body and NO custom headers, which is a "simple" request
 *   that skips the CORS preflight. The auth token travels in the body, never
 *   in an Authorization header. Keep it that way or cross-origin calls break.
 *************************************************************************/

/***** CONFIG — REVIEWERS *****/
/* role: owner = MASTER ADMIN (Dash) — sees everything and can do anything:
 *       approve / reject / escalate / reopen / bill, on either billing type, at any stage.
 * approver is scoped: 'production' (Tony) or 'install' (Gabe) — each sees only their type.
 * controller bills both types once approved. */
const REVIEWERS = {
  'dash@limitlesslightsandsound.com'       : { role: 'owner',      name: 'Dash' },
  'tony@limitlesslightsandsound.com'       : { role: 'approver',   name: 'Tony',       scope: 'production' },
  'gabe@limitlesslightsandsound.com'       : { role: 'approver',   name: 'Gabe',       scope: 'install' },
  'taryn@limitlesslightsandsound.com'      : { role: 'controller', name: 'Taryn' },
  'accounting@limitlesslightsandsound.com' : { role: 'controller', name: 'Accounting' }
};

const DRIVE_FOLDER_NAME = 'Limitless — Contractor Invoices';
const CODE_TTL_MIN      = 10;     // login code validity
const SESSION_TTL_DAYS  = 30;     // how long a login lasts
const MAX_CODE_ATTEMPTS = 5;      // brute-force guard
const MAX_FILE_MB       = 10;     // per uploaded file

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

const HEADERS = ['Timestamp','InvoiceID','Status','BillingType','Contractor','Company','Email','Phone',
  'Job','PM','EntryType','Amount','Ref/InvoiceNo','Description','LineItemsJSON',
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
  var sess = { email:email, role:who.role, name:who.name, scope: who.scope||'', exp: Date.now()+SESSION_TTL_DAYS*86400000 };
  props.setProperty('sess_'+token, JSON.stringify(sess));
  return json({ ok:true, token:token, role:who.role, name:who.name, scope: who.scope||'', email:email });
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
  var billingType = (b.billingType==='install') ? 'install' : 'production';
  var id = 'INV-' + (billingType==='install'?'INST-':'') +
           Utilities.formatDate(new Date(),'GMT','yyyyMMdd') + '-' +
           Math.random().toString(36).slice(2,6).toUpperCase();

  var entryType = b.entryType || 'hours';   // hours | file
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

  sheet_(tabForType_(billingType)).appendRow(row);
  return json({ ok:true, id:id });
}

/***** LIST (token) *****/
function listInvoices(b){
  var s = session(b.token);
  if (!s) return json({ ok:false, error:'Not signed in.' });
  ensureSheets_();

  var rows;
  if (s.role === 'owner'){
    rows = readData_(PRODUCTIONS_TAB).concat(readData_(INSTALLS_TAB));
  } else if (s.role === 'approver'){
    rows = readData_(s.scope === 'install' ? INSTALLS_TAB : PRODUCTIONS_TAB);
  } else { // controller — billable pipeline across both types
    rows = readData_(PRODUCTIONS_TAB).concat(readData_(INSTALLS_TAB))
             .filter(function(x){ return x.status==='approved' || x.status==='billed'; });
  }
  rows.sort(function(a,c){ return String(c.submitted||'').localeCompare(String(a.submitted||'')); }); // newest first
  return json({ ok:true, role:s.role, name:s.name, scope:s.scope||'', invoices: rows });
}

function readData_(tab){
  var sh = sheet_(tab);
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2,1,last-1,HEADERS.length).getValues().map(rowToObj_);
}

/***** ACT (token) *****/
function actOnInvoice(b){
  var s = session(b.token);
  if (!s) return json({ ok:false, error:'Not signed in.' });
  // doPost routes on body.action ('act'); the verb (approve/escalate/reject/billed/reopen) is in b.verb
  var id = b.id, act = b.verb, note = b.note||'', billRef = b.billRef||'';
  if (!id || !act) return json({ ok:false, error:'Missing id or action.' });

  var found = findInvoice_(id);
  if (!found) return json({ ok:false, error:'Invoice not found.' });
  var sh = found.sh, rowIdx = found.rowIdx;

  var billingType = sh.getRange(rowIdx, COL['BillingType']+1).getValue() || 'production';
  // approvers are scoped to their billing type
  if (s.role === 'approver' && s.scope && billingType !== s.scope){
    return json({ ok:false, error:'That item is outside your queue.' });
  }

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
    // controllers bill; owner (master admin) can also bill
    if ((s.role==='controller' || s.role==='owner') && status==='approved'){
      sh.getRange(rowIdx, COL['BilledBy']+1).setValue(s.name);
      sh.getRange(rowIdx, COL['BilledAt']+1).setValue(now);
      sh.getRange(rowIdx, COL['BillRef']+1).setValue(billRef);
      setStatus('billed'); allowed=true;
    }
  } else if (act==='reopen'){
    if (s.role==='owner'){ setStatus('pending'); allowed=true; } // send back to the approver
  }

  if (!allowed) return json({ ok:false, error:'Not permitted for your role at this stage.' });
  return json({ ok:true });
}

// Search both data tabs for an InvoiceID. Returns {sh, rowIdx} (1-based row) or null.
function findInvoice_(id){
  for (var t=0; t<DATA_TABS.length; t++){
    var sh = sheet_(DATA_TABS[t]);
    var last = sh.getLastRow();
    if (last < 2) continue;
    var ids = sh.getRange(2, COL['InvoiceID']+1, last-1, 1).getValues();
    for (var i=0;i<ids.length;i++){ if (ids[i][0]===id){ return { sh:sh, rowIdx:i+2 }; } }
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
    // {Productions; Installs} stacked, then projected. Col order matches HEADERS (1-based): B,D,E,I,J,L,Q,C,AA
    ap.getRange('A2').setFormula(
      "=IFERROR(QUERY({'"+PRODUCTIONS_TAB+"'!A2:AA;'"+INSTALLS_TAB+"'!A2:AA}, " +
      "\"select Col2,Col4,Col5,Col9,Col10,Col12,Col17,Col3,Col27 where Col3='approved' or Col3='billed' order by Col1 desc\", 0), )"
    );
  }
  styleApprovedTab_(ap);
}

function ensureDataTab_(name, accent){
  var sh = sheet_(name);
  if (sh.getLastRow()===0){
    sh.getRange(1,1,1,HEADERS.length).setValues([HEADERS]);
  }
  styleDataTab_(sh, accent);
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
  sh.getRange(1, COL['Amount']+1,   maxRows, 1).setNumberFormat('$#,##0.00');
  [ 'Stage1At','Stage2At','BilledAt' ].forEach(function(h){
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
    'Stage1By':110,'Stage1At':150,'Stage1Note':200,'Stage2By':110,'Stage2At':150,'Stage2Note':200,
    'BilledBy':110,'BilledAt':150,'BillRef':130
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
    stage1:{ by:o['Stage1By'], at: o['Stage1At']?new Date(o['Stage1At']).toISOString():'', note:o['Stage1Note'] },
    stage2:{ by:o['Stage2By'], at: o['Stage2At']?new Date(o['Stage2At']).toISOString():'', note:o['Stage2Note'] },
    billed:{ by:o['BilledBy'], at: o['BilledAt']?new Date(o['BilledAt']).toISOString():'', ref:o['BillRef'] }
  };
}
function safeParse_(s){ try{return JSON.parse(s);}catch(e){return null;} }

function getFolder_(){
  var it = DriveApp.getFoldersByName(DRIVE_FOLDER_NAME);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(DRIVE_FOLDER_NAME);
  // share with reviewers so they can open invoice files (no public links)
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
  Logger.log('Setup complete. Tabs built + styled. Now deploy as a Web App (Execute as: Me, Access: Anyone).');
}

// Re-apply the glossy theme any time (safe to run repeatedly).
function restyle(){
  styleDataTab_(sheet_(PRODUCTIONS_TAB), ACCENT.production);
  styleDataTab_(sheet_(INSTALLS_TAB),    ACCENT.install);
  styleApprovedTab_(sheet_(APPROVED_TAB));
}
