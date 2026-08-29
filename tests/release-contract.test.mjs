import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const index = await readFile(resolve(root, 'index.html'), 'utf8');
const serviceWorker = await readFile(resolve(root, 'sw.js'), 'utf8');

test('media teardown restores a playable control shell after an active directory is removed', () => {
  assert.match(index, /function teardownMediaElement\(/);
  assert.match(index, /restoreMediaArea\(\{ empty: true \}\)/);
  assert.match(index, /async function renderMediaElement\(file\)/);
});

test('directory records use stable ids and no longer use names as persistent identities', () => {
  assert.match(index, /const MEDIA_DIRS_KEY = 'mediaDirsV2'/);
  assert.match(index, /LAST_USED_DIR_ID_KEY/);
  assert.match(index, /id: createClipDiagnosticId\('dir'\)/);
});

test('media scan defers Object URL creation until a file is selected', () => {
  assert.doesNotMatch(index, /url:\s*URL\.createObjectURL\(file\)/);
  assert.match(index, /activeMediaUrl = URL\.createObjectURL\(localFile\)/);
});

test('offline app shell does not atomically precache the FFmpeg Wasm payload', () => {
  assert.doesNotMatch(serviceWorker, /ffmpeg-core\.wasm/);
  assert.match(serviceWorker, /CACHE_VERSION = 'framedeck-v20-20260829-3'/);
});
