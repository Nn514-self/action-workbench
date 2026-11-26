import type { DatabaseSync } from 'node:sqlite';
import type { Invocation } from './backend.js';
import { ActionError } from './errors.js';
import type { Action, ActionContext } from './module.js';

type Bound = ReturnType<Action['bind']>;
type Claim = () => Invocation | undefined; // Existing receipt, or a newly claimed running row.

function encode(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('Action output must be JSON');
  return json;
}

export function createCommandExecutor(db: DatabaseSync) {
  const finish = db.prepare("UPDATE aw_invocations SET state=?, output=?, error=? WHERE id=? AND state='running'");
  function save(id: string, state: string, output: string | null, error: string | null) {
    if (finish.run(state, output, error, id).changes !== 1) throw new Error('Command lost its journal claim');
  }
  function success(id: string, action: string, output: string): Invocation {
    save(id, 'succeeded', output, null);
    return {id, action, status:'succeeded', result:JSON.parse(output)};
  }
  function failure(id: string, action: string, cause: unknown, rolledBack: boolean): Invocation {
    const known = cause instanceof ActionError;
    const status = known || rolledBack ? 'failed' : 'unknown';
    const error = known ? {status:cause.status, code:cause.code, message:cause.message}
      : rolledBack ? {status:500, code:'ACTION_ROLLED_BACK', message:'本次业务写入已回滚。'}
      : {status:502, code:'OUTCOME_UNKNOWN', message:'未取得可信回执，请按调用编号核实，不要重新发起写入。'};
    save(id, status, null, JSON.stringify(error));
    return {id, action, status, error};
  }
  function local(ctx: ActionContext, name: string, bound: Bound): Invocation {
    // Keep the claim, but undo *all* business statements if validation or the handler fails.
    db.exec('SAVEPOINT aw_effect');
    let output: string;
    try { output = encode(bound(ctx)); }
    catch (cause) {
      db.exec('ROLLBACK TO aw_effect; RELEASE aw_effect');
      return failure(ctx.invocationId, name, cause, true);
    }
    db.exec('RELEASE aw_effect');
    return success(ctx.invocationId, name, output);
  }
  async function external(ctx: ActionContext, name: string, bound: Bound): Promise<Invocation> {
    let output: string;
    try { output = encode(await bound(ctx)); }
    catch (cause) { return failure(ctx.invocationId, name, cause, false); }
    return success(ctx.invocationId, name, output);
  }
  return function execute(ctx: ActionContext, name: string, bound: Bound, atomic: boolean, claim: Claim): Invocation | Promise<Invocation> {
    if (!atomic) return claim() ?? external(ctx, name, bound);
    // The claim itself must also roll back after a crash. Never await while holding this lock.
    db.exec('BEGIN IMMEDIATE');
    try {
      const receipt = claim() ?? local(ctx, name, bound);
      db.exec('COMMIT');
      return receipt;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  };
}
