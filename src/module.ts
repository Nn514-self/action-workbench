import { DatabaseSync } from 'node:sqlite';
import { types } from 'node:util';
import { z } from 'zod';
import { ActionError } from './errors.js';

export interface Actor { readonly id: string; readonly tenantId: string; readonly permissions: readonly string[] }
export interface ActionContext { actor: Actor; invocationId: string }
export type Source = 'http' | 'ai';
type Route = { method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; path: string };
interface Definition<I extends z.ZodObject, O extends z.ZodType> {
  description: string; permission: string; http: Route; ai?: boolean | 'describe'; version?: number;
  input: I; output: O; modelOutput?: z.ZodType;
  run(ctx: ActionContext, input: z.output<I>): z.input<O> | Promise<z.input<O>>;
}
export interface Action {
  readonly description: string; readonly permission: string; readonly http: Readonly<Route>;
  readonly pathParameters: readonly string[];
  readonly ai: boolean; readonly advertised: boolean; readonly version: number; readonly kind: 'query' | 'command';
  readonly confirmation: 'required' | 'none'; readonly inputSchema: z.core.JSONSchema.JSONSchema;
  readonly outputSchema: z.core.JSONSchema.JSONSchema;
  readonly transactionDatabase?: DatabaseSync;
  readonly modelView?: (result: unknown) => unknown;
  bind(raw: unknown): (ctx: ActionContext) => unknown;
}
export function permits(actor: Actor, action: Action, source: Source): boolean {
  return actor.permissions.includes(action.permission) && (source === 'http' || (source === 'ai' && action.ai));
}
function action<I extends z.ZodObject, O extends z.ZodType>(kind: Action['kind'], d: Definition<I,O>, confirmation: Action['confirmation'], transactionDatabase?: DatabaseSync): Action {
  if (!d.description?.trim() || !d.permission?.trim() || typeof d.run !== 'function') throw new Error('An action needs description, permission and run');
  if (d.ai !== undefined && d.ai !== true && d.ai !== false && d.ai !== 'describe') throw new Error('Invalid AI exposure policy');
  const modelOutput=d.modelOutput;
  if (modelOutput!==undefined && (d.ai!==true || typeof modelOutput?.parse!=='function')) throw new Error('modelOutput requires an AI-callable action and a schema');
  if (kind==='query' && d.ai===true && !modelOutput) throw new Error('AI queries require an explicit modelOutput schema');
  if (!['none','required'].includes(confirmation) || !Number.isSafeInteger(d.version ?? 1) || (d.version ?? 1) < 1) throw new Error('Invalid action policy/version');
  if (!d.http || !['GET','POST','PUT','PATCH','DELETE'].includes(d.http.method) || (kind === 'command' && d.http.method === 'GET')) throw new Error('Invalid method for action');
  if (!/^\/(?:[a-zA-Z0-9_-]+|:[a-zA-Z][a-zA-Z0-9_]*)(?:\/(?:[a-zA-Z0-9_-]+|:[a-zA-Z][a-zA-Z0-9_]*))*$/.test(d.http.path) || /^\/_aw(?:\/|$)/.test(d.http.path)) throw new Error(`Invalid or reserved route: ${d.http.path}`);
  const inputSchema = z.toJSONSchema(d.input, { io: 'input' });
  if (inputSchema.type !== 'object' || inputSchema.additionalProperties !== false) throw new Error('Use z.strictObject for action input');
  const params = d.http.path.split('/').filter(s => s.startsWith(':')).map(s => s.slice(1));
  if (new Set(params).size !== params.length || params.some(p => !Object.hasOwn(inputSchema.properties ?? {}, p))) throw new Error(`Unbound path parameter: ${d.http.path}`);
  const outputSchema = z.toJSONSchema(d.output, {io:'output'});
  return Object.freeze({ kind, description:d.description, permission:d.permission, http:Object.freeze({...d.http}), pathParameters:Object.freeze(params),
    ai:d.ai === true, advertised:d.ai === true || d.ai === 'describe', version:d.version ?? 1,
    confirmation, inputSchema, outputSchema, transactionDatabase,
    modelView:modelOutput ? (value:unknown)=>{
      try { return modelOutput.parse(value); }
      catch { throw new ActionError(502,'MODEL_VIEW_UNAVAILABLE','没有可提供给模型的结果。'); }
    }:undefined,
    bind(raw: unknown) {
      const input = d.input.safeParse(raw);
      if (!input.success) { const issue = input.error.issues[0]; throw new ActionError(400, 'INVALID_INPUT', `${issue.path.join('.') || '输入'}：${issue.message}`); }
      if (transactionDatabase) return (ctx: ActionContext) => {
        const result: unknown = d.run(ctx, input.data);
        if (result !== null && (typeof result === 'object' || typeof result === 'function') && 'then' in result && typeof result.then === 'function') {
          // A native promise has already started; report failure via the receipt, not an unhandled rejection.
          if (types.isPromise(result)) void result.catch(() => {});
          throw new TypeError('sqliteCommand must return a synchronous result');
        }
        return d.output.parse(result);
      };
      return async (ctx: ActionContext) => d.output.parse(await d.run(ctx, input.data));
    },
  });
}
type QueryExposure = {ai:true; modelOutput:z.ZodType} | {ai?:false|'describe'; modelOutput?:never};
export function query<I extends z.ZodObject, O extends z.ZodType>(d: Definition<I,O> & QueryExposure): Action { return action('query', d, 'none'); }
export function command<I extends z.ZodObject, O extends z.ZodType>(d: Definition<I,O> & { confirmation?: Action['confirmation'] }): Action { return action('command', d, d.confirmation ?? 'required'); }

/** Only synchronous writes on this connection belong here. Network/other database work uses command(). */
export function sqliteCommand<I extends z.ZodObject, O extends z.ZodType>(
  database: DatabaseSync,
  d: Omit<Definition<I,O>, 'run'> & { confirmation?: Action['confirmation']; run(ctx: ActionContext, input: z.output<I>): z.input<O> },
): Action {
  if (!(database instanceof DatabaseSync)) throw new TypeError('sqliteCommand needs its SQLite connection');
  if (types.isAsyncFunction(d.run) || types.isGeneratorFunction(d.run)) throw new TypeError('sqliteCommand needs a synchronous handler');
  return action('command', d, d.confirmation ?? 'required', database);
}
export interface BusinessModule { readonly name: string; readonly actions: Readonly<Record<string, Action>> }
export function defineModule(name: string, actions: Record<string, Action>): BusinessModule {
  const valid = /^[a-z][a-zA-Z0-9_]{0,47}$/;
  if (!valid.test(name) || !Object.keys(actions).length || Object.keys(actions).some(k => !valid.test(k))) throw new Error(`Invalid module or action name: ${name}`);
  return Object.freeze({ name, actions: Object.freeze({...actions}) });
}
