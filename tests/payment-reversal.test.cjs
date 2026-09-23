const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
function setup(role='controller',pay=false,status='billed',archived='') {
 const context=vm.createContext({console,LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})}});
 vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../Code.gs'),'utf8'),context);
 const cols=vm.runInContext('COL',context), row=Array(vm.runInContext('HEADERS.length',context)).fill('');
 Object.entries({InvoiceID:'test',Status:status,BillingType:'production',Contractor:'Test',ReviewedBy:'Approver',ReviewedAt:new Date('2026-09-01'),BilledBy:'Accounting',BilledAt:new Date('2026-09-02'),BillRef:'check-123',Archived:archived}).forEach(([k,v])=>row[cols[k]]=v);
 let writes=0;
 context.session=()=>({role,pay,name:'Reviewer',scope:'install'});
 context.json=v=>v;
 context.findInvoice_=()=>({sh:{getRange:()=>({getValues:()=>[[...row]],setValues:values=>{writes++;row.splice(0,row.length,...values[0])}})},rowIdx:2});
 return {context,row,cols,writes:()=>writes};
}
test('unpay preserves approval, clears current payment, and saves its previous stamp',()=>{
 for(const [role,pay] of [['owner',false],['controller',false],['approver',true]]){
 const {context,writes}=setup(role,pay);
 const r=context.actOnInvoice({id:'test',verb:'unpaid'});
 assert.equal(r.ok,true);assert.equal(writes(),1);assert.equal(r.invoice.status,'approved');
 assert.equal(r.invoice.reviewed.by,'Approver');assert.equal(r.invoice.billed.by,'');assert.equal(r.invoice.billed.ref,'');
 assert.equal(r.invoice.paymentHistory[0].previous.ref,'check-123');assert.equal(r.invoice.paymentHistory[0].by,'Reviewer');
 const repeat=context.actOnInvoice({id:'test',verb:'unpaid'});
 assert.equal(repeat.ok,false);assert.equal(writes(),1);
 }
});
test('unpay refuses unauthorized users, unpaid states and archived bills without writes',()=>{
 for(const args of [['approver',false],['controller',false,'approved'],['controller',false,'pending'],['controller',false,'billed','yes']]){
 const {context,writes}=setup(...args);assert.equal(context.actOnInvoice({id:'test',verb:'unpaid'}).ok,false);assert.equal(writes(),0);
 }
});
test('re-paying preserves reversal history',()=>{
 const {context}=setup();context.actOnInvoice({id:'test',verb:'unpaid'});
 const r=context.actOnInvoice({id:'test',verb:'billed',billRef:'check-456'});
 assert.equal(r.invoice.status,'billed');assert.equal(r.invoice.billed.ref,'check-456');assert.equal(r.invoice.paymentHistory[0].previous.ref,'check-123');
});
test('corrupt history fails closed and lock contention causes no write',()=>{
 const {context,row,cols,writes}=setup();row[cols.PaymentHistoryJSON]='not json';
 assert.equal(context.actOnInvoice({id:'test',verb:'unpaid'}).ok,false);assert.equal(writes(),0);
 context.LockService.getScriptLock=()=>({tryLock:()=>false});
 assert.equal(context.actOnInvoice({id:'test',verb:'unpaid'}).ok,false);assert.equal(writes(),0);
});
