import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const names = [
  'sourceOperationBlocked', 'updateSourceDeleteControls', 'runSourceOperation',
  'hasActiveSourceExports', 'getSourceDeleteError', 'deleteSourceEntry',
  'verifyPermission', 'handlesMatch', 'renderPlaylist', 'updateControls',
  'teardownMediaElement', 'renderMediaElement', 'playMedia', 'restoreMediaArea',
  'renamePlaylistEntry', 'copyEntryToTargetDir', 'removeFromSavedDirs', 'enqueueClipJob',
  'syncPlaylistSourceUI', 'hasReadableMediaSource', 'getEntryFile',
  'cancelPendingPlaylistClick', 'rememberPlaylistSession', 'captureCurrentPlaybackState',
  'restoreCurrentPlaybackState',
];
const source = names.map((name) => {
  const match = html.match(new RegExp(`(?:async )?function ${name}\\([^]*?^        \\}$`, 'm'));
  assert.ok(match, name);
  return match[0];
}).join('\n');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(count = 3) {
  const nodes = new Map();
  class Element {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.style = {}; this.attrs = {}; this.classList = { toggle() {} }; }
    set innerHTML(value) { this.html = value; this.children = []; }
    get innerHTML() { return this.html || ''; }
    appendChild(child) { this.children.push(child); return child; }
    setAttribute(name, value) { this.attrs[name] = value; }
    removeAttribute(name) { delete this.attrs[name]; }
    addEventListener() {}
    pause() { this.paused = true; }
    load() {}
    async play() { this.played = true; }
  }
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, Object.assign(new Element(), { id }));
      return nodes.get(id);
    },
    createElement(tag) { return new Element(tag); },
    querySelector(selector) { return this.getElementById(selector); },
    querySelectorAll(selector) {
      if (selector !== '.source-delete') return [];
      return [this.getElementById('deleteSourceBtn'), ...this.getElementById('playlist').children.flatMap(li => li.children.filter(n => n.className === 'source-delete'))];
    },
  };
  const calls = [], toasts = [], revoked = [];
  const c = vm.createContext({
    document, console, setTimeout, clearTimeout,
    window: { confirm(message) { calls.push(['confirm', message]); return true; } },
    URL: { createObjectURL() { calls.push(['url']); return 'blob:new'; }, revokeObjectURL(url) { revoked.push(url); } },
    playlist: [], currentIndex: 0, dirHandle: {}, sourceOperation: null,
    activePlaylistSource: 'directory', playMode: 'single',
    playlistSessions: {
      directory: { entries: [], currentIndex: -1, playMode: 'single', dirHandle: null, playbackState: null },
      drop: { entries: [], currentIndex: -1, playMode: 'list', dirHandle: null, playbackState: null },
    },
    clipTasks: [], mediaElement: new Element('video'), activeMediaUrl: 'blob:old',
    mediaRenderRequestId: 0, mediaVisualizerCleanup: null, isPlaying: true,
    pendingPlaybackRestore: null,
    playlistClickTimer: null, trackAudioSpectrum: false, isMuted: true,
    showToast(message, options) { toasts.push({ message, options }); },
    resetClipPoints() { c.clipResets = (c.clipResets || 0) + 1; },
    initControlOverlayEvents() {}, clipLog() {}, serializeClipError(e) { return { message: e.message }; },
    updateClipDockUI() {}, createClipDiagnosticId() { return 'test'; },
    renamePlaylistEntryUnlocked() { throw new Error('Unexpected rename'); },
    copyEntryToTargetDirUnlocked() { throw new Error('Unexpected copy'); },
    removeFromSavedDirsUnlocked() { throw new Error('Unexpected saved-dir write'); },
  });
  for (let i = 0; i < count; i++) {
    const entry = { sourceKind: 'directory', name: `${i}.png`, relativePath: `nested/${i}.png`, mediaKind: 'image' };
    entry.fileHandle = { kind: 'file', async getFile() { return { type: 'image/png' }; }, async isSameEntry(other) { return other === this; } };
    entry.parentDirHandle = {
      async queryPermission(opts) { calls.push(['queryPermission', opts.mode]); return 'granted'; },
      async requestPermission(opts) { calls.push(['requestPermission', opts.mode]); return 'granted'; },
      async getFileHandle(name, opts) { calls.push(['getFileHandle', name, opts.create]); return entry.fileHandle; },
      async removeEntry(name, opts) { calls.push(['removeEntry', name, opts.recursive]); },
    };
    c.playlist.push(entry);
  }
  vm.runInContext(source, c);
  c.renderPlaylist();
  return { c, calls, toasts, revoked, document };
}
const removes = f => f.calls.filter(x => x[0] === 'removeEntry');

test('cancel describes exact path and permanent deletion and does no filesystem IO', async () => {
  const f = fixture(); const { c, calls, document } = f;
  c.window.confirm = message => { calls.push(['confirm', message]); return false; };
  const before = c.mediaElement;
  assert.equal(await c.deleteSourceEntry(c.playlist[0]), false);
  assert.deepEqual(calls.map(x => x[0]), ['confirm']);
  assert.match(calls[0][1], /nested\/0.png/);
  for (const phrase of ['永久删除本地源文件', '不只是从播放列表移除', '不会移入回收站']) assert.ok(calls[0][1].includes(phrase));
  assert.equal(c.playlist.length, 3); assert.equal(c.mediaElement, before);
  assert.equal(c.sourceOperation, null); assert.equal(document.getElementById('deleteSourceBtn').disabled, false);
});

test('noncurrent deletion uses exact parent/name, is nonrecursive and preserves active media/index', async () => {
  const f = fixture(); const { c } = f; c.currentIndex = 2;
  const selected = c.playlist[2], before = c.mediaElement;
  assert.equal(await c.deleteSourceEntry(c.playlist[0]), true);
  assert.deepEqual(removes(f), [['removeEntry', '0.png', false]]);
  assert.ok(f.calls.some(x => x[0] === 'queryPermission' && x[1] === 'readwrite'));
  assert.equal(c.currentIndex, 1); assert.equal(c.playlist[1], selected);
  assert.equal(c.mediaElement, before); assert.equal(c.isPlaying, true); assert.deepEqual(f.revoked, []);
});

for (const index of [0, 1, 2]) test(`current deletion at ${index} releases media and selects next or previous`, async () => {
  const f = fixture(); const { c } = f; c.currentIndex = index;
  const old = c.mediaElement, target = c.playlist[index], next = c.playlist[index === 2 ? 1 : index + 1];
  assert.equal(await c.deleteSourceEntry(target), true);
  assert.equal(c.playlist[c.currentIndex], next); assert.equal(target.deleted, true);
  assert.equal(old.paused, true); assert.equal(f.revoked[0], 'blob:old');
  assert.equal(c.mediaElement.tagName, 'IMG'); assert.equal(f.document.getElementById('currentMedia').textContent, next.name);
});

test('last item produces genuine empty state, clears media and resets controls', async () => {
  const f = fixture(1); const { c, document } = f;
  await c.deleteSourceEntry(c.playlist[0]);
  assert.equal(c.currentIndex, -1); assert.equal(c.playlist.length, 0);
  assert.equal(c.mediaElement, null); assert.equal(c.activeMediaUrl, null); assert.equal(c.isPlaying, false);
  assert.match(document.getElementById('#mediaEmptyState h1').textContent, /当前目录没有媒体文件/);
  assert.equal(document.getElementById('playlistEmpty').hidden, false);
  for (const id of ['deleteSourceBtn', 'playPauseBtn', 'prevBtn', 'nextBtn', 'speedControl', 'screenshotBtn', 'copyFileBtn']) assert.equal(document.getElementById(id).disabled, true, id);
  assert.ok(c.clipResets > 0);
});

for (const mode of ['denied', 'query-rejected', 'request-rejected', 'security', 'remove-failed', 'identity-changed', 'missing']) test(`${mode} keeps item/media and restores buttons with actionable error`, async () => {
  const f = fixture(); const { c, document } = f; const entry = c.playlist[0], before = c.mediaElement;
  const fail = name => { throw Object.assign(new Error('failure'), { name }); };
  if (['denied', 'request-rejected', 'security'].includes(mode)) entry.parentDirHandle.queryPermission = async () => 'prompt';
  if (mode === 'denied') entry.parentDirHandle.requestPermission = async () => 'denied';
  if (mode === 'query-rejected') entry.parentDirHandle.queryPermission = async () => fail('NotAllowedError');
  if (mode === 'request-rejected') entry.parentDirHandle.requestPermission = async () => fail('NotAllowedError');
  if (mode === 'security') entry.parentDirHandle.requestPermission = async () => fail('SecurityError');
  if (mode === 'remove-failed') entry.parentDirHandle.removeEntry = async () => fail('NoModificationAllowedError');
  if (mode === 'identity-changed') entry.parentDirHandle.getFileHandle = async () => ({});
  if (mode === 'missing') entry.parentDirHandle.getFileHandle = async () => fail('NotFoundError');
  assert.equal(await c.deleteSourceEntry(entry), false);
  assert.equal(c.playlist[0], entry); assert.equal(c.playlist.length, 3); assert.equal(c.mediaElement, before);
  assert.equal(entry.deleted, undefined); assert.equal(c.sourceOperation, null);
  assert.equal(document.getElementById('deleteSourceBtn').disabled, false);
  assert.match(f.toasts.at(-1).message, /未删除.*(重新|检查)/);
  assert.equal(removes(f).length, 0);
});

test('pending delete blocks duplicates, rename, copy, directory removal/switch and export enqueue', async () => {
  const f = fixture(); const { c, document } = f; const gate = deferred();
  c.playlist[0].parentDirHandle.queryPermission = () => gate.promise;
  const pending = c.deleteSourceEntry(c.playlist[0]);
  assert.equal(document.getElementById('deleteSourceBtn').disabled, true);
  assert.equal(await c.deleteSourceEntry(c.playlist[0]), false);
  assert.equal(await c.deleteSourceEntry(c.playlist[1]), false);
  assert.equal(await c.renamePlaylistEntry(0, 'other.png'), false);
  assert.equal(await c.copyEntryToTargetDir(c.playlist[0]), false);
  assert.equal(await c.removeFromSavedDirs({}), false);
  assert.equal(await c.runSourceOperation('打开媒体目录', () => { throw Error('must not switch'); }), false);
  assert.equal(c.enqueueClipJob({ a: 0, b: 1 }), false);
  gate.resolve('granted'); await pending;
  assert.equal(removes(f).length, 1); assert.equal(c.sourceOperation, null);
  assert.equal(document.getElementById('deleteSourceBtn').disabled, false);
});

test('rename/copy/directory operation already pending blocks deletion before confirmation', async () => {
  for (const [wrapper, inner, args] of [
    ['renamePlaylistEntry', 'renamePlaylistEntryUnlocked', [0, 'new.png']],
    ['copyEntryToTargetDir', 'copyEntryToTargetDirUnlocked', [{}]],
    ['removeFromSavedDirs', 'removeFromSavedDirsUnlocked', [{}]],
  ]) {
    const f = fixture(), gate = deferred(); f.c[inner] = () => gate.promise;
    const pending = f.c[wrapper](...args);
    assert.equal(await f.c.deleteSourceEntry(f.c.playlist[0]), false);
    assert.equal(f.calls.length, 0); gate.resolve(true); await pending;
  }
});

for (const status of ['pending', 'running', 'loading-ffmpeg']) test(`export ${status} blocks delete without prompting or disk IO`, async () => {
  const f = fixture(); f.c.clipTasks = [{ status, sourceEntry: f.c.playlist[0] }];
  assert.equal(await f.c.deleteSourceEntry(f.c.playlist[0]), false);
  assert.equal(f.calls.length, 0); assert.match(f.toasts.at(-1).message, /等待导出完成/);
});

test('selection changes during permission prompt do not change deletion target or restart new playback', async () => {
  const f = fixture(); const { c } = f, gate = deferred(), target = c.playlist[0];
  target.parentDirHandle.queryPermission = () => gate.promise;
  const pending = c.deleteSourceEntry(target);
  await c.playMedia(2); const selected = c.playlist[2], rendered = c.mediaElement;
  gate.resolve('granted'); await pending;
  assert.deepEqual(removes(f), [['removeEntry', '0.png', false]]);
  assert.equal(c.playlist[c.currentIndex], selected); assert.equal(c.mediaElement, rendered);
});

for (const change of ['list', 'directory', 'name', 'handle']) test(`stale ${change} during permission check aborts without removeEntry`, async () => {
  const f = fixture(), { c } = f, gate = deferred(), entry = c.playlist[0];
  entry.parentDirHandle.queryPermission = () => gate.promise;
  const pending = c.deleteSourceEntry(entry);
  if (change === 'list') c.playlist = [...c.playlist];
  if (change === 'directory') c.dirHandle = {};
  if (change === 'name') entry.name = 'renamed.png';
  if (change === 'handle') entry.fileHandle = {};
  gate.resolve('granted'); assert.equal(await pending, false); assert.equal(removes(f).length, 0);
});

test('list changed after removeEntry started is not spliced on late completion', async () => {
  const f = fixture(), { c } = f, gate = deferred(), started = deferred(), entry = c.playlist[0];
  entry.parentDirHandle.removeEntry = async () => { started.resolve(); await gate.promise; };
  const pending = c.deleteSourceEntry(entry); await started.promise;
  const replacement = [{ name: 'unrelated.png' }]; c.playlist = replacement; c.currentIndex = 0;
  gate.resolve(); assert.equal(await pending, true);
  assert.equal(c.playlist, replacement); assert.equal(c.playlist.length, 1); assert.equal(entry.deleted, true);
});

test('late media read cannot recreate deleted preview or show stale read errors', async () => {
  for (const reject of [false, true]) {
    const f = fixture(1), { c } = f, gate = deferred(), entry = c.playlist[0];
    entry.fileHandle.getFile = () => gate.promise;
    const reading = c.playMedia(0);
    await c.deleteSourceEntry(entry);
    if (reject) gate.reject(new Error('gone')); else gate.resolve({ type: 'image/png' });
    assert.equal(await reading, false);
    assert.equal(c.mediaElement, null); assert.equal(c.activeMediaUrl, null);
    assert.equal(f.calls.filter(x => x[0] === 'url').length, 0);
    assert.equal(f.toasts.some(x => /读取媒体失败/.test(x.message)), false);
  }
});

test('disk success and next-preview read/render failure remain deletion success', async () => {
  for (const thrown of [false, true]) {
    const f = fixture(2), { c } = f;
    if (thrown) c.playMedia = async () => { throw new Error('render failed'); };
    else c.playlist[1].fileHandle.getFile = async () => { throw new Error('read failed'); };
    assert.equal(await c.deleteSourceEntry(c.playlist[0]), true);
    assert.equal(removes(f).length, 1); assert.equal(c.playlist.length, 1);
    assert.match(f.toasts.at(-1).message, /源文件已永久删除.*预览/);
    assert.doesNotMatch(f.toasts.at(-1).message, /未删除/); assert.equal(c.sourceOperation, null);
  }
});

test('row delete button stops click, double-click and keyboard propagation and binds entry identity', async () => {
  const f = fixture(); const { c, document } = f;
  const row = document.getElementById('playlist').children[1];
  const button = row.children.find(n => n.className === 'source-delete');
  assert.match(button.attrs['aria-label'], /删除磁盘源文件 nested\/1.png/);
  let stopped = 0, target;
  c.deleteSourceEntry = async entry => { target = entry; };
  const entry = c.playlist[1]; c.playlist.reverse();
  for (const event of ['onclick', 'ondblclick', 'onkeydown']) button[event]({ stopPropagation() { stopped++; } });
  assert.equal(stopped, 3); assert.equal(target, entry);
});

test('pending selection survives an earlier row deletion without stale index checks', async () => {
  const f = fixture(), { c } = f, gate = deferred(), selected = c.playlist[2];
  selected.fileHandle.getFile = () => gate.promise;
  const selecting = c.playMedia(2);
  await c.deleteSourceEntry(c.playlist[0]);
  gate.resolve({ type: 'image/png' });
  assert.equal(await selecting, true);
  assert.equal(c.playlist[c.currentIndex], selected);
  assert.equal(c.mediaElement.tagName, 'IMG');
});

test('repeated deletion of stale entry cannot delete its replacement row', async () => {
  const f = fixture(), { c } = f, entry = c.playlist[0];
  await c.deleteSourceEntry(entry);
  const next = c.playlist[0];
  assert.equal(await c.deleteSourceEntry(entry), false);
  assert.equal(c.playlist[0], next); assert.equal(removes(f).length, 1);
});

test('successful permission request is readwrite, identity-checked, then removed', async () => {
  const f = fixture(), { c, calls } = f;
  c.currentIndex = 1;
  c.playlist[0].parentDirHandle.queryPermission = async opts => { calls.push(['queryPermission', opts.mode]); return 'prompt'; };
  await c.deleteSourceEntry(c.playlist[0]);
  assert.deepEqual(calls.map(call => call[0]), ['confirm', 'queryPermission', 'requestPermission', 'getFileHandle', 'removeEntry']);
  assert.equal(calls[2][1], 'readwrite');
});
