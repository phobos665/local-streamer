# Local Streamer (Tauri)

The main version of Local Streamer, for Windows and macOS. See the [root README](../README.md)
for installing, using it, music setup and troubleshooting. This file covers building and how the
code works.

## Build

Needs Rust (stable) and Node 18+, plus the Visual Studio C++ build tools on Windows or the Xcode
Command Line Tools on macOS.

```sh
npm install
npm run dev          # run with live reload of src/
npm run build        # bare binary, no installer (Windows: src-tauri/target/release/local-streamer.exe)
npm run build:mac    # macOS .app: src-tauri/target/release/bundle/macos/Local Streamer.app
npx tauri build      # full bundles for this OS: NSIS installer, or .app + .dmg
```

On Windows the .exe is self-contained and uses the WebView2 runtime that ships with Windows 11.
On macOS, run the `.app`, not the bare `target/release/local-streamer` binary or `npm run dev`:
macOS only reads the camera / microphone usage strings from a bundled app's `Info.plist`, so the
bare binary gets no video and silent audio. The app detects this and says so.

## Platform files

| File | Used on | Purpose |
| --- | --- | --- |
| `src-tauri/tauri.conf.json` | all | Base config. Bundle target NSIS. |
| `src-tauri/tauri.macos.conf.json` | macOS | Merged over the base: `.app` + `.dmg`, macOS 12 minimum, ad-hoc signing, entitlements. |
| `src-tauri/Info.plist` | macOS | Merged into the bundle's Info.plist: camera, microphone and audio-capture usage strings. |
| `src-tauri/Entitlements.plist` | macOS | Camera and audio-input entitlements for the hardened runtime. |

## How it works

- `src/` is plain HTML/CSS/JS with no bundler. `getUserMedia` opens the capture card and
  the picture goes to a `<video>` element. Crop, a forced aspect ratio, sharp / integer scaling
  and FSR 1 go through the WebGL renderer in `src/fsr.js` instead, drawing to a canvas.
  `main.js` gives it a layout function (which part of the frame, and where on the canvas, in
  device pixels) and a filter (`linear`, `nearest` or `fsr`).
- `src/analyse.js` works on luma arrays with no DOM: `findPicture` finds the black borders and a
  line multiplier (rows repeated in blocks of *f*, so all row-to-row change sits on every *f*-th
  row; the largest *f* that fits wins), and `flashFraction` drives the A/V sync helper.
- Stats overlay: frame rate and capture-to-screen latency come from
  `requestVideoFrameCallback`, dropped frames from `getVideoPlaybackQuality()` and the track's
  `stats`. Audio numbers come from the `audio_stats` command, which reads atomics that the
  audio callbacks keep up to date: FIFO fill vs target, underruns, skips, peaks, output buffer,
  device latency and clipped samples.
- A/V sync helper: `audio_sync_probe` turns on a beep detector on the game source in the output
  callback. It timestamps each beep at the moment it leaves the output device (callback time
  plus cpal's playback timestamp), on the engine's monotonic clock (`audio_clock`). The page
  times flashes with `requestVideoFrameCallback`'s `expectedDisplayTime`, converts beep times
  with a round-trip clock offset, pairs flashes with beeps, and sets the delay from the median.
- Sound does **not** go through the webview. WebView2 plays audio from its own helper process
  (msedgewebview2.exe) and WKWebView from WebKit's WebContent process, and Discord's window share
  doesn't attribute those to the app. `src-tauri/src/audio.rs` instead captures the input with
  cpal (WASAPI on Windows, Core Audio on macOS) and plays it from the app's own process.
  The buffer is held at 15 ms plus the audio delay setting. If clock drift lets the buffer grow,
  it skips ahead; if it runs dry, it refills with silence. When the delay setting changes, the
  buffer moves to the new level at once: it trims, or refills with silence.
- Music mix-in captures an output device: WASAPI loopback on Windows, a Core Audio process tap on
  macOS 14.6+. A virtual device with an input side, such as BlackHole, is read as an ordinary input.
- On macOS the output stream uses the device's own sample rate and format, because cpal would
  otherwise switch the speakers' hardware rate to match the capture card. The resampler in
  `audio.rs` covers the difference. On Windows it requests f32 stereo at the source rate.
- `src-tauri/src/main.rs` provides the global hotkeys (`tauri-plugin-global-shortcut`).
  On Windows it auto-grants camera and microphone access to the page, so you don't get a prompt
  every launch, and disables browser shortcuts such as F5. On macOS wry grants the page's media
  requests by default, and macOS asks once at the system level. Window position is saved with
  `tauri-plugin-window-state`.
- Background throttling is turned off, so video keeps updating while the window is behind other
  windows, for example during a Discord share: `additionalBrowserArgs` for WebView2 and
  `backgroundThrottling: "disabled"` for WKWebView (macOS 14+), both in `tauri.conf.json`.
- Platform-specific text in `index.html` uses the `os-windows` / `os-mac` classes. `main.js`
  adds `mac` to `<html>` on macOS, and also uses it for Mac key labels (⌃⌥⇧⌘) and shortcuts
  (⌃⌘F fullscreen, ⌘, settings).
