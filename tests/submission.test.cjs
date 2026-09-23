const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

for (const file of ['index.html', 'install.html']) {
  function form(t, response = { ok: true, id: 'INV-TEST', emailSent: true }) {
    const requests = [];
    const dom = new JSDOM(read(file), { runScripts: 'dangerously', beforeParse(w) {
      w.scrollTo = () => {};
      w.fetch = async (_url, init) => { requests.push(JSON.parse(init.body)); return { json: async () => response }; };
    }});
    t.after(() => dom.window.close());
    const w = dom.window, d = w.document;
    for (const [name, value] of Object.entries({contractor:'Test Contractor', email:'contractor@example.com', job:'Multi-day show', pm:'Dash Speer'})) d.querySelector(`[name="${name}"]`).value = value;
    for (const [name,value] of Object.entries({date:'2026-09-23',desc:'Show day',hrs:'8',rate:'50'})) d.querySelector('.li-'+name).value = value;
    return {w,d,requests};
  }
  test(file+': Enter is blocked in invoice fields but buttons and notes retain keyboard behavior', t => {
    const {w,d,requests} = form(t);
    for (const field of d.querySelectorAll('input:not([type=file])')) {
      const event = new w.KeyboardEvent('keydown', {key:'Enter', bubbles:true, cancelable:true});
      field.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true);
    }
    for (const selector of ['textarea','#submitBtn']) {
      const event = new w.KeyboardEvent('keydown', {key:'Enter', bubbles:true, cancelable:true});
      d.querySelector(selector).dispatchEvent(event);
      assert.equal(event.defaultPrevented, false);
    }
    assert.equal(requests.length, 0);
  });
  test(file+': copy preserves fields and OT, recalculates totals, and rows edit independently', t => {
    const {w,d} = form(t);
    const toggle = d.querySelector('.li-ot-toggle');
    if (toggle) { toggle.checked = true; d.querySelector('.li-ot').value = '2'; toggle.dispatchEvent(new w.Event('change')); }
    d.querySelector('.copy-line').click();
    const rows = d.querySelectorAll('#lineItems .line');
    assert.equal(rows.length,2);
    for (const field of ['date','desc','hrs','rate']) assert.equal(rows[1].querySelector('.li-'+field).value, rows[0].querySelector('.li-'+field).value);
    if(toggle) {
      assert.equal(rows[1].querySelector('.li-ot-toggle').checked,true);
      assert.equal(rows[1].querySelector('.li-ot').value,'2');
      assert.equal(rows[1].querySelector('.li-ot-cell').classList.contains('off'),false);
    }
    assert.equal(d.querySelector('#hoursTotal').textContent,toggle?'$1,100.00':'$800.00');
    rows[1].querySelector('.li-hrs').value='4';
    rows[1].querySelector('.li-hrs').dispatchEvent(new w.Event('input'));
    assert.equal(rows[0].querySelector('.li-hrs').value,'8');
    rows[1].querySelector('.del').click();
    assert.equal(d.querySelectorAll('#lineItems .line').length,1);
  });
  for(const sent of [true,false,undefined]) test(file+': explicit submit succeeds with email status '+sent, async t => {
    const {d,requests} = form(t,{ok:true,id:'INV-TEST',emailSent:sent});
    d.querySelector('#submitBtn').click();
    d.querySelector('#submitBtn').click();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(requests.length,1);
    assert.equal(requests[0].action,'submit');
    assert.equal(d.querySelector('#done').classList.contains('show'),true);
    assert.match(d.querySelector('#emailOut').textContent,sent ? /sent to contractor@example.com/ : /saved.*not sent/);
  });
}

function backend({mailFails=false,writeFails=false,configured=true}={}) {
  const events=[], rows=[], emails=[];
  const context=vm.createContext({PropertiesService:{getScriptProperties:()=>({getProperty:()=>configured?'configured':null})},UrlFetchApp:{fetch(_url,options){const message=JSON.parse(options.payload);events.push('mail');if(mailFails) throw Error('quota');emails.push(message);return {getResponseCode:()=>200,getContentText:()=>'{"ok":true}'};}},console:{error(){}}, Utilities:{formatDate:()=> '20260923'}, MailApp:{sendEmail(email){events.push('mail'); if(mailFails) throw Error('quota'); emails.push(email);}}});
  vm.runInContext(read('Code.gs'),context);
  context.ensureSheets_=()=>{};
  context.sheet_=()=>({appendRow(row){events.push('saved');if(writeFails) throw Error('write failed');rows.push(row);}});
  context.json=value=>value;
  return {context,events,rows,emails};
}
const input={billingType:'production',entryType:'hours',contractor:'Test Contractor',email:'contractor@example.com',job:'Multi-day show',pm:'Test PM',laborAmount:550,
  lineItems:[{date:'2026-09-23',desc:'Show day',hours:8,otHours:2,rate:50,total:550}],expenses:[{category:'Parking',amount:20,desc:'Venue parking'}],notes:'Thank you'};
test('saves invoice before sending a single itemized copy to the contractor',()=>{
  const {context,events,emails}=backend();
  const result=context.submitInvoice(input);
  assert.equal(result.ok,true);assert.equal(result.emailSent,true);
  assert.deepEqual(events,['saved','mail']);assert.equal(emails.length,1);
  assert.equal(emails[0].to,input.email);
  for(const text of [result.id,'Multi-day show','Show day','OT: 2 hrs @ $75.00/hr','Parking','Invoice total: $570.00','Thank you']) assert.ok(emails[0].body.includes(text),text);
});
test('mail failure reports saved success, never a failed invoice submission',()=>{
  const {context,rows}=backend({mailFails:true});const result=context.submitInvoice(input);
  assert.equal(result.ok,true);assert.equal(result.emailSent,false);assert.equal(rows.length,1);
});
test('a failed write never sends a confirmation',()=>{
  const {context,emails}=backend({writeFails:true});
  assert.throws(()=>context.submitInvoice(input),/write failed/);assert.equal(emails.length,0);
});
test('does not allow multiple email recipients on a public submission',()=>{
  const {context,emails}=backend();
  const result=context.submitInvoice({...input,email:'a@example.com,b@example.com'});
  assert.equal(result.emailSent,false);assert.equal(emails.length,0);
});

test('never falls back to Dash when the Accounting mail service is not configured',()=>{
  const {context,emails,rows}=backend({configured:false});
  const result=context.submitInvoice(input);
  assert.equal(result.ok,true);assert.equal(result.emailSent,false);
  assert.equal(rows.length,1);assert.equal(emails.length,0);
});

function mailer({sender='accounting@limitlesslightsandsound.com'}={}) {
  const sent=[], cache=new Map();
  const context=vm.createContext({console:{error(){}},Session:{getEffectiveUser:()=>({getEmail:()=>sender})},
    PropertiesService:{getScriptProperties:()=>({getProperty:()=> 'test-secret'})},
    LockService:{getScriptLock:()=>({tryLock:()=>true,hasLock:()=>true,releaseLock(){}})},
    CacheService:{getScriptCache:()=>({get:k=>cache.get(k),put:(k,v)=>cache.set(k,v)})},
    MailApp:{sendEmail:message=>sent.push(message)}});
  vm.runInContext(read('accounting-mailer/Code.gs'),context);context.reply_=value=>value;
  return {sent,send:input=>context.doPost({postData:{contents:JSON.stringify(input)}})};
}
const receipt={secret:'test-secret',id:'INV-TEST',to:'contractor@example.com',body:'Invoice copy'};
test('Accounting service validates its secret and running identity before any mail',()=>{
  const service=mailer();assert.equal(service.send({...receipt,secret:'wrong'}).ok,false);assert.equal(service.sent.length,0);
  const dash=mailer({sender:'dash@limitlesslightsandsound.com'});assert.equal(dash.send(receipt).ok,false);assert.equal(dash.sent.length,0);
});
test('Accounting service sends a receipt once and uses Accounting reply-to',()=>{
  const service=mailer();assert.equal(service.send(receipt).ok,true);assert.equal(service.send(receipt).ok,true);
  assert.equal(service.sent.length,1);assert.equal(service.sent[0].replyTo,'accounting@limitlesslightsandsound.com');
});
test('Accounting service rejects multiple recipients and malformed references',()=>{
  const service=mailer();assert.equal(service.send({...receipt,to:'a@example.com,b@example.com'}).ok,false);
  assert.equal(service.send({...receipt,id:'not an invoice'}).ok,false);assert.equal(service.sent.length,0);
});
