//! Audio mixer: game capture (+ optional music loopback) -> output device, all
//! inside this process, so Discord's per-application ("window") audio capture
//! picks it up.
//!
//! Sources:
//!   * game  - a capture device, e.g. "HDMI (Elgato 4K S)"
//!   * music - loopback of an *output* device the user routes Spotify etc. to
//!             (e.g. "Speakers (Steam Streaming Speakers)" on Windows, or a
//!             virtual device such as BlackHole on macOS), so it is heard once,
//!             through us, rather than directly as well.
//!
//! Loopback is cpal's: WASAPI loopback on Windows, a Core Audio process tap on
//! macOS (14.6+). Devices that are both input and output (BlackHole) are read
//! as a plain input instead, which works on any macOS version.
//!
//! Each source has its own FIFO. Its fill level *is* that source's latency:
//! we hold it near a target, dropping the oldest audio if it grows (clock
//! drift) and re-priming with silence if it runs dry.
//!
//! Diagnostics: per-source FIFO fill, underruns, skips and peaks, plus output
//! buffer / latency / clipping, are kept in atomics for the stats overlay
//! (`stats`). For the A/V sync helper, `sync_probe` turns on a beep (onset)
//! detector on the game source; onsets are timestamped on `clock_ms`'s clock at
//! the moment they reach the output device.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample, StreamConfig};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Instant;

const GAME_BASE_MS: u32 = 15; // jitter cushion for the capture card
const MUSIC_BASE_MS: u32 = 30; // loopback arrives in ~10ms packets, give it more room
const SLACK_MS: u32 = 50; // allowed overshoot before we skip ahead
const MAX_MS: u32 = 2000; // hard cap on buffered audio

pub type ErrorSink = Arc<dyn Fn(String) + Send + Sync>;

#[derive(Clone, Copy, PartialEq)]
pub enum Channel {
    Game,
    Music,
}

struct Level {
    volume: AtomicU32, // f32 bits, 1.0 = 100%
    muted: AtomicBool,
}

impl Level {
    fn new(v: f32) -> Self {
        Self { volume: AtomicU32::new(v.to_bits()), muted: AtomicBool::new(false) }
    }
    fn gain(&self) -> f32 {
        if self.muted.load(Ordering::Relaxed) {
            0.0
        } else {
            f32::from_bits(self.volume.load(Ordering::Relaxed))
        }
    }
}

/// Live numbers for one source, written by the audio callbacks.
#[derive(Default)]
struct SourceStats {
    active: AtomicBool,
    rate: AtomicU32,
    target: AtomicU32,    // frames the FIFO is held at
    fill: AtomicU32,      // frames queued when the latest output callback started (= latency)
    underruns: AtomicU32, // FIFO ran dry (heard as a gap)
    skips: AtomicU32,     // FIFO overshot and old audio was dropped
    peak: AtomicU32,      // f32 bits, max |sample| (before volume) since the last read
}

impl SourceStats {
    fn reset(&self) {
        self.active.store(false, Ordering::Relaxed);
        for a in [&self.rate, &self.target, &self.fill, &self.underruns, &self.skips, &self.peak] {
            a.store(0, Ordering::Relaxed);
        }
    }
    fn snapshot(&self) -> SourceSnapshot {
        let rate = self.rate.load(Ordering::Relaxed).max(1) as f32;
        SourceSnapshot {
            active: self.active.load(Ordering::Relaxed),
            rate: self.rate.load(Ordering::Relaxed),
            target_ms: self.target.load(Ordering::Relaxed) as f32 * 1000.0 / rate,
            fill_ms: self.fill.load(Ordering::Relaxed) as f32 * 1000.0 / rate,
            underruns: self.underruns.load(Ordering::Relaxed),
            skips: self.skips.load(Ordering::Relaxed),
            // Non-negative f32s order the same as their bits, so fetch_max works on them.
            peak: f32::from_bits(self.peak.swap(0, Ordering::Relaxed)),
        }
    }
}

#[derive(Default)]
struct OutputStats {
    rate: AtomicU32,
    buffer: AtomicU32,     // frames per callback
    latency_us: AtomicU32, // callback -> sound leaving the device, as the host reports it
    clipped: AtomicU32,    // samples clamped to +-1 since the last read
}

/// Beep detector for the A/V sync helper.
#[derive(Default)]
struct SyncProbe {
    on: AtomicBool,
    onsets: Mutex<Vec<f64>>, // clock_ms() at which each beep is heard
}

pub struct Shared {
    game: Level,
    music: Level,
    delay_ms: AtomicU32, // game only (A/V sync)
    epoch: Instant,
    game_stats: SourceStats,
    music_stats: SourceStats,
    out: OutputStats,
    probe: SyncProbe,
}

impl Shared {
    fn new() -> Self {
        Self {
            game: Level::new(0.8),
            music: Level::new(0.5),
            delay_ms: AtomicU32::new(0),
            epoch: Instant::now(),
            game_stats: SourceStats::default(),
            music_stats: SourceStats::default(),
            out: OutputStats::default(),
            probe: SyncProbe::default(),
        }
    }
    fn level(&self, c: Channel) -> &Level {
        match c {
            Channel::Game => &self.game,
            Channel::Music => &self.music,
        }
    }
    fn stats(&self, c: Channel) -> &SourceStats {
        match c {
            Channel::Game => &self.game_stats,
            Channel::Music => &self.music_stats,
        }
    }
    fn now_ms(&self) -> f64 {
        self.epoch.elapsed().as_secs_f64() * 1000.0
    }
}

#[derive(serde::Serialize)]
pub struct SourceSnapshot {
    active: bool,
    rate: u32,
    target_ms: f32,
    fill_ms: f32,
    underruns: u32,
    skips: u32,
    peak: f32,
}

#[derive(serde::Serialize)]
pub struct StatsSnapshot {
    game: SourceSnapshot,
    music: SourceSnapshot,
    output_rate: u32,
    buffer_ms: f32,
    latency_ms: f32,
    clipped: u32,
}

/// When the current output buffer will be heard, for timestamping beeps.
struct Tick {
    t0: f64,       // clock_ms() at which frame 0 of this buffer leaves the device
    frame_ms: f64, // duration of one output frame
    rate: u32,     // output frames per second
}

struct Fifo {
    buf: VecDeque<f32>, // interleaved stereo
    primed: bool,
}

/// Output-side reader for one source: FIFO + linear resampler + gain smoothing.
struct Reader {
    channel: Channel,
    fifo: Arc<Mutex<Fifo>>,
    rate: u32,
    step: f64, // source frames per output frame
    prev: [f32; 2],
    next: [f32; 2],
    frac: f64,
    gain: f32,
    last_target: usize, // FIFO target at the previous callback, to spot delay changes
    onset: OnsetDetector,
}

/// Beep detector for the game source while the sync probe is on.
struct OnsetDetector {
    floor: f32,       // running average level
    since_loud: u32,  // output frames since the level was last above the trigger
    since_onset: u32, // output frames since the last detected beep
}

impl OnsetDetector {
    fn new() -> Self {
        Self { floor: 0.0, since_loud: 0, since_onset: u32::MAX }
    }

    /// Spots the start of a beep: the level jumps well above its running average
    /// after at least 100 ms of quiet. Fed the level before volume / mute.
    fn feed(&mut self, a: f32, i: usize, tick: &Tick, shared: &Shared) {
        let quiet = tick.rate / 10;
        let refractory = tick.rate / 4;
        let trigger = (self.floor * 8.0).max(0.03);
        if a > trigger {
            if self.since_loud >= quiet && self.since_onset >= refractory {
                self.since_onset = 0;
                let t = tick.t0 + i as f64 * tick.frame_ms;
                if let Ok(mut v) = shared.probe.onsets.try_lock() {
                    if v.len() < 256 {
                        v.push(t);
                    }
                }
            }
            self.since_loud = 0;
        } else {
            self.since_loud = self.since_loud.saturating_add(1);
        }
        self.since_onset = self.since_onset.saturating_add(1);
        self.floor += (a - self.floor) * 0.0005;
    }
}

impl Reader {
    /// Adds this source's audio for `frames` output frames into `mix`.
    fn mix_into(&mut self, mix: &mut [[f32; 2]], shared: &Shared, tick: &Tick) {
        let stats = shared.stats(self.channel);
        let target_gain = shared.level(self.channel).gain();
        let base = match self.channel {
            Channel::Game => GAME_BASE_MS + shared.delay_ms.load(Ordering::Relaxed),
            Channel::Music => MUSIC_BASE_MS,
        };
        let target = (self.rate * base / 1000) as usize;
        let slack = (self.rate * SLACK_MS / 1000) as usize;
        stats.target.store(target as u32, Ordering::Relaxed);

        let Ok(mut f) = self.fifo.lock() else { return };
        let mut avail = f.buf.len() / 2;
        if target != self.last_target {
            // The delay changed: move to the new latency now. Left alone, the fill
            // level would only follow on the next underrun (longer delay) or once
            // it overshot by more than the slack (shorter delay).
            self.last_target = target;
            if avail > target {
                f.buf.drain(..(avail - target) * 2);
                avail = target;
            } else {
                f.primed = false; // build up the extra delay with silence
            }
        }
        if !f.primed {
            if avail >= target {
                f.primed = true;
            } else {
                stats.fill.store(avail as u32, Ordering::Relaxed);
                return; // silence until the cushion has built up
            }
        }
        if avail > target + slack {
            let drop = (avail - target) * 2;
            f.buf.drain(..drop);
            avail = target;
            stats.skips.fetch_add(1, Ordering::Relaxed);
        }
        stats.fill.store(avail as u32, Ordering::Relaxed);

        let probe = self.channel == Channel::Game && shared.probe.on.load(Ordering::Relaxed);
        let mut peak = 0.0f32;
        let mut ran_dry = false;
        for (i, out) in mix.iter_mut().enumerate() {
            while self.frac >= 1.0 {
                self.prev = self.next;
                match (f.buf.pop_front(), f.buf.pop_front()) {
                    (Some(l), Some(r)) => self.next = [l, r],
                    _ => {
                        ran_dry |= f.primed;
                        f.primed = false; // ran dry: re-prime
                        self.next = [0.0, 0.0];
                    }
                }
                self.frac -= 1.0;
            }
            let t = self.frac as f32;
            let l = self.prev[0] + (self.next[0] - self.prev[0]) * t;
            let r = self.prev[1] + (self.next[1] - self.prev[1]) * t;
            self.frac += self.step;
            self.gain += (target_gain - self.gain) * 0.002; // ~10ms smoothing, avoids clicks
            out[0] += l * self.gain;
            out[1] += r * self.gain;
            let a = l.abs().max(r.abs());
            peak = peak.max(a);
            if probe {
                self.onset.feed(a, i, tick, shared);
            }
        }
        if ran_dry {
            stats.underruns.fetch_add(1, Ordering::Relaxed);
        }
        stats.peak.fetch_max(peak.to_bits(), Ordering::Relaxed);
    }
}

enum Cmd {
    Configure {
        game: Option<String>,
        music: Option<String>,
        output: Option<String>,
        reply: Sender<Result<String, String>>,
    },
}

pub struct AudioEngine {
    tx: Sender<Cmd>,
    shared: Arc<Shared>,
}

#[derive(serde::Serialize)]
pub struct DeviceList {
    inputs: Vec<String>,
    outputs: Vec<String>,
    default_output: Option<String>,
}

fn name_of(d: &cpal::Device) -> Option<String> {
    d.description().ok().map(|x| x.name().to_string())
}

pub fn list_devices() -> DeviceList {
    let host = cpal::default_host();
    DeviceList {
        inputs: host
            .input_devices()
            .map(|i| i.filter_map(|d| name_of(&d)).collect())
            .unwrap_or_default(),
        outputs: host
            .output_devices()
            .map(|i| i.filter_map(|d| name_of(&d)).collect())
            .unwrap_or_default(),
        default_output: host.default_output_device().and_then(|d| name_of(&d)),
    }
}

impl AudioEngine {
    pub fn new(on_error: ErrorSink) -> Self {
        let shared = Arc::new(Shared::new());
        let (tx, rx) = channel::<Cmd>();
        let sh = shared.clone();
        // cpal streams stay on the thread that owns them; this thread holds them.
        std::thread::Builder::new()
            .name("audio".into())
            .spawn(move || {
                let mut streams: Vec<cpal::Stream> = Vec::new();
                while let Ok(cmd) = rx.recv() {
                    match cmd {
                        Cmd::Configure { game, music, output, reply } => {
                            streams.clear(); // stop old streams first (frees the devices)
                            let res = build(game.as_deref(), music.as_deref(), output.as_deref(), sh.clone(), on_error.clone())
                                .map(|(s, desc)| {
                                    streams = s;
                                    desc
                                });
                            let _ = reply.send(res);
                        }
                    }
                }
            })
            .expect("spawn audio thread");
        Self { tx, shared }
    }

    pub fn configure(
        &self,
        game: Option<String>,
        music: Option<String>,
        output: Option<String>,
    ) -> Result<String, String> {
        let (reply, rx) = channel();
        self.tx
            .send(Cmd::Configure { game, music, output, reply })
            .map_err(|e| e.to_string())?;
        rx.recv().map_err(|e| e.to_string())?
    }

    pub fn set_volume(&self, channel: Channel, volume: f32, muted: bool) {
        let l = self.shared.level(channel);
        l.volume.store(volume.clamp(0.0, 4.0).to_bits(), Ordering::Relaxed);
        l.muted.store(muted, Ordering::Relaxed);
    }

    pub fn set_delay(&self, ms: u32) {
        self.shared.delay_ms.store(ms.min(1000), Ordering::Relaxed);
    }

    /// Numbers for the stats overlay. Peaks and the clip count cover the time
    /// since the previous call.
    pub fn stats(&self) -> StatsSnapshot {
        let o = &self.shared.out;
        let rate = o.rate.load(Ordering::Relaxed);
        StatsSnapshot {
            game: self.shared.game_stats.snapshot(),
            music: self.shared.music_stats.snapshot(),
            output_rate: rate,
            buffer_ms: o.buffer.load(Ordering::Relaxed) as f32 * 1000.0 / rate.max(1) as f32,
            latency_ms: o.latency_us.load(Ordering::Relaxed) as f32 / 1000.0,
            clipped: o.clipped.swap(0, Ordering::Relaxed),
        }
    }

    /// Milliseconds on the engine's monotonic clock (the clock beep onsets use).
    pub fn clock_ms(&self) -> f64 {
        self.shared.now_ms()
    }

    /// Starts or stops beep detection on the game source. Clears old onsets.
    pub fn sync_probe(&self, on: bool) {
        if let Ok(mut v) = self.shared.probe.onsets.lock() {
            v.clear();
        }
        self.shared.probe.on.store(on, Ordering::Relaxed);
    }

    /// Beep onsets detected since the last call, in `clock_ms` time.
    pub fn sync_onsets(&self) -> Vec<f64> {
        self.shared.probe.onsets.lock().map(|mut v| std::mem::take(&mut *v)).unwrap_or_default()
    }
}

fn find(devices: impl Iterator<Item = cpal::Device>, name: &str) -> Option<cpal::Device> {
    devices.into_iter().find(|d| name_of(d).as_deref() == Some(name))
}

fn build(
    game_name: Option<&str>,
    music_name: Option<&str>,
    output_name: Option<&str>,
    shared: Arc<Shared>,
    on_error: ErrorSink,
) -> Result<(Vec<cpal::Stream>, String), String> {
    for c in [Channel::Game, Channel::Music] {
        shared.stats(c).reset();
    }
    shared.out.rate.store(0, Ordering::Relaxed);
    if game_name.is_none() && music_name.is_none() {
        return Ok((Vec::new(), "Audio off".into()));
    }
    let host = cpal::default_host();
    let output = match output_name {
        Some(n) => host
            .output_devices()
            .ok()
            .and_then(|d| find(d, n))
            .ok_or_else(|| format!("Output device not found: {n}"))?,
        None => host.default_output_device().ok_or("No default output device")?,
    };
    let output_label = name_of(&output).unwrap_or_else(|| "output".into());

    let mut streams = Vec::new();
    let mut readers = Vec::new();
    let mut parts = Vec::new();

    if let Some(name) = game_name {
        let dev = host
            .input_devices()
            .ok()
            .and_then(|d| find(d, name))
            .ok_or_else(|| format!("Game input not found: {name}"))?;
        let sup = dev.default_input_config().map_err(|e| e.to_string())?;
        let (s, r) = open_source(&dev, sup, Channel::Game, on_error.clone())?;
        parts.push(format!("game {} Hz", r.rate));
        mark_active(&shared, &r);
        streams.push(s);
        readers.push(r);
    }

    if let Some(name) = music_name {
        if name == output_label {
            return Err(format!(
                "Music can't come from \"{name}\" - that's where this app plays. \
                 Route your music player to a spare device instead."
            ));
        }
        let dev = host
            .output_devices()
            .ok()
            .and_then(|d| find(d, name))
            .ok_or_else(|| format!("Music device not found: {name}"))?;
        // Loopback: an input stream on an output device captures what plays to it.
        // A device that also has an input side (e.g. BlackHole on macOS) is
        // opened as that input, so use its input format.
        let sup = dev
            .default_input_config()
            .or_else(|_| dev.default_output_config())
            .map_err(|e| e.to_string())?;
        let (s, r) = open_source(&dev, sup, Channel::Music, on_error.clone())?;
        parts.push(format!("music {} Hz", r.rate));
        mark_active(&shared, &r);
        streams.push(s);
        readers.push(r);
    }

    // Windows: play at the first source's rate in f32 stereo (WASAPI converts
    // for us). Elsewhere, use the output device's own format: CoreAudio would
    // otherwise switch the speakers' hardware sample rate system-wide to match
    // the capture card. Our resampler covers any rate difference.
    // Either way, fall back to the device's own format if the first try is refused.
    let first_try = if cfg!(windows) {
        let rate = readers[0].rate;
        let wanted = StreamConfig { channels: 2, sample_rate: rate, buffer_size: cpal::BufferSize::Default };
        output_stream::<f32>(&output, &wanted, take(&mut readers), shared.clone(), on_error.clone())
    } else {
        Err((String::new(), take(&mut readers)))
    };
    let out_stream = match first_try {
        Ok(s) => s,
        Err((_, rs)) => {
            readers = rs;
            let sup = output.default_output_config().map_err(|e| e.to_string())?;
            let cfg = sup.config();
            let res = match sup.sample_format() {
                SampleFormat::F32 => output_stream::<f32>(&output, &cfg, readers, shared, on_error),
                SampleFormat::I16 => output_stream::<i16>(&output, &cfg, readers, shared, on_error),
                SampleFormat::I32 => output_stream::<i32>(&output, &cfg, readers, shared, on_error),
                SampleFormat::U16 => output_stream::<u16>(&output, &cfg, readers, shared, on_error),
                f => return Err(format!("Unsupported output sample format {f:?}")),
            };
            res.map_err(|(e, _)| e)?
        }
    };

    for s in &streams {
        s.play().map_err(|e| e.to_string())?;
    }
    out_stream.play().map_err(|e| e.to_string())?;
    streams.push(out_stream);
    Ok((streams, format!("{} -> {}", parts.join(" + "), output_label)))
}

fn take(v: &mut Vec<Reader>) -> Vec<Reader> {
    std::mem::take(v)
}

fn mark_active(shared: &Shared, r: &Reader) {
    let s = shared.stats(r.channel);
    s.rate.store(r.rate, Ordering::Relaxed);
    s.active.store(true, Ordering::Relaxed);
}

fn open_source(
    dev: &cpal::Device,
    sup: cpal::SupportedStreamConfig,
    channel: Channel,
    on_error: ErrorSink,
) -> Result<(cpal::Stream, Reader), String> {
    let cfg = sup.config();
    let fifo = Arc::new(Mutex::new(Fifo {
        buf: VecDeque::with_capacity(cfg.sample_rate as usize * 2),
        primed: false,
    }));
    let label = match channel {
        Channel::Game => "Game audio",
        Channel::Music => "Music",
    };
    let stream = match sup.sample_format() {
        SampleFormat::F32 => input_stream::<f32>(dev, &cfg, fifo.clone(), label, on_error),
        SampleFormat::I16 => input_stream::<i16>(dev, &cfg, fifo.clone(), label, on_error),
        SampleFormat::I32 => input_stream::<i32>(dev, &cfg, fifo.clone(), label, on_error),
        SampleFormat::U16 => input_stream::<u16>(dev, &cfg, fifo.clone(), label, on_error),
        f => return Err(format!("{label}: unsupported sample format {f:?}")),
    }?;
    let reader = Reader {
        channel,
        fifo,
        rate: cfg.sample_rate,
        step: 1.0,
        prev: [0.0; 2],
        next: [0.0; 2],
        frac: 0.0,
        gain: 0.0,
        last_target: 0,
        onset: OnsetDetector::new(),
    };
    Ok((stream, reader))
}

fn input_stream<T>(
    dev: &cpal::Device,
    cfg: &StreamConfig,
    fifo: Arc<Mutex<Fifo>>,
    label: &'static str,
    on_error: ErrorSink,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let ch = cfg.channels.max(1) as usize;
    let cap = (cfg.sample_rate * MAX_MS / 1000) as usize * 2;
    dev.build_input_stream::<T, _, _>(
        cfg.clone(),
        move |data: &[T], _| {
            let Ok(mut f) = fifo.lock() else { return };
            for frame in data.chunks_exact(ch) {
                let l = f32::from_sample(frame[0]);
                let r = if ch > 1 { f32::from_sample(frame[1]) } else { l };
                f.buf.push_back(l);
                f.buf.push_back(r);
            }
            let excess = f.buf.len().saturating_sub(cap);
            f.buf.drain(..excess);
        },
        move |e| on_error(format!("{label}: {e}")),
        None,
    )
    .map_err(|e| format!("{label}: {e}"))
}

/// On failure the readers are handed back so a fallback config can reuse them.
fn output_stream<T>(
    dev: &cpal::Device,
    cfg: &StreamConfig,
    mut readers: Vec<Reader>,
    shared: Arc<Shared>,
    on_error: ErrorSink,
) -> Result<cpal::Stream, (String, Vec<Reader>)>
where
    T: SizedSample + FromSample<f32>,
{
    let ch = cfg.channels.max(1) as usize;
    let out_rate = cfg.sample_rate;
    for r in &mut readers {
        r.step = r.rate as f64 / out_rate as f64;
        r.gain = shared.level(r.channel).gain();
    }
    // The closure needs to own the readers, but we must be able to return them
    // if building fails, so share them through an Arc<Mutex>.
    let readers = Arc::new(Mutex::new(readers));
    let rs = readers.clone();
    let mut mix: Vec<[f32; 2]> = Vec::new();

    let res = dev.build_output_stream::<T, _, _>(
        cfg.clone(),
        move |out: &mut [T], info: &cpal::OutputCallbackInfo| {
            let frames = out.len() / ch;
            let ts = info.timestamp();
            let latency = ts.playback.duration_since(ts.callback);
            let tick = Tick {
                t0: shared.now_ms() + latency.as_secs_f64() * 1000.0,
                frame_ms: 1000.0 / out_rate as f64,
                rate: out_rate,
            };
            shared.out.rate.store(out_rate, Ordering::Relaxed);
            shared.out.buffer.store(frames as u32, Ordering::Relaxed);
            shared.out.latency_us.store(latency.as_micros().min(u32::MAX as u128) as u32, Ordering::Relaxed);
            mix.clear();
            mix.resize(frames, [0.0; 2]);
            if let Ok(mut readers) = rs.lock() {
                for r in readers.iter_mut() {
                    r.mix_into(&mut mix, &shared, &tick);
                }
            }
            let clipped = mix.iter().flatten().filter(|s| s.abs() > 1.0).count() as u32;
            if clipped > 0 {
                shared.out.clipped.fetch_add(clipped, Ordering::Relaxed);
            }
            for (frame, m) in out.chunks_exact_mut(ch).zip(&mix) {
                let (l, r) = (m[0].clamp(-1.0, 1.0), m[1].clamp(-1.0, 1.0));
                match ch {
                    1 => frame[0] = T::from_sample((l + r) * 0.5),
                    _ => {
                        frame[0] = T::from_sample(l);
                        frame[1] = T::from_sample(r);
                        for s in &mut frame[2..] {
                            *s = T::EQUILIBRIUM;
                        }
                    }
                }
            }
        },
        move |e| on_error(format!("Audio output: {e}")),
        None,
    );
    res.map_err(|e| {
        let rs = std::mem::take(&mut *readers.lock().unwrap());
        (e.to_string(), rs)
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn lists_devices() {
        let d = super::list_devices();
        println!("inputs: {:?}\noutputs: {:?}\ndefault: {:?}", d.inputs, d.outputs, d.default_output);
        assert!(!d.outputs.is_empty());
    }
}

#[cfg(test)]
mod engine_tests {
    use super::*;

    const RATE: u32 = 48_000;
    const BLOCK: usize = 480; // 10 ms callbacks

    fn reader(fifo: &Arc<Mutex<Fifo>>) -> Reader {
        Reader {
            channel: Channel::Game,
            fifo: fifo.clone(),
            rate: RATE,
            step: 1.0,
            prev: [0.0; 2],
            next: [0.0; 2],
            frac: 0.0,
            gain: 1.0,
            last_target: 0,
            onset: OnsetDetector::new(),
        }
    }

    fn tick(n: usize) -> Tick {
        Tick { t0: n as f64 * 10.0, frame_ms: 1000.0 / RATE as f64, rate: RATE }
    }

    /// Runs `blocks` 10 ms callbacks: push one block of input (from `signal`), pull one block out.
    fn run(r: &mut Reader, fifo: &Arc<Mutex<Fifo>>, shared: &Shared, start: usize, blocks: usize, signal: impl Fn(usize) -> f32) {
        let mut mix = vec![[0.0f32; 2]; BLOCK];
        for n in start..start + blocks {
            {
                let mut f = fifo.lock().unwrap();
                for i in 0..BLOCK {
                    let v = signal(n * BLOCK + i);
                    f.buf.push_back(v);
                    f.buf.push_back(v);
                }
            }
            mix.iter_mut().for_each(|m| *m = [0.0; 2]);
            r.mix_into(&mut mix, shared, &tick(n));
        }
    }

    fn fill_ms(shared: &Shared) -> f32 {
        shared.game_stats.fill.load(Ordering::Relaxed) as f32 * 1000.0 / RATE as f32
    }

    fn new_fifo() -> Arc<Mutex<Fifo>> {
        Arc::new(Mutex::new(Fifo { buf: VecDeque::new(), primed: false }))
    }

    #[test]
    fn delay_changes_take_effect_immediately() {
        let shared = Shared::new();
        let fifo = new_fifo();
        let mut r = reader(&fifo);
        // Prime with a little extra input so the FIFO sits at its 15 ms base.
        fifo.lock().unwrap().buf.extend(std::iter::repeat_n(0.0, 2 * 720));
        run(&mut r, &fifo, &shared, 0, 50, |_| 0.1);
        assert!((fill_ms(&shared) - 15.0).abs() < 1.0, "base fill {}", fill_ms(&shared));

        // Longer delay: re-primes with silence, then holds the new level.
        shared.delay_ms.store(100, Ordering::Relaxed);
        run(&mut r, &fifo, &shared, 50, 50, |_| 0.1);
        assert!((fill_ms(&shared) - 115.0).abs() < 11.0, "after +100 ms: {}", fill_ms(&shared));

        // Shorter delay by less than the slack: trimmed at once, not left at 115 ms.
        shared.delay_ms.store(70, Ordering::Relaxed);
        run(&mut r, &fifo, &shared, 100, 5, |_| 0.1);
        assert!((fill_ms(&shared) - 85.0).abs() < 11.0, "after -30 ms: {}", fill_ms(&shared));
    }

    #[test]
    fn detects_beep_onsets() {
        let shared = Shared::new();
        shared.probe.on.store(true, Ordering::Relaxed);
        let fifo = new_fifo();
        let mut r = reader(&fifo);
        // 1 kHz beeps of 100 ms, once a second starting at 0.5 s, over a little noise.
        let beep = |i: usize| {
            let t = i as f32 / RATE as f32;
            let noise = ((i * 7919) % 101) as f32 / 101.0 * 0.004 - 0.002;
            let in_beep = t >= 0.5 && (t - 0.5) % 1.0 < 0.1;
            noise + if in_beep { 0.5 * (t * 1000.0 * std::f32::consts::TAU).sin() } else { 0.0 }
        };
        run(&mut r, &fifo, &shared, 0, 350, beep);
        let onsets = shared.probe.onsets.lock().unwrap().clone();
        assert_eq!(onsets.len(), 3, "onsets {onsets:?}");
        // Heard 15 ms after input (the FIFO's base latency), plus up to one block of priming.
        for (k, t) in onsets.iter().enumerate() {
            let expected = 500.0 + 1000.0 * k as f64 + 15.0;
            assert!((t - expected).abs() < 12.0, "onset {k} at {t}, expected ~{expected}");
        }
    }
}

#[cfg(test)]
mod loopback_test {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    #[test]
    #[ignore] // touches real hardware; run with --ignored
    fn opens_steam_speakers_loopback() {
        let host = cpal::default_host();
        let dev = super::find(host.output_devices().unwrap(), "Speakers (Steam Streaming Speakers)")
            .expect("device present");
        let sup = dev.default_output_config().unwrap();
        println!("loopback format: {:?} {} Hz {} ch", sup.sample_format(), sup.sample_rate(), sup.channels());
        let (s, _r) = super::open_source(&dev, sup, super::Channel::Music, std::sync::Arc::new(|e| println!("err {e}"))).unwrap();
        s.play().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1000));
        println!("loopback stream ran OK");
    }
}
