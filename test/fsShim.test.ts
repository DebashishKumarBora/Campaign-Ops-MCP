import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as shim from '../src/cloud/fs-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { memoryFileStore, splitText, sqlFileStore, useFileStore, type SqlLike } from '../src/cloud/fs-shim.js';
import { AuditLog } from '../src/governance/audit.js';

/** The real SQLite that ships with Node 22, shaped like a Durable Object's storage. Skipped on older Node. */
async function realSql(): Promise<SqlLike | undefined> {
  try {
    const { DatabaseSync } = (await import('node:sqlite' as string)) as { DatabaseSync: new (file: string) => { prepare(q: string): { all(...b: unknown[]): Record<string, unknown>[] } } };
    const db = new DatabaseSync(':memory:');
    // Like a Durable Object, a statement runs when exec is called, not when its rows are read.
    return {
      exec: (q: string, ...b: unknown[]) => {
        const rows = db.prepare(q).all(...b);
        return { toArray: () => rows };
      },
    };
  } catch {
    return undefined;
  }
}

test('long text is split without cutting an emoji in half', () => {
  const text = 'ab\u{1F600}cd';
  const parts = splitText(text, 3);
  assert.equal(parts.join(''), text);
  for (const p of parts) assert.ok(!/[\uD800-\uDBFF]$/.test(p), `piece ends inside a pair: ${JSON.stringify(p)}`);
  assert.deepEqual(splitText(''), ['']);
});

test('files bigger than one database row are stored across rows and read back exactly', async (t) => {
  const sql = await realSql();
  if (!sql) return t.skip('node:sqlite needs Node 22');
  const store = sqlFileStore(sql, 10);
  store.put('/data/a.txt', 'x'.repeat(25), 1);
  assert.equal(store.get('/data/a.txt')?.data, 'x'.repeat(25));
  assert.equal(sql.exec('SELECT COUNT(*) AS c FROM file_chunks WHERE path = ?', '/data/a.txt').toArray()[0].c, 3);
  store.append('/data/a.txt', '12345', 2); // fills the last row
  store.append('/data/a.txt', 'abcdefghijklmnop\u{1F600}', 3); // spills into new rows
  assert.equal(store.get('/data/a.txt')?.data, 'x'.repeat(25) + '12345' + 'abcdefghijklmnop\u{1F600}');
  assert.equal(store.get('/data/a.txt')?.mtime, 3);
  for (const row of sql.exec('SELECT data, len FROM file_chunks').toArray()) assert.equal(String(row.data).length, Number(row.len));
  store.put('/data/a.txt', 'short', 4);
  assert.equal(store.get('/data/a.txt')?.data, 'short');
  assert.equal(sql.exec('SELECT COUNT(*) AS c FROM file_chunks').toArray()[0].c, 1);
  store.put('/data/sub/b.json', '{}', 5);
  assert.deepEqual(store.list('/data/').sort(), ['/data/a.txt', '/data/sub/b.json']);
  store.delete('/data/a.txt');
  assert.equal(store.get('/data/a.txt'), undefined);
});

test('an audit log appended line by line across many rows reads back with its chain intact', async (t) => {
  const sql = await realSql();
  if (!sql) return t.skip('node:sqlite needs Node 22');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cops-chunks-'));
  try {
    // A real hash chain, written by the real audit log on disk.
    const original = new AuditLog(path.join(dir, 'audit.jsonl'));
    for (let i = 0; i < 25; i++) original.append({ ts: new Date(1_800_000_000_000 + i * 1000).toISOString(), type: 'proposal_created', actor: 'test', proposalId: `P-${String(i).padStart(4, '0')}`, details: { summary: `change ${i}`, note: 'é\u{1F600}'.repeat(i % 3) } });
    const raw = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8');
    // The same lines appended one at a time into small database rows, the way the cloud writes them.
    const store = sqlFileStore(sql, 300);
    for (const line of raw.split(/(?<=\n)/)) store.append('/data/audit.jsonl', line, 1);
    const rows = Number(sql.exec('SELECT COUNT(*) AS c FROM file_chunks WHERE path = ?', '/data/audit.jsonl').toArray()[0].c);
    assert.ok(rows > 5, `expected the log to span many rows, got ${rows}`);
    const back = store.get('/data/audit.jsonl')!.data;
    assert.equal(back, raw);
    fs.writeFileSync(path.join(dir, 'copy.jsonl'), back);
    const v = new AuditLog(path.join(dir, 'copy.jsonl')).verify();
    assert.equal(v.ok, true, v.problem);
    assert.equal(v.count, 25);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the node:fs stand-in behaves like the parts of fs the engine uses', () => {
  useFileStore(memoryFileStore());
  shim.writeFileSync('/data/x.json', '{"a":1}');
  assert.equal(shim.existsSync('/data/x.json'), true);
  assert.equal(shim.existsSync('/data'), true);
  assert.equal(shim.readFileSync('/data/x.json'), '{"a":1}');
  shim.appendFileSync('/data/log.jsonl', 'one\n');
  shim.appendFileSync('/data/log.jsonl', 'two\n');
  assert.equal(shim.readFileSync('/data/log.jsonl'), 'one\ntwo\n');
  shim.writeFileSync('/data/x.json.tmp', 'new');
  shim.renameSync('/data/x.json.tmp', '/data/x.json');
  assert.equal(shim.readFileSync('/data/x.json'), 'new');
  assert.equal(shim.existsSync('/data/x.json.tmp'), false);
  const fd = shim.openSync('/data/x.lock', 'wx');
  assert.throws(() => shim.openSync('/data/x.lock', 'wx'), (e: Error & { code?: string }) => e.code === 'EEXIST');
  shim.writeSync(fd, '1');
  shim.closeSync(fd);
  shim.unlinkSync('/data/x.lock');
  assert.throws(() => shim.readFileSync('/data/missing'), (e: Error & { code?: string }) => e.code === 'ENOENT');
  assert.deepEqual(shim.readdirSync('/data').sort(), ['log.jsonl', 'x.json']);
  assert.equal(shim.statSync('/data/x.json').isFile(), true);
});
