import {directory} from './access.ts';
import {openStore} from './store.ts';
const [mode,tenant,user,role,...extra]=process.argv.slice(2);
if (!tenant || !user || extra.length || !(mode==='grant' && role || mode==='revoke' && !role)) throw new Error('Usage: npm run access -- grant TENANT USER viewer|staff|manager, or revoke TENANT USER. For grant, set ROOMS_USER_TOKEN in the environment.');
const db=openStore();try {
  const users=directory(db);
  if (mode==='grant') users.grant(tenant,user,role,process.env.ROOMS_USER_TOKEN || ''); else users.revoke(tenant,user);
  console.log('Access updated.');
} finally {db.close()}
