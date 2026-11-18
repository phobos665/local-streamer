# Local Streamer (Tauri)

A single-window HDMI capture viewer for screen-sharing console games to Discord.
It shows the capture card's video and plays its audio. Share the window in Discord
(Screen Share → Applications → "Local Streamer - …") and the audio comes along.

## Use

| What | How |
| --- | --- |
| Settings panel | Right-click, the gear icon (top right), or Ctrl+H |
| Volume up / down / mute (global) | Ctrl+Alt+Up / Ctrl+Alt+Down / Ctrl+Alt+M. Change them in the settings panel. |
| Fullscreen | F11 or double-click. Esc to leave. |
| Volume above 100% | Boosts quiet sources, up to 200% |
| Audio delay | Delays the sound if it arrives before the picture |
| Music (Spotify etc.) | In Windows' Volume mixer, set the player's output to a spare device such as "Speakers (Steam Streaming Speakers)". Choose that device under Music in the panel. Local Streamer captures it and mixes it in, so it plays once and Discord's share includes it. Music hotkeys: Ctrl+Alt+Shift+Up / Down / M. |
| Scaling | Video → Scaling → AMD FSR 1. It upscales with EASU and sharpens with RCAS, using WebGL on any GPU (`src/fsr.js`). Sharpness is adjustable. When the window is smaller than the video, it only sharpens. |
| Game / console | Set under "Now playing". They become the window title, e.g. "Halo 3 · Xbox 360", and previous entries are suggested next time. |
| Discord status | Optional Rich Presence ("Playing &lt;game&gt;", "on &lt;console&gt;"). Needs a Discord Application ID: create one at discord.com/developers/applications and paste it in. |

The app remembers your devices, mode, volume, hotkeys and window position.
Only one app can use the capture card at a time, so close OBS and the Python version first.

## Build

Needs Rust (stable), Node 18+ and the Visual Studio C++ build tools.

```sh
npm install
npm run build          # -> src-tauri/target/release/local-streamer.exe
npm run dev            # run with live reload of src/
npx tauri build        # optional: also builds an NSIS installer
```

The .exe is self-contained. It uses the WebView2 runtime that ships with Windows 11.

## How it works

- `src/` is plain HTML/CSS/JS with no bundler. `getUserMedia` opens the capture card and
  the picture goes to a `<video>` element.
- Sound does **not** go through the webview. WebView2 plays audio from its own helper process
  (msedgewebview2.exe), and Discord's window share doesn't capture that.
  `src-tauri/src/audio.rs` instead captures the input with WASAPI (cpal) and plays it from
  `local-streamer.exe` itself. The buffer is held at 15 ms plus the audio delay setting.
  If clock drift lets the buffer grow, it skips ahead; if it runs dry, it refills with silence.
- `src-tauri/src/main.rs` provides the global hotkeys (`tauri-plugin-global-shortcut`).
  It also auto-grants camera and microphone access to the page, so you don't get a prompt every launch,
  and disables browser shortcuts such as F5. Window position is saved with `tauri-plugin-window-state`.
- WebView2 background throttling is turned off (see `additionalBrowserArgs` in `tauri.conf.json`),
  so video keeps updating while the window is behind other windows, for example during a Discord share.
