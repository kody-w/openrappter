---
name: video-frames
description: Extract frames from video files using ffmpeg for analysis or processing.
metadata: {"openclaw":{"emoji":"🎬","requires":{"bins":["ffmpeg"]}}}
---

# Video Frames

Extract frames from video files.

## Extract a Single Frame

```bash
ffmpeg -i video.mp4 -ss 00:00:05 -frames:v 1 /tmp/frame.jpg
```

## Extract Frames at Interval

```bash
# One frame every 10 seconds
ffmpeg -i video.mp4 -vf "fps=1/10" /tmp/frames/frame_%04d.jpg
```

## Extract Key Frames Only

```bash
ffmpeg -i video.mp4 -vf "select=eq(pict_type\\,I)" -vsync vfr /tmp/keyframes/kf_%04d.jpg
```

## Create Thumbnail Grid

```bash
ffmpeg -i video.mp4 -vf "fps=1/30,scale=160:90,tile=5x4" /tmp/thumbnails.jpg
```

## Get Video Info

```bash
ffprobe -v quiet -print_format json -show_streams video.mp4
```
