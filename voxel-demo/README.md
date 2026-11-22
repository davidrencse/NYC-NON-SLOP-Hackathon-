# FORGE scene-only demo

Self-contained Three.js / WebGL diorama. Four research labs and a factory that builds the gesture wristband in five visible steps. All activity is simulated locally. There are no backend calls.

Run from the repository root:

```sh
python3 -m http.server 8766 --bind 127.0.0.1 --directory voxel-demo
```

Open http://127.0.0.1:8766/ . Drag to orbit, scroll to zoom, click a researcher to show their dialogue. The 54-second demonstration loops automatically. Reduced-motion preferences start it paused.

Optional **Whip · off** enables a tapered cursor rope: move the handle, then flick so the trailing **tip** sweeps a visible crew member (click adds an impulse). A fast tip cracks, with a cooldown; misses do not affect crew. Hits briefly hop/squint, show the scripted “I’ll work faster, I promise!” bubble, and double work-animation speed for 2.4 seconds. Sound follows the existing mute toggle; no TTS or AI response is involved. Escape exits; reduced motion disables the rope. This is cosmetic, never faster agent/API execution. The integrated app uses mirrored `/static/diorama/index.html` via **Cute**; **Graph** disarms it.

Motion reference: [WHIP Cursor](https://whipcursor.com/) (cursor inertia and velocity-triggered cracks). This implementation is original; no extension code/assets are used.

Check the bounded hit/boost state with `node tests/voxel-whip.mjs` from the repository root.

Embed the directory as static assets and use an iframe pointing to its index.html. No surrounding UI is required. The iframe's same-origin `contentWindow.ForgeDiorama` exposes `play()`, `pause()`, `restart()`, `setProgress(seconds)` and `getState()`. These are local presentation controls only; no backend integration is included.

`app.js` owns the procedural geometry, lighting and animation. `style.css` owns the canvas and dialogue overlays. Three.js is vendored under `vendor/` with its license. Instrument Sans is the existing application's font.
