import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBackend } from 'action-workbench';
import { createHttpServer } from 'action-workbench/http';
import { localCodex } from 'action-workbench/codex';
import { expensesModule } from './expenses.ts';
import { ordersModule } from './orders.ts';

const token=process.env.WORKBENCH_TOKEN;
if (!token || Buffer.byteLength(token)<32) throw new Error('WORKBENCH_TOKEN must be a private token of at least 32 bytes; see README.');
const digest=createHash('sha256').update(token).digest();
const port=Number(process.env.PORT || 4881);
if (!Number.isInteger(port) || port<0 || port>65535) throw new Error('Invalid PORT');
if (process.platform!=='win32') process.umask(0o077);
const dir=resolve(process.env.ACTION_DATA_DIR || '.data');
mkdirSync(dir,{recursive:true,mode:0o700});
const db=new DatabaseSync(join(dir,'product.sqlite'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
const backend=createBackend({database:db,modules:[ordersModule(db), expensesModule(db)]});
const ai=process.argv.includes('--ai');
const provider=ai ? localCodex() : null;
const server=createHttpServer(backend,{provider, authenticate(req) {
  const authorization=req.headers.authorization;
  if (!authorization?.startsWith('Bearer ') || !timingSafeEqual(digest,createHash('sha256').update(authorization.slice(7)).digest())) return null;
  // This local starter has one user. Replace this adapter with your trusted identity service for deployment.
  return {id:'developer',tenantId:'local',permissions:['orders:read','orders:write','orders:ship','expenses:read','expenses:write']};
}});
server.addHook('onClose',async()=>db.close());
for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{void server.close()});
console.log(`Business API: ${await server.listen({port,host:'127.0.0.1'})} | AI: ${provider?.label ?? (ai ? 'Codex not installed (HTTP available)' : 'off')}`);
