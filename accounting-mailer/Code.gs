/* Dedicated Accounting-owned receipt sender. No invoice database or Gmail inbox access.
 * Deploy as Accounting, execute as Me. Set RECEIPT_SECRET in Script Properties;
 * the invoice backend holds the same secret plus this service's deployment URL. */
var RECEIPT_SENDER = 'accounting@limitlesslightsandsound.com';
function authorizeMailer() {
  if (Session.getEffectiveUser().getEmail().toLowerCase() !== RECEIPT_SENDER) throw new Error('Sign in as Accounting');
  console.log('Accounting mail authorization ready; remaining daily recipients: ' + MailApp.getRemainingDailyQuota());
}
function doGet() { return reply_({ok:true, service:'accounting-invoice-receipts', version:1}); }
function doPost(e) {
  var lock;
  try {
    var b = JSON.parse(e.postData.contents);
    var secret = PropertiesService.getScriptProperties().getProperty('RECEIPT_SECRET');
    if (!secret || typeof b.secret !== 'string' || b.secret !== secret) return reply_({ok:false});
    if (Session.getEffectiveUser().getEmail().toLowerCase() !== RECEIPT_SENDER) return reply_({ok:false});
    if (typeof b.to !== 'string' || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(b.to)) return reply_({ok:false});
    if (typeof b.id !== 'string' || !/^INV-[A-Za-z0-9-]{1,80}$/.test(b.id)) return reply_({ok:false});
    if (typeof b.body !== 'string' || !b.body || b.body.length > 100000) return reply_({ok:false});
    lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) return reply_({ok:false});
    var cache = CacheService.getScriptCache(), key = 'receipt:' + b.id;
    if (cache.get(key)) return reply_({ok:true});
    MailApp.sendEmail({to:b.to, name:'Limitless Accounting', replyTo:RECEIPT_SENDER,
      subject:'Received: invoice ' + b.id, body:b.body});
    cache.put(key, 'sent', 21600);
    return reply_({ok:true});
  } catch(err) {
    console.error('Receipt delivery failed');
    return reply_({ok:false});
  } finally { if(lock && lock.hasLock()) lock.releaseLock(); }
}
function reply_(value) { return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON); }
