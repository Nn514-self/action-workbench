import {mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
export function openStore() {
  if (process.platform!=='win32') process.umask(0o077);
  const dir=resolve(process.env.ROOMS_DATA_DIR || '.data');mkdirSync(dir,{recursive:true,mode:0o700});
  const db=new DatabaseSync(join(dir,'rooms.sqlite'));db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');return db;
}
