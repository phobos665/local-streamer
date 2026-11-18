# Local Streamer

A small app for Windows and macOS that shows an HDMI capture card's video and plays its audio in
one window, so you can screen-share a console game to Discord without running OBS.

Plug the console into a capture card (built and tested with an Elgato 4K S), open Local Streamer,
then in Discord pick **Screen Share → Applications → "Local Streamer - …"** (or the game title
you set under *Now playing*). The game's sound plays from the app itself, so it goes with the share.

## Contents

- [Install](#install)
- [Using it](#using-it)
- [Mixing in music](#mixing-in-music)
- [Discord status](#discord-status-rich-presence)
- [Troubleshooting](#troubleshooting)
- [Building from source](#building-from-source)
- [How it works](#how-it-works)
- [Licence](#licence)

## Install

Download the latest build from the [Releases](../../releases) page.

### Windows 10 / 11

Run `Local Streamer_*_x64-setup.exe`. The app uses the WebView2 runtime, which ships with
Windows 11; the installer fetches it on Windows 10 if it's missing.

### macOS 12 or later (Apple Silicon and Intel)

1. Open `Local Streamer_*_universal.dmg` and drag **Local Streamer** to Applications.
2. The app isn't notarized by Apple, so the first launch is blocked. Open
   **System Settings → Privacy & Security**, scroll down and press **Open Anyway**.
   Or, in Terminal:

   ```sh
   xattr -dr com.apple.quarantine "/Applications/Local Streamer.app"
   ```

3. Allow **Camera** and **Microphone** access when asked. macOS treats the capture card's video
   as a camera and its sound as a microphone. If you pressed *Don't Allow*, turn them on later in
   **System Settings → Privacy & Security → Camera / Microphone**.

The app is ad-hoc signed, so macOS may ask for these permissions again after you update.

## Using it

Only one app can use the capture card at a time. Close OBS or the Elgato software before
starting Local Streamer.

| What | Windows | macOS |
| --- | --- | --- |
| Settings panel | Right-click, the gear icon (top right), or Ctrl+H | Right-click, the gear icon, Ctrl+H or ⌘, |
| Fullscreen | F11 or double-click. Esc to leave. | ⌃⌘F, the green window button, or double-click. Esc to leave. |
| Game volume up / down / mute (global) | Ctrl+Alt+Up / Down / M | ⌃⌥Up / Down / M |
| Music volume up / down / mute (global) | Ctrl+Alt+Shift+Up / Down / M | ⌃⌥⇧Up / Down / M |

Global hotkeys work while other windows are focused. Change them in the settings panel: click a
hotkey, press the new combination, Esc to cancel, Backspace to clear.

In the settings panel:

- **Now playing**: game and console. They become the window title (for example
  "Halo 3 · Xbox 360"), which is the name Discord shows in its share picker. Previous entries are
  suggested next time.
- **Video**: capture device, resolution / frame rate, and scaling. *AMD FSR 1* upscales with EASU
  and sharpens with RCAS using WebGL, on any GPU. When the window is smaller than the video it only
  sharpens.
- **Audio**: the capture input (for example "HDMI (Elgato 4K S)"), the output you listen on,
  volume up to 200% for quiet sources, and an audio delay for when sound arrives before the picture.
- **Window**: always on top, fullscreen.

The app remembers your devices, mode, volumes, hotkeys and window position.

## Mixing in music

Local Streamer can capture music (Spotify and so on) from a spare audio device and mix it into
its own output. You hear it once, and Discord's window share includes it.

**Windows**: in **Settings → System → Sound → Volume mixer**, set the music player's *Output
device* to a device you don't listen on, such as "Speakers (Steam Streaming Speakers)". Choose that
same device under **Music → Capture from**.

**macOS**: macOS has no per-app output setting, so you need a virtual audio device. The free
[BlackHole 2ch](https://existential.audio/blackhole/) works:

1. Install BlackHole 2ch.
2. Send the music to it, either:
   - set **System Settings → Sound → Output** to BlackHole 2ch, and set Discord's own output
     (**Discord Settings → Voice & Video → Output Device**) to your real speakers or headphones,
     so you still hear your friends; or
   - route just the music player to BlackHole with an app such as SoundSource.
3. In Local Streamer, set **Audio → Output** to your real speakers or headphones (not
   "System default", if the system default is now BlackHole).
4. Choose **BlackHole 2ch** under **Music → Capture from**.

Capturing a regular output device (rather than a virtual one like BlackHole) needs macOS 14.6 or
later, and macOS asks once for permission to capture audio.

Music has its own volume, mute and hotkeys. The music device can't be the same device Local
Streamer plays to.

## Discord status (Rich Presence)

Optional. Shows "Playing &lt;game&gt;" and "on &lt;console&gt;" on your Discord profile. One-time
setup: go to [discord.com/developers/applications](https://discord.com/developers/applications),
click **New Application**, name it (for example "Console"), then paste its **Application ID** into
**Now playing → Discord status** in the settings panel. Leave it empty to turn it off. The Discord
desktop app must be running.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| "Can't open the capture card" | Another app has it open. Close OBS or Elgato Studio / 4K Capture Utility. |
| macOS: no video or audio devices, or "macOS blocks camera and microphone access…" | You're running the bare binary (`target/release/local-streamer`) instead of the app. Open `Local Streamer.app`. macOS only grants camera and microphone access to a bundled app. |
| macOS: "Camera access is off" | System Settings → Privacy & Security → Camera → turn on Local Streamer, then reopen the app. |
| No video devices listed | Replug the card. On macOS, check that Local Streamer has Camera access. |
| No sound | Pick the card's audio under **Audio → Input**. On macOS, check Microphone access. |
| Sound is ahead of the picture | Raise **Audio delay**. |
| A hotkey button has a red border | Another app already uses that combination. Pick a different one. |
| macOS: "Local Streamer is damaged" or "can't be opened" | It's the quarantine flag on an un-notarized app. See [Install](#macos-12-or-later-apple-silicon-and-intel). |
| Discord share has no sound | Share the **Local Streamer window** (Applications tab), not the whole screen. On macOS, app audio in window shares depends on Discord's macOS support and your Discord / macOS version. |
| Video freezes when the window is behind others | Shouldn't happen: background throttling is disabled. On macOS this needs macOS 14 or later; on older versions keep the window visible. |

## Building from source

Needs Rust (stable) and Node 18+, plus:

- **Windows**: the Visual Studio C++ build tools.
- **macOS**: the Xcode Command Line Tools (`xcode-select --install`).

```sh
cd tauri
npm install
npm run dev          # run with live reload of src/
npm run build        # Windows: tauri/src-tauri/target/release/local-streamer.exe
npm run build:mac    # macOS: tauri/src-tauri/target/release/bundle/macos/Local Streamer.app
npx tauri build      # full bundles for this OS: NSIS installer, or .app + .dmg
```

On macOS, always run the `.app` from `npm run build:mac`, not the bare
`target/release/local-streamer` binary next to it (or `npm run build`'s output). macOS reads the
camera and microphone permission text from the app bundle, so the bare binary gets no video and
silent audio. A universal (Apple Silicon + Intel) build
needs both Rust targets:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npx tauri build --target universal-apple-darwin
```

### Releases

Pushing a tag such as `v0.2.0` runs [.github/workflows/release.yml](.github/workflows/release.yml).
It creates a draft release for the tag, builds the Windows NSIS installer and the macOS universal
`.dmg` on GitHub Actions, and attaches both. Check the draft on GitHub, then press **Publish**.
The app version is taken from the tag.

## How it works

- The front end (`tauri/src/`) is plain HTML/CSS/JS with no bundler. `getUserMedia` opens the
  capture card and the picture goes to a `<video>` element (or a WebGL canvas when FSR is on).
- Sound does **not** go through the webview. Both system webviews play audio from a helper
  process (`msedgewebview2.exe` on Windows, WebKit's WebContent process on macOS), and Discord's
  window share doesn't attribute that to the app. Instead, `tauri/src-tauri/src/audio.rs`
  captures the card's audio with [cpal](https://github.com/RustAudio/cpal) (WASAPI on Windows,
  Core Audio on macOS) and plays it from the app's own process. The buffer is held at 15 ms plus
  the audio delay setting. If clock drift lets it grow it skips ahead; if it runs dry it refills
  with silence.
- Global hotkeys come from `tauri-plugin-global-shortcut`, window position from
  `tauri-plugin-window-state`, and Rich Presence from `discord-rich-presence`.
- Webview background throttling is off, so video keeps updating while the window is behind other
  windows during a Discord share.

See [tauri/README.md](tauri/README.md) for more developer detail.

## Requirements

- Windows 10/11, or macOS 12 or later
- A UVC capture card, such as an Elgato 4K S

## Licence

GPL-3.0. See [LICENCE.md](LICENCE.md).
