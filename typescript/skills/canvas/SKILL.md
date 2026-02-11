---
name: canvas
description: Generate and manipulate images using the HTML5 Canvas API through a headless browser or node-canvas.
metadata: {"openclaw":{"emoji":"🎨","requires":{}}}
---

# Canvas

Create and manipulate images programmatically using canvas APIs.

## Node.js (node-canvas)

```javascript
const { createCanvas } = require('canvas');
const fs = require('fs');

const canvas = createCanvas(800, 600);
const ctx = canvas.getContext('2d');

ctx.fillStyle = '#1a1a2e';
ctx.fillRect(0, 0, 800, 600);
ctx.fillStyle = '#e94560';
ctx.font = 'bold 48px sans-serif';
ctx.fillText('Hello Canvas', 200, 300);

fs.writeFileSync('/tmp/canvas.png', canvas.toBuffer('image/png'));
```

## Use Cases

- Generate social media images
- Create charts and graphs
- Process and annotate screenshots
- Build thumbnail generators
```
