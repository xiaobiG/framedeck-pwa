Synthetic test media, generated locally with FFmpeg (no third-party footage):

```sh
ffmpeg -f lavfi -i 'testsrc2=size=160x90:rate=24:duration=12' -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=12' -c:v libx264 -g 48 -keyint_min 48 -sc_threshold 0 -bf 3 -c:a aac -b:a 32k clip-avc-aac.mp4
ffmpeg -f lavfi -i 'testsrc2=size=160x90:rate=24:duration=6' -c:v libx265 -x265-params 'keyint=48:min-keyint=48:scenecut=0:open-gop=0' -tag:v hvc1 -an clip-hevc-silent.mp4
```

The tests insert a virtual 7 GiB `free` box and rewrite `stco` to `co64`, exercising large file addressing without allocating gigabytes in CI.
