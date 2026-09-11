import {
    Input, BlobSource, MP4, Output, Mp4OutputFormat, StreamTarget,
    EncodedPacketSink, EncodedVideoPacketSource, EncodedAudioPacketSource,
} from '../vendor/mediabunny/mediabunny.min.mjs';

function clipError(code, message) {
    return Object.assign(new Error(message), { code });
}

// Some demuxers omit unrecognized tracks entirely. Check declared track kinds
// independently so an unknown audio codec cannot turn into a silent export.
async function declaredTracks(file) {
    const counts = { soun: 0, vide: 0 };
    async function walk(start, end, level) {
        for (let offset = start; offset < end;) {
            const bytes = await file.slice(offset, Math.min(offset + 16, end)).arrayBuffer();
            const view = new DataView(bytes);
            if (view.byteLength < 8) throw clipError('CLIP_INVALID_MP4', 'MP4 索引不完整');
            let size = view.getUint32(0);
            const type = String.fromCharCode(...new Uint8Array(bytes, 4, 4));
            const header = size === 1 ? 16 : 8;
            if (size === 1) {
                if (view.byteLength < 16) throw clipError('CLIP_INVALID_MP4', 'MP4 索引不完整');
                size = Number(view.getBigUint64(8));
            } else if (size === 0) size = end - offset;
            if (!Number.isSafeInteger(size) || size < header || offset + size > end) {
                throw clipError('CLIP_INVALID_MP4', 'MP4 索引中的文件偏移无效');
            }
            if ((level === 0 && type === 'moov') || (level === 1 && type === 'trak')
                || (level === 2 && type === 'mdia')) {
                await walk(offset + header, offset + size, level + 1);
            } else if (level === 3 && type === 'hdlr' && size >= header + 12) {
                const kind = String.fromCharCode(...new Uint8Array(
                    await file.slice(offset + header + 8, offset + header + 12).arrayBuffer()));
                if (kind in counts) counts[kind]++;
            }
            offset += size;
        }
    }
    await walk(0, file.size, 0);
    return counts;
}

// Inspect before creating the destination. File bytes remain on disk; BlobSource
// reads indexed ranges with a bounded cache, including 64-bit MP4 chunk offsets.
export async function prepareBrowserClip(file, start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
        throw clipError('CLIP_INVALID_RANGE', '剪辑时间范围无效');
    }
    const input = new Input({
        formats: [MP4],
        source: new BlobSource(file, {
            maxCacheSize: 8 * 1024 * 1024,
            // Explicit range reads also avoid long-lived browser Blob readers.
            useStreamReader: false,
        }),
    });
    try {
        const video = await input.getPrimaryVideoTrack();
        const audio = await input.getPrimaryAudioTrack();
        const declared = await declaredTracks(file);
        if (declared.soun !== (await input.getAudioTracks()).length
            || declared.vide !== (await input.getVideoTracks()).length) {
            throw clipError('CLIP_REMUX_UNSUPPORTED', '文件含无法识别的音视频轨道，无法保留原音画导出');
        }
        const videoCodec = await video?.getCodec();
        const audioCodec = await audio?.getCodec();
        if (!video || !['avc', 'hevc'].includes(videoCodec) || (audio && audioCodec !== 'aac')) {
            throw clipError('CLIP_REMUX_UNSUPPORTED',
                `浏览器快速剪辑目前支持 H.264/H.265 视频与 AAC 音频的 MP4/MOV（当前：${videoCodec || '无视频'}/${audioCodec || '无音频'}）`);
        }
        const videoConfig = await video.getDecoderConfig();
        const audioConfig = audio && await audio.getDecoderConfig();
        if (!videoConfig || (audio && !audioConfig)) {
            throw clipError('CLIP_CONFIG_MISSING', '源文件缺少剪辑所需的编码信息');
        }
        const sink = new EncodedPacketSink(video);
        const verify = { verifyKeyPackets: true };
        const first = await sink.getKeyPacket(start, verify) || await sink.getFirstKeyPacket(verify);
        if (!first || first.timestamp >= end) {
            throw clipError('CLIP_KEYFRAME_MISSING', '指定片段内没有可用的起始关键帧');
        }
        // Copy complete GOPs in decode order. Stopping on presentation timestamps
        // would drop reordered B-frames or their reference pictures.
        let stop = await sink.getKeyPacket(end, verify);
        if (stop && stop.timestamp < end - 0.000001) {
            stop = await sink.getNextKeyPacket(stop, verify);
        }
        const actualStart = first.timestamp;
        const actualEnd = stop ? stop.timestamp : await video.computeDuration();
        if (!(actualEnd > actualStart) || start >= actualEnd) {
            throw clipError('CLIP_EMPTY', '指定范围没有可导出的媒体数据');
        }
        const rotation = await video.getRotation();
        let used = false;
        return {
            actualStart, actualEnd, videoCodec, audioCodec,
            dispose: () => input.dispose(),
            async write(writable, onProgress = () => {}) {
                if (used) throw new Error('剪辑任务不能重复执行');
                used = true;
                let bytes = 0;
                // The adapter leaves commit/abort ownership with the job runner.
                const target = new StreamTarget(new WritableStream({
                    async write(chunk) {
                        await writable.write(chunk);
                        bytes = Math.max(bytes, chunk.position + chunk.data.byteLength);
                    },
                }), { chunked: true, chunkSize: 1024 * 1024 });
                const output = new Output({
                    format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 }),
                    target,
                });
                const videoSource = new EncodedVideoPacketSource(videoCodec);
                output.addVideoTrack(videoSource, { rotation });
                const streams = [{
                    iterator: sink.packets(first, stop || undefined),
                    source: videoSource, config: videoConfig,
                }];
                try {
                    if (audio) {
                        const audioSink = new EncodedPacketSink(audio);
                        let audioFirst = await audioSink.getPacket(actualStart)
                            || await audioSink.getFirstPacket();
                        // AAC packets are indivisible. Keep the first packet at or
                        // after the common origin; never reset audio independently.
                        if (audioFirst && audioFirst.timestamp < actualStart) {
                            audioFirst = await audioSink.getNextPacket(audioFirst);
                        }
                        if (audioFirst && audioFirst.timestamp < actualEnd) {
                            const audioSource = new EncodedAudioPacketSource(audioCodec);
                            output.addAudioTrack(audioSource);
                            streams.push({
                                iterator: audioSink.packets(audioFirst),
                                source: audioSource, config: audioConfig, audio: true,
                            });
                        }
                    }
                    await output.start();
                    for (const stream of streams) stream.next = await stream.iterator.next();
                    let count = 0;
                    while (true) {
                        const available = streams.filter(s => !s.next.done
                            && (!s.audio || s.next.value.timestamp < actualEnd));
                        if (!available.length) break;
                        // Interleave tracks without reordering packets within a
                        // track, so the fragmented writer cannot buffer all audio.
                        const stream = available.reduce((a, b) =>
                            a.next.value.timestamp <= b.next.value.timestamp ? a : b);
                        const packet = stream.next.value;
                        await stream.source.add(packet.clone({ timestamp: packet.timestamp - actualStart }),
                            { decoderConfig: stream.config });
                        if (++count % 30 === 0) {
                            onProgress(Math.max(0, Math.min(0.99,
                                (packet.timestamp - actualStart) / (actualEnd - actualStart))));
                        }
                        stream.next = await stream.iterator.next();
                    }
                    for (const stream of streams) stream.source.close();
                    await output.finalize();
                    return { bytes, actualStart, actualEnd };
                } catch (error) {
                    try { await output.cancel(); } catch (_) { /* preserve original failure */ }
                    throw error;
                } finally {
                    await Promise.allSettled(streams.map(s => s.iterator.return()));
                    input.dispose();
                }
            },
        };
    } catch (error) {
        input.dispose();
        throw error;
    }
}
