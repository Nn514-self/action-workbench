import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ActionError, sqliteCommand, defineModule, migrate, query, type Actor } from 'action-workbench';

const record = z.strictObject({orderId:z.string(), item:z.string(), status:z.enum(['placed','shipped','cancelled'])});
const forModel=record.pick({orderId:true,item:true,status:true}).strip();
const byId = z.strictObject({orderId:z.uuid().describe('订单编号')});
export function ordersModule(db:DatabaseSync) {
  migrate(db,'orders',[`CREATE TABLE orders (orderId TEXT PRIMARY KEY,tenant TEXT NOT NULL, owner TEXT NOT NULL,item TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('placed','shipped','cancelled')));
    CREATE INDEX orders_owner ON orders(tenant,owner);`]);
  const list = db.prepare('SELECT orderId,item,status FROM orders WHERE tenant=? AND owner=? ORDER BY rowid DESC LIMIT 100');
  const add = db.prepare("INSERT INTO orders VALUES(?,?,?,?,'placed') RETURNING orderId,item,status");
  const change = db.prepare("UPDATE orders SET status=? WHERE tenant=? AND owner=? AND orderId=? AND status='placed' RETURNING orderId,item,status");
  const get = db.prepare('SELECT orderId,item,status FROM orders WHERE tenant=? AND owner=? AND orderId=?');
  function transition(actor:Actor,id:string,to:'shipped'|'cancelled') {
    const updated=change.get(to,actor.tenantId,actor.id,id);
    if (updated) return record.parse(updated);
    const row=get.get(actor.tenantId,actor.id,id);
    if (!row) throw new ActionError(404,'ORDER_NOT_FOUND','找不到这张订单。');
    if (row.status===to) return record.parse(row);
    if (row.status==='shipped') throw new ActionError(409,'ORDER_ALREADY_SHIPPED','订单已经发货，不能取消。');
    throw new ActionError(409,'ORDER_ALREADY_CANCELLED','订单已取消，不能发货。');
  }
  return defineModule('orders',{
    list:query({description:'列出当前用户最近的 100 张订单、编号和状态。',permission:'orders:read',http:{method:'GET',path:'/orders'},ai:true,
      input:z.strictObject({}), output:z.array(record),modelOutput:z.array(forModel),run:({actor})=>list.all(actor.tenantId,actor.id).map(r=>record.parse(r))}),
    place:sqliteCommand(db,{description:'按商品名称创建一张本机示例订单，不收费。',permission:'orders:write',http:{method:'POST',path:'/orders'},ai:true,confirmation:'none',
      input:z.strictObject({item:z.string().trim().min(1).max(100).describe('商品名称')}),output:record,
      run:({actor},{item})=>record.parse(add.get(randomUUID(),actor.tenantId,actor.id,item))}),
    cancel:sqliteCommand(db,{description:'取消当前用户一张未发货的订单，不办理退货。',permission:'orders:write',http:{method:'POST',path:'/orders/:orderId/cancel'},ai:true,confirmation:'required',
      input:byId,output:record,run:({actor},{orderId})=>transition(actor,orderId,'cancelled')}),
    ship:sqliteCommand(db,{description:'将本人已下单的订单标记为已发货，不安排物流运输。',permission:'orders:ship',http:{method:'POST',path:'/orders/:orderId/ship'},ai:'describe',confirmation:'none',
      input:byId,output:record,run:({actor},{orderId})=>transition(actor,orderId,'shipped')}),
  });
}
