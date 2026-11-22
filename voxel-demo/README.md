# FORGE scene-only demo

Self-contained Three.js / WebGL diorama. Four research labs and a factory that builds the gesture wristband in five visible steps. All activity is simulated locally. There are no backend calls.

Run from the repository root:

```sh
python3 -m http.server 8766 --bind 127.0.0.1 --directory voxel-demo
```

Open http://127.0.0.1:8766/ . Drag to orbit, scroll to zoom, click a researcher to show their dialogue. The 54-second demonstration loops automatically. Reduced-motion preferences start it paused.

Optional **Whip · off** in the scene controls enables a cartoon swing: click a crew member for a brief hop, squint, and 2× work-animation boost (2.4 seconds). Misses only swing; Escape exits. This is cosmetic, never faster agent/API execution. Reduced motion suppresses the added animation. The integrated research app uses the mirrored `/static/diorama/index.html` via **Cute**; returning to **Graph** disarms the whip.

Check the bounded hit/boost state with `node tests/voxel-whip.mjs` from the repository root.

Embed the directory as static assets and use an iframe pointing to its index.html. No surrounding UI is required. The iframe's same-origin `contentWindow.ForgeDiorama` exposes `play()`, `pause()`, `restart()`, `setProgress(seconds)` and `getState()`. These are local presentation controls only; no backend integration is included.

`app.js` owns the procedural geometry, lighting and animation. `style.css` owns the canvas and dialogue overlays. Three.js is vendored under `vendor/` with its license. Instrument Sans is the existing application's font.
