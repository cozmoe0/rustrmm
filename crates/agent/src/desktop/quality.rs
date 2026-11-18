//! Quality and frame-rate control.
//!
//! Fixed levels use their JPEG quality (45/65/82) at up to 30 fps; acks still limit the rate. In
//! `auto` the controller watches the ack round-trip time and how long the encoder sat blocked on
//! the two-frames-in-flight limit (backlog), and every 2 s window steps JPEG quality (35–82) and
//! the target frame rate (5–30) down quickly when the link struggles and up slowly when it is
//! healthy. The frame rate is also capped so encoding never takes more than ~80 % of the time.

use std::time::Duration;

use rustrmm_proto::desktop::Quality;

pub const MIN_FPS: u32 = 5;
pub const MAX_FPS: u32 = 30;
pub const MIN_AUTO_QUALITY: u8 = 35;
pub const MAX_AUTO_QUALITY: u8 = Quality::HIGH_JPEG;
const START_AUTO_QUALITY: u8 = Quality::MEDIUM_JPEG;
const START_AUTO_FPS: u32 = 20;
/// Weight of a new RTT sample in the moving average.
const RTT_ALPHA: f64 = 0.3;

/// What happened during one stats window.
#[derive(Debug, Clone, Copy, Default)]
pub struct Window {
    pub elapsed: Duration,
    /// Time spent waiting because two frames were already in flight.
    pub blocked: Duration,
    /// Average encode time per frame.
    pub encode_ms: f64,
}

#[derive(Debug, Clone)]
pub struct Controller {
    mode: Quality,
    quality: u8,
    fps: u32,
    rtt_ms: Option<f64>,
}

impl Controller {
    pub fn new(mode: Quality) -> Self {
        let mut c = Self {
            mode,
            quality: START_AUTO_QUALITY,
            fps: START_AUTO_FPS,
            rtt_ms: None,
        };
        c.set_mode(mode);
        c
    }

    pub fn set_mode(&mut self, mode: Quality) {
        self.mode = mode;
        match mode.jpeg_quality() {
            Some(q) => {
                self.quality = q;
                self.fps = MAX_FPS;
            }
            None => {
                self.quality = START_AUTO_QUALITY;
                self.fps = START_AUTO_FPS;
            }
        }
    }

    #[cfg(test)]
    pub fn mode(&self) -> Quality {
        self.mode
    }

    pub fn jpeg_quality(&self) -> u8 {
        self.quality
    }

    #[cfg(test)]
    pub fn fps(&self) -> u32 {
        self.fps
    }

    pub fn frame_interval(&self) -> Duration {
        Duration::from_secs_f64(1.0 / f64::from(self.fps.max(1)))
    }

    #[cfg(test)]
    pub fn rtt_ms(&self) -> Option<f64> {
        self.rtt_ms
    }

    /// Records the time from sending a frame to its ack.
    pub fn on_ack(&mut self, rtt: Duration) {
        let sample = rtt.as_secs_f64() * 1000.0;
        self.rtt_ms = Some(match self.rtt_ms {
            Some(avg) => avg + RTT_ALPHA * (sample - avg),
            None => sample,
        });
    }

    /// Adjusts quality and frame rate at the end of a stats window.
    pub fn on_window(&mut self, w: &Window) {
        let encode_cap = if w.encode_ms > 0.5 {
            ((800.0 / w.encode_ms) as u32).clamp(MIN_FPS, MAX_FPS)
        } else {
            MAX_FPS
        };
        if self.mode != Quality::Auto {
            self.fps = encode_cap;
            return;
        }
        let window = w.elapsed.as_secs_f64().max(0.001);
        let backlog = (w.blocked.as_secs_f64() / window).clamp(0.0, 1.0);
        let rtt = self.rtt_ms.unwrap_or(0.0);
        if rtt > 300.0 || backlog > 0.5 {
            // Congested: back off hard.
            self.quality = self.quality.saturating_sub(10).max(MIN_AUTO_QUALITY);
            self.fps = (self.fps * 2 / 3).max(MIN_FPS);
        } else if rtt > 150.0 || backlog > 0.2 {
            self.quality = self.quality.saturating_sub(5).max(MIN_AUTO_QUALITY);
            self.fps = self.fps.saturating_sub(3).max(MIN_FPS);
        } else if rtt < 80.0 && backlog < 0.05 {
            self.quality = (self.quality + 3).min(MAX_AUTO_QUALITY);
            self.fps = (self.fps + 5).min(MAX_FPS);
        }
        self.fps = self.fps.min(encode_cap).max(MIN_FPS);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(blocked_ms: u64, encode_ms: f64) -> Window {
        Window {
            elapsed: Duration::from_secs(2),
            blocked: Duration::from_millis(blocked_ms),
            encode_ms,
        }
    }

    #[test]
    fn fixed_levels_use_contract_qualities() {
        for (mode, q) in [
            (Quality::Low, 45),
            (Quality::Medium, 65),
            (Quality::High, 82),
        ] {
            let mut c = Controller::new(mode);
            assert_eq!(c.jpeg_quality(), q);
            assert_eq!(c.fps(), 30);
            // A congested link does not change a fixed quality.
            c.on_ack(Duration::from_millis(900));
            c.on_window(&window(1900, 5.0));
            assert_eq!(c.jpeg_quality(), q);
        }
    }

    #[test]
    fn auto_backs_off_under_congestion_and_respects_bounds() {
        let mut c = Controller::new(Quality::Auto);
        let (q0, f0) = (c.jpeg_quality(), c.fps());
        c.on_ack(Duration::from_millis(500));
        c.on_window(&window(0, 5.0));
        assert!(c.jpeg_quality() < q0);
        assert!(c.fps() < f0);
        for _ in 0..20 {
            c.on_ack(Duration::from_millis(800));
            c.on_window(&window(1500, 5.0));
        }
        assert_eq!(c.jpeg_quality(), MIN_AUTO_QUALITY);
        assert_eq!(c.fps(), MIN_FPS);
    }

    #[test]
    fn auto_backlog_alone_triggers_back_off() {
        let mut c = Controller::new(Quality::Auto);
        let q0 = c.jpeg_quality();
        c.on_ack(Duration::from_millis(20));
        c.on_window(&window(1200, 5.0)); // blocked 60 % of the window
        assert!(c.jpeg_quality() < q0);
    }

    #[test]
    fn auto_recovers_slowly_on_a_healthy_link() {
        let mut c = Controller::new(Quality::Auto);
        for _ in 0..30 {
            c.on_ack(Duration::from_millis(20));
            c.on_window(&window(0, 4.0));
        }
        assert_eq!(c.jpeg_quality(), MAX_AUTO_QUALITY);
        assert_eq!(c.fps(), MAX_FPS);
        // The RTT average needs several bad samples before it reacts.
        c.on_ack(Duration::from_millis(400));
        assert!(c.rtt_ms().expect("rtt") < 300.0);
    }

    #[test]
    fn slow_encoding_caps_the_frame_rate() {
        let mut c = Controller::new(Quality::High);
        c.on_window(&window(0, 80.0)); // 80 ms per frame → at most 10 fps
        assert_eq!(c.fps(), 10);
        let mut auto = Controller::new(Quality::Auto);
        for _ in 0..10 {
            auto.on_ack(Duration::from_millis(10));
            auto.on_window(&window(0, 400.0));
        }
        assert_eq!(auto.fps(), MIN_FPS);
        assert_eq!(auto.frame_interval(), Duration::from_millis(200));
    }

    #[test]
    fn switching_modes_resets_the_targets() {
        let mut c = Controller::new(Quality::Auto);
        c.set_mode(Quality::Low);
        assert_eq!((c.jpeg_quality(), c.fps()), (45, 30));
        c.set_mode(Quality::Auto);
        assert_eq!(c.jpeg_quality(), 65);
        assert_eq!(c.mode(), Quality::Auto);
    }
}
