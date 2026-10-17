import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const sessionDefaults = html.match(/const playlistSessions = (\{[^]*?^        \});/m);
assert.ok(sessionDefaults, 'production playlist session defaults');
const initialSource = html.match(/let activePlaylistSource = ([^;]+);/);
assert.ok(initialSource, 'production active playlist source');
const playPauseAssignment = html.match(/document\.getElementById\('playPauseBtn'\)\.onclick = async \(\) => \{[^]*?^        \};/m);
assert.ok(playPauseAssignment, 'production play/pause button handler');
const names = [
  'getExtension', 'getMediaKind', 'isMediaFile', 'hasReadableMediaSource', 'getEntryFile',
  'cancelPendingPlaylistClick', 'rememberPlaylistSession', 'syncPlaylistSourceUI',
  'activatePlaylist', 'switchPlaylistSource', 'importDroppedVideos', 'removeDroppedEntry',
  'clearDroppedPlaylist', 'collectDroppedVideoFiles', 'handleVideoDrop', 'initVideoDrop',
  'sourceOperationBlocked', 'runSourceOperation', 'updateSourceDeleteControls',
  'captureCurrentPlaybackState', 'restoreCurrentPlaybackState', 'teardownMediaElement',
  'restoreMediaArea', 'renderMediaElement', 'playMedia', 'getNextIndex', 'updateControls',
  'renderPlaylist', 'renamePlaylistEntry', 'renamePlaylistEntryUnlocked',
  'copyEntryToTargetDir', 'copyEntryToTargetDirUnlocked', 'deleteSourceEntry',
  'enqueueClipJob', 'prepareClipExport', 'enqueueQuickClipExport', 'validateClipRange', 'getMediaFiles',
];
const source = names.map(name => {
  const match = html.match(new RegExp(`(?:async )?function ${name}\\([^]*?^        \\}$`, 'm'));
  assert.ok(match, name);
  return match[0];
}).join('\n');

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

function video(name = 'movie.mp4', type = 'video/mp4', size = 1024) {
  return {
    name, type, size,
    slice() { throw new Error('must not pre-read file bytes'); },
    arrayBuffer() { throw new Error('must not buffer entire file'); },
    stream() { throw new Error('must not stream entire file before playback'); },
    text() { throw new Error('must not decode file bytes'); },
  };
}

function fixture() {
  const nodes = new Map(), events = new Map(), toasts = [], urls = [], revoked = [], calls = [];
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.children = []; this.style = {}; this.attrs = {};
      this.classList = { toggle() {}, add() {}, remove() {} }; this.dataset = {};
      this.value = '1'; this.currentTime = 0; this.duration = 180; this.readyState = 1;
      this.paused = true; this.playbackRate = 1; this.muted = false; this.listeners = new Map();
    }
    set innerHTML(value) { this.html = value; this.children = []; }
    get innerHTML() { return this.html || ''; }
    appendChild(child) { this.children.push(child); return child; }
    setAttribute(name, value) { this.attrs[name] = value; }
    removeAttribute(name) { delete this.attrs[name]; }
    addEventListener(name, handler, options = {}) {
      const listeners = this.listeners.get(name) || [];
      listeners.push({ handler, once: options.once }); this.listeners.set(name, listeners);
    }
    dispatchEvent(event) {
      for (const listener of [...(this.listeners.get(event.type) || [])]) {
        if (listener.once) this.listeners.set(event.type, this.listeners.get(event.type).filter(item => item !== listener));
        listener.handler(event);
      }
      return true;
    }
    pause() { this.paused = true; }
    load() {}
    async play() { this.paused = false; }
    click() { this.clicked = true; }
  }
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, Object.assign(new Element(), { id }));
      return nodes.get(id);
    },
    createElement(tag) { return new Element(tag); },
    querySelector(selector) { return this.getElementById(selector); },
    querySelectorAll() { return []; },
  };
  const c = vm.createContext({
    document, console, setTimeout, clearTimeout,
    window: {
      addEventListener(name, fn) { events.set(name, fn); },
      confirm() { calls.push('confirm'); throw new Error('unexpected filesystem confirmation'); },
    },
    URL: { createObjectURL(file) { urls.push(file); return `blob:${urls.length}`; }, revokeObjectURL(url) { revoked.push(url); } },
    MEDIA_EXTENSIONS: { image: new Set(['png']), audio: new Set(['mp3']), video: new Set(['mp4', 'webm', 'mov']) },
    activePlaylistSource: vm.runInNewContext(initialSource[1]),
    playlistSessions: vm.runInNewContext(`(${sessionDefaults[1]})`),
    playlist: [], currentIndex: -1, playMode: 'single', dirHandle: null,
    modeTexts: { single: 'single', list: 'list', random: 'random' }, sourceOperation: null,
    mediaElement: null, activeMediaUrl: null, mediaRenderRequestId: 0, mediaVisualizerCleanup: null,
    pendingPlaybackRestore: null,
    playlistClickTimer: null, isPlaying: false, isMuted: false, trackAudioSpectrum: false,
    clipTasks: [], clipTaskIdSeq: 0, MIN_CLIP_DURATION: 0.1,
    QUICK_CLIP_BEFORE_SECONDS: 10, QUICK_CLIP_AFTER_SECONDS: 10,
    showToast(message, options) { toasts.push({ message, options }); },
    resetClipPoints() {}, initControlOverlayEvents() {}, updateClipDockUI() {}, updateClipTimeline() {},
    attachClipMediaDiagnostics() {}, clipLog() {}, serializeClipError(e) { return { message: e.message }; },
    createClipDiagnosticId() { return `id-${calls.push('id')}`; },
    getClipOutputProfile() { return { extension: 'mp4' }; },
    buildClipOutputName(name) { return `${name}-clip.mp4`; },
    getCurrentMediaDiagnosticSnapshot() { return { current: true }; },
    renderClipTasksList() {}, formatClipRange() { return '0–1'; }, async processClipQueue() {},
    verifyPermission() { calls.push('permission'); throw new Error('unexpected disk permission'); },
    ensureTargetDir() { calls.push('target'); throw new Error('unexpected target picker'); },
  });
  vm.runInContext(source, c);
  return { c, document, events, toasts, urls, revoked, calls };
}

async function directory(f) {
  const file = video('directory.mp4'), handle = { name: 'root' };
  const entry = { sourceKind: 'directory', name: file.name, type: file.type, mediaKind: 'video', relativePath: `nested/${file.name}`, fileHandle: { async getFile() { return file; } } };
  await f.c.activatePlaylist('directory', { entries: [entry], handle, playIndex: 0 });
  return { entry, file, handle };
}

test('production sessions start empty and independent with directory single and drop list modes', () => {
  const { c } = fixture();
  assert.equal(c.activePlaylistSource, 'directory');
  assert.equal(c.playlistSessions.directory.playMode, 'single'); assert.equal(c.playlistSessions.drop.playMode, 'list');
  assert.notEqual(c.playlistSessions.directory.entries, c.playlistSessions.drop.entries);
  for (const session of Object.values(c.playlistSessions)) {
    assert.equal(session.entries.length, 0); assert.equal(session.currentIndex, -1);
    assert.equal(session.dirHandle, null); assert.equal(session.playbackState, null);
  }
});

test('File sources preserve identity and playback never pre-reads the whole dropped file', async () => {
  const f = fixture(), file = video();
  assert.equal(await f.c.importDroppedVideos([file]), true);
  const entry = f.c.playlist[0];
  assert.equal(entry.file, file);
  assert.equal(entry.sourceKind, 'drop'); assert.equal(entry.relativePath, file.name);
  assert.equal(f.c.hasReadableMediaSource(entry), true);
  assert.equal(await f.c.getEntryFile(entry), file);
  assert.deepEqual(f.urls, [file]);
  let reads = 0;
  const disk = { fileHandle: { async getFile() { reads++; return file; } } };
  assert.equal(await f.c.getEntryFile(disk), file); assert.equal(reads, 1);
  assert.equal(f.c.hasReadableMediaSource({ ...entry, deleted: true }), false);
  assert.equal(f.c.hasReadableMediaSource({ sourceKind: 'drop', fileHandle: disk.fileHandle }), false);
  await assert.rejects(f.c.getEntryFile({ sourceKind: 'drop' }));
});

test('directory scanning marks directory entries and retains nested parent handles', async () => {
  const { c } = fixture(), file = video();
  const handle = { kind: 'file', name: file.name, async getFile() { return file; } };
  const nested = { kind: 'directory', name: 'nested', async *values() { yield handle; } };
  const root = { async *values() { yield nested; } };
  const entries = await c.getMediaFiles(root);
  assert.equal(entries.length, 1); assert.equal(entries[0].sourceKind, 'directory');
  assert.equal(entries[0].fileHandle, handle); assert.equal(entries[0].parentDirHandle, nested);
  assert.equal(entries[0].relativePath, 'nested/movie.mp4');
});

test('directory and drop retain independent entries, modes, roots, selection and paused/playing resume state', async () => {
  const f = fixture(), { c } = f, disk = await directory(f);
  c.playMode = 'random'; c.mediaElement.currentTime = 37; c.mediaElement.playbackRate = 1.5;
  c.mediaElement.muted = true; c.mediaElement.pause();
  await c.importDroppedVideos([video('a.mp4'), video('b.mp4')]);
  assert.equal(c.playMode, 'list'); assert.equal(c.dirHandle, null);
  await c.playMedia(1); c.playMode = 'single'; c.mediaElement.currentTime = 62;
  c.mediaElement.playbackRate = 0.75; c.mediaElement.muted = false;
  await c.switchPlaylistSource('directory');
  assert.equal(c.playlist[0], disk.entry); assert.equal(c.dirHandle, disk.handle); assert.equal(c.playMode, 'random');
  assert.equal(c.mediaElement.currentTime, 37); assert.equal(c.mediaElement.playbackRate, 1.5);
  assert.equal(c.mediaElement.muted, true); assert.equal(c.mediaElement.paused, true);
  await c.switchPlaylistSource('drop');
  assert.equal(c.currentIndex, 1); assert.equal(c.playlist[1].name, 'b.mp4'); assert.equal(c.playMode, 'single');
  assert.equal(c.dirHandle, null); assert.equal(c.mediaElement.currentTime, 62);
  assert.equal(c.mediaElement.playbackRate, 0.75); assert.equal(c.mediaElement.muted, false);
  assert.equal(c.mediaElement.paused, false);
});

for (const wasPlaying of [true, false]) test(`switching again before metadata preserves pending time and ${wasPlaying ? 'playing' : 'paused'} intent`, async () => {
  const f = fixture(), { c, document } = f; await directory(f);
  c.mediaElement.currentTime = 37; c.mediaElement.playbackRate = 1.5; c.mediaElement.muted = true;
  if (!wasPlaying) c.mediaElement.pause();
  await c.importDroppedVideos([video('drop.mp4')]);
  c.mediaElement.currentTime = 11; c.mediaElement.playbackRate = 0.75; c.mediaElement.muted = false;
  const createElement = document.createElement;
  document.createElement = tag => {
    const element = createElement(tag);
    if (tag === 'video') element.readyState = 0;
    return element;
  };
  await c.switchPlaylistSource('directory');
  const pendingElement = c.mediaElement;
  assert.equal(pendingElement.readyState, 0); assert.equal(pendingElement.currentTime, 0);
  assert.equal(c.pendingPlaybackRestore.element, pendingElement);
  const captured = c.captureCurrentPlaybackState(c.currentIndex);
  assert.equal(captured.currentTime, 37); assert.equal(captured.wasPlaying, wasPlaying);
  captured.currentTime = 999;
  assert.equal(c.pendingPlaybackRestore.state.currentTime, 37, 'capture returns a copy of the remembered intent');
  document.createElement = createElement;
  await c.switchPlaylistSource('drop');
  const saved = c.playlistSessions.directory.playbackState;
  assert.equal(saved.currentTime, 37); assert.equal(saved.wasPlaying, wasPlaying);
  assert.equal(saved.playbackRate, 1.5); assert.equal(saved.muted, true);
  const current = c.mediaElement;
  assert.equal(current.currentTime, 11); assert.equal(c.pendingPlaybackRestore, null);
  pendingElement.readyState = 1;
  pendingElement.dispatchEvent({ type: 'loadedmetadata' });
  assert.equal(c.mediaElement, current); assert.equal(current.currentTime, 11);
  assert.equal(current.playbackRate, 0.75); assert.equal(current.muted, false); assert.equal(current.paused, false);
  assert.equal(pendingElement.currentTime, 0, 'detached metadata callback cannot apply the old restore');
  await c.switchPlaylistSource('directory');
  assert.equal(c.mediaElement.currentTime, 37); assert.equal(c.mediaElement.paused, !wasPlaying);
  assert.equal(c.mediaElement.playbackRate, 1.5); assert.equal(c.mediaElement.muted, true);
  assert.equal(c.pendingPlaybackRestore, null);
});

test('actual play/pause handler trusts native paused state despite stale isPlaying and rapid toggles', async () => {
  for (const tagName of ['VIDEO', 'AUDIO']) {
    const { c, document } = fixture(); await c.importDroppedVideos([video()]);
    vm.runInContext(playPauseAssignment[0], c);
    const media = c.mediaElement, gate = deferred(); let plays = 0, pauses = 0;
    media.tagName = tagName;
    media.play = async () => { plays++; media.paused = false; await gate.promise; };
    media.pause = () => { pauses++; media.paused = true; };
    media.paused = true; c.isPlaying = true;
    const firstPlay = document.getElementById('playPauseBtn').onclick();
    assert.equal(plays, 1); assert.equal(pauses, 0); assert.equal(media.paused, false);
    c.isPlaying = false;
    await document.getElementById('playPauseBtn').onclick();
    assert.equal(plays, 1); assert.equal(pauses, 1); assert.equal(media.paused, true);
    gate.resolve(); await firstPlay;
    assert.equal(media.paused, true);
  }
});

test('default drop list mode advances and wraps on ended', async () => {
  const { c } = fixture(); await c.importDroppedVideos([video('a.mp4'), video('b.mp4')]);
  assert.equal(c.playMode, 'list');
  let next;
  c.playMedia = index => { next = index; };
  c.mediaElement.onended(); assert.equal(next, 1);
  c.mediaElement.onended(); assert.equal(next, 0);
});

test('imports append without deduplication and play the first newly appended video', async () => {
  const { c } = fixture(), a = video('same.mp4'), b = video('same.mp4');
  await c.importDroppedVideos([a]); const first = c.playlist[0];
  await c.importDroppedVideos([b, a]);
  assert.equal(c.playlist.length, 3); assert.equal(c.currentIndex, 1);
  assert.equal(c.playlist[0], first); assert.equal(c.playlist[1].file, b); assert.equal(c.playlist[2].file, a);
  assert.notEqual(c.playlist[0].id, c.playlist[1].id);
});

test('invalid, empty, image, audio and link-only imports never switch the active directory', async () => {
  const f = fixture(), disk = await directory(f), { c } = f, before = c.mediaElement;
  assert.equal(await c.importDroppedVideos([video('empty.mp4', 'video/mp4', 0), video('pic.png', 'image/png'), video('song.mp3', 'audio/mp3'), video('notes.txt', 'text/plain')], 1), false);
  assert.equal(c.activePlaylistSource, 'directory'); assert.equal(c.playlist[0], disk.entry);
  assert.equal(c.mediaElement, before); assert.equal(c.playlistSessions.drop.entries.length, 0);
  assert.equal(await c.handleVideoDrop({ dataTransfer: { types: ['text/uri-list'] }, preventDefault() { throw new Error('must leave webpage links alone'); } }), false);
});

test('remove and clear are memory-only and retain queued File references', async () => {
  const f = fixture(), { c } = f;
  const files = [video('a.mp4'), video('b.mp4'), video('c.mp4')];
  await c.importDroppedVideos(files);
  const first = c.playlist[0];
  assert.equal(c.enqueueClipJob({ a: 0, b: 1, targetDirHandle: { name: 'output' } }), true);
  const job = c.clipTasks[0];
  assert.equal(await c.removeDroppedEntry(first), true);
  assert.equal(first.deleted, undefined); assert.equal(await c.getEntryFile(job.sourceEntry), files[0]);
  assert.equal(c.currentIndex, 0); assert.equal(c.playlist[0].file, files[1]);
  await c.playMedia(1); const current = c.mediaElement;
  assert.equal(await c.removeDroppedEntry(c.playlist[0]), true);
  assert.equal(c.currentIndex, 0); assert.equal(c.mediaElement, current);
  assert.equal(await c.clearDroppedPlaylist(), true);
  assert.equal(c.playlist.length, 0); assert.equal(c.currentIndex, -1); assert.equal(c.mediaElement, null);
  assert.equal(await c.getEntryFile(job.sourceEntry), files[0]);
  assert.equal(f.calls.includes('permission'), false); assert.equal(f.calls.includes('target'), false); assert.equal(f.calls.includes('confirm'), false);
});

test('queued drop source snapshots selected File, root-relative name, diagnostics and explicit output target', async () => {
  const f = fixture(), { c } = f;
  const file = video('same.mp4'); await c.importDroppedVideos([file, video('other.mp4')]);
  const entry = c.playlist[0], target = { name: 'chosen-output' }, mediaSnapshot = { duration: 180, selected: 'same.mp4' };
  entry.relativePath = 'untrusted/nested/same.mp4';
  await c.playMedia(1);
  assert.equal(c.enqueueClipJob({ a: 2, b: 5, selectedEntry: entry, mediaSnapshot, targetDirHandle: target }), true);
  const job = c.clipTasks[0];
  assert.notEqual(job.sourceEntry, entry); assert.equal(job.sourceEntry.sourceKind, 'drop');
  assert.equal(job.sourceEntry.file, file); assert.equal(job.sourceEntry.fileHandle, null);
  assert.equal(job.sourceEntry.relativePath, 'same.mp4'); assert.equal(job.sourceName, 'same.mp4');
  assert.equal(job.targetDirHandle, target); assert.equal(job.mediaSnapshot, mediaSnapshot);
  entry.name = 'renamed-in-memory.mp4'; entry.file = video('replacement.mp4');
  await c.clearDroppedPlaylist(); await c.switchPlaylistSource('directory');
  assert.equal(job.sourceEntry.name, 'same.mp4'); assert.equal(await c.getEntryFile(job.sourceEntry), file);
  assert.equal(job.targetDirHandle, target);
});

test('directory queue snapshots preserve relative output subdirectories and handle identity', async () => {
  const f = fixture(), { c } = f, disk = await directory(f), target = { name: 'output' };
  assert.equal(c.enqueueClipJob({ a: 0, b: 1, targetDirHandle: target }), true);
  const job = c.clipTasks[0];
  assert.equal(job.sourceEntry.sourceKind, 'directory'); assert.equal(job.sourceEntry.fileHandle, disk.entry.fileHandle);
  assert.equal(job.sourceEntry.relativePath, disk.entry.relativePath); assert.equal(job.targetDirHandle, target);
  assert.equal(await c.getEntryFile(job.sourceEntry), disk.file);
});

test('read-only hard guards reject source rename and delete even with forged file handles', async () => {
  const f = fixture(), { c } = f; await c.importDroppedVideos([video()]);
  const entry = c.playlist[0];
  const poison = new Proxy({}, { get() { throw new Error('must not touch forged disk handles'); } });
  entry.fileHandle = poison; entry.parentDirHandle = poison;
  assert.equal(await c.renamePlaylistEntry(0, 'other.mp4'), false);
  assert.equal(await c.renamePlaylistEntryUnlocked(0, 'other.mp4'), false);
  assert.equal(await c.deleteSourceEntry(entry), false);
  const unreadable = { ...entry, file: null };
  assert.equal(await c.copyEntryToTargetDir(unreadable), false);
  assert.equal(await c.copyEntryToTargetDirUnlocked(unreadable), false);
  assert.equal(c.playlist[0], entry); assert.equal(entry.name, 'movie.mp4');
  assert.equal(f.calls.includes('permission'), false); assert.equal(f.calls.includes('target'), false); assert.equal(f.calls.includes('confirm'), false);
});

test('explicit drop copy writes the original File to output root without source-handle IO', async () => {
  const f = fixture(), { c } = f, file = video(); await c.importDroppedVideos([file]);
  const entry = c.playlist[0], target = { name: 'output' }, writes = [];
  entry.fileHandle = new Proxy({}, { get() { throw Error('must not read forged source handle'); } });
  entry.relativePath = 'ignored/nested/movie.mp4';
  c.ensureTargetDir = async () => target;
  c.resolveCopyTargetName = async (handle, name) => { assert.equal(handle, target); assert.equal(name, file.name); return { fileName: name }; };
  c.writeFileToDir = async (...args) => { writes.push(args); };
  assert.equal(await c.copyEntryToTargetDir(entry), true);
  assert.deepEqual(writes, [[target, file.name, file]]);
  assert.equal(f.calls.includes('permission'), false);
});

test('export preflight captures selection and diagnostics before awaiting output permission and locks source changes', async () => {
  const f = fixture(), { c } = f, files = [video('a.mp4'), video('b.mp4')];
  await c.importDroppedVideos(files);
  const selected = c.playlist[0], mediaSnapshot = { selected: 'a.mp4', time: 25 }, gate = deferred(), target = { name: 'chosen-output' };
  c.getCurrentMediaDiagnosticSnapshot = () => mediaSnapshot;
  c.ensureTargetDir = () => gate.promise;
  const pending = c.prepareClipExport({ a: 2, b: 9, label: 'clip' });
  assert.equal(c.sourceOperation, '准备导出'); assert.equal(c.clipTasks.length, 0);
  assert.equal(await c.switchPlaylistSource('directory'), false);
  assert.equal(await c.importDroppedVideos([video('blocked.mp4')]), false);
  assert.equal(await c.removeDroppedEntry(selected), false); assert.equal(await c.clearDroppedPlaylist(), false);
  assert.equal(await c.prepareClipExport({ a: 0, b: 1 }), false);
  await c.playMedia(1);
  c.getCurrentMediaDiagnosticSnapshot = () => ({ selected: 'b.mp4' });
  gate.resolve(target);
  assert.equal(await pending, true); assert.equal(c.sourceOperation, null); assert.equal(c.clipTasks.length, 1);
  const job = c.clipTasks[0];
  assert.equal(job.sourceEntry.file, files[0]); assert.equal(job.mediaSnapshot, mediaSnapshot);
  assert.equal(job.targetDirHandle, target); assert.equal(job.a, 2); assert.equal(job.b, 9);
  assert.equal(c.playlist[c.currentIndex].file, files[1]);
});

test('cancelled or failed output preflight queues nothing and releases source-operation lock', async () => {
  for (const mode of ['cancel', 'reject']) {
    const { c } = fixture(); await c.importDroppedVideos([video()]);
    const gate = deferred();
    c.ensureTargetDir = async () => { await gate.promise; if (mode === 'reject') throw Error('permission failed'); return null; };
    const pending = c.prepareClipExport({ a: 0, b: 1 });
    assert.equal(c.clipTasks.length, 0); gate.resolve();
    if (mode === 'reject') await assert.rejects(pending, /permission failed/);
    else assert.equal(await pending, false);
    assert.equal(c.clipTasks.length, 0); assert.equal(c.sourceOperation, null);
    assert.equal(await c.switchPlaylistSource('directory'), true);
  }
});

test('quick export awaits preflight and retains the original range and File when selection changes', async () => {
  const { c } = fixture(), files = [video('a.mp4'), video('b.mp4')]; await c.importDroppedVideos(files);
  c.mediaElement.currentTime = 30;
  const gate = deferred(), target = { name: 'output' };
  c.ensureTargetDir = () => gate.promise;
  const pending = c.enqueueQuickClipExport();
  assert.equal(typeof pending.then, 'function'); assert.equal(c.clipTasks.length, 0);
  await c.playMedia(1); c.mediaElement.currentTime = 90;
  gate.resolve(target); await pending;
  assert.equal(c.clipTasks.length, 1);
  const job = c.clipTasks[0];
  assert.equal(job.sourceEntry.file, files[0]); assert.equal(job.a, 20); assert.equal(job.b, 40);
  assert.equal(job.type, 'quick-g'); assert.equal(job.targetDirHandle, target);
});

test('pending source operations block import, switch, remove, clear and synchronous export enqueue', async () => {
  const { c } = fixture(); await c.importDroppedVideos([video()]);
  const entry = c.playlist[0], gate = deferred();
  const pending = c.runSourceOperation('test operation', () => gate.promise);
  assert.equal(await c.importDroppedVideos([video('new.mp4')]), false);
  assert.equal(await c.switchPlaylistSource('directory'), false);
  assert.equal(await c.removeDroppedEntry(entry), false);
  assert.equal(await c.clearDroppedPlaylist(), false);
  assert.equal(c.enqueueClipJob({ a: 0, b: 1 }), false);
  assert.equal(c.playlist.length, 1); assert.equal(c.playlist[0], entry); assert.equal(c.activePlaylistSource, 'drop');
  gate.resolve(true); assert.equal(await pending, true); assert.equal(c.sourceOperation, null);
});

test('drop collection snapshots File synchronously, skips directories and filters nonvideo during import', async () => {
  const f = fixture(), { c } = f, file = video(), nonvideo = video('notes.txt', 'text/plain');
  let accessible = true, gets = 0, prevented = 0;
  const item = value => ({ kind: 'file', getAsFile() { assert.equal(accessible, true); gets++; return value; } });
  const transfer = { types: ['Files'], items: [item(file), item(nonvideo), { kind: 'file', webkitGetAsEntry() { return { isDirectory: true }; }, getAsFile() { throw Error('must not read directories'); } }, { kind: 'string', getAsFile() { throw Error('must not read links'); } } ] };
  const pending = c.handleVideoDrop({ dataTransfer: transfer, preventDefault() { prevented++; } });
  accessible = false; transfer.items.length = 0;
  assert.equal(gets, 2); assert.equal(prevented, 1);
  assert.equal(await pending, true); assert.equal(c.playlist.length, 1); assert.equal(c.playlist[0].file, file);
  assert.match(f.toasts.find(t => /已加入/.test(t.message)).options.detail, /2/);
  const fallback = c.collectDroppedVideoFiles({ files: [file] });
  assert.equal(fallback.files[0], file); assert.equal(fallback.skipped, 0);
});

test('detached media ended/play/pause events cannot advance or alter the active source', async () => {
  const f = fixture(), { c } = f; await directory(f);
  const detached = c.mediaElement;
  await c.importDroppedVideos([video('a.mp4'), video('b.mp4')]);
  const current = c.mediaElement, selected = c.playlist[c.currentIndex], urlCount = f.urls.length;
  detached.onended();
  assert.equal(c.currentIndex, 0); assert.equal(c.playlist[c.currentIndex], selected);
  assert.equal(c.mediaElement, current); assert.equal(f.urls.length, urlCount);
  current.dispatchEvent({ type: 'play' }); assert.equal(c.isPlaying, true);
  detached.dispatchEvent({ type: 'pause' }); assert.equal(c.isPlaying, true);
  current.dispatchEvent({ type: 'pause' }); assert.equal(c.isPlaying, false);
  detached.dispatchEvent({ type: 'play' }); assert.equal(c.isPlaying, false);
  assert.equal(c.mediaElement, current); assert.equal(c.activePlaylistSource, 'drop');
});

test('a late directory File read cannot replace an activated dropped preview', async () => {
  const f = fixture(), { c } = f, disk = await directory(f), gate = deferred();
  disk.entry.fileHandle.getFile = () => gate.promise;
  const pending = c.playMedia(0);
  const file = video('drop.mp4'); await c.importDroppedVideos([file]);
  const preview = c.mediaElement, urlCount = f.urls.length;
  gate.resolve(disk.file);
  assert.equal(await pending, false);
  assert.equal(c.mediaElement, preview); assert.equal(c.activePlaylistSource, 'drop');
  assert.equal(c.playlist[c.currentIndex].file, file); assert.equal(f.urls.length, urlCount);
});

test('source switches cancel stale delayed row clicks', async () => {
  const f = fixture(), { c } = f; await directory(f);
  f.document.getElementById('playlist').children[0].onclick();
  assert.notEqual(c.playlistClickTimer, null);
  await c.importDroppedVideos([video('new.mp4')]);
  assert.equal(c.playlistClickTimer, null);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(c.activePlaylistSource, 'drop'); assert.equal(c.playlist[c.currentIndex].name, 'new.mp4');
});

test('drop initialization wires file chooser snapshot and copy-only native drop behavior', async () => {
  const f = fixture(), { c, document, events } = f;
  c.initVideoDrop();
  const event = { dataTransfer: { types: ['Files'] }, preventDefault() {} };
  events.get('dragenter')(event); assert.equal(document.getElementById('videoDropOverlay').hidden, false);
  events.get('dragover')(event); assert.equal(event.dataTransfer.dropEffect, 'copy');
  events.get('blur')(); assert.equal(document.getElementById('videoDropOverlay').hidden, true);
  const file = video(), input = document.getElementById('dropVideoInput'); let snapshot;
  c.importDroppedVideos = files => { snapshot = files; return Promise.resolve(true); };
  input.files = [file]; input.onchange(); input.files.length = 0;
  assert.equal(snapshot[0], file); assert.equal(input.value, '');
  document.getElementById('addDropVideosBtn').onclick(); assert.equal(input.clicked, true);
});
