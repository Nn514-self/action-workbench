// Opt-in. Actual HTTP + local Codex; synthetic records only. No fallback provider.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createBackend} from 'action-workbench';
import {createHttpServer} from 'action-workbench/http';
import {localCodex} from 'action-workbench/codex';
import {directory} from '../access.ts';
import {meetingModules} from '../bookings.ts';
const provider=localCodex();if(!provider)throw Error('Install and sign in to a supported Codex CLI; no substitute is used.');
const db=new DatabaseSync(':memory:'), users=directory(db), token=randomBytes(32).toString('hex');users.grant('acme','tester','manager',token);
const backend=createBackend({database:db,modules:meetingModules(db)});
const http=createHttpServer(backend,{authenticate:r=>users.authenticate(r.headers.authorization),provider});
try {
  const base=await http.listen({host:'127.0.0.1',port:0});
  async function api(method,path,code,body) {const r=await fetch(base+path,{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(240000)});const j=await r.json();assert.equal(r.status,code,JSON.stringify(j));return j;}
  const day=new Date(Date.now()+32*3600000).toISOString().slice(0,10), hour=h=>`${day}T${String(h).padStart(2,'0')}:00:00Z`;
  await api('POST','/rooms',200,{roomId:'A',name:'海棠厅'});
  async function book(title,h){const p=await api('POST','/bookings',202,{roomId:'A',title,startsAt:hour(h),endsAt:hour(h+1)});return (await api('POST',`/_aw/invocations/${p.id}/confirm`,200)).result;}
  const target=await book('季度复盘',1), untouched=await book('预算讨论',3);
  const say=(message,code,conversationId)=>api('POST','/_aw/assistant/messages',code,{message,...(conversationId?{conversationId}:{})});
  const manual=await say('我可以登记新的会议室吗？请说明是我手动做，还是你能代办。',200);
  assert.match(manual.text,/手动|人工|自行|亲自/);console.log('Introduction:',manual.text);
  const ambiguous=await say(`请把我 ${day} 的会议改到当天下午三点。`,200);assert.equal(ambiguous.pending,undefined);
  assert.deepEqual((await api('GET','/_aw/invocations/pending',200)).items,[]);assert.match(ambiguous.text,/哪|选|确认|指明|指定|区分/);console.log('Clarification:',ambiguous.text);
  const cid=ambiguous.conversationId;
  const first=await say('是季度复盘这场，请把它改到那天下午三点开始，时长不变。',202,cid);
  const expected={bookingId:target.bookingId,revision:target.revision,startsAt:hour(7),endsAt:hour(8)};
  assert.equal(first.invocation.action,'bookings.move');assert.deepEqual(first.invocation.input,expected);
  const info=await say('先不办。解释一下这一步会改哪场会议、哪个房间，原来和拟改的时间各是什么？',200,cid);
  assert.equal(info.pending.id,first.invocation.id);assert.match(info.text,/季度复盘/);assert.match(info.text,/海棠|\bA\b/);console.log('Pending explanation:',info.text);
  const revised=await say('我改主意了，把刚才这笔改期提议改成同一天下午四点开始，保留一小时，不换会、不换房间。',202,cid);
  assert.notEqual(revised.invocation.id,first.invocation.id);assert.deepEqual(revised.invocation.input,{...expected,startsAt:hour(8),endsAt:hour(9)});
  assert.equal((await api('POST',`/_aw/invocations/${first.invocation.id}/confirm`,409)).status,'cancelled');
  assert.deepEqual((await api('GET',`/bookings/${target.bookingId}`,200)).result,target);
  const committed=await api('POST',`/_aw/invocations/${revised.invocation.id}/confirm`,200);
  assert.equal(committed.result.startsAt,hour(8));assert.equal(committed.result.revision,target.revision+1);
  assert.deepEqual((await api('GET',`/bookings/${untouched.bookingId}`,200)).result,untouched);
  console.log('Real model:',provider.label,'| old proposal cancelled; only selected meeting moved to 16:00 China Standard Time.');
}finally{await http.close();db.close()}
