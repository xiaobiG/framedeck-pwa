import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareBrowserClip } from '../assets/clip-remux.mjs';
import { Input, BlobSource, MP4, EncodedPacketSink } from '../vendor/mediabunny/mediabunny.min.mjs';

const fixture = await readFile(new URL('./fixtures/clip-avc-aac.mp4', import.meta.url));

// A valid MP4 with a virtual 7 GiB free box ahead of mdat, and real co64 chunk
// offsets. No 7 GiB allocation: any accidental whole-file read fails immediately.
export function sparseMp4(bytes = fixture) {
    const padding = 7 * 1024 ** 3;
    const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
    function rewrite(data) {
        const parts = [];
        for (let offset = 0; offset < data.length;) {
            const size = data.readUInt32BE(offset);
            const type = data.toString('ascii', offset + 4, offset + 8);
            let body = data.subarray(offset + 8, offset + size);
            let name = type;
            if (containers.has(type)) body = rewrite(body);
            if (type === 'stco') {
                name = 'co64';
                const count = body.readUInt32BE(4);
                const expanded = Buffer.alloc(8 + count * 8);
                body.copy(expanded, 0, 0, 8);
                for (let i = 0; i < count; i++) {
                    expanded.writeBigUInt64BE(BigInt(body.readUInt32BE(8 + 4 * i) + padding), 8 + i * 8);
                }
                body = expanded;
            }
            const header = Buffer.alloc(8);
            header.writeUInt32BE(body.length + 8);
            header.write(name, 4);
            parts.push(header, body);
            offset += size;
        }
        return Buffer.concat(parts);
    }
    const segments = [];
    let position = 0;
    for (let offset = 0; offset < bytes.length;) {
        const size = bytes.readUInt32BE(offset);
        const type = bytes.toString('ascii', offset + 4, offset + 8);
        if (type === 'mdat') {
            const header = Buffer.alloc(16);
            header.writeUInt32BE(1);
            header.write('free', 4);
            header.writeBigUInt64BE(BigInt(padding), 8);
            segments.push({ position, data: header });
            position += padding;
        }
        const data = type === 'moov' ? rewrite(bytes.subarray(offset, offset + size))
            : bytes.subarray(offset, offset + size);
        segments.push({ position, data });
        position += data.length;
        offset += size;
    }
    const reads = [];
    class SparseBlob extends Blob {
        get size() { return position; }
        arrayBuffer() { throw new Error('Whole-file read forbidden'); }
        stream() { throw new Error('Whole-file stream forbidden'); }
        slice(start = 0, end = position) {
            if (start < 0) start += position;
            if (end < 0) end += position;
            start = Math.max(0, start);
            end = Math.min(position, end);
            assert.ok(end - start <= 16 * 1024 ** 2, 'read must be bounded');
            reads.push({ start, end });
            const result = Buffer.alloc(Math.max(0, end - start));
            for (const segment of segments) {
                const from = Math.max(start, segment.position);
                const to = Math.min(end, segment.position + segment.data.length);
                if (to > from) segment.data.copy(result, from - start, from - segment.position, to - segment.position);
            }
            return new Blob([result]);
        }
    }
    return { blob: new SparseBlob(), reads, segments, size: position };
}

async function exportClip(file, start, end) {
    const plan = await prepareBrowserClip(file, start, end);
    const writes = [];
    const result = await plan.write({ async write(chunk) {
        writes.push({ position: chunk.position, data: Buffer.from(chunk.data) });
    } });
    const buffer = Buffer.alloc(result.bytes);
    for (const chunk of writes) chunk.data.copy(buffer, chunk.position);
    return { plan, buffer };
}

async function packets(track) {
    const result = [];
    for await (const packet of new EncodedPacketSink(track).packets()) result.push(packet);
    return result;
}

for (const [start, end] of [[0, 3], [3.25, 7.25], [9, 12]]) {
    test(`large MP4 ${start}-${end}: bounded reads, complete GOPs, original packets and A/V timestamps`, async () => {
        const sparse = sparseMp4();
        const { plan, buffer } = await exportClip(sparse.blob, start, end);
        assert.ok(plan.actualStart <= start + 0.001);
        assert.ok(plan.actualEnd >= end - 0.001);
        assert.ok(sparse.reads.some(read => read.start > 4 * 1024 ** 3));
        assert.ok(sparse.reads.reduce((total, read) => total + read.end - read.start, 0) < 32 * 1024 ** 2);
        const original = new Input({ source: new BlobSource(new Blob([fixture])), formats: [MP4] });
        const output = new Input({ source: new BlobSource(new Blob([buffer])), formats: [MP4] });
        try {
            const sourceVideo = await packets(await original.getPrimaryVideoTrack());
            const resultVideo = await packets(await output.getPrimaryVideoTrack());
            const expectedVideo = sourceVideo.filter(p => p.timestamp >= plan.actualStart - 0.000001
                && p.timestamp < plan.actualEnd - 0.000001);
            assert.equal(resultVideo[0].type, 'key');
            assert.equal(resultVideo.length, expectedVideo.length);
            for (let i = 0; i < resultVideo.length; i++) {
                assert.deepEqual(resultVideo[i].data, expectedVideo[i].data);
                assert.ok(Math.abs(resultVideo[i].timestamp - (expectedVideo[i].timestamp - plan.actualStart)) < 0.001);
            }
            const sourceAudio = await packets(await original.getPrimaryAudioTrack());
            const resultAudio = await packets(await output.getPrimaryAudioTrack());
            const expectedAudio = sourceAudio.filter(p => p.timestamp >= plan.actualStart
                && p.timestamp < plan.actualEnd);
            assert.equal(resultAudio.length, expectedAudio.length);
            for (let i = 0; i < resultAudio.length; i++) {
                assert.deepEqual(resultAudio[i].data, expectedAudio[i].data);
                assert.ok(Math.abs(resultAudio[i].timestamp - (expectedAudio[i].timestamp - plan.actualStart)) < 0.001);
            }
        } finally { original.dispose(); output.dispose(); }
    });
}

test('write failures propagate and the source stops reading', async () => {
    const sparse = sparseMp4();
    const plan = await prepareBrowserClip(sparse.blob, 2, 5);
    await assert.rejects(plan.write({ write() { throw new Error('disk full'); } }), /disk full/);
    const count = sparse.reads.length;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(sparse.reads.length, count);
    plan.dispose();
});

test('invalid ranges and corrupt files fail before writing', async () => {
    await assert.rejects(prepareBrowserClip(new Blob([fixture]), 4, 2), { code: 'CLIP_INVALID_RANGE' });
    await assert.rejects(prepareBrowserClip(new Blob(['invalid mp4']), 0, 3));
    await assert.rejects(prepareBrowserClip(new Blob([fixture]), 15, 18), { code: 'CLIP_EMPTY' });
});

test('HEVC video without audio exports through the same lazy path', async () => {
    const data = await readFile(new URL('./fixtures/clip-hevc-silent.mp4', import.meta.url));
    const { buffer, plan } = await exportClip(sparseMp4(data).blob, 1, 4);
    assert.equal(plan.videoCodec, 'hevc');
    const input = new Input({ formats: [MP4], source: new BlobSource(new Blob([buffer])) });
    try {
        assert.equal(await input.getPrimaryAudioTrack(), null);
        const track = await input.getPrimaryVideoTrack();
        assert.equal(await track.getCodec(), 'hevc');
        assert.ok((await packets(track)).length > 0);
    } finally { input.dispose(); }
});

test('unknown audio codec is rejected rather than silently dropped', async () => {
    const data = Buffer.from(fixture);
    const offset = data.indexOf(Buffer.from('mp4a'));
    assert.ok(offset > 0);
    data.write('zzzz', offset);
    const descriptor = data.indexOf(Buffer.from('esds'), offset);
    assert.ok(descriptor > offset);
    data.write('free', descriptor);
    await assert.rejects(prepareBrowserClip(new Blob([data]), 1, 4), { code: 'CLIP_REMUX_UNSUPPORTED' });
});
