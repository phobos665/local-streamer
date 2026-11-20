# Enhancements

Ideas for where Local Streamer could go next. Nothing here is committed to; it's a backlog to pick
from. Effort is a rough guess: **S** about an afternoon, **M** a few days, **L** a week or more.
Items marked **Done** have shipped and are kept for context.

## Contents

- [Suggested order](#suggested-order)
- [CRT filter for line-multiplied retro consoles](#crt-filter-for-line-multiplied-retro-consoles)
- [Recording](#recording)
- [Quick wins](#quick-wins)
- [Picture](#picture)
- [Per-game and per-console profiles](#per-game-and-per-console-profiles)
- [Discord](#discord)
- [Overlays](#overlays)
- [Diagnostics](#diagnostics)
- [Distribution and polish](#distribution-and-polish)

## Suggested order

1. Quick wins: screenshot, privacy screen, output limiter.
2. CRT filter, stage 1 (crt-lottes with manual source settings).
3. Recording, option A.
4. Per-console profiles (they make the CRT settings and audio delay stick per console).
5. CRT filter, stages 2 and 3 (auto-detection, then crt-guest-advanced).

---

## CRT filter for line-multiplied retro consoles

**Goal:** a CRT look that holds up next to the best RetroArch shaders, for retro consoles fed
through a line multiplier, specifically a **RetroTINK 5X Pro** into the capture card at 1080p.
Streaming is 720p or 1080p end to end.

### Why most CRT filters look wrong

Most filters darken every other line and stop there. The convincing ones model the beam:

1. **Beam width varies with brightness.** Bright lines bloom fat, dark lines go thin with gaps.
   This matters most, and a fixed overlay can't do it.
2. **Blending in linear light**, then gamma, so colours mix like phosphors instead of going muddy.
3. **Phosphor mask** (aperture grille / slot / shadow mask) aligned to *output* pixels.
4. **Brightness recovery.** Mask plus scanlines lose 50–70% of the brightness; glow, halation or
   bloom bring it back.
5. **Horizontal softness / NTSC blending**, which many Genesis and SNES games relied on for
   transparency and dithering.
6. **Integer vertical scale**, so every scanline has the same height.

### Shaders to port or learn from

All from the libretro shader repositories. Check each file's licence header before porting: the
app is GPL-3.0, so GPL-2.0-or-later, MIT and public domain are fine; GPL-2.0-only is not.

| Shader | Use |
| --- | --- |
| **crt-lottes** (Timothy Lottes) | Stage 1. One pass, several mask types, bloom. Header says public domain. |
| **crt-guest-advanced** (guest.r), esp. `-fast` and `-ntsc` | Stage 3. The current enthusiast favourite; does all six points well. Multi-pass. |
| crt-easymode, crt-hyllian, crt-geom | Lighter alternatives / reference for curvature. |
| CRT-Royale, Sony Megatron | Reference only. Royale is very heavy; Megatron needs HDR, which WebGL in a webview can't reliably do. |

### What the RetroTINK 5X Pro sends

A line multiplier repeats each source line a whole number of times without blending, so the
original frame can be recovered exactly.

| 5X mode (240p source) | In the 1080p frame |
| --- | --- |
| **5x** | Each line ×5; overscan cropped to **216 active lines**, full height. |
| **4x** | Each line ×4; **240 lines** in 960 rows, black bars top and bottom. |
| **Optimal timings** | Samples at the console's dot clock, so each source pixel is a fixed block (256 or 320 wide, for example). Without them, horizontal is resampled and soft. |
| 480i / 480p content | Roughly ×2 vertically. The shader should drop scanline gaps here. |

Recommended 5X settings for use with the app's shader:

- **5X scanlines off**, so the shader gets clean pixels.
- **Optimal timings on** where the console has a profile.
- **Multiplier matched to the display**, so scanlines are even:

  | Display height | 5x (216 lines) | 4x (240 lines) |
  | --- | --- | --- |
  | 1080p | 5× exact | 4.5× uneven |
  | 1440p | 6.67× uneven | 6× exact |
  | 4K | 10× exact | 9× exact |

- If the capture card drops or stutters on the console's exact refresh (SNES is about 60.09 Hz),
  use the 5X's output / frame-lock options that keep it at standard 60 Hz (see the 5X manual).

### How it fits the app

- New scaling option next to *AMD FSR 1* in the settings panel: **CRT**.
- Reuses the WebGL setup in `tauri/src/fsr.js` (it already runs a two-pass pipeline). Could be a
  sibling module, `crt.js`, sharing the context and texture upload.
- **No downsample pass.** Given the line factor, active area and native width, the shader reads the
  captured 1080p texture at the centre of each source pixel, treating it as the native frame.
- New **Source** setting: `Auto` / `Line multiplier ×N` / `Off (modern console)`, plus active area
  and native width when manual.
- Settings exposed (keep it to a handful, with presets): scanline strength, beam width range,
  mask type and strength, glow, horizontal sharpness, curvature (off by default), gamma.
- Presets: **Clean** (scanlines + glow, no mask), **Arcade** (strong mask, more glow),
  **Consumer TV** (softer, slot mask, slight curvature).
- Per-console profiles (below) store the source settings and preset.

### Auto-detection (stage 2)

Because the multiplier duplicates rows exactly, the source settings can be detected:

1. **Active area:** find the black borders.
2. **Line factor:** compare adjacent rows; runs of matching rows give the multiplier (5, 4, ~2).
3. **Horizontal factor:** the same on columns. Reliable with Optimal timings, fuzzier without.
4. **Re-check** about once a second, or on a sharp scene change, to follow 240p ↔ 480i switches
   (PS1 menus vs gameplay, some PS2 games). The 5X changes multiplier when this happens.

Capture compression adds noise, so "matching" means within a tolerance. Read back a small strip of
rows, not the whole frame. Fall back to the last good result, or the profile's pinned value.

### Stages

| Stage | Scope | Effort |
| --- | --- | --- |
| 1 | crt-lottes port, manual source settings, presets | S–M |
| 2 | Auto-detection of active area and line / pixel factor | M |
| 3 | crt-guest-advanced(-fast) port, NTSC option | L |

### Testing

- Test patterns via the 5X (or the 240p Test Suite on the console): grid, colour bars,
  gradient, and a dithered-transparency scene (Sonic waterfalls).
- Check 5x on a 1080p display and 4x on a 1440p display for even scanlines.
- Compare the local window against a Discord share recording, at 720p and 1080p, with each preset.
  Mask strength is adjustable in case fine detail doesn't come through.
- Check a 240p ↔ 480i switch mid-session once auto-detection lands.

---

## Recording

The constraint: video is in the webview, the mixed audio (game + music) is in `audio.rs`, and audio
must never be *played* by the webview.

| Option | How | Trade-off |
| --- | --- | --- |
| **A. Webview `MediaRecorder`** (MVP) | Record the video track plus a second `getUserMedia` audio track of the capture card (recorded, never played). Stream chunks to Rust over binary IPC and append to a file. | Small. Game audio only, no music. WebM / H.264 on WebView2, MP4 on WKWebView. **M** |
| **B. Hybrid** | `MediaRecorder` for video only; Rust writes the mixed audio with timestamps on a shared clock and muxes at stop (Matroska takes raw PCM). | Recording matches what Discord hears. Needs A/V alignment and a pure-Rust MKV muxer. **M–L** |
| **C. Rust owns video capture** | Native capture (Media Foundation / AVFoundation), frames pushed to the webview. | Unlocks proper encoders and replay buffer. Rewrites the video path. **L** |

Plan: ship A, grow it into B.

- **Instant replay** ("save the last 60 s" hotkey): rotate fixed-length `MediaRecorder` segments
  and keep the last few. Mid-stream WebM chunks aren't decodable on their own. **M** after A.
- Recording hotkey, output folder setting, and a small recording indicator outside the shared area
  or togglable.

## Quick wins

| Idea | Notes | Effort |
| --- | --- | --- |
| **Screenshot hotkey** | Draw the frame (or FSR / CRT canvas) to a canvas; save PNG and/or copy to clipboard. | S |
| **Privacy / BRB screen** | Hotkey shows a "Be right back" card and mutes game audio; music keeps playing. For password entry or stepping away. | S |
| **Output limiter** | Volume goes to 200% and probably clips. Soft-knee or look-ahead limiter in `audio.rs`. | S |
| **Audio level meters** | Peaks are already in `audio_stats` (stats overlay); meters in the panel would reuse them. | S |
| **Hot-plug and reconnect** | Restart video and audio on `devicechange`; "No signal" overlay instead of a frozen frame. | S–M |

## Picture

| Idea | Notes | Effort |
| --- | --- | --- |
| **RGB range fix** (limited ↔ full) | Common cause of washed-out or crushed blacks. A shader tweak. | S |
| **Crop / overscan / aspect presets** | **Done.** 4:3 / 16:9 / stretch, crop, overscan, and *Detect* (black bars + line multiplier). The CRT filter can reuse `cropRect` and the line multiplier. | S–M |
| **Integer / nearest-neighbour scaling** | **Done.** *Sharp pixels* and *Integer scale* (whole screen pixels per source line). | S |
| **Brightness / contrast / saturation** | | S |

## Per-game and per-console profiles

*Now playing* already knows the game and console. Tie settings to them: mode, scaling, CRT source
settings and preset, crop, RGB range, audio delay. Switching to "SNES via RetroTINK" restores 4:3,
CRT preset and 40 ms delay in one go. **M**

## Discord

| Idea | Notes | Effort |
| --- | --- | --- |
| **Cover art in Rich Presence** | `large_image` accepts external URLs. User-supplied URL, or an IGDB lookup. | S–M |
| **Elapsed-time timestamp** | Already sent. | S |
| **Game as the activity name** | **Done.** Sent as `name`; Discord builds that ignore it still show the game under the app name. | S |
| **Playtime log** | Per-game session history. | S–M |

## Overlays

These appear in the share.

- **Webcam picture-in-picture**: a second `getUserMedia` camera in a draggable corner. Discord only
  allows one stream at a time, so this gets you and the game in one share. **M**
- **Now-playing caption / clock**, togglable. **S**

## Diagnostics

- **Stats overlay**: **Done.** FPS, dropped frames, capture-to-screen latency, actual capture mode,
  audio FIFO fill / target, underruns, skips, peaks, output latency and clipping. Ctrl+I.
- **A/V sync helper**: **Done.** Times a flash-and-beep test played on the console and sets
  *Audio delay*. Also fixed the delay slider, which only took effect after the next dropout.

## Distribution and polish

| Idea | Notes | Effort |
| --- | --- | --- |
| **Auto-update** | `tauri-plugin-updater` against GitHub Releases; needs a signing key in CI. | M |
| **macOS notarization** | Removes "Open Anyway" and repeated permission prompts. Needs a paid Apple Developer account. | M |
| **Tray icon, start minimized, launch at login** | | S–M |
| **Linux** | cpal is fine; WebKitGTK `getUserMedia` is the open question. Research spike first. | ? |
