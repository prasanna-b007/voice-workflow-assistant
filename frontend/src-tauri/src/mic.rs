//! Microphone capture for Whisper: records one utterance and decides when the user has
//! finished speaking.
//!
//! Audio arrives at whatever rate and channel count the default input device uses; it is
//! mixed to mono and resampled to the 16 kHz Whisper expects. The earshot voice-activity
//! detector then scores each 16 ms frame. Listening ends after a stretch of silence that
//! follows speech, or with no result when nobody speaks before the initial timeout. Only
//! audio that contains speech ever reaches Whisper, which otherwise tends to invent text
//! ("Thank you.") out of silence.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample, StreamConfig};

pub const SAMPLE_RATE: u32 = 16_000;

/// earshot scores frames of exactly 256 samples (16 ms at 16 kHz).
const FRAME: usize = 256;
const FRAME_MS: u32 = 16;
/// earshot's suggested cut-off between voice and not-voice.
const VOICE_THRESHOLD: f32 = 0.5;
/// Consecutive voiced frames that count as the start of speech, so a click or a cough
/// doesn't.
const START_FRAMES: u32 = 3;
/// Audio kept from just before speech starts, so the first syllable isn't clipped.
const PREROLL_FRAMES: usize = 20;
/// Silence kept after the last voiced frame, so the last syllable isn't clipped.
const TAIL_FRAMES: u32 = 12;
/// Less voice than this (~0.25 s) is a cough, a click or the tail of Sonix's own reply,
/// not a command; Whisper turns such scraps into "Thank you." Keep listening instead.
const MIN_SPEECH_FRAMES: u32 = 15;

pub struct Limits {
    /// Give up if nobody starts speaking within this long.
    pub initial_silence_ms: u32,
    /// Stop once the speaker has been quiet this long.
    pub end_silence_ms: u32,
    /// Stop regardless after this long.
    pub max_ms: u32,
}

pub enum Outcome {
    /// 16 kHz mono samples of one utterance.
    Speech(Vec<f32>),
    /// Nobody spoke.
    Silence,
    Cancelled,
}

/// Lets another thread cancel a recording.
#[derive(Default)]
pub struct Control {
    cancel: AtomicBool,
}

impl Control {
    /// Stop and discard the recording.
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
}

enum Msg {
    Audio(Vec<f32>),
    Error(String),
}

/// Records from the default microphone until the user stops talking. `on_level` gets the
/// input level (0..1) about every 60 ms, for the overlay's animation.
pub fn record(limits: &Limits, control: &Control, mut on_level: impl FnMut(f32)) -> Result<Outcome, String> {
    let device = cpal::default_host().default_input_device().ok_or("No microphone found.")?;
    let supported = device.default_input_config().map_err(|e| format!("Could not open the microphone: {e}"))?;
    let config = supported.config();
    let (tx, rx) = mpsc::channel();
    let stream = match supported.sample_format() {
        SampleFormat::F32 => build::<f32>(&device, &config, tx),
        SampleFormat::I16 => build::<i16>(&device, &config, tx),
        SampleFormat::I32 => build::<i32>(&device, &config, tx),
        SampleFormat::U16 => build::<u16>(&device, &config, tx),
        SampleFormat::U8 => build::<u8>(&device, &config, tx),
        other => return Err(format!("Unsupported microphone sample format: {other}")),
    }
    .map_err(|e| format!("Could not open the microphone: {e}"))?;
    stream.play().map_err(|e| format!("Could not start the microphone: {e}"))?;
    log::info!("mic: recording at {} Hz, {} channel(s)", config.sample_rate, config.channels);

    let mut resampler = Resampler::new(config.sample_rate, SAMPLE_RATE);
    let mut endpointer = Endpointer::new(limits);
    let mut last_audio = Instant::now();
    let mut last_level = Instant::now();

    // `stream` is dropped on return, which releases the microphone.
    loop {
        if control.cancel.load(Ordering::SeqCst) {
            return Ok(Outcome::Cancelled);
        }
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(Msg::Audio(samples)) => {
                last_audio = Instant::now();
                if let Some(outcome) = endpointer.push(&resampler.process(&samples)) {
                    return Ok(outcome);
                }
                if last_level.elapsed() >= Duration::from_millis(60) {
                    last_level = Instant::now();
                    on_level(endpointer.level());
                }
            }
            Ok(Msg::Error(e)) => return Err(format!("The microphone stopped working: {e}")),
            Err(RecvTimeoutError::Timeout) if last_audio.elapsed() > Duration::from_secs(3) => {
                return Err("The microphone isn't sending any audio.".into());
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Err("The microphone stopped working.".into()),
        }
    }
}

fn build<T>(device: &cpal::Device, config: &StreamConfig, tx: Sender<Msg>) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = usize::from(config.channels.max(1));
    let err_tx = tx.clone();
    device.build_input_stream(
        config,
        // Runs on the audio thread: just downmix and hand off.
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            let mono = data
                .chunks(channels)
                .map(|frame| frame.iter().map(|&s| s.to_sample::<f32>()).sum::<f32>() / frame.len() as f32)
                .collect();
            let _ = tx.send(Msg::Audio(mono));
        },
        move |err| match err {
            cpal::StreamError::DeviceNotAvailable => {
                let _ = err_tx.send(Msg::Error(err.to_string()));
            }
            // Glitches the stream recovers from; a stream that really died is caught by
            // the no-audio timeout in record().
            other => log::warn!("mic: stream error: {other}"),
        },
        None,
    )
}

/// Streaming resampler: a low-pass filter against aliasing when downsampling, then
/// linear interpolation. Plenty for speech recognition.
pub struct Resampler {
    /// Input samples per output sample.
    step: f64,
    /// Position of the next output sample, in input samples, where 0 is `prev`.
    pos: f64,
    /// Last (filtered) sample of the previous chunk.
    prev: f32,
    filters: Vec<Biquad>,
}

impl Resampler {
    pub fn new(from_hz: u32, to_hz: u32) -> Self {
        let filters = if from_hz > to_hz {
            // Two 2nd-order sections: about -24 dB/octave above 45% of the new rate.
            let cutoff = 0.45 * to_hz as f64;
            vec![Biquad::low_pass(from_hz as f64, cutoff), Biquad::low_pass(from_hz as f64, cutoff)]
        } else {
            Vec::new()
        };
        Self { step: from_hz as f64 / to_hz as f64, pos: 1.0, prev: 0.0, filters }
    }

    pub fn process(&mut self, input: &[f32]) -> Vec<f32> {
        let filtered: Vec<f32> = input
            .iter()
            .map(|&x| self.filters.iter_mut().fold(x, |x, f| f.process(x)))
            .collect();
        let n = filtered.len();
        if n == 0 {
            return Vec::new();
        }
        // Interpolate over [prev, filtered...], where index 0 is `prev`.
        let mut out = Vec::with_capacity((n as f64 / self.step) as usize + 1);
        while self.pos < n as f64 {
            let i = self.pos as usize;
            let frac = (self.pos - i as f64) as f32;
            let a = if i == 0 { self.prev } else { filtered[i - 1] };
            let b = filtered[i];
            out.push(a + (b - a) * frac);
            self.pos += self.step;
        }
        self.pos -= n as f64;
        self.prev = filtered[n - 1];
        out
    }
}

/// RBJ-cookbook biquad low-pass, Butterworth Q.
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    fn low_pass(sample_rate: f64, cutoff: f64) -> Self {
        let w0 = 2.0 * std::f64::consts::PI * cutoff / sample_rate;
        let alpha = w0.sin() / (2.0 * std::f64::consts::FRAC_1_SQRT_2);
        let cos = w0.cos();
        let a0 = 1.0 + alpha;
        Self {
            b0: ((1.0 - cos) / 2.0 / a0) as f32,
            b1: ((1.0 - cos) / a0) as f32,
            b2: ((1.0 - cos) / 2.0 / a0) as f32,
            a1: (-2.0 * cos / a0) as f32,
            a2: ((1.0 - alpha) / a0) as f32,
            z1: 0.0,
            z2: 0.0,
        }
    }

    fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

/// Decides, frame by frame, when an utterance starts and ends.
pub struct Endpointer {
    vad: Box<earshot::Detector>,
    /// Samples that don't yet fill a whole frame.
    pending: Vec<f32>,
    /// Before speech starts, the most recent pre-roll; after, the whole utterance.
    audio: Vec<f32>,
    started: bool,
    voiced_run: u32,
    /// Voiced frames since speech started.
    voiced: u32,
    /// Frames since the last voiced one.
    trailing_silence: u32,
    frames: u32,
    level: f32,
    initial_frames: u32,
    end_frames: u32,
    max_frames: u32,
}

impl Endpointer {
    pub fn new(limits: &Limits) -> Self {
        Self {
            vad: earshot::Detector::default_boxed(),
            pending: Vec::new(),
            audio: Vec::new(),
            started: false,
            voiced_run: 0,
            voiced: 0,
            trailing_silence: 0,
            frames: 0,
            level: 0.0,
            initial_frames: limits.initial_silence_ms / FRAME_MS,
            end_frames: limits.end_silence_ms / FRAME_MS,
            max_frames: limits.max_ms / FRAME_MS,
        }
    }

    /// Feeds 16 kHz mono samples. Returns the outcome once listening should stop.
    pub fn push(&mut self, samples: &[f32]) -> Option<Outcome> {
        self.pending.extend_from_slice(samples);
        let mut used = 0;
        let mut outcome = None;
        while outcome.is_none() && self.pending.len() - used >= FRAME {
            let mut frame = [0f32; FRAME];
            for (dst, &src) in frame.iter_mut().zip(&self.pending[used..used + FRAME]) {
                // earshot requires [-1, 1]; a clipping or broken driver can exceed it.
                *dst = if src.is_finite() { src.clamp(-1.0, 1.0) } else { 0.0 };
            }
            used += FRAME;
            outcome = self.frame(&frame);
        }
        self.pending.drain(..used);
        outcome
    }

    /// Input level, 0..1, for display.
    pub fn level(&self) -> f32 {
        self.level
    }

    fn frame(&mut self, frame: &[f32; FRAME]) -> Option<Outcome> {
        self.frames += 1;
        let rms = (frame.iter().map(|s| s * s).sum::<f32>() / FRAME as f32).sqrt();
        // -55 dBFS (room noise) .. -10 dBFS (loud speech), decaying smoothly.
        let level = ((20.0 * (rms + 1e-9).log10() + 55.0) / 45.0).clamp(0.0, 1.0);
        self.level = level.max(self.level * 0.8);

        let voiced = self.vad.predict_f32(frame) >= VOICE_THRESHOLD;
        self.audio.extend_from_slice(frame);

        if !self.started {
            self.voiced_run = if voiced { self.voiced_run + 1 } else { 0 };
            let preroll = PREROLL_FRAMES * FRAME;
            if self.voiced_run >= START_FRAMES {
                self.started = true;
                self.voiced = self.voiced_run;
                self.trailing_silence = 0;
                let excess = self.audio.len().saturating_sub(preroll);
                self.audio.drain(..excess);
            } else {
                // Trim in batches rather than every frame.
                if self.audio.len() > 2 * preroll {
                    let excess = self.audio.len() - preroll;
                    self.audio.drain(..excess);
                }
                if self.frames >= self.initial_frames {
                    return Some(Outcome::Silence);
                }
                return None;
            }
        } else if voiced {
            self.voiced += 1;
            self.trailing_silence = 0;
        } else {
            self.trailing_silence += 1;
        }

        if self.frames >= self.max_frames {
            return Some(self.take());
        }
        if self.trailing_silence >= self.end_frames {
            if self.voiced >= MIN_SPEECH_FRAMES {
                return Some(self.take());
            }
            // Just a blip: forget it and wait for real speech.
            self.started = false;
            self.voiced_run = 0;
            if self.frames >= self.initial_frames {
                return Some(Outcome::Silence);
            }
        }
        None
    }

    fn take(&mut self) -> Outcome {
        let extra = self.trailing_silence.saturating_sub(TAIL_FRAMES) as usize * FRAME;
        let len = self.audio.len().saturating_sub(extra);
        self.audio.truncate(len);
        Outcome::Speech(std::mem::take(&mut self.audio))
    }
}
