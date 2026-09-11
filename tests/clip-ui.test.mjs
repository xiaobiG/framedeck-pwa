import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const context = vm.createContext({ Date });
for (const name of ['buildClipOutputName', 'appendNumericSuffix', 'findAvailableFileName', 'getClipUserError']) {
    const match = html.match(new RegExp(`(?:async )?function ${name}\\([^]*?^        \\}`, 'm'));
    assert.ok(match, name);
    vm.runInContext(match[0], context);
}

test('clip filenames keep one timestamp and use numeric suffixes on collisions', async () => {
    const name = context.buildClipOutputName('video.mp4', 2, 8, 'quick-g');
    assert.equal((name.match(/\d{8}-\d{6}/g) || []).length, 1);
    const occupied = new Set([name, context.appendNumericSuffix(name, 2)]);
    const dir = { async getFileHandle(candidate) {
        if (!occupied.has(candidate)) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
        return {};
    } };
    assert.equal(await context.findAvailableFileName(dir, name), context.appendNumericSuffix(name, 3));
    occupied.clear();
    assert.equal(await context.findAvailableFileName(dir, name), name);
});

test('filename checks propagate permission errors instead of treating them as free names', async () => {
    await assert.rejects(context.findAvailableFileName({ async getFileHandle() {
        throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    } }, 'clip.mp4'), { name: 'NotAllowedError' });
});

test('clip failures expose actionable messages without requiring technical details', () => {
    assert.match(context.getClipUserError({ name: 'QuotaExceededError' }), /空间不足/);
    assert.match(context.getClipUserError({ name: 'NotAllowedError' }), /重新选择/);
    assert.match(context.getClipUserError({ name: 'NotFoundError' }), /已移动/);
    assert.equal(context.getClipUserError({ message: '源文件大小超限' }), '源文件大小超限');
    assert.doesNotMatch(context.getClipUserError({ message: 'Internal muxer failure' }), /muxer/);
});
