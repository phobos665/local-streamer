// Local Streamer frontend. Picture: getUserMedia -> <video>.
// Sound: handled in Rust (src-tauri/src/audio.rs) so it plays from the app's own
// process, which is what Discord's window share captures.
import { FsrRenderer } from "./fsr.js";

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
  fsrCanvas: $("fsr"), scaling: $("scaling"), sharpness: $("sharpness"), sharpnessText: $("sharpnessText"),
  sharpnessRow: $("sharpnessRow"), fsrStatus: $("fsrStatus"),
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
    return "Can't open the capture card.\nAnother app (OBS, Elgato Studio, the Python version...) is probably using it.";
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
  if (settings.scaling === "fsr") fsr?.setEnabled(true); // re-arm frame callbacks for the new source
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

// ---------------------------------------------------------------- scaling (FSR 1)
let fsr = null;
function applyScaling() {
  if (settings.scaling === "fsr" && !fsr) {
    try {
      fsr = new FsrRenderer(els.fsrCanvas, els.video, (s) => (els.fsrStatus.textContent = s));
    } catch (e) {
      settings.scaling = "off";
      els.fsrStatus.textContent = `FSR unavailable: ${e.message}`;
    }
  }
  const on = settings.scaling === "fsr";
  fsr?.setSharpness(settings.sharpness);
  fsr?.setEnabled(on);
  els.scaling.value = settings.scaling;
  els.sharpness.value = settings.sharpness;
  els.sharpnessText.textContent = `${settings.sharpness}%`;
  els.sharpnessRow.hidden = !on;
  save();
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
  els.scaling.addEventListener("change", () => { settings.scaling = els.scaling.value; applyScaling(); });
  els.sharpness.addEventListener("input", () => { settings.sharpness = +els.sharpness.value; applyScaling(); });

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
  applyScaling();
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
