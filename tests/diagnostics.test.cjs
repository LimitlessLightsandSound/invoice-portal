const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
function setup() {
  const logs=[];
  const context=vm.createContext({console:{log:v=>logs.push(v),error:v=>logs.push(v)}});
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../Code.gs'),'utf8'),context);
  context.json=value=>({getContent:()=>JSON.stringify(value)});
  return {context,logs};
}
test('records safe action, outcome and timing without tokens or invoice data',()=>{
  const {context,logs}=setup();
  context.listInvoices=()=>context.json({ok:true,invoices:[{email:'private@example.com'}]});
  const result=context.doPost({postData:{contents:JSON.stringify({action:'list',token:'secret-token'})}});
  assert.equal(JSON.parse(result.getContent()).ok,true);
  assert.equal(logs.length,1);
  assert.deepEqual(Object.keys(JSON.parse(logs[0])),['event','action','outcome','durationMs']);
  assert.equal(JSON.parse(logs[0]).outcome,'ok');
  assert.doesNotMatch(logs[0],/secret|private/);
});
test('classifies application failures even though the Apps Script invocation completes',()=>{
  for(const [message,outcome] of [['Not signed in','session_expired'],['Service invoked too many times','quota'],['Timed out','timeout'],['Missing row with private@example.com','application_error']]) {
    const {context,logs}=setup();
    context.listInvoices=()=>{throw Error(message)};
    const result=context.doPost({postData:{contents:'{"action":"list"}'}});
    assert.equal(JSON.parse(result.getContent()).ok,false);
    assert.equal(JSON.parse(logs[0]).outcome,outcome);
    assert.doesNotMatch(logs[0],/private/);
  }
});
test('logging failure does not undo successful writes or change their response',()=>{
  const {context}=setup();
  context.console.log=()=>{throw Error('logging unavailable')};
  context.actOnInvoice=()=>context.json({ok:true,id:'saved'});
  assert.equal(JSON.parse(context.doPost({postData:{contents:'{"action":"act"}'}}).getContent()).id,'saved');
});
