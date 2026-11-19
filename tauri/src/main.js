// Local Streamer frontend. Picture: getUserMedia -> <video>.
// Sound: handled in Rust (src-tauri/src/audio.rs) so it plays from the app's own
// process, which is what Discord's window share captures.
import { VideoRenderer } from "./fsr.js";
import { lumaOf, findPicture, flashFraction } from "./analyse.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const appWindow = window.__TAURI__.window.getCurrentWindow();

const IS_MAC = /Mac/.test(navigator.platform || navigator.userAgent);
document.documentElement.classList.toggle("mac", IS_MAC); // shows the .os-mac hints
const PREFERRED = "elgato 4k s";
const VOLUME_STEP = 5;
const MAX_VOLUME = 200;
const DEFAULT_HOTKEYS = {
  volume_up: "Ctrl+Alt+ArrowUp",
  volume_down: "Ctrl+Alt+ArrowDown",
  mute: "Ctrl+Alt+KeyM",
  music_up: "Ctrl+Alt+Shift+ArrowUp",
  music_down: "Ctrl+Alt+Shift+ArrowDown",
  music_mute: "Ctrl+Alt+Shift+KeyM",
};
// Candidate capture modes; filtered against what the device reports.
const MODES = [
  [3840, 2160, 60], [3840, 2160, 30],
  [2560, 1440, 120], [2560, 1440, 60],
  [1920, 1080, 240], [1920, 1080, 120], [1920, 1080, 60], [1920, 1080, 30],
  [1280, 720, 60],
];
const DEFAULT_MODE = "1920x1080@60";

const $ = (id) => document.getElementById(id);
const els = {
  video: $("video"), osd: $("osd"), message: $("message"), panel: $("panel"),
  gear: $("gear"), close: $("close"),
  videoDevice: $("videoDevice"), videoMode: $("videoMode"), videoStatus: $("videoStatus"),
  audioDevice: $("audioDevice"), audioOutput: $("audioOutput"), audioStatus: $("audioStatus"),
  volume: $("volume"), volumeText: $("volumeText"), mute: $("mute"),
  delay: $("delay"), delayText: $("delayText"),
  musicDevice: $("musicDevice"), musicVolume: $("musicVolume"), musicVolumeText: $("musicVolumeText"),
  musicMute: $("musicMute"),
  canvas: $("canvas"), scaling: $("scaling"), sharpness: $("sharpness"), sharpnessText: $("sharpnessText"),
  sharpnessRow: $("sharpnessRow"), pictureStatus: $("pictureStatus"),
  aspect: $("aspect"), overscan: $("overscan"), overscanText: $("overscanText"),
  lineMultiplier: $("lineMultiplier"), lineMultiplierRow: $("lineMultiplierRow"),
  detect: $("detect"), resetCrop: $("resetCrop"),
  crop: { top: $("cropTop"), bottom: $("cropBottom"), left: $("cropLeft"), right: $("cropRight") },
  stats: $("stats"), showStats: $("showStats"),
  measureSync: $("measureSync"), syncStatus: $("syncStatus"),
  resetHotkeys: $("resetHotkeys"), onTop: $("onTop"), fullscreen: $("fullscreen"),
  game: $("game"), console: $("console"), gameHistory: $("gameHistory"), consoleList: $("consoleList"),
  discordId: $("discordId"), presenceStatus: $("presenceStatus"),
};
const CONSOLES = [
  "PlayStation 5", "PlayStation 4", "PlayStation 3", "PlayStation 2",
  "Xbox Series X|S", "Xbox One", "Xbox 360",
  "Nintendo Switch 2", "Nintendo Switch", "Wii U", "Wii", "GameCube",
  "Steam Deck", "PC", "Retro console",
];

// ---------------------------------------------------------------- settings
const settings = Object.assign(
  {
    videoLabel: "", mode: DEFAULT_MODE, audioLabel: null, outputLabel: "",
    volume: 80, muted: false, delay: 0, onTop: false, hotkeys: { ...DEFAULT_HOTKEYS },
    game: "", console: "", gameHistory: [], consoleHistory: [], discordId: "", playStart: 0,
    musicLabel: "", musicVolume: 50, musicMuted: false,
    scaling: "off", sharpness: 80,
    // Picture. crop holds border sizes in pixels of a w x h frame (scaled if the mode changes).
    aspect: "source", overscan: 0, lineMultiplier: 1,
    crop: { top: 0, bottom: 0, left: 0, right: 0, w: 0, h: 0 },
    showStats: false,
  },
  load(),
);
// Older saves don't have the newer hotkeys.
settings.hotkeys = { ...DEFAULT_HOTKEYS, ...settings.hotkeys };
function load() {
  try { return JSON.parse(localStorage.getItem("settings") || "{}"); } catch { return {}; }
}
function save() {
  try { localStorage.setItem("settings", JSON.stringify(settings)); } catch {}
}

// ---------------------------------------------------------------- state
let videoStream = null;
let audioRunning = false;
let devices = [];
let cameraError = null; // why camera access failed, if it did (WebKit hides devices until granted)
let unbundledMac = false; // macOS bare binary: no Info.plist, so camera/mic access is blocked
let audioDevices = { inputs: [], outputs: [], default_output: null };

// ---------------------------------------------------------------- UI helpers
let osdTimer;
function osd(text, ms = 1200) {
  els.osd.textContent = text;
  els.osd.hidden = false;
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => (els.osd.hidden = true), ms);
}
function message(text) {
  els.message.textContent = text || "";
  els.message.hidden = !text;
}
function fillSelect(select, items, selectedValue) {
  select.replaceChildren(
    ...items.map(({ value, label }) => {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      o.selected = value === selectedValue;
      return o;
    }),
  );
}
const pickByLabel = (list, label) =>
  (label && list.find((d) => d.label === label)) ||
  list.find((d) => d.label.toLowerCase().includes(PREFERRED));

// ---------------------------------------------------------------- devices
async function refreshDevices() {
  devices = await navigator.mediaDevices.enumerateDevices();
  if (devices.some((d) => d.kind === "videoinput" && !d.label)) {
    // Labels are hidden until camera permission is used once this session.
    // WebKit (macOS) goes further and lists one placeholder camera with no id,
    // so if this fails there is nothing usable to open: remember why.
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true });
      s.getTracks().forEach((t) => t.stop());
      cameraError = null;
    } catch (e) {
      cameraError = e;
    }
    devices = await navigator.mediaDevices.enumerateDevices();
  }
  const cams = devices.filter((d) => d.kind === "videoinput");
  const cam = pickByLabel(cams, settings.videoLabel) || cams[0];
  fillSelect(els.videoDevice,
    cams.length ? cams.map((d) => ({ value: d.deviceId, label: d.label || "Camera" }))
                : [{ value: "", label: "(no video devices found)" }],
    cam?.deviceId);

  try { audioDevices = await invoke("audio_devices"); } catch (e) { console.warn(e); }
  const named = (n) => ({ label: n });
  const mic = settings.audioLabel === "" ? null
    : pickByLabel(audioDevices.inputs.map(named), settings.audioLabel)?.label ?? null;
  fillSelect(els.audioDevice,
    [{ value: "", label: "None (no audio)" }, ...audioDevices.inputs.map((n) => ({ value: n, label: n }))],
    mic ?? "");

  const out = audioDevices.outputs.includes(settings.outputLabel) ? settings.outputLabel : "";
  fillSelect(els.audioOutput,
    [{ value: "", label: `System default${audioDevices.default_output ? ` (${audioDevices.default_output})` : ""}` },
     ...audioDevices.outputs.map((n) => ({ value: n, label: n }))],
    out);

  const music = audioDevices.outputs.includes(settings.musicLabel) ? settings.musicLabel : "";
  fillSelect(els.musicDevice,
    [{ value: "", label: "None" }, ...audioDevices.outputs.map((n) => ({ value: n, label: n }))],
    music);

  return { cam, mic, music };
}

// ---------------------------------------------------------------- video
function parseMode(m) {
  const [, w, h, f] = /^(\d+)x(\d+)@(\d+)$/.exec(m) || /^(\d+)x(\d+)@(\d+)$/.exec(DEFAULT_MODE);
  return { width: +w, height: +h, frameRate: +f };
}

const UNBUNDLED_TEXT =
  "macOS blocks camera and microphone access when Local Streamer runs as a bare binary.\n" +
  "Open Local Streamer.app instead (npm run build:mac puts it in src-tauri/target/release/bundle/macos/).";

function videoErrorText(e) {
  if (e.name === "NotReadableError")
    return "Can't open the capture card.\nAnother app (OBS, Elgato Studio...) is probably using it.";
  if (e.name === "NotAllowedError" && unbundledMac) return UNBUNDLED_TEXT;
  if (e.name === "NotAllowedError" && IS_MAC)
    return "Camera access is off for Local Streamer.\nTurn it on in System Settings → Privacy & Security → Camera, then reopen the app.";
  return `Video error: ${e.name}\n${e.message}`;
}

async function startVideo(deviceId) {
  stopStream(videoStream);
  videoStream = null;
  if (!deviceId) {
    message(cameraError ? videoErrorText(cameraError) : "No video device found.\nPlug in the capture card.");
    return;
  }
  const mode = parseMode(settings.mode);
  try {
    videoStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        deviceId: { exact: deviceId },
        width: { ideal: mode.width },
        height: { ideal: mode.height },
        frameRate: { ideal: mode.frameRate },
        resizeMode: "none",
      },
    });
  } catch (e) {
    message(videoErrorText(e));
    return;
  }
  message("");
  const track = videoStream.getVideoTracks()[0];
  track.addEventListener("ended", () => {
    message("Video signal lost - retrying...");
    setTimeout(() => startVideo(els.videoDevice.value), 2000);
  });
  els.video.srcObject = videoStream;
  els.video.play().catch(() => {});
  if (renderer?.enabled) renderer.setEnabled(true); // re-arm frame callbacks for the new source
  if (stats.on) startStats();
  settings.videoLabel = track.label;
  save();
  updateTitle();
  updateModes(track);
}

function updateModes(track) {
  const caps = track.getCapabilities?.() || {};
  const maxW = caps.width?.max ?? Infinity;
  const maxH = caps.height?.max ?? Infinity;
  const maxF = caps.frameRate?.max ?? Infinity;
  const modes = MODES.filter(([w, h, f]) => w <= maxW && h <= maxH && f <= Math.round(maxF));
  const items = modes.map(([w, h, f]) => ({ value: `${w}x${h}@${f}`, label: `${w} x ${h} @ ${f} fps` }));
  if (!items.some((i) => i.value === settings.mode)) {
    const { width, height, frameRate } = parseMode(settings.mode);
    items.unshift({ value: settings.mode, label: `${width} x ${height} @ ${frameRate} fps` });
  }
  fillSelect(els.videoMode, items, settings.mode);
  const s = track.getSettings();
  els.videoStatus.textContent =
    `Receiving ${s.width} x ${s.height} @ ${Math.round(s.frameRate)} fps` +
    (s.width !== parseMode(settings.mode).width || Math.round(s.frameRate) !== parseMode(settings.mode).frameRate
      ? " (device picked the closest mode)" : "");
}

// ---------------------------------------------------------------- picture
// The plain <video> element shows the whole frame, fitted. Anything else (crop,
// aspect, sharp / integer scaling, FSR) goes through the WebGL renderer.
const ASPECTS = { "4:3": 4 / 3, "16:9": 16 / 9 };
const FILTERS = { off: "linear", sharp: "nearest", integer: "nearest", fsr: "fsr" };
const CROP_SIDES = ["top", "bottom", "left", "right"];
let renderer = null;

/** Border sizes for a vw x vh frame, scaled from the frame size they were set on. */
function cropBorders(vw, vh) {
  const c = settings.crop;
  const sx = c.w ? vw / c.w : 1;
  const sy = c.h ? vh / c.h : 1;
  return {
    top: Math.round(c.top * sy), bottom: Math.round(c.bottom * sy),
    left: Math.round(c.left * sx), right: Math.round(c.right * sx),
  };
}

/** The part of the frame to show: crop, then overscan (in whole source lines). */
function cropRect(vw, vh) {
  const b = cropBorders(vw, vh);
  let x = b.left, y = b.top, w = vw - b.left - b.right, h = vh - b.top - b.bottom;
  if (w < 16 || h < 16) [x, y, w, h] = [0, 0, vw, vh];
  const f = settings.lineMultiplier;
  const ox = Math.round((w * settings.overscan) / 100);
  const oy = Math.round((h * settings.overscan) / 100 / f) * f;
  if (w - 2 * ox >= 16 && h - 2 * oy >= 16) {
    x += ox; w -= 2 * ox;
    y += oy; h -= 2 * oy;
  }
  return { x, y, w, h };
}

/** Renderer layout, in device pixels. See VideoRenderer.configure. */
function layout(vw, vh, cw, ch) {
  const crop = cropRect(vw, vh);
  const stretch = settings.aspect === "stretch";
  const ar = ASPECTS[settings.aspect] ?? crop.w / crop.h;
  let w = 0, h = 0, note;
  if (settings.scaling === "integer") {
    // A whole number of screen pixels per source line, so every line is the same height.
    const lines = crop.h / settings.lineMultiplier;
    let k = Math.floor(ch / lines);
    while (k >= 1 && !stretch && Math.round(k * lines * ar) > cw) k--;
    if (k >= 1) {
      h = Math.round(k * lines);
      w = stretch ? cw : Math.round(h * ar);
      note = `${k}x of ${+lines.toFixed(1)} lines`;
    } else note = "window too small for whole pixels";
  }
  if (!w) {
    if (stretch) [w, h] = [cw, ch];
    else if (cw / ch > ar) [w, h] = [Math.round(ch * ar), ch];
    else [w, h] = [cw, Math.round(cw / ar)];
  }
  return { crop, dest: { x: Math.floor((cw - w) / 2), y: Math.floor((ch - h) / 2), w, h }, note };
}

const cropped = () => CROP_SIDES.some((k) => settings.crop[k] > 0);
const needsRenderer = () =>
  settings.scaling !== "off" || settings.aspect !== "source" || settings.overscan > 0 || cropped();

function showCrop() {
  const vw = els.video.videoWidth || settings.crop.w;
  const vh = els.video.videoHeight || settings.crop.h;
  const b = vw && vh ? cropBorders(vw, vh) : settings.crop;
  for (const k of CROP_SIDES) els.crop[k].value = b[k];
}

function applyPicture() {
  const want = needsRenderer();
  if (want && !renderer) {
    try {
      renderer = new VideoRenderer(els.canvas, els.video, (s) => (els.pictureStatus.textContent = s));
      renderer.configure({ layout });
    } catch (e) {
      renderer = null;
      els.pictureStatus.textContent = `Picture processing unavailable (${e.message}). Showing the plain video.`;
    }
  }
  if (renderer) {
    renderer.configure({ filter: FILTERS[settings.scaling] ?? "linear" });
    renderer.setSharpness(settings.sharpness);
    renderer.setEnabled(want);
  }
  els.scaling.value = settings.scaling;
  els.aspect.value = settings.aspect;
  els.sharpness.value = settings.sharpness;
  els.sharpnessText.textContent = `${settings.sharpness}%`;
  els.sharpnessRow.hidden = settings.scaling !== "fsr";
  els.lineMultiplier.value = String(settings.lineMultiplier);
  els.lineMultiplierRow.hidden = settings.scaling !== "integer";
  els.overscan.value = settings.overscan;
  els.overscanText.textContent = `${settings.overscan}%`;
  showCrop();
  save();
}

function cropEdited() {
  const vw = els.video.videoWidth, vh = els.video.videoHeight;
  if (!vw || !vh) return;
  const c = { w: vw, h: vh };
  for (const k of CROP_SIDES) c[k] = Math.max(0, Math.round(+els.crop[k].value || 0));
  settings.crop = c;
  applyPicture();
}

/** Grabs the current frame as luma (full resolution). */
function grabLuma(width, height) {
  const v = els.video;
  if (!v.videoWidth) return null;
  const w = width ?? v.videoWidth;
  const h = height ?? v.videoHeight;
  const c = Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(v, 0, 0, w, h);
  return { Y: lumaOf(ctx.getImageData(0, 0, w, h).data, w, h), w, h };
}

/** "Detect": crop to the picture and find the line multiplier. */
function detectPicture() {
  const frame = grabLuma();
  if (!frame) return osd("No video to look at yet.", 2500);
  const r = findPicture(frame.Y, frame.w, frame.h);
  if (r.error) return osd("The picture is black. Try again on a bright screen.", 3500);
  settings.crop = { ...r.crop, w: frame.w, h: frame.h };
  settings.lineMultiplier = r.factor;
  applyPicture();
  const w = frame.w - r.crop.left - r.crop.right;
  const h = frame.h - r.crop.top - r.crop.bottom;
  const lines = r.factor > 1 ? `, each line repeated ${r.factor}x (${h / r.factor} source lines)`
    : r.detail ? ", no line multiplier" : ". Too little detail to check for a line multiplier";
  osd(`Picture: ${w} x ${h}${lines}`, 4000);
}

// ---------------------------------------------------------------- audio
async function startAudio() {
  const game = els.audioDevice.value || null;
  const music = els.musicDevice.value || null;
  const output = els.audioOutput.value || null;
  settings.audioLabel = game ?? "";
  settings.musicLabel = music ?? "";
  settings.outputLabel = output ?? "";
  save();
  try {
    const desc = await invoke("audio_configure", { game, music, output });
    audioRunning = !!(game || music);
    els.audioStatus.textContent = audioRunning ? `Playing ${desc}` : "Audio off";
    if (audioRunning && unbundledMac)
      els.audioStatus.textContent += ". Running outside Local Streamer.app, so macOS may give silence: open the .app instead.";
  } catch (e) {
    audioRunning = false;
    els.audioStatus.textContent = `Audio error: ${e}`;
    osd(`Audio error: ${e}`, 4000);
  }
}

// Game and music each have a volume + mute; same UI pattern for both.
const LEVELS = {
  game: { vol: "volume", muted: "muted", slider: "volume", text: "volumeText", button: "mute", label: "Volume" },
  music: { vol: "musicVolume", muted: "musicMuted", slider: "musicVolume", text: "musicVolumeText", button: "musicMute", label: "Music" },
};
function applyLevel(channel, show = true) {
  const L = LEVELS[channel];
  settings[L.vol] = Math.max(0, Math.min(MAX_VOLUME, Math.round(settings[L.vol])));
  const volume = settings[L.vol];
  const muted = settings[L.muted];
  invoke("audio_set_volume", { channel, volume: volume / 100, muted }).catch(() => {});
  const text = muted ? "MUTED" : `${volume}%`;
  els[L.slider].value = volume;
  els[L.text].textContent = text;
  els[L.button].setAttribute("aria-pressed", String(muted));
  els[L.button].textContent = muted ? "Unmute" : "Mute";
  save();
  if (show) osd(`${L.label}: ${text}`);
}
function stepLevel(channel, delta) {
  const L = LEVELS[channel];
  if (delta > 0) settings[L.muted] = false;
  settings[L.vol] += delta;
  applyLevel(channel);
}
function toggleMute(channel) {
  settings[LEVELS[channel].muted] = !settings[LEVELS[channel].muted];
  applyLevel(channel);
}
function applyDelay() {
  invoke("audio_set_delay", { ms: settings.delay }).catch(() => {});
  els.delay.value = settings.delay;
  els.delayText.textContent = `${settings.delay} ms`;
  save();
}

const actions = {
  volume_up: () => stepLevel("game", VOLUME_STEP),
  volume_down: () => stepLevel("game", -VOLUME_STEP),
  mute: () => toggleMute("game"),
  music_up: () => stepLevel("music", VOLUME_STEP),
  music_down: () => stepLevel("music", -VOLUME_STEP),
  music_mute: () => toggleMute("music"),
};

function stopStream(s) { s?.getTracks().forEach((t) => t.stop()); }

// ---------------------------------------------------------------- stats overlay
// Video numbers come from requestVideoFrameCallback and the track; audio numbers
// from the Rust engine (audio_stats). Ctrl+I or Window → Show stats.
const stats = { on: false, handle: 0, timer: 0, last: null, presented: 0, now: 0, latency: [], base: null };

function setStats(on) {
  stats.on = on;
  settings.showStats = on;
  save();
  els.showStats.checked = on;
  els.stats.hidden = !on;
  if (on) startStats();
  else {
    if (stats.handle) els.video.cancelVideoFrameCallback?.(stats.handle);
    clearInterval(stats.timer);
    stats.handle = stats.timer = 0;
  }
}

function startStats() {
  if (stats.handle) els.video.cancelVideoFrameCallback?.(stats.handle);
  clearInterval(stats.timer);
  stats.last = null;
  stats.base = null;
  stats.latency = [];
  const onFrame = (now, meta) => {
    stats.presented = meta.presentedFrames;
    stats.now = now;
    // Camera frames carry a capture time in Chromium: capture -> display latency.
    if (meta.captureTime) {
      stats.latency.push(meta.expectedDisplayTime - meta.captureTime);
      if (stats.latency.length > 120) stats.latency.shift();
    }
    stats.handle = els.video.requestVideoFrameCallback(onFrame);
  };
  if (els.video.requestVideoFrameCallback) stats.handle = els.video.requestVideoFrameCallback(onFrame);
  stats.timer = setInterval(renderStats, 500);
  renderStats();
}

function videoCounters() {
  const q = els.video.getVideoPlaybackQuality?.();
  const t = videoStream?.getVideoTracks()[0]?.stats; // MediaStreamTrackVideoStats, newer Chromium
  return { dropped: q?.droppedVideoFrames ?? 0, discarded: t?.discardedFrames ?? 0 };
}

const fmt = (n, digits = 0) => (Number.isFinite(n) ? n.toFixed(digits) : "-");
const dB = (peak) => (peak > 0.00003 ? `${fmt(20 * Math.log10(peak))} dB` : "silent");
const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
};

async function renderStats() {
  const lines = [];
  const track = videoStream?.getVideoTracks()[0];
  if (track && track.readyState === "live") {
    const st = track.getSettings();
    const asked = parseMode(settings.mode);
    lines.push(`Video   ${st.width}x${st.height} @ ${fmt(st.frameRate, 2)} from the device` +
      (st.width !== asked.width || st.height !== asked.height || Math.round(st.frameRate) !== asked.frameRate
        ? ` (asked ${settings.mode})` : ""));
    const counters = videoCounters();
    stats.base ??= counters;
    let fps = NaN;
    if (stats.last && stats.now > stats.last.now) {
      fps = ((stats.presented - stats.last.presented) * 1000) / (stats.now - stats.last.now);
    }
    stats.last = { presented: stats.presented, now: stats.now };
    const dropped = counters.dropped - stats.base.dropped + counters.discarded - stats.base.discarded;
    const lat = median(stats.latency);
    lines.push(`Shown   ${fmt(fps, 1)} fps · dropped ${dropped}` +
      (Number.isFinite(lat) ? ` · capture to screen ${fmt(lat)} ms` : ""));
  } else {
    lines.push("Video   no signal");
  }
  lines.push(`Picture ${renderer?.enabled ? renderer.lastStatus || "-" : "plain video (no processing)"}`);

  try {
    const a = await invoke("audio_stats");
    const src = (name, s) => {
      if (!s.active) return `${name}off`;
      return `${name}${s.rate} Hz · buffer ${fmt(s.fill_ms)}/${fmt(s.target_ms)} ms · ` +
        `underruns ${s.underruns} · skips ${s.skips} · peak ${dB(s.peak)}`;
    };
    lines.push(src("Game    ", a.game));
    lines.push(src("Music   ", a.music));
    if (a.output_rate) {
      lines.push(`Output  ${a.output_rate} Hz · ${fmt(a.buffer_ms, 1)} ms per callback · ` +
        `device ${fmt(a.latency_ms, 1)} ms` + (a.clipped ? " · CLIPPING (lower the volume)" : ""));
    }
  } catch (e) {
    lines.push(`Audio   ${e}`);
  }
  if (stats.on) els.stats.textContent = lines.join("\n");
}

// ---------------------------------------------------------------- A/V sync helper
// Play a flash-and-beep test on the console (240p Test Suite's audio sync test,
// or a "flash and beep" video). We time each flash as it reaches the screen and
// each beep as it reaches the output device, then set Audio delay to line them up.
const SYNC_PAIRS = 8;
const SYNC_TIMEOUT_MS = 25000;
let sync = null;

/** Offset from performance.now() to the audio engine's clock, over the fastest of a few round trips. */
async function audioClockOffset() {
  let best = null;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const rust = await invoke("audio_clock");
    const t1 = performance.now();
    if (!best || t1 - t0 < best.rtt) best = { rtt: t1 - t0, offset: rust - (t0 + t1) / 2 };
  }
  return best.offset;
}

async function measureSync() {
  const say = (t) => (els.syncStatus.textContent = t);
  if (!videoStream || !els.video.requestVideoFrameCallback) return say("No video to measure.");
  if (!audioRunning || !els.audioDevice.value) return say("Choose the capture card under Input first.");
  const offset = await audioClockOffset();
  await invoke("audio_sync_probe", { on: true });

  const W = 160, H = 90;
  const canvas = Object.assign(document.createElement("canvas"), { width: W, height: H });
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const s = (sync = { flashes: [], beeps: [], prev: null, handle: 0, poll: 0, timeout: 0, startDelay: settings.delay });

  const pairs = () => {
    const out = [];
    for (const f of s.flashes) {
      let best = null;
      for (const b of s.beeps) if (Math.abs(b - f) < 400 && (best === null || Math.abs(b - f) < Math.abs(best - f))) best = b;
      if (best !== null) out.push(best - f); // > 0: sound heard after the picture
    }
    return out;
  };

  s.finish = (why) => {
    if (sync !== s) return;
    sync = null;
    els.video.cancelVideoFrameCallback?.(s.handle);
    clearInterval(s.poll);
    clearTimeout(s.timeout);
    invoke("audio_sync_probe", { on: false }).catch(() => {});
    els.measureSync.textContent = "Measure A/V sync";
    const d = pairs();
    if (why) return say(why);
    if (d.length < 3) {
      return say(`Not enough matches: saw ${s.flashes.length} flashes and ${s.beeps.length} beeps. ` +
        "Is the test playing, with its sound coming through the capture card?");
    }
    const late = median(d);
    const spread = median(d.map((x) => Math.abs(x - late)));
    const wanted = s.startDelay - late;
    const next = Math.max(0, Math.min(500, Math.round(wanted / 10) * 10));
    settings.delay = next;
    applyDelay();
    const where = Math.abs(late) < 5 ? "in sync"
      : late > 0 ? `${fmt(late)} ms behind the picture` : `${fmt(-late)} ms ahead of the picture`;
    let text = `Sound was ${where} (${d.length} matches, ±${fmt(spread)} ms). Audio delay: ${s.startDelay} → ${next} ms.`;
    if (wanted < -10) text += " Sound is late even with no delay; the app can't delay the picture.";
    if (spread > 20) text += " The matches varied a lot: measure again to check.";
    else text += " Measure again to confirm.";
    say(text);
  };

  const onFrame = (now, meta) => {
    if (sync !== s) return;
    ctx.drawImage(els.video, 0, 0, W, H);
    const Y = lumaOf(ctx.getImageData(0, 0, W, H).data, W, H);
    if (s.prev && flashFraction(s.prev, Y) > 0.1) {
      const t = meta.expectedDisplayTime ?? now;
      if (!s.flashes.length || t - s.flashes.at(-1) > 250) s.flashes.push(t);
    }
    s.prev = Y;
    s.handle = els.video.requestVideoFrameCallback(onFrame);
  };
  s.handle = els.video.requestVideoFrameCallback(onFrame);
  s.poll = setInterval(async () => {
    const onsets = await invoke("audio_sync_onsets").catch(() => []);
    s.beeps.push(...onsets.map((t) => t - offset));
    const n = pairs().length;
    say(`Measuring... ${n}/${SYNC_PAIRS} (${s.flashes.length} flashes, ${s.beeps.length} beeps)`);
    if (n >= SYNC_PAIRS) s.finish();
  }, 250);
  s.timeout = setTimeout(() => s.finish(), SYNC_TIMEOUT_MS);
  els.measureSync.textContent = "Stop";
  say("Measuring... play the flash-and-beep test now.");
}

// ---------------------------------------------------------------- hotkeys
const hotkeyButtons = [...document.querySelectorAll(".hotkey")];
const MAC_SYMBOLS = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Super: "⌘" };
const prettyKey = (accel) => {
  if (!accel) return "(none)";
  const text = accel.replace(/Key([A-Z])/, "$1").replace(/Digit(\d)/, "$1").replace(/Arrow/, "");
  if (!IS_MAC) return text;
  // macOS style: ⌃⌥Up rather than Ctrl+Alt+Up.
  const parts = text.split("+");
  const key = parts.pop();
  return parts.map((m) => MAC_SYMBOLS[m] ?? `${m}+`).join("") + key;
};

async function registerHotkeys() {
  const failed = await invoke("set_hotkeys", { hotkeys: settings.hotkeys });
  for (const b of hotkeyButtons) {
    const accel = settings.hotkeys[b.dataset.action];
    b.textContent = prettyKey(accel);
    b.classList.toggle("failed", failed.some((f) => f.startsWith(accel + " ")));
  }
  if (failed.length) osd(`Hotkey unavailable (in use by another app?): ${failed.map((f) => prettyKey(f.split(" ")[0])).join(", ")}`, 5000);
}

let capturing = null;
for (const b of hotkeyButtons) {
  b.addEventListener("click", async () => {
    if (capturing) return;
    capturing = b;
    b.classList.add("listening");
    b.textContent = "Press keys...";
    await invoke("set_hotkeys", { hotkeys: {} }); // free the combo while recording
  });
}
function finishCapture(accel) {
  const b = capturing;
  capturing = null;
  b.classList.remove("listening");
  if (accel !== undefined) {
    settings.hotkeys[b.dataset.action] = accel;
    save();
  }
  registerHotkeys();
}
const MODIFIER_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;
function captureKey(e) {
  e.preventDefault();
  if (e.code === "Escape") return finishCapture();
  if (e.code === "Backspace" || e.code === "Delete") return finishCapture("");
  if (MODIFIER_CODES.test(e.code)) return;
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean);
  if (!mods.length && !/^F\d+$/.test(e.code)) {
    capturing.textContent = IS_MAC ? "Add ⌃ / ⌥ / ⇧ / ⌘" : "Add Ctrl / Alt / Shift";
    return;
  }
  finishCapture([...mods, e.code].join("+"));
}

// ---------------------------------------------------------------- now playing
function updateTitle() {
  const { game, console: con } = settings;
  const title = game && con ? `${game} · ${con}`
    : game || con || `Local Streamer - ${settings.videoLabel || "no source"}`;
  appWindow.setTitle(title).catch(() => {});
  document.title = title;
}

function remember(list, value, max = 15) {
  if (!value) return list;
  return [value, ...list.filter((v) => v.toLowerCase() !== value.toLowerCase())].slice(0, max);
}

function fillDatalists() {
  const opts = (values) => values.map((v) => Object.assign(document.createElement("option"), { value: v }));
  els.gameHistory.replaceChildren(...opts(settings.gameHistory));
  const consoles = [...settings.consoleHistory, ...CONSOLES.filter((c) => !settings.consoleHistory.includes(c))];
  els.consoleList.replaceChildren(...opts(consoles));
}

function sendPresence() {
  invoke("presence_set", {
    clientId: settings.discordId,
    game: settings.game,
    console: settings.console,
    startMs: settings.playStart || Date.now(),
  }).catch(() => {});
  if (!settings.discordId.trim()) els.presenceStatus.textContent = "Off";
}

let nowPlayingTimer;
function nowPlayingChanged(commit = false) {
  const game = els.game.value.trim();
  const con = els.console.value.trim();
  const changed = game !== settings.game || con !== settings.console;
  settings.game = game;
  settings.console = con;
  if (changed) settings.playStart = Date.now(); // restart the "elapsed" timer
  updateTitle();
  save();
  clearTimeout(nowPlayingTimer);
  // Wait for typing to settle before touching Discord / history.
  nowPlayingTimer = setTimeout(sendPresence, commit ? 0 : 1500);
  if (commit) {
    // Only finished entries (Enter / leaving the field) go into the suggestions.
    settings.gameHistory = remember(settings.gameHistory, settings.game);
    settings.consoleHistory = remember(settings.consoleHistory, settings.console);
    save();
    fillDatalists();
    if (settings.game || settings.console) osd(`Now playing: ${document.title}`, 2000);
  }
}

// ---------------------------------------------------------------- window
async function toggleFullscreen() {
  const fs = await appWindow.isFullscreen();
  await appWindow.setFullscreen(!fs);
}
function togglePanel(show = els.panel.hidden) {
  els.panel.hidden = !show;
}

let idleTimer;
function poke() {
  document.body.classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (els.panel.hidden) document.body.classList.add("idle");
  }, 2500);
}

// ---------------------------------------------------------------- wiring
function wire() {
  els.videoDevice.addEventListener("change", () => startVideo(els.videoDevice.value));
  els.videoMode.addEventListener("change", () => {
    settings.mode = els.videoMode.value;
    save();
    startVideo(els.videoDevice.value);
  });
  els.audioDevice.addEventListener("change", startAudio);
  els.audioOutput.addEventListener("change", startAudio);
  els.musicDevice.addEventListener("change", startAudio);
  for (const [channel, L] of Object.entries(LEVELS)) {
    els[L.slider].addEventListener("input", () => {
      settings[L.vol] = +els[L.slider].value;
      settings[L.muted] = false;
      applyLevel(channel, false);
    });
  }
  els.musicMute.addEventListener("click", () => actions.music_mute());
  els.mute.addEventListener("click", () => actions.mute());
  els.delay.addEventListener("input", () => { settings.delay = +els.delay.value; applyDelay(); });
  els.resetHotkeys.addEventListener("click", () => {
    settings.hotkeys = { ...DEFAULT_HOTKEYS };
    save();
    registerHotkeys();
  });
  els.onTop.addEventListener("change", () => {
    settings.onTop = els.onTop.checked;
    save();
    appWindow.setAlwaysOnTop(settings.onTop);
  });
  els.fullscreen.addEventListener("click", toggleFullscreen);
  for (const input of [els.game, els.console]) {
    input.addEventListener("input", () => nowPlayingChanged());
    input.addEventListener("change", () => nowPlayingChanged(true));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
  }
  els.discordId.addEventListener("change", () => {
    settings.discordId = els.discordId.value.trim();
    save();
    els.presenceStatus.textContent = settings.discordId ? "Connecting..." : "Off";
    sendPresence();
  });
  listen("presence-status", (e) => (els.presenceStatus.textContent = e.payload));
  els.gear.addEventListener("click", () => togglePanel());
  els.close.addEventListener("click", () => togglePanel(false));
  // The FSR canvas sits over the video, so listen on the page.
  document.addEventListener("dblclick", (e) => {
    if (!els.panel.contains(e.target) && e.target !== els.gear) toggleFullscreen();
  });
  els.scaling.addEventListener("change", () => { settings.scaling = els.scaling.value; applyPicture(); });
  els.sharpness.addEventListener("input", () => { settings.sharpness = +els.sharpness.value; applyPicture(); });
  els.aspect.addEventListener("change", () => { settings.aspect = els.aspect.value; applyPicture(); });
  els.overscan.addEventListener("input", () => { settings.overscan = +els.overscan.value; applyPicture(); });
  els.lineMultiplier.addEventListener("change", () => {
    settings.lineMultiplier = +els.lineMultiplier.value || 1;
    applyPicture();
  });
  for (const k of CROP_SIDES) els.crop[k].addEventListener("change", cropEdited);
  els.detect.addEventListener("click", detectPicture);
  els.resetCrop.addEventListener("click", () => {
    settings.crop = { top: 0, bottom: 0, left: 0, right: 0, w: 0, h: 0 };
    settings.overscan = 0;
    settings.lineMultiplier = 1;
    applyPicture();
  });
  els.video.addEventListener("loadedmetadata", showCrop);
  els.video.addEventListener("resize", showCrop);
  els.showStats.addEventListener("change", () => setStats(els.showStats.checked));
  els.measureSync.addEventListener("click", () => (sync ? sync.finish("Stopped.") : measureSync()));

  document.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (!els.panel.contains(e.target)) togglePanel();
  });
  document.addEventListener("keydown", (e) => {
    if (capturing) return captureKey(e);
    // macOS: Ctrl+Cmd+F is the usual full-screen key (F11 shows the desktop) and Cmd+, opens settings.
    if (e.code === "F11" || (IS_MAC && e.ctrlKey && e.metaKey && e.code === "KeyF")) {
      e.preventDefault();
      toggleFullscreen();
    } else if (e.code === "Escape") {
      if (!els.panel.hidden) togglePanel(false);
      else appWindow.setFullscreen(false);
    } else if ((e.ctrlKey && e.code === "KeyH") || (IS_MAC && e.metaKey && e.code === "Comma")) {
      e.preventDefault();
      togglePanel();
    } else if (e.ctrlKey && e.code === "KeyI") {
      e.preventDefault();
      setStats(!stats.on);
    }
  });
  document.addEventListener("pointermove", poke);
  poke();

  navigator.mediaDevices.addEventListener("devicechange", async () => {
    const before = els.videoDevice.value;
    const { cam, mic, music } = await refreshDevices();
    const videoDead = !videoStream || videoStream.getVideoTracks()[0]?.readyState === "ended";
    if (cam && (videoDead || cam.deviceId !== before)) startVideo(cam.deviceId);
    if ((mic || music) && !audioRunning) startAudio();
  });

  listen("hotkey", (e) => actions[e.payload]?.());
  listen("audio-error", (e) => {
    audioRunning = false;
    els.audioStatus.textContent = `${e.payload}`;
    osd("Audio stopped - device lost? Reconnecting when it returns.", 4000);
  });
}

async function main() {
  if (IS_MAC) els.gear.title = "Settings (right-click, Ctrl+H or ⌘,)";
  wire();
  applyLevel("game", false);
  applyLevel("music", false);
  applyDelay();
  applyPicture();
  if (settings.showStats) setStats(true);
  els.onTop.checked = settings.onTop;
  els.game.value = settings.game;
  els.console.value = settings.console;
  els.discordId.value = settings.discordId;
  fillDatalists();
  updateTitle();
  if (settings.discordId && (settings.game || settings.console)) {
    settings.playStart = Date.now();
    sendPresence();
  }
  if (settings.onTop) appWindow.setAlwaysOnTop(true);
  registerHotkeys();

  message("Starting capture...");
  try { await invoke("media_ready"); } catch (e) { console.warn("media_ready", e); }
  if (IS_MAC) unbundledMac = await invoke("unbundled_mac").catch(() => false);
  const { cam } = await refreshDevices();
  await Promise.all([startVideo(cam?.deviceId), startAudio()]);
}

main();
