# Local Streamer

A small Windows app that shows an HDMI capture card's video and plays its audio in one window,
so you can screen-share a console game to Discord without running OBS.

Plug the console into a capture card (built and tested with an Elgato 4K S), open Local Streamer,
then in Discord pick **Screen Share → Applications → "Local Streamer - …"**. The game's sound
is included in the share.

## Versions

The repo has two versions of the app:

| Folder | Stack | Status |
| --- | --- | --- |
| [`tauri/`](tauri/) | Rust + Tauri 2, plain HTML/JS front end | **Main version.** Builds to a single `local-streamer.exe` with no runtime to install. |
| repo root | Python + PySide6 (`local_streamer.py`) | Older fallback with fewer features. |

Only one app can use the capture card at a time. Close OBS, the Elgato software, or the other
version before starting one.

## Tauri version (recommended)

Features:

- Video and audio device selection, remembered between launches
- Global volume hotkeys (default Ctrl+Alt+Up / Down / M), configurable
- Volume up to 200% and an adjustable audio delay for lip sync
- Optional music mix-in, such as Spotify routed to a spare output device, so it plays once and is included in the share
- AMD FSR 1 upscaling and sharpening through WebGL
- "Now playing" game and console in the window title, with optional Discord Rich Presence
- Fullscreen (F11 or double-click), settings panel (right-click, gear icon or Ctrl+H)

Build it with Rust (stable), Node 18+ and the Visual Studio C++ build tools:

```sh
cd tauri
npm install
npm run build    # -> tauri/src-tauri/target/release/local-streamer.exe
```

See [tauri/README.md](tauri/README.md) for the full controls, dev setup and how the audio path works.

Releases: pushing a tag such as `v0.2.0` runs [.github/workflows/release.yml](.github/workflows/release.yml),
which builds the NSIS installer on GitHub Actions and attaches it to a draft release for that tag.

### Why audio is played by the .exe, not the webview

WebView2 plays sound from its helper process (`msedgewebview2.exe`), and Discord's window share
doesn't pick that up. So the Tauri version captures the card's audio with WASAPI (via `cpal`) in
Rust and plays it from `local-streamer.exe` itself.

## Python version

Needs Python 3 on Windows. Double-click `run.bat`. The first run creates `.venv` and installs
PySide6; after that it starts the app straight away.

Or run it by hand:

```sh
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python local_streamer.py
```

| What | How |
| --- | --- |
| Menu | Right-click anywhere, or Ctrl+H to show the menu bar |
| Volume (global) | Ctrl+Alt+Up / Ctrl+Alt+Down / Ctrl+Alt+M, changeable under Audio → Hotkeys... |
| Fullscreen | F11 or double-click. Esc to leave. |

## Requirements

- Windows 10/11 (Windows 11 ships the WebView2 runtime the Tauri version needs)
- A UVC capture card, such as an Elgato 4K S

## Licence

GPL-3.0. See [LICENCE.md](LICENCE.md).
