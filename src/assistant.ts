import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Actor } from './module.js';
import type { Backend, Capability, Invocation, Tool } from './backend.js';
import { requireActor } from './backend.js';
import { ActionError, proposalChanged, unavailable } from './errors.js';
import {createTurnBudget, maxDecisionBytes, type AssistantLimits} from './model-budget.js';
export type {AssistantLimits} from './model-budget.js';

type Event = { role:'user'|'assistant'; text:string } | { role:'tool'; name:string; result?:unknown; error?:string };
export interface ModelTurn { capabilities: Capability[]; tools: Tool[]; history: readonly Event[]; now: string; pending?: Pick<Invocation,'action'|'input'|'expiresAt'> }
export type ModelDecision = {type:'reply'; text:string} | {type:'call'|'revise'; name:string; args:unknown};
export interface ModelProvider { label: string; decide(turn: ModelTurn, signal?: AbortSignal): Promise<ModelDecision> }
export type AssistantReply = { conversationId:string } & ({type:'reply'; text:string; pending?:Invocation} | {type:'confirmation_required'; invocation:Invocation});
interface Entry { event:Event; bytes:number }
interface Session { owner:string; tenant:string; scope:string; history:Entry[]; expires:number; busy:boolean; pending?:string }
const message = z.strictObject({message:z.string().trim().min(1).max(2000), conversationId:z.uuid().optional()});
const lifetime = 30 * 60_000;
function jsonBytes(value:unknown):number {
  try { const json=JSON.stringify(value); return json===undefined?Infinity:Buffer.byteLength(json); }
  catch { return Infinity; }
}
const maxHistoryBytes=32_768, maxTurnBytes=131_072;
const modelErrorCodes={NOT_FOUND:true,INVALID_INPUT:true,INVALID_REVISION:true,REVIEW_PENDING:true,REVISION_TARGET_CHANGED:true,MODEL_VIEW_UNAVAILABLE:true};
async function converse(backend:Backend,provider:ModelProvider,actor:Actor,s:Session,text:string,id:string,signal:AbortSignal):Promise<AssistantReply> {
  const history=s.history.slice(); // Commit only completed messages. A cancelled request is not a future instruction.
  let size=history.reduce((total,e)=>total+e.bytes,0);
  const add=(event:Event)=>{
    let bytes=jsonBytes(event);
    if (bytes>maxDecisionBytes) {
      if (event.role!=='tool') throw new ActionError(502,'MODEL_RESPONSE_TOO_LARGE','模型回复超出限制。');
      event={role:'tool',name:event.name,error:'MODEL_RESULT_TOO_LARGE'}; bytes=jsonBytes(event);
    }
    while (history.length>=24 || size+bytes>maxHistoryBytes) size-=history.shift()!.bytes;
    history.push({event,bytes});size+=bytes;
  };
  let pending:Invocation|undefined;
  if (s.pending) {
    const call=backend.status(actor,s.pending,'ai');
    if (call.status==='pending') pending=call;
    else add({role:'tool',name:call.action,result:{status:call.status,...(call.result===undefined?{}:{result:call.result})}});
  }
  add({role:'user',text});
  const tools=backend.discover(actor,'ai'), capabilities=backend.capabilities(actor);
  for (let i=0;i<5;i++) {
    signal.throwIfAborted();
    const turn:ModelTurn={tools,capabilities,history:history.map(e=>e.event),now:new Date().toISOString(),
      ...(pending?{pending:{action:pending.action,input:pending.input,expiresAt:pending.expiresAt}}:{})};
    if (jsonBytes(turn)>maxTurnBytes) throw new ActionError(422,'MODEL_CONTEXT_TOO_LARGE','能力目录或本轮上下文超出模型入口限制。');
    const next=await provider.decide(turn,signal);
    signal.throwIfAborted(); // A late provider result must never create or revise a proposal.
    if (jsonBytes(next)>maxDecisionBytes) throw new ActionError(502,'MODEL_RESPONSE_TOO_LARGE','模型回复超出限制。');
    if (next?.type==='reply' && typeof next.text==='string' && next.text.trim()) {
      if (pending) { pending=backend.status(actor,pending.id,'ai'); if (pending.status!=='pending') throw proposalChanged(); }
      add({role:'assistant',text:next.text});s.history=history;s.pending=pending?.id;
      return {conversationId:id,type:'reply',text:next.text,...(pending?{pending}:{})};
    }
    if (!next || (next.type!=='call' && next.type!=='revise') || typeof next.name!=='string') throw new ActionError(502,'MODEL_INVALID_RESPONSE','模型没有返回有效动作。');
    const tool=tools.find(t=>t.name===next.name);
    try {
      if (!tool) throw unavailable();
      let call:Invocation;
      if (next.type==='revise') {
        if (!pending || pending.action!==next.name) throw new ActionError(400,'INVALID_REVISION','只可修改当前待确认动作的完整参数。');
        call=backend.revise(actor,pending.id,next.args);
      } else {
        if (pending && tool.kind==='command') throw new ActionError(409,'REVIEW_PENDING','请先处理当前提议。');
        call=await backend.invoke(actor,next.name,next.args,{source:'ai'});
      }
      if (call.status==='pending') {
        add({role:'tool',name:call.action,result:{status:'pending',input:call.input}});
        s.pending=call.id;s.history=history;
        return {conversationId:id,type:'confirmation_required',invocation:call};
      }
      add({role:'tool',name:tool.name,result:call.result});
    } catch (e) {
      if (!(e instanceof ActionError) || e.code==='PROPOSAL_CHANGED' || e.code==='ACTION_CHANGED') throw e;
      add({role:'tool',name:tool?.name ?? 'unavailable',error:Object.hasOwn(modelErrorCodes,e.code)?e.code:'ACTION_REJECTED'});
    }
  }
  throw new ActionError(422,'TOOL_STEP_LIMIT','无法在本轮确定合适动作，没有执行写入。');
}

export function createAssistant(backend:Backend,provider:ModelProvider,limits?:AssistantLimits) {
  const sessions=new Map<string,Session>(), run=createTurnBudget(limits);
  return {async say(actor:Actor,raw:unknown,client?:AbortSignal):Promise<AssistantReply> {
    requireActor(actor);
    const body=message.safeParse(raw);
    if (!body.success) throw new ActionError(400,'INVALID_CHAT_INPUT','需要 message，可选 conversationId。');
    const now=Date.now(), id=body.data.conversationId ?? randomUUID(), previous=sessions.get(id);
    const scope=JSON.stringify([...new Set(actor.permissions)].sort());
    if (body.data.conversationId && (!previous || previous.expires<=now || previous.owner!==actor.id || previous.tenant!==actor.tenantId || previous.scope!==scope)) throw unavailable();
    if (previous?.busy) throw new ActionError(409,'CHAT_BUSY','当前对话仍在处理上一条消息。');
    return run(JSON.stringify([actor.tenantId,actor.id]),client,async signal=>{
      if (!previous) {
        let mine=0;
        for (const [key,s] of sessions) {
          if (!s.busy && s.expires<=now) sessions.delete(key);
          else if (s.owner===actor.id && s.tenant===actor.tenantId) mine++;
        }
        if (sessions.size>=1000 || mine>=16) throw new ActionError(429,'CHAT_CAPACITY','会话已满，请使用已有对话或稍后重试。');
      }
      const s=previous ?? {owner:actor.id,tenant:actor.tenantId,scope,history:[],busy:false,expires:now+lifetime,pending:undefined};
      if (!previous) sessions.set(id,s);
      s.busy=true;
      try { return await converse(backend,provider,actor,s,body.data.message,id,signal); }
      catch (e) { if (!previous && !s.pending) sessions.delete(id); throw e; }
      finally { s.busy=false;s.expires=Date.now()+lifetime; }
    });
  }};
}
