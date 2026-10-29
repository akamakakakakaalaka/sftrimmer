import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncIOSBundle } from '../tools/sync-ios.mjs';

test('sync copies exact binary bytes and replaces stale bundled assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project128-sync-'));
  try {
    const source = join(root, 'dist');
    const destination = join(root, 'WebBundle');
    await mkdir(join(source, 'assets'), { recursive: true });
    await mkdir(destination);
    await writeFile(join(source, 'index.html'), '<html>offline</html>');
    await writeFile(join(source, 'assets', 'engine.wasm'), Buffer.from([0, 255, 128, 1]));
    await writeFile(join(destination, 'stale.js'), 'old');
    const result = await syncIOSBundle(source, destination);
    assert.equal(result.files, 2);
    assert.equal(result.bytes, 24);
    assert.deepEqual(await readFile(join(destination, 'assets', 'engine.wasm')), Buffer.from([0, 255, 128, 1]));
    await assert.rejects(readFile(join(destination, 'stale.js')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('invalid or linked sources preserve the existing bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project128-sync-'));
  try {
    const source = join(root, 'dist');
    const destination = join(root, 'WebBundle');
    await mkdir(source);
    await mkdir(destination);
    await writeFile(join(destination, 'index.html'), 'existing');
    await assert.rejects(syncIOSBundle(source, destination));
    assert.equal(await readFile(join(destination, 'index.html'), 'utf8'), 'existing');
    await writeFile(join(source, 'index.html'), 'new');
    await symlink(join(destination, 'index.html'), join(source, 'linked.js'));
    await assert.rejects(syncIOSBundle(source, destination), /symbolic/i);
    assert.equal(await readFile(join(destination, 'index.html'), 'utf8'), 'existing');
  } finally { await rm(root, { recursive: true, force: true }); }
});
