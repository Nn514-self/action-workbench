import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createAssistant, type AssistantLimits, type ModelProvider } from './assistant.js';
import { requireActor, type Backend, type Invocation } from './backend.js';
import { ActionError } from './errors.js';
import type { Actor } from './module.js';

export interface HttpOptions {
  authenticate(request: FastifyRequest): Actor | null | Promise<Actor|null>;
  provider?: ModelProvider | null;
  assistantLimits?: AssistantLimits;
  allowedOrigin?: string;
  logger?: boolean;
}
function inputs(...parts: unknown[]): Record<string,unknown> {
  const input: Record<string,unknown> = Object.create(null);
  for (const part of parts) {
    if (part === undefined) continue;
    if (!part || typeof part !== 'object' || Array.isArray(part)) throw new ActionError(400,'INVALID_INPUT','输入必须是 JSON 对象。');
    for (const [key,value] of Object.entries(part)) {
      if (Object.hasOwn(input,key)) throw new ActionError(400,'DUPLICATE_INPUT',`参数重复：${key}`);
      input[key]=value;
    }
  }
  return input;
}
const pendingQuery = z.strictObject({limit:z.string().regex(/^[1-9]\d{0,2}$/).transform(Number).optional(), cursor:z.string().optional()});
const httpStatus: Partial<Record<Invocation['status'],number>> = {pending:202,running:202,expired:410,cancelled:409};
function send(reply: FastifyReply, call: Invocation) {
  return reply.code(call.error?.status ?? httpStatus[call.status] ?? 200).send(call);
}
/** Only the host authenticates actors. Cookie-bearing writes require its exact configured Origin. */
export function createHttpServer(backend: Backend, options: HttpOptions): FastifyInstance {
  const origin=options.allowedOrigin;
  if (origin!==undefined && (!/^https?:\/\//.test(origin) || new URL(origin).origin!==origin)) throw new Error('allowedOrigin must be one exact HTTP(S) origin');
  const server = Fastify({bodyLimit:32_768, logger:options.logger ?? false, exposeHeadRoutes:false, onProtoPoisoning:'error', onConstructorPoisoning:'error'});
  const chats = options.provider ? createAssistant(backend,options.provider,options.assistantLimits) : null;
  server.addHook('onRequest', async (req,reply) => {
    reply.header('Cache-Control','no-store');
    if (req.method!=='GET' && (req.headers.cookie!==undefined || req.headers.origin!==undefined) &&
        (!origin || req.headers.origin!==origin)) throw new ActionError(403,'FOREIGN_ORIGIN','请求来源未获授权。');
    const actor = await options.authenticate(req); requireActor(actor);
    req.setDecorator('workbenchActor',actor);
  });
  server.decorateRequest('workbenchActor',null);
  const actor = (req:FastifyRequest) => req.getDecorator<Actor>('workbenchActor');
  server.setErrorHandler((error:Error & {statusCode?:number}, _req, reply) => {
    if (error instanceof ActionError) return reply.code(error.status).send({error:{code:error.code,message:error.message}});
    const status = error.statusCode && error.statusCode>=400 && error.statusCode<500 ? error.statusCode : 500;
    return reply.code(status).send({error:{code:status===500?'INTERNAL_ERROR':'INVALID_REQUEST',message:status===500?'服务器未取得可用结果。':'请求格式或大小不正确。'}});
  });
  for (const route of backend.routes) server.route({method:route.method,url:route.path,async handler(req,reply) {
    const value = req.headers['idempotency-key'];
    if (Array.isArray(value)) throw new ActionError(400,'INVALID_IDEMPOTENCY_KEY','只能提供一个幂等键。');
    return send(reply,await backend.invoke(actor(req),route.name,inputs(req.params,req.query,req.body),{idempotencyKey:value}));
  }});
  server.get('/_aw/actions',async req=>backend.discover(actor(req)));
  server.get('/_aw/capabilities',async req=>backend.capabilities(actor(req)));
  server.get('/_aw/openapi.json',async req=>backend.openApi(actor(req)));
  server.get('/_aw/invocations/pending',async req=>{
    const parsed = pendingQuery.safeParse(req.query);
    if (!parsed.success) throw new ActionError(400,'INVALID_PAGE','仅支持 limit 和 cursor 分页参数。');
    return backend.pending(actor(req),parsed.data);
  });
  server.get<{Params:{id:string}}>('/_aw/invocations/:id',async(req,reply)=>send(reply,backend.status(actor(req),req.params.id)));
  for (const method of ['confirm','cancel'] as const) server.post<{Params:{id:string}}>(`/_aw/invocations/:id/${method}`,async(req,reply)=>{
    if (Object.keys(inputs(req.query,req.body)).length) throw new ActionError(400,'INVALID_INPUT','确认和取消不能更改已保存的参数。');
    return send(reply,await backend[method](actor(req),req.params.id));
  });
  server.post('/_aw/assistant/messages',async(req,reply)=>{
    if (!chats) throw new ActionError(503,'AI_DISABLED','未启用 AI，普通业务 API 不受影响。');
    const stop=new AbortController(), disconnect=()=>{if (!reply.raw.writableEnded) stop.abort();};
    reply.raw.once('close',disconnect);
    if (reply.raw.destroyed) disconnect();
    try {
      const result=await chats.say(actor(req),req.body,stop.signal);
      return reply.code(result.type==='confirmation_required'?202:200).send(result);
    } finally { reply.raw.off('close',disconnect); }
  });
  return server;
}
