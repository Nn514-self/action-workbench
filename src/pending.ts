import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ActionError } from './errors.js';
import { permits, type Action, type Actor, type Source } from './module.js';

export interface PendingOptions { limit?: number; cursor?: string }
export interface PendingItem { id: string; action: string; source: Source; status: 'pending'; input: unknown; createdAt: number; expiresAt: number }
export interface PendingPage { items: PendingItem[]; nextCursor: string | null }
const row = z.object({id:z.string(), action:z.string(), source:z.enum(['ai','http']), args:z.string(), created:z.int(), expires:z.int()});
const cursorPattern = /^(0|[1-9]\d{0,15})\.([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/;
const invalidPage = () => new ActionError(400,'INVALID_PAGE','limit 必须为 1 到 100 的整数，cursor 必须是返回的分页标记。');

export function createPendingReader(db: DatabaseSync, actions: ReadonlyMap<string, Action>) {
  const list = db.prepare(`SELECT id,action,source,args,created,expires FROM aw_invocations
    WHERE tenant=? AND owner=? AND state='pending' AND expires>? AND (created,id)<(?,?)
      AND (action,version,source) IN (SELECT value ->> 0, value ->> 1, value ->> 2 FROM json_each(?))
    ORDER BY created DESC,id DESC LIMIT ?`);
  return function listPending(actor: Actor, {limit=20, cursor}: PendingOptions = {}): PendingPage {
    if (!Number.isSafeInteger(limit) || limit<1 || limit>100) throw invalidPage();
    let before = Number.MAX_SAFE_INTEGER, beforeId = '';
    if (cursor !== undefined) {
      const parts = typeof cursor === 'string' && cursorPattern.exec(cursor);
      if (!parts || !Number.isSafeInteger(Number(parts[1]))) throw invalidPage();
      before=Number(parts[1]); beforeId=parts[2];
    }
    // Filter by *current* grants/version/source before LIMIT. A cursor is a position, never authority.
    const grants: [string,number,Source][] = [];
    for (const [name, a] of actions) {
      if (a.kind !== 'command') continue;
      if (permits(actor,a,'http')) grants.push([name,a.version,'http']);
      if (permits(actor,a,'ai')) grants.push([name,a.version,'ai']);
    }
    if (!grants.length) return {items:[], nextCursor:null};
    const rows = list.all(actor.tenantId,actor.id,Date.now(),before,beforeId,JSON.stringify(grants),limit+1);
    const hasNext = rows.length>limit;
    if (hasNext) rows.pop();
    const items = rows.map((raw): PendingItem => {
      const r = row.parse(raw);
      return {id:r.id, action:r.action, source:r.source, status:'pending', input:JSON.parse(r.args), createdAt:r.created, expiresAt:r.expires};
    });
    const last = items.at(-1);
    return {items,nextCursor:hasNext && last ? `${last.createdAt}.${last.id}` : null};
  };
}
