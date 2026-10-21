// The deploy step stamps a copy of the site with the release version; check the copy still hangs together.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stampSite } from '../scripts/stamp.mjs';

const root = path.resolve(import.meta.dirname, '..');

function stampedCopy(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shanghai-site-'));
  fs.copyFileSync(path.join(root, 'index.html'), path.join(dir, 'index.html'));
  fs.cpSync(path.join(root, 'js'), path.join(dir, 'js'), { recursive: true });
  stampSite(dir, version);
  return dir;
}

test('index.html points at stamped files and carries the version', () => {
  const html = fs.readFileSync(path.join(stampedCopy('abc123'), 'index.html'), 'utf8');
  assert.match(html, /<meta name="app-version" content="abc123" \/>/);
  assert.match(html, /<meta name="app-released" content="\d{4}-\d\d-\d\dT[\d:.]+Z" \/>/);
  assert.match(html, /href="css\/style\.css\?v=abc123"/);
  assert.match(html, /src="js\/main\.js\?v=abc123"/);
  assert.match(html, /src="vendor\/peerjs\.min\.js\?v=abc123"/);
  assert.match(html, /href="manifest\.webmanifest"/); // left alone
});

test('every import between modules is stamped the same way', () => {
  const dir = stampedCopy('abc123');
  for (const name of fs.readdirSync(path.join(dir, 'js'))) {
    const src = fs.readFileSync(path.join(dir, 'js', name), 'utf8');
    const imports = [...src.matchAll(/from\s+'(\.\/[^']+)'/g)].map((m) => m[1]);
    for (const spec of imports) assert.match(spec, /\.js\?v=abc123$/, `${name} imports ${spec}`);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8')), { version: 'abc123' });
});

test('the stamped modules still load together', async () => {
  const dir = stampedCopy('abc123');
  const host = await import(pathToFileURL(path.join(dir, 'js', 'host.js')).href + '?v=abc123');
  assert.equal(typeof host.HostSession, 'function');
});
