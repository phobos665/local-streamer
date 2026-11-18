//! Audio mixer: game capture (+ optional music loopback) -> output device, all
//! inside this process, so Discord's per-application ("window") audio capture
//! picks it up.
//!
//! Sources:
//!   * game  - a capture device, e.g. "HDMI (Elgato 4K S)"
//!   * music - loopback of an *output* device the user routes Spotify etc. to
//!             (e.g. "Speakers (Steam Streaming Speakers)"), so it is heard once,
//!             through us, rather than directly as well.
//!
//! Each source has its own FIFO. Its fill level *is* that source's latency:
//! we hold it near a target, dropping the oldest audio if it grows (clock
//! drift) and re-priming with silence if it runs dry.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample, StreamConfig};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};

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

pub struct Shared {
    game: Level,
    music: Level,
    delay_ms: AtomicU32, // game only (A/V sync)
}

impl Shared {
    fn level(&self, c: Channel) -> &Level {
        match c {
            Channel::Game => &self.game,
            Channel::Music => &self.music,
        }
    }
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
}

impl Reader {
    /// Adds this source's audio for `frames` output frames into `mix`.
    fn mix_into(&mut self, mix: &mut [[f32; 2]], shared: &Shared) {
        let target_gain = shared.level(self.channel).gain();
        let base = match self.channel {
            Channel::Game => GAME_BASE_MS + shared.delay_ms.load(Ordering::Relaxed),
            Channel::Music => MUSIC_BASE_MS,
        };
        let target = (self.rate * base / 1000) as usize;
        let slack = (self.rate * SLACK_MS / 1000) as usize;

        let Ok(mut f) = self.fifo.lock() else { return };
        let avail = f.buf.len() / 2;
        if !f.primed {
            if avail >= target {
                f.primed = true;
            } else {
                return; // silence until the cushion has built up
            }
        }
        if avail > target + slack {
            let drop = (avail - target) * 2;
            f.buf.drain(..drop);
        }

        for out in mix.iter_mut() {
            while self.frac >= 1.0 {
                self.prev = self.next;
                match (f.buf.pop_front(), f.buf.pop_front()) {
                    (Some(l), Some(r)) => self.next = [l, r],
                    _ => {
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
        }
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
        let shared = Arc::new(Shared {
            game: Level::new(0.8),
            music: Level::new(0.5),
            delay_ms: AtomicU32::new(0),
        });
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
        let sup = dev.default_output_config().map_err(|e| e.to_string())?;
        let (s, r) = open_source(&dev, sup, Channel::Music, on_error.clone())?;
        parts.push(format!("music {} Hz", r.rate));
        streams.push(s);
        readers.push(r);
    }

    // Play at the first source's rate in f32 stereo (WASAPI converts for us);
    // fall back to the device's own format if that's refused.
    let rate = readers[0].rate;
    let wanted = StreamConfig { channels: 2, sample_rate: rate, buffer_size: cpal::BufferSize::Default };
    let out_stream = match output_stream::<f32>(&output, &wanted, take(&mut readers), shared.clone(), on_error.clone()) {
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
    for r in &mut readers {
        r.step = r.rate as f64 / cfg.sample_rate as f64;
        r.gain = shared.level(r.channel).gain();
    }
    // The closure needs to own the readers, but we must be able to return them
    // if building fails, so share them through an Arc<Mutex>.
    let readers = Arc::new(Mutex::new(readers));
    let rs = readers.clone();
    let mut mix: Vec<[f32; 2]> = Vec::new();

    let res = dev.build_output_stream::<T, _, _>(
        cfg.clone(),
        move |out: &mut [T], _| {
            let frames = out.len() / ch;
            mix.clear();
            mix.resize(frames, [0.0; 2]);
            if let Ok(mut readers) = rs.lock() {
                for r in readers.iter_mut() {
                    r.mix_into(&mut mix, &shared);
                }
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
