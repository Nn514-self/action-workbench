import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ActionError, sqliteCommand, defineModule, migrate, query, type Actor } from 'action-workbench';

const record=z.strictObject({id:z.string(),title:z.string(),amount:z.string(),status:z.enum(['草稿','已提交'])});
const forModel=record.pick({id:true,title:true,amount:true,status:true}).strip();
const byId=z.strictObject({id:z.string().regex(/^[1-9]\d{0,14}$/).describe('费用单编号')});
const amount=z.string().regex(/^(0|[1-9]\d{0,6})(\.\d{1,2})?$/).refine(v=>!/^0(?:\.0{1,2})?$/.test(v),'金额必须大于零').describe('人民币元，字符串，例如 36.09');
export function expensesModule(db:DatabaseSync) {
  migrate(db,'expenses',[`CREATE TABLE expense_entries (id INTEGER PRIMARY KEY,tenant TEXT NOT NULL,owner TEXT NOT NULL,title TEXT NOT NULL,cents INTEGER NOT NULL CHECK(cents>0),submitted INTEGER NOT NULL DEFAULT 0 CHECK(submitted IN (0,1)));
    CREATE INDEX expense_owner ON expense_entries(tenant,owner,id);`]);
  const cols='CAST(id AS TEXT) AS id,title,printf(\'%d.%02d\',cents/100,cents%100) AS amount,CASE submitted WHEN 1 THEN \'已提交\' ELSE \'草稿\' END AS status';
  const list=db.prepare(`SELECT ${cols} FROM expense_entries WHERE tenant=? AND owner=? ORDER BY id DESC LIMIT 100`);
  const add=db.prepare(`INSERT INTO expense_entries(tenant,owner,title,cents) VALUES(?,?,?,?) RETURNING ${cols}`);
  const set=db.prepare(`UPDATE expense_entries SET submitted=? WHERE tenant=? AND owner=? AND id=? AND submitted=? RETURNING ${cols}`);
  const get=db.prepare(`SELECT ${cols} FROM expense_entries WHERE tenant=? AND owner=? AND id=?`);
  function change(actor:Actor,id:string,to:0|1) {
    const updated=set.get(to,actor.tenantId,actor.id,id,1-to);
    if (updated) return record.parse(updated);
    const row=get.get(actor.tenantId,actor.id,id);
    if (!row) throw new ActionError(404,'EXPENSE_NOT_FOUND','找不到这张费用单。');
    if (!to) throw new ActionError(409,'EXPENSE_NOT_SUBMITTED','只有已提交的费用单可以撤回。');
    return record.parse(row);
  }
  return defineModule('expenses',{
    list:query({description:'查询自己的费用单，返回最近 100 笔的编号、事由、金额和状态。',permission:'expenses:read',http:{method:'GET',path:'/expenses'},ai:true,
      input:z.strictObject({}),output:z.array(record),modelOutput:z.array(forModel),run:({actor})=>list.all(actor.tenantId,actor.id).map(r=>record.parse(r))}),
    create:sqliteCommand(db,{description:'按事由、人民币金额创建一张费用草稿，不提交。',permission:'expenses:write',http:{method:'POST',path:'/expenses'},ai:true,confirmation:'none',
      input:z.strictObject({title:z.string().trim().min(1).max(80).describe('事由'),amount}),output:record,
      run:({actor},{title,amount})=>{const [yuan,frac='']=amount.split('.');return record.parse(add.get(actor.tenantId,actor.id,title,Number(yuan)*100+Number(frac.padEnd(2,'0'))));}}),
    submit:sqliteCommand(db,{description:'按编号将自己的费用草稿标记为已提交。',permission:'expenses:write',http:{method:'POST',path:'/expenses/:id/submit'},ai:true,
      input:byId,output:record,run:({actor},{id})=>change(actor,id,1)}),
    withdraw:sqliteCommand(db,{description:'撤回当前用户指定的一张已提交费用单，变回草稿，不删除也不退款。',permission:'expenses:write',http:{method:'POST',path:'/expenses/:id/withdraw'},ai:true,
      input:byId,output:record,run:({actor},{id})=>change(actor,id,0)}),
  });
}
