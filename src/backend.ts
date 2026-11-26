import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { ActionError, proposalChanged, unavailable } from './errors.js';
import { migrate } from './migrations.js';
import { createCommandExecutor } from './execution.js';
import { createPendingReader, type PendingOptions, type PendingPage } from './pending.js';
import { permits, type Action, type Actor, type BusinessModule, type Source } from './module.js';
import { describeHttp, type ApiDocument } from './openapi.js';

type State = 'pending' | 'running' | 'succeeded' | 'cancelled' | 'expired' | 'failed' | 'unknown';
interface Failure { status: number; code: string; message: string }
export interface Invocation { id: string; action: string; status: State; input?: unknown; expiresAt?: number; result?: unknown; error?: Failure }
interface Row { id: string; action: string; version: number; source: Source; args: string; state: State; expires: number; output: string | null; error: string | null }
export type Tool = Pick<Action,'description'|'kind'|'inputSchema'> & { name: string };
export interface Capability { name: string; description: string; mode: 'manual' | 'assistant' }
export interface BackendOptions { modules: readonly BusinessModule[]; database: DatabaseSync; confirmationTtlMs?: number }
export interface Backend {
  readonly routes: readonly (Action['http'] & {name: string})[];
  discover(actor: Actor, source?: Source): Tool[];
  capabilities(actor: Actor): Capability[];
  openApi(actor: Actor): ApiDocument;
  invoke(actor: Actor, name: string, input: unknown, options?: { source?: Source; idempotencyKey?: string }): Promise<Invocation>;
  pending(actor: Actor, options?: PendingOptions): PendingPage;
  status(actor: Actor, id: string, source?: Source): Invocation;
  revise(actor: Actor, proposalId: string, input: unknown): Invocation;
  cancel(actor: Actor, id: string): Invocation;
  confirm(actor: Actor, id: string): Promise<Invocation>;
}
function receipt(row: Row): Invocation {
  const common = { id: row.id, action: row.action, status: row.state };
  if (row.state === 'pending') return { ...common, input: JSON.parse(row.args), expiresAt: row.expires };
  if (row.output !== null) return { ...common, result: JSON.parse(row.output) };
  if (row.error !== null) return { ...common, error: JSON.parse(row.error) };
  return common;
}
export function requireActor(actor: Actor | null | undefined): asserts actor is Actor {
  if (typeof actor?.id !== 'string' || !actor.id.trim() || typeof actor.tenantId !== 'string' || !actor.tenantId.trim() ||
    !Array.isArray(actor.permissions) || !actor.permissions.every(p=>typeof p==='string' && p.trim())) throw new ActionError(401,'UNAUTHENTICATED','请先认证。');
}
export function createBackend({ modules, database: db, confirmationTtlMs = 300_000 }: BackendOptions): Backend {
  if (!Number.isSafeInteger(confirmationTtlMs) || confirmationTtlMs <= 0) throw new Error('Invalid confirmation TTL');
  const registry = new Map<string, Action>(), routes = new Set<string>(), names = new Set<string>();
  for (const mod of modules) {
    if (names.has(mod.name)) throw new Error(`Duplicate module: ${mod.name}`);
    names.add(mod.name);
    for (const [key, action] of Object.entries(mod.actions)) {
      if (action.transactionDatabase && action.transactionDatabase !== db) throw new Error(`sqliteCommand ${mod.name}.${key} must use the backend's database connection`);
      const pathKey = `${action.http.method} ${action.http.path.replace(/:[^/]+/g, ':')}`;
      if (routes.has(pathKey)) throw new Error(`Duplicate route: ${pathKey}`);
      routes.add(pathKey); registry.set(`${mod.name}.${key}`, action);
    }
  }
  migrate(db, '@workbench', [`CREATE TABLE aw_invocations (
    id TEXT PRIMARY KEY NOT NULL, tenant TEXT NOT NULL, owner TEXT NOT NULL, idem TEXT,
    action TEXT NOT NULL, version INTEGER NOT NULL, source TEXT NOT NULL, args TEXT NOT NULL,
    state TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, output TEXT, error TEXT,
    UNIQUE(tenant,owner,idem))`,
    `CREATE INDEX aw_pending_owner ON aw_invocations(tenant,owner,created DESC,id DESC) WHERE state='pending'`]);
  const insert = db.prepare('INSERT INTO aw_invocations(id,tenant,owner,idem,action,version,source,args,state,created,expires) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant,owner,idem) DO NOTHING');
  const get = db.prepare('SELECT * FROM aw_invocations WHERE id=? AND tenant=? AND owner=?');
  const keyed = db.prepare('SELECT * FROM aw_invocations WHERE tenant=? AND owner=? AND idem=?');
  const move = db.prepare("UPDATE aw_invocations SET state=? WHERE id=? AND state='pending' AND expires>?");
  const expire = db.prepare("UPDATE aw_invocations SET state='expired' WHERE id=? AND state='pending' AND expires<=?");
  const execute = createCommandExecutor(db), listPending = createPendingReader(db, registry);
  function lookup(actor: Actor, name: string, source: Source) {
    requireActor(actor);
    const action = registry.get(name);
    if (!action || !permits(actor,action,source)) throw unavailable();
    return action;
  }
  function rowFor(actor: Actor, id: string): Row {
    requireActor(actor);
    let row = get.get(id, actor.tenantId, actor.id) as unknown as Row | undefined;
    if (!row) throw unavailable();
    lookup(actor, row.action, row.source);
    if (row.state === 'pending' && row.expires <= Date.now()) {
      expire.run(id, Date.now()); row = get.get(id, actor.tenantId, actor.id) as unknown as Row;
    }
    return row;
  }
  function currentCommand(actor: Actor, row: Row) {
    const action = lookup(actor,row.action,row.source);
    if (action.kind !== 'command' || action.version !== row.version) throw new ActionError(409,'ACTION_CHANGED','动作已升级，请重新发起确认。');
    return action;
  }
  function visibleReceipt(actor:Actor,row:Row,source:Source):Invocation {
    if (source==='http') return receipt(row);
    if (source!=='ai' || row.source!=='ai') throw unavailable();
    const action=lookup(actor,row.action,'ai');
    if (row.state==='pending') return receipt(row);
    const visible:Invocation={id:row.id,action:row.action,status:row.state};
    if (row.state==='succeeded' && row.version===action.version && row.output!==null && action.modelView) {
      try { visible.result=action.modelView(JSON.parse(row.output)); }
      catch (error) { if (!(error instanceof ActionError) || error.code!=='MODEL_VIEW_UNAVAILABLE') throw error; }
    }
    return visible;
  }
  return {
    routes: Object.freeze([...registry].map(([name, a]) => ({name, ...a.http}))),
    discover(actor: Actor, source: Source = 'http'): Tool[] {
      requireActor(actor);
      return [...registry].filter(([,a]) => permits(actor,a,source)).map(([name,a]) => ({name, description:a.description, kind:a.kind, inputSchema:a.inputSchema}));
    },
    capabilities(actor) {
      requireActor(actor);
      const visible: Capability[] = [];
      for (const [name,a] of registry) if (a.advertised && permits(actor,a,'http')) {
        visible.push({name,description:a.description,mode:a.ai?'assistant':'manual'});
      }
      return visible;
    },
    openApi(actor) { requireActor(actor); return describeHttp(registry,actor); },
    async invoke(actor: Actor, name: string, input: unknown, options: { source?: Source; idempotencyKey?: string } = {}): Promise<Invocation> {
      const {source='http'}=options, action=lookup(actor,name,source);
      const bound = action.bind(input), id = randomUUID();
      if (action.kind === 'query') {
        const value=await bound({actor,invocationId:id});
        return {id,action:name,status:'succeeded',result:source==='ai' ? action.modelView?.(value) : value};
      }
      const key = options.idempotencyKey ?? null;
      if (key !== null && (typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key))) throw new ActionError(400,'INVALID_IDEMPOTENCY_KEY','无效的幂等键。');
      const raw = JSON.stringify(input), now = Date.now(), pending = action.confirmation === 'required' || source === 'ai';
      const reserve = (): Invocation | undefined => {
        if (insert.run(id,actor.tenantId,actor.id,key,name,action.version,source,raw,pending?'pending':'running',now,now+confirmationTtlMs).changes) return;
        const old = keyed.get(actor.tenantId, actor.id, key) as unknown as Row;
        if (old.action !== name || old.version !== action.version || old.source !== source || !isDeepStrictEqual(JSON.parse(old.args),JSON.parse(raw))) throw new ActionError(409,'IDEMPOTENCY_CONFLICT','该幂等键已绑定其他请求。');
        return visibleReceipt(actor,rowFor(actor,old.id),source);
      };
      if (pending) return reserve() ?? {id,action:name,status:'pending',input:JSON.parse(raw),expiresAt:now+confirmationTtlMs};
      return execute({actor,invocationId:id},name,bound,!!action.transactionDatabase,reserve);
    },
    pending(actor, options) { requireActor(actor); return listPending(actor,options); },
    status(actor, id, source='http') {
      return visibleReceipt(actor,rowFor(actor,id),source);
    },
    revise(actor, proposalId, input) {
      requireActor(actor);
      // Serialize with confirmation on other connections. Never cancel a proposal without creating its replacement.
      db.exec('BEGIN IMMEDIATE');
      try {
        const old = rowFor(actor,proposalId);
        if (old.source !== 'ai') throw unavailable();
        if (old.state !== 'pending') throw proposalChanged();
        const action=currentCommand(actor,old), args=JSON.stringify(input);
        if (args===undefined) throw new ActionError(400,'INVALID_INPUT','需要完整的业务参数。');
        const wire=JSON.parse(args), original=JSON.parse(old.args);
        action.bind(wire);
        for (const key of action.pathParameters) if (!isDeepStrictEqual(original[key],wire[key])) {
          throw new ActionError(409,'REVISION_TARGET_CHANGED','不能把同一个提议改为操作另一条记录。');
        }
        const now=Date.now();
        if (old.expires <= now) throw proposalChanged();
        let result: Invocation;
        if (isDeepStrictEqual(wire,original)) result=receipt(old);
        else {
          if (!move.run('cancelled',old.id,now).changes) throw proposalChanged();
          const id=randomUUID(), expiresAt=now+confirmationTtlMs;
          insert.run(id,actor.tenantId,actor.id,null,old.action,old.version,'ai',args,'pending',now,expiresAt);
          result={id,action:old.action,status:'pending',input:wire,expiresAt};
        }
        db.exec('COMMIT'); return result;
      } catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); throw e; }
    },
    cancel(actor: Actor, id: string): Invocation { rowFor(actor,id); move.run('cancelled',id,Date.now()); return receipt(rowFor(actor,id)); },
    async confirm(actor: Actor, id: string): Promise<Invocation> {
      const row = rowFor(actor,id);
      if (row.state !== 'pending') return receipt(row);
      const action = currentCommand(actor,row);
      const bound = action.bind(JSON.parse(row.args));
      return execute({actor,invocationId:id},row.action,bound,!!action.transactionDatabase,
        () => move.run('running',id,Date.now()).changes ? undefined : receipt(rowFor(actor,id)));
    },
  };
}
