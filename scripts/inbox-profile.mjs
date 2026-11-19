// A repeatable local experiment, independent of the application data directory and frozen benchmark.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Store } from '../server/storage/store.ts';
const samples = 32;
const summary = (values) => {
  const sorted = [...values].sort((a,b) => a-b);
  const at = (q) => Number(sorted[Math.ceil(sorted.length*q)-1].toFixed(3));
  return {samples: sorted.length, p50Ms:at(.5),p95Ms:at(.95)};
};
function time(fn) {const before=performance.now();fn();return performance.now()-before;}
function run(history, indexed) {
  const db = new Store(':memory:');
  try {
    // Remove only these two proposal-specific indexes in the throwaway baseline.
    if (!indexed) db.db.exec('DROP INDEX inbox_pending_user_conversation; DROP INDEX inbox_pending_user_run;');
    const put = db.db.prepare("INSERT INTO records(kind,id,data) VALUES('user-inbox',?,?)");
    const add = (id,c,state) => put.run(String(id),JSON.stringify({id:String(id),conversationId:c,runId:c+'-run',state,content:'X'.repeat(128)}));
    const buildMs=time(()=>db.transaction(()=>{for(let n=0;n<history;n++) add(n,'unrelated-'+n%50,'delivered');add(history,'target','pending');}));
    const read = indexed ? ()=>db.pendingUserInbox('target') : ()=>db.list('user-inbox').filter(x=>x.state==='pending' && x.conversationId==='target');
    const expected=[String(history)]; const check=()=>assert.deepEqual(read().map(x=>x.id),expected);
    for(let n=0;n<4;n++) check();
    const readTimes=Array.from({length:samples},()=>time(check));
    const settle=db.db.prepare("UPDATE records SET data=json_set(data,'$.state','delivered') WHERE kind='user-inbox' AND id=?");
    const writeTimes=Array.from({length:samples},(_,n)=>time(()=>db.transaction(()=>{for(let j=0;j<32;j++) {const id=history+1+n*32+j;add(id,'writer','pending');settle.run(String(id));}})));
    check();
    return {history,mode:indexed?'indexed':'scan',seedMs:Number(buildMs.toFixed(2)),read:summary(readTimes),enqueueAndSettleBatch32:summary(writeTimes)};
  } finally {db.close();}
}
console.log(JSON.stringify({experiment:'synthetic-inbox-v1', node:process.version, platform:process.platform, units:'ms', observations:[...runPair(1000,false),...runPair(10000,true),...runPair(30000,false)]},null,2));
function runPair(history,invert) {return [run(history,invert),run(history,!invert)];}
