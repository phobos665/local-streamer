# CLAUDE.md

Local Streamer is a single-window HDMI capture viewer. It shows a capture card's video and
plays its audio from its own process, so a console game can be screen-shared to Discord
(window share) without OBS. It targets **Windows and macOS**.

## Layout

| Path | What |
| --- | --- |
| `tauri/` | **Main app.** Tauri 2 + Rust back end, plain HTML/CSS/JS front end (no bundler, no framework). |
| `tauri/src/` | Front end. `main.js` (all UI logic and settings), `fsr.js` (WebGL renderer: crop, aspect, nearest / integer scaling, AMD FSR 1), `analyse.js` (frame analysis: borders, line multiplier, flash detection; no DOM), `index.html`, `style.css`. |
| `tauri/src-tauri/src/main.rs` | Tauri commands, global hotkeys, Windows-only WebView2 permission handler. |
| `tauri/src-tauri/src/audio.rs` | cpal audio engine: game input + optional music loopback, mixed and played to an output device. |
| `tauri/src-tauri/src/discord.rs` | Optional Discord Rich Presence over local IPC. |
| `tauri/src-tauri/tauri.conf.json` | Base config (Windows bundle = NSIS). |
| `tauri/src-tauri/tauri.macos.conf.json` | macOS overrides, merged automatically on macOS: `.app` + `.dmg`, ad-hoc signing, entitlements. |
| `tauri/src-tauri/Info.plist` | Merged into the macOS bundle. Camera / microphone / audio-capture usage strings. |
| `tauri/src-tauri/Entitlements.plist` | Camera + audio-input entitlements for the hardened runtime. |
| `.github/workflows/release.yml` | Tag `v*` -> draft release with the Windows NSIS installer and a macOS universal `.dmg`. |

## Commands

Run from `tauri/`:

```sh
npm install
npm run dev          # live reload of src/ (front-end edits need no Rust rebuild)
npm run build        # bare binary, no bundle (Windows: local-streamer.exe)
npm run build:mac    # macOS .app in src-tauri/target/release/bundle/macos/
npx tauri build      # full bundles for the current OS (NSIS on Windows, .app + .dmg on macOS)
```

Rust checks, from `tauri/src-tauri/`:

```sh
cargo check
cargo clippy
cargo test                 # lists audio devices; needs at least one output device
cargo test -- --ignored    # hardware test, Windows only (expects "Steam Streaming Speakers")
```

There is no JS test suite or linter config. Keep the front end dependency-free.
`cargo test engine_tests` covers the audio FIFO and beep detector without audio hardware.

## How it fits together

- **Video**: `getUserMedia` in the webview -> `<video>`, or the WebGL canvas (`fsr.js`) whenever
  crop, aspect, sharp / integer scaling or FSR is on. `layout()` in `main.js` decides the crop and
  output rectangle in device pixels; integer scaling uses whole screen pixels per *source* line
  (capture lines / `lineMultiplier`). The page calls the
  `media_ready` command before `getUserMedia`. On Windows that installs a WebView2
  `PermissionRequested` handler that auto-allows camera/mic and disables browser accelerator keys.
  On macOS it's a no-op: wry's WKUIDelegate grants media requests by default, and the OS-level
  prompt comes from the `Info.plist` usage strings.
- **Audio never goes through the webview.** WebView2 (msedgewebview2.exe) and WKWebView
  (WebKit WebContent process) play sound from helper processes, which Discord's window share
  doesn't attribute to the app. `audio.rs` captures with cpal and plays from the main process.
  The `<video>` element is always `muted`; keep it that way.
- **Audio engine** (`audio.rs`): a dedicated thread owns the cpal streams (they aren't `Send`
  on every host). Each source has a FIFO whose fill level is its latency, held near a target
  (15 ms game + user delay, 30 ms music); overshoot beyond 50 ms is dropped, underrun re-primes
  with silence, and a target change (delay slider) trims or re-primes at once. Linear resampling
  handles rate differences between sources and the output. Callbacks also keep atomics for the
  stats overlay (`audio_stats`) and, while `audio_sync_probe` is on, timestamp beep onsets on the
  engine clock (`audio_clock`) for the A/V sync helper.
- **Music loopback**: an input stream on an *output* device. cpal does this with WASAPI loopback
  on Windows and a Core Audio process tap on macOS 14.6+. Devices with an input side (BlackHole)
  are opened as a plain input, so the code prefers `default_input_config()` and falls back to
  `default_output_config()`. The music device must not be the device we play to (guarded).
- **Output format**: Windows asks for f32 stereo at the source rate (WASAPI converts). On macOS
  the device's own default config is used, because cpal's CoreAudio host would otherwise change
  the speakers' hardware sample rate system-wide. Don't remove that `cfg!(windows)` branch.
- **Hotkeys**: `tauri-plugin-global-shortcut`. The front end sends `{action: accelerator}` to
  `set_hotkeys`; Rust emits `hotkey` events back. Accelerators use `KeyboardEvent.code` names
  (`Ctrl+Alt+ArrowUp`); `Super` is Cmd on macOS. macOS shows them with ⌃⌥⇧⌘ (`prettyKey`).
- **Settings** live in the webview's `localStorage` (`settings` key). Devices are remembered
  by label, not id. Crop is stored with the frame size it was set on and scaled if the mode changes.
- **Discord presence** sends the game as the activity `name` (some Discord builds show it in place
  of the application name) and also in `details` with `StatusDisplayType::Details`. Window position/size: `tauri-plugin-window-state`.
- **Background throttling** must stay off, or video freezes while the window is behind Discord:
  `additionalBrowserArgs` (WebView2) and `backgroundThrottling: "disabled"` (WKWebView, macOS 14+).

## Platform gotchas

- Platform-specific UI text uses `.os-windows` / `.os-mac` classes; `main.js` sets `html.mac`.
  Platform checks in JS use `IS_MAC`; in Rust use `cfg(windows)` / `cfg(target_os = "macos")`.
- Windows-only crates (`webview2-com`, `windows-core`) are under
  `[target.'cfg(windows)'.dependencies]`. Keep new platform crates target-gated.
- macOS camera/mic access only works from a bundled `.app` (TCC reads the bundle's Info.plist).
  The bare `target/release/local-streamer` (from `npm run build`, or next to the bundle) gets
  `NotAllowedError` and silent audio; `npm run dev` is attributed to whatever launched it.
  Test with `npm run build:mac` and open the `.app`. The `unbundled_mac` command lets the UI
  explain this instead of reporting "no video device".
- WebKit's `enumerateDevices()` returns a single placeholder camera with an empty `deviceId`
  until camera access is granted, so `refreshDevices` keeps the unlock error in `cameraError`
  and `startVideo` reports it.
- On macOS, settings (`localStorage`) live in
  `~/Library/WebKit/dev.local.streamer/WebsiteData/Default/…/LocalStorage/localstorage.sqlite3`
  (values are UTF-16). Useful for checking what the app selected.
- The macOS build is ad-hoc signed (`signingIdentity: "-"`), not notarized. Each rebuild has a new
  signature, so macOS may ask for camera/mic permission again after an update.
- Only one app can open a UVC capture card at a time (OBS, Elgato software).

## Conventions

- Keep the front end as plain ES modules served from `src/`; no build step, no npm runtime deps.
- `withGlobalTauri` is on; the front end uses `window.__TAURI__`, not `@tauri-apps/api`.
- New window APIs need a permission entry in `src-tauri/capabilities/default.json`.
- User-facing docs: root `README.md` (use and install), `tauri/README.md` (developer detail).
  Update both when behaviour or setup changes.
- Licence is GPL-3.0.
