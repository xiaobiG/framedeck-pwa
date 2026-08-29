import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const index = await readFile(resolve(root, 'index.html'), 'utf8');
const serviceWorker = await readFile(resolve(root, 'sw.js'), 'utf8');

const requiredIndexContracts = [
  'function restoreMediaArea',
  'function teardownMediaElement',
  'function getMediaKind',
  'MAX_CLIP_SOURCE_BYTES',
  "if (isEditing) return;",
  'mediaVisualizerCleanup = createVisualizer',
];
for (const contract of requiredIndexContracts) {
  if (!index.includes(contract)) throw new Error(`缺少关键运行时契约: ${contract}`);
}
if (index.includes('url: URL.createObjectURL(file)')) {
  throw new Error('目录扫描不应为每个媒体文件创建 Object URL');
}

const shellMatch = serviceWorker.match(/const APP_SHELL = \[([\s\S]*?)\];/);
if (!shellMatch) throw new Error('无法读取 Service Worker APP_SHELL');
const assets = [...shellMatch[1].matchAll(/'\.\/(.*?)'/g)].map((match) => match[1]);
for (const asset of assets) {
  await stat(resolve(root, asset));
}
if (assets.some((asset) => asset.endsWith('.wasm'))) {
  throw new Error('FFmpeg Wasm 不应阻塞 PWA 首次安装；应按需缓存');
}

console.log(`release check passed: ${assets.length} app-shell assets`);
