import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** Append SQL steps; changing an already applied step is an error, not a silent migration. */
export function migrate(db: DatabaseSync, namespace: string, steps: readonly string[]): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS aw_migrations (namespace TEXT NOT NULL, version INTEGER NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(namespace,version))');
    const applied = db.prepare('SELECT version,digest FROM aw_migrations WHERE namespace=? ORDER BY version').all(namespace);
    if (applied.length > steps.length) throw new Error(`Database is newer than module ${namespace}`);
    const insert = db.prepare('INSERT INTO aw_migrations VALUES(?,?,?)');
    steps.forEach((sql, i) => {
      const digest = createHash('sha256').update(sql).digest('hex');
      if (i < applied.length) {
        if (applied[i].version !== i + 1 || applied[i].digest !== digest) throw new Error(`Migration changed: ${namespace}/${i+1}`);
      } else { db.exec(sql); insert.run(namespace, i+1, digest); }
    });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
