import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {directory} from '../access.ts';
const root=new URL('../',import.meta.url);
async function start(dir) {
  const child=spawn(process.execPath,['server.ts'],{cwd:root,env:{...process.env,PORT:'0',ROOMS_DATA_DIR:dir},stdio:['ignore','pipe','pipe']});let log='';child.stderr.on('data',b=>{log+=b});
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('Startup timeout: '+log))},8000);
    child.stdout.on('data',b=>{const m=/Meeting rooms: (http:\/\/127\.0\.0\.1:\d+)/.exec(String(b));if(m){clearTimeout(timer);resolve(m[1])}});
    child.once('exit',code=>{clearTimeout(timer);reject(Error('Startup failed '+code+': '+log))});});
  return {url,async close(){if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done}}};
}
async function request(server,user,method,path,body){const r=await fetch(server.url+path,{method,headers:{Authorization:`Bearer ${user}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});return {code:r.status,data:await r.json()};}
const when=(n)=>`2099-08-27T${String(n).padStart(2,'0')}:00:00Z`;
const interval=n=>({startsAt:when(n),endsAt:when(n+1)});
const reserve=(s,u,title,n)=>request(s,u,'POST','/bookings',{roomId:'A',title,...interval(n)});
const confirm=(s,u,p)=>request(s,u,'POST',`/_aw/invocations/${p.data.id}/confirm`);

test('two installed backend processes enforce reservations, overlapping windows, ownership, role changes and operation without AI',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'aw-rooms-')), processes=[];let db;
  try {
    const s=await start(dir);processes.push(s);const s2=await start(dir);processes.push(s2);
    db=new DatabaseSync(join(dir,'rooms.sqlite'));db.exec('PRAGMA busy_timeout=5000');const access=directory(db);
    const [mgr,a,b,other]=Array.from({length:4},()=>randomBytes(32).toString('hex'));
    access.grant('HQ','admin','manager',mgr);access.grant('HQ','a','staff',a);access.grant('HQ','b','staff',b);access.grant('Branch','a','manager',other);
    assert.equal((await request(s,a,'POST','/_aw/assistant/messages',{message:'订房'})).data.error.code,'AI_DISABLED');
    const add={roomId:'A',name:'海棠厅'};
    assert.equal((await request(s,a,'POST','/rooms',add)).code,404);
    assert.equal((await request(s,mgr,'POST','/rooms',add)).code,200);assert.equal((await request(s,other,'POST','/rooms',add)).code,200);
    const [p,q]=await Promise.all([reserve(s,a,'季度复盘',8),request(s2,b,'POST','/bookings',{roomId:'A',title:'场地巡检',startsAt:'2099-08-27T08:30:00Z',endsAt:'2099-08-27T09:30:00Z'})]);
    assert.equal(p.code,202);assert.equal(q.code,202);
    const results=await Promise.all([confirm(s,a,p),confirm(s2,b,q)]);assert.deepEqual(results.map(r=>r.code).sort(),[200,409]);
    assert.equal(results.find(r=>r.code===409).data.error.code,'SLOT_CONFLICT');
    const booked=results.find(r=>r.code===200).data.result, [owner,otherStaff]=results[0].code===200?[a,b]:[b,a];
    assert.equal((await request(s,otherStaff,'GET','/bookings/'+booked.bookingId)).code,404);
    assert.equal((await request(s,other,'GET','/bookings/'+booked.bookingId)).code,404);
    assert.deepEqual((await request(s,otherStaff,'GET','/bookings')).data.result,[]);
    assert.equal((await confirm(s,other,await reserve(s,other,'分部独立预约',8))).code,200);
    const path='/bookings/'+booked.bookingId+'/move', change={revision:booked.revision,...interval(12)};
    const free=await request(s,owner,'GET','/rooms/available?'+new URLSearchParams(interval(12)));assert.deepEqual(free.data.result,[add]);
    const proposal=await request(s,owner,'POST',path,change);
    assert.equal((await confirm(s2,otherStaff,await reserve(s2,otherStaff,'临时会议',12))).code,200);
    assert.equal((await confirm(s,owner,proposal)).data.error.code,'SLOT_CONFLICT');
    assert.deepEqual((await request(s,owner,'GET','/bookings/'+booked.bookingId)).data.result,booked);
    const old=await request(s,owner,'POST',path,{revision:booked.revision,...interval(13)});
    const newer=await request(s,owner,'POST',path,{revision:booked.revision,...interval(14)});
    const moved=await confirm(s,owner,newer);assert.equal(moved.data.result.revision,booked.revision+1);
    assert.equal((await confirm(s2,owner,old)).data.error.code,'BOOKING_CHANGED');
    const cancelPath='/bookings/'+booked.bookingId+'/cancel', cancel=await request(s,owner,'POST',cancelPath,{revision:moved.data.result.revision});
    const userId=owner===a?'a':'b';access.grant('HQ',userId,'viewer',owner);
    assert.equal((await confirm(s2,owner,cancel)).code,404);assert.equal((await request(s,owner,'POST',path,change)).code,404);
    assert.equal((await request(s,owner,'GET','/bookings/'+booked.bookingId)).data.result.state,'booked');
    access.grant('HQ',userId,'staff',owner);assert.equal((await confirm(s,owner,cancel)).data.result.state,'cancelled');
    assert.deepEqual((await request(s,owner,'GET','/rooms/available?'+new URLSearchParams(interval(14)))).data.result,[add]);
    access.revoke('HQ',userId);assert.equal((await request(s2,owner,'GET','/rooms')).code,401);
  } finally {await Promise.all(processes.map(p=>p.close()));db?.close();rmSync(dir,{recursive:true,force:true})}
});
