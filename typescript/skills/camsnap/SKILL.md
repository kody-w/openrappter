---
name: camsnap
description: Capture frames or clips from RTSP/ONVIF cameras.
homepage: https://camsnap.ai
metadata: {"openclaw":{"emoji":"📸","requires":{"bins":["camsnap"]},"install":[{"id":"brew","kind":"brew","formula":"camsnap","bins":["camsnap"],"label":"Install camsnap (brew)"}]}}
---

# CamSnap

Capture images and video clips from IP cameras (RTSP/ONVIF).

## Capture a Frame

```bash
camsnap capture --url rtsp://camera-ip:554/stream --output /tmp/frame.jpg
```

## List Cameras

```bash
camsnap discover
```

## Record a Clip

```bash
camsnap record --url rtsp://camera-ip:554/stream --duration 10 --output /tmp/clip.mp4
```

## Continuous Monitoring

```bash
camsnap watch --url rtsp://camera-ip:554/stream --interval 60 --output /tmp/frames/
```
