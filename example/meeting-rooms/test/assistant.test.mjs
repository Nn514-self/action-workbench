import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createBackend} from 'action-workbench';
import {createHttpServer} from 'action-workbench/http';
import {directory} from '../access.ts';
import {meetingModules} from '../bookings.ts';

test('availability read by the assistant is not a reservation or permission to write later',async t=>{
  const db=new DatabaseSync(':memory:'), users=directory(db), [one,two]=[1,2].map(()=>randomBytes(32).toString('hex'));
  users.grant('acme','a','manager',one);users.grant('acme','b','staff',two);
  const slot={startsAt:'2099-01-11T05:00:00Z',endsAt:'2099-01-11T06:00:00Z'}, input={...slot,title:'法务讨论',roomId:'A'};
  const backend=createBackend({database:db,modules:meetingModules(db)});
  const http=createHttpServer(backend,{authenticate:r=>users.authenticate(r.headers.authorization),provider:{label:'contract',async decide(turn){
    const last=turn.history.at(-1);
    if(last.role==='user') return {type:'call',name:'rooms.available',args:slot};
    assert.deepEqual(last.result,[{roomId:'A',name:'海棠厅'}]);return {type:'call',name:'bookings.reserve',args:input};
  }}});t.after(async()=>{await http.close();db.close()});
  const req=async(token,method,url,payload)=>{const r=await http.inject({method,url,payload,headers:{authorization:'Bearer '+token}});return {status:r.statusCode,body:r.json()}};
  const confirm=(token,id)=>req(token,'POST',`/_aw/invocations/${id}/confirm`);
  await req(one,'POST','/rooms',{roomId:'A',name:'海棠厅'});
  const propose=async()=>{const chat=await req(one,'POST','/_aw/assistant/messages',{message:'帮我订海棠厅'});assert.equal(chat.status,202);return chat.body.invocation.id};
  const race=await propose(), withdrawn=await propose();
  const theirs=await req(two,'POST','/bookings',{...input,title:'他人私密会议'});assert.equal((await confirm(two,theirs.body.id)).status,200);
  const rejected=await confirm(one,race);assert.equal(rejected.status,409);assert.equal(rejected.body.error.code,'SLOT_CONFLICT');assert.ok(!JSON.stringify(rejected).includes('他人私密会议'));
  users.grant('acme','a','viewer',one);assert.equal((await confirm(one,withdrawn)).status,404);
  assert.deepEqual((await req(one,'GET','/_aw/invocations/pending')).body.items,[]);assert.deepEqual((await req(one,'GET','/bookings')).body.result,[]);
});
