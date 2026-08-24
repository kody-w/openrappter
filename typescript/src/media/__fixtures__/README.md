# Media test fixture

`one-frame.mp4` is a generated 16×16 black H.264 frame with no audio. It was
created for OpenRappter tests with:

```bash
ffmpeg -f lavfi -i color=c=black:s=16x16:d=0.04 -an \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart one-frame.mp4
```

The release smoke appends a valid `free` atom to reach the exact reported size
without holding the expanded fixture in memory.
