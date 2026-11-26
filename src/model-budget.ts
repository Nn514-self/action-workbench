import {ActionError} from './errors.js';

export interface AssistantLimits {
  maxConcurrent?: number;
  maxConcurrentPerUser?: number;
  turnTimeoutMs?: number;
}
export const maxDecisionBytes=16_384;
const cancelled=()=>new ActionError(408,'CHAT_CANCELLED','请求已取消。');

/** Per assistant instance. Do not return a permit on timeout while an uncooperative provider is still running. */
export function createTurnBudget({maxConcurrent=4,maxConcurrentPerUser=1,turnTimeoutMs=120_000}:AssistantLimits={}) {
  if (![maxConcurrent,maxConcurrentPerUser,turnTimeoutMs].every(n=>Number.isSafeInteger(n)&&n>0) ||
      maxConcurrentPerUser>maxConcurrent || turnTimeoutMs>2_147_483_647) throw new Error('Invalid assistant limits');
  const owners=new Map<string,number>(); let active=0;
  return function run<T>(owner:string,client:AbortSignal|undefined,work:(signal:AbortSignal)=>Promise<T>):Promise<T> {
    if (client?.aborted) throw cancelled();
    const n=owners.get(owner) ?? 0;
    if (n>=maxConcurrentPerUser || active>=maxConcurrent) throw new ActionError(429,'MODEL_BUSY','模型并发已满，请稍后重试。');
    owners.set(owner,n+1);active++;
    const {promise,resolve,reject}=Promise.withResolvers<T>(), control=new AbortController();
    const detach=()=>{clearTimeout(timer);client?.removeEventListener('abort',disconnect);};
    const stop=(reason:ActionError)=>{detach();control.abort(reason);reject(reason);};
    const disconnect=()=>stop(cancelled());
    const timer=setTimeout(()=>stop(new ActionError(504,'MODEL_TIMEOUT','本轮模型处理超时。')),turnTimeoutMs);
    client?.addEventListener('abort',disconnect,{once:true});
    void (async()=>{
      try {const value=await work(control.signal);control.signal.throwIfAborted();resolve(value);}
      catch (error) {reject(error);}
      finally {
        detach();active--;const count=owners.get(owner)!-1;
        if (count) owners.set(owner,count); else owners.delete(owner);
      }
    })();
    return promise;
  };
}
