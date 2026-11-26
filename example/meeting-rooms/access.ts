import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {migrate, type Actor} from 'action-workbench';
import {z} from 'zod';

const roles=z.enum(['viewer','staff','manager']);
const read=['rooms:read','bookings:read'], staff=[...read,'bookings:write'];
const permissions={viewer:read,staff,manager:[...staff,'rooms:manage']};
const principal=z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const validToken=/^[A-Za-z0-9_-]{32,256}$/;
const digest=(token:string)=>createHash('sha256').update(token).digest('hex');
export function directory(db:DatabaseSync) {
  migrate(db,'room-access',[`CREATE TABLE room_accounts(tenant TEXT NOT NULL, userId TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('viewer','staff','manager')),tokenHash TEXT NOT NULL UNIQUE,PRIMARY KEY(tenant,userId))`]);
  const get=db.prepare('SELECT tenant,userId,role FROM room_accounts WHERE tokenHash=?');
  const set=db.prepare(`INSERT INTO room_accounts(tenant,userId,role,tokenHash) VALUES(?,?,?,?) ON CONFLICT(tenant,userId) DO UPDATE SET role=excluded.role,tokenHash=excluded.tokenHash`);
  const remove=db.prepare('DELETE FROM room_accounts WHERE tenant=? AND userId=?');
  return {
    grant(tenant:string,user:string,role:string,token:string) {
      if (!validToken.test(token)) throw new Error('Use a random private token of 32–256 base64url characters.');
      set.run(principal.parse(tenant),principal.parse(user),roles.parse(role),digest(token));
    },
    revoke(tenant:string,user:string) { remove.run(principal.parse(tenant),principal.parse(user)); },
    authenticate(header:string|undefined): Actor|null {
      if (!header?.startsWith('Bearer ')) return null;
      const token=header.slice(7); if (!validToken.test(token)) return null;
      const r=get.get(digest(token)); if (!r || typeof r.tenant!=='string' || typeof r.userId!=='string') return null;
      return {tenantId:r.tenant,id:r.userId,permissions:permissions[roles.parse(r.role)]};
    },
  };
}
