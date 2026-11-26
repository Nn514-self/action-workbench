import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {ActionError, defineModule, migrate, query, sqliteCommand, type Actor} from 'action-workbench';

const roomId=z.string().regex(/^[A-Z][A-Z0-9-]{0,23}$/).describe('会议室编号，通过 rooms.list 或 rooms.available 查询');
const bookingId=z.uuid().describe('本人预约编号；不明确时查询 bookings.mine，不猜编号');
const revision=z.int().positive().describe('查询到的这条预约的当前版本');
const instant=z.iso.datetime({precision:0}).describe('UTC 时间，精确到秒，结尾 Z。用户未说明时按中国标准时间 UTC+08:00 理解。');
const times={startsAt:instant,endsAt:instant};
const room=z.strictObject({roomId,name:z.string().trim().min(1).max(60)});
const subject=z.string().trim().min(1).max(120);
const booking=z.strictObject({bookingId,roomId,title:subject,...times,revision,state:z.enum(['booked','cancelled'])});
const publicRoom=room.pick({roomId:true,name:true}).strip();
const publicBooking=booking.pick({bookingId:true,roomId:true,title:true,startsAt:true,endsAt:true,revision:true,state:true}).strip();
const reference=z.strictObject({bookingId,revision});
const ordered=(v:{startsAt:string;endsAt:string})=>v.startsAt<v.endsAt;
const interval={message:'结束时间必须晚于开始时间',path:['endsAt']};
const missing=()=>new ActionError(404,'BOOKING_NOT_FOUND','找不到这条预约。');

export function meetingModules(db:DatabaseSync) {
  migrate(db,'meeting-rooms',[`CREATE TABLE rooms(tenant TEXT NOT NULL,roomId TEXT NOT NULL,name TEXT NOT NULL,PRIMARY KEY(tenant,roomId));
    CREATE TABLE bookings(bookingId TEXT PRIMARY KEY NOT NULL,tenant TEXT NOT NULL,owner TEXT NOT NULL,roomId TEXT NOT NULL,title TEXT NOT NULL,
      startsAt TEXT NOT NULL,endsAt TEXT NOT NULL CHECK(endsAt>startsAt),revision INTEGER NOT NULL DEFAULT 1,state TEXT NOT NULL DEFAULT 'booked' CHECK(state IN ('booked','cancelled')),
      FOREIGN KEY(tenant,roomId) REFERENCES rooms(tenant,roomId));
    CREATE INDEX booked_slots ON bookings(tenant,roomId,startsAt,endsAt) WHERE state='booked';
    CREATE INDEX own_bookings ON bookings(tenant,owner,startsAt);`]);
  const columns='bookingId,roomId,title,startsAt,endsAt,revision,state';
  const rooms=db.prepare('SELECT roomId,name FROM rooms WHERE tenant=? ORDER BY roomId');
  const newRoom=db.prepare('INSERT INTO rooms(tenant,roomId,name) VALUES(?,?,?) ON CONFLICT(tenant,roomId) DO NOTHING RETURNING roomId,name');
  const roomExists=db.prepare('SELECT 1 FROM rooms WHERE tenant=? AND roomId=?');
  const available=db.prepare(`SELECT r.roomId,r.name FROM rooms r WHERE r.tenant=? AND NOT EXISTS
    (SELECT 1 FROM bookings b WHERE b.tenant=r.tenant AND b.roomId=r.roomId AND b.state='booked' AND b.startsAt<? AND b.endsAt>?) ORDER BY r.roomId`);
  const overlaps=db.prepare("SELECT 1 FROM bookings WHERE tenant=? AND roomId=? AND state='booked' AND startsAt<? AND endsAt>? AND bookingId<>? LIMIT 1");
  const mine=db.prepare(`SELECT ${columns} FROM bookings WHERE tenant=? AND owner=? AND state='booked' AND endsAt>? ORDER BY startsAt,bookingId LIMIT 100`);
  const get=db.prepare(`SELECT ${columns} FROM bookings WHERE tenant=? AND owner=? AND bookingId=?`);
  const add=db.prepare(`INSERT INTO bookings(bookingId,tenant,owner,roomId,title,startsAt,endsAt) VALUES(?,?,?,?,?,?,?) RETURNING ${columns}`);
  const move=db.prepare(`UPDATE bookings SET startsAt=?,endsAt=?,revision=revision+1 WHERE tenant=? AND owner=? AND bookingId=? AND revision=? AND state='booked' RETURNING ${columns}`);
  const cancel=db.prepare(`UPDATE bookings SET state='cancelled',revision=revision+1 WHERE tenant=? AND owner=? AND bookingId=? AND revision=? AND state='booked' RETURNING ${columns}`);
  function own(a:Actor,id:string) { const r=get.get(a.tenantId,a.id,id);if (!r) throw missing();return booking.parse(r); }
  function current(a:Actor,id:string,version:number) {
    const r=own(a,id); if(r.revision!==version || r.state!=='booked') throw new ActionError(409,'BOOKING_CHANGED','预约已改变，请重新查询后办理。');return r;
  }
  function checkSlot(tenant:string,room:string,start:string,end:string,except='') {
    if (Date.parse(start)<=Date.now()) throw new ActionError(409,'PAST_SLOT','不能预约已开始的时段。');
    if (overlaps.get(tenant,room,end,start,except)) throw new ActionError(409,'SLOT_CONFLICT','该会议室的时段已被占用，未改订其他房间或时间。');
  }
  return [defineModule('rooms',{
    list:query({description:'列出本组织的会议室名称及编号。',permission:'rooms:read',ai:true,http:{method:'GET',path:'/rooms'},input:z.strictObject({}),output:z.array(room),modelOutput:z.array(publicRoom),run:({actor})=>rooms.all(actor.tenantId).map(r=>room.parse(r))}),
    available:query({description:'按时间查询本组织仍空闲的会议室，不披露其他人的会议标题和预订人。',permission:'rooms:read',ai:true,http:{method:'GET',path:'/rooms/available'},input:z.strictObject(times).refine(ordered,interval),output:z.array(room),modelOutput:z.array(publicRoom),run:({actor},{startsAt,endsAt})=>available.all(actor.tenantId,endsAt,startsAt).map(r=>room.parse(r))}),
    add:sqliteCommand(db,{description:'场地管理员可登记会议室及其名称。',permission:'rooms:manage',ai:'describe',confirmation:'none',http:{method:'POST',path:'/rooms'},input:room,output:room,run:({actor},{roomId,name})=>{const r=newRoom.get(actor.tenantId,roomId,name);if(!r) throw new ActionError(409,'ROOM_EXISTS','会议室编号已存在。');return room.parse(r)}}),
  }),defineModule('bookings',{
    mine:query({description:'列出本人尚未结束的有效会议预约（最早 100 条），含编号、版本、标题、房间及起止时间；出现多场匹配时请用户选定。',permission:'bookings:read',ai:true,http:{method:'GET',path:'/bookings'},input:z.strictObject({}),output:z.array(booking),modelOutput:z.array(publicBooking),run:({actor})=>mine.all(actor.tenantId,actor.id,new Date().toISOString().replace(/\.\d{3}Z$/,'Z')).map(r=>booking.parse(r))}),
    get:query({description:'用明确编号查询本人预约的房间、原时间、标题、状态和版本。',permission:'bookings:read',ai:true,http:{method:'GET',path:'/bookings/:bookingId'},input:z.strictObject({bookingId}),output:booking,modelOutput:publicBooking,run:({actor},{bookingId})=>own(actor,bookingId)}),
    reserve:sqliteCommand(db,{description:'为自己在指定会议室预约一场会议。房间、时间和会议标题明确后才提议，冲突时不会自动换房。',permission:'bookings:write',ai:true,http:{method:'POST',path:'/bookings'},input:z.strictObject({roomId,title:subject,...times}).refine(ordered,interval),output:booking,run:({actor},{roomId,title,startsAt,endsAt})=>{
      if(!roomExists.get(actor.tenantId,roomId)) throw new ActionError(404,'ROOM_NOT_FOUND','找不到这间会议室。');
      checkSlot(actor.tenantId,roomId,startsAt,endsAt);return booking.parse(add.get(randomUUID(),actor.tenantId,actor.id,roomId,title,startsAt,endsAt));}}),
    move:sqliteCommand(db,{description:'改期本人指定的一场预约，保持原房间与会议标题；只改开始时间时保留原时长。先从本人预约取得编号、版本与原时间；有歧义先询问。',permission:'bookings:write',ai:true,http:{method:'POST',path:'/bookings/:bookingId/move'},input:z.strictObject({bookingId,revision,...times}).refine(ordered,interval),output:booking,run:({actor},{bookingId,revision,startsAt,endsAt})=>{
      const old=current(actor,bookingId,revision);checkSlot(actor.tenantId,old.roomId,startsAt,endsAt,bookingId);return booking.parse(move.get(startsAt,endsAt,actor.tenantId,actor.id,bookingId,revision));}}),
    cancel:sqliteCommand(db,{description:'取消本人指定的有效会议预约，释放该时段。',permission:'bookings:write',ai:true,http:{method:'POST',path:'/bookings/:bookingId/cancel'},input:reference,output:booking,run:({actor},{bookingId,revision})=>{
      current(actor,bookingId,revision);return booking.parse(cancel.get(actor.tenantId,actor.id,bookingId,revision));}}),
  })];
}
