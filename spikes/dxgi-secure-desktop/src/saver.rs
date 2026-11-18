//! Writes proof frames as JPEG on a worker thread so encoding never stalls
//! the capture loop (and never skews the measured frame rates).
//! File name: `{tag}-{seq}-{timestamp}-{desktop}-{method}.jpg`.

use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::thread::JoinHandle;
use std::time::Instant;

use jpeg_encoder::{ColorType, Encoder};

use crate::capture::Image;

struct Job {
    path: PathBuf,
    width: u32,
    height: u32,
    bgra: Vec<u8>,
}

pub struct Saver {
    tx: Option<SyncSender<Job>>,
    worker: Option<JoinHandle<()>>,
    dir: PathBuf,
    tag: &'static str,
    max: u32,
    pub submitted: u32,
    pub dropped: u32,
    limit_logged: bool,
}

impl Saver {
    pub fn start(dir: PathBuf, tag: &'static str, quality: u8, max: u32) -> anyhow::Result<Saver> {
        std::fs::create_dir_all(&dir)?;
        let (tx, rx) = mpsc::sync_channel::<Job>(2);
        let worker = std::thread::Builder::new()
            .name("saver".into())
            .spawn(move || encode_worker(rx, quality))?;
        log!("saver: writing up to {max} frames to {}", dir.display());
        Ok(Saver {
            tx: Some(tx),
            worker: Some(worker),
            dir,
            tag,
            max,
            submitted: 0,
            dropped: 0,
            limit_logged: false,
        })
    }

    /// Queues a copy of `image`; returns false if dropped or over the limit.
    pub fn submit(&mut self, desktop: &str, method: &str, reason: &str, image: Image<'_>) -> bool {
        if self.submitted >= self.max {
            if !self.limit_logged {
                log!(
                    "saver: reached the limit of {} frames; not writing more",
                    self.max
                );
                self.limit_logged = true;
            }
            return false;
        }
        let name = format!(
            "{}-{:05}-{}-{}-{}.jpg",
            self.tag,
            self.submitted,
            crate::util::timestamp_compact(),
            sanitize(desktop),
            method
        );
        let job = Job {
            path: self.dir.join(&name),
            width: image.width,
            height: image.height,
            bgra: image.bgra.to_vec(),
        };
        let Some(tx) = &self.tx else {
            return false;
        };
        match tx.try_send(job) {
            Ok(()) => {
                self.submitted += 1;
                log!("saver: queued {name} ({reason})");
                true
            }
            Err(TrySendError::Full(_)) => {
                self.dropped += 1;
                false
            }
            Err(TrySendError::Disconnected(_)) => false,
        }
    }

    /// Flushes queued frames and stops the worker.
    pub fn finish(&mut self) {
        drop(self.tx.take());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn sanitize(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if s.is_empty() { "unknown".into() } else { s }
}

/// Mean luma (0-255) and percentage of non-black pixels, sampled. A black
/// frame is the classic failure mode when capturing a desktop the thread is
/// not attached to.
fn image_stats(bgra: &[u8]) -> (f64, f64) {
    let (mut n, mut sum, mut lit) = (0u64, 0u64, 0u64);
    for px in bgra.as_chunks::<4>().0.iter().step_by(7) {
        let y = (114 * px[0] as u64 + 587 * px[1] as u64 + 299 * px[2] as u64) / 1000;
        sum += y;
        n += 1;
        if y > 8 {
            lit += 1;
        }
    }
    let n = n.max(1) as f64;
    (sum as f64 / n, 100.0 * lit as f64 / n)
}

fn encode_worker(rx: Receiver<Job>, quality: u8) {
    for job in rx {
        let started = Instant::now();
        let (luma, lit) = image_stats(&job.bgra);
        let (Ok(w), Ok(h)) = (u16::try_from(job.width), u16::try_from(job.height)) else {
            log!("saver: {}x{} too large for JPEG", job.width, job.height);
            continue;
        };
        let result = Encoder::new_file(&job.path, quality)
            .and_then(|encoder| encoder.encode(&job.bgra, w, h, ColorType::Bgra));
        let name = job.path.file_name().unwrap_or_default().to_string_lossy();
        match result {
            Ok(()) => {
                let kib = std::fs::metadata(&job.path)
                    .map(|m| m.len() / 1024)
                    .unwrap_or(0);
                log!(
                    "saver: wrote {name} ({}x{}, {kib} KiB, {:.0} ms, mean luma {luma:.0}, non-black {lit:.1}%)",
                    job.width,
                    job.height,
                    started.elapsed().as_secs_f64() * 1000.0
                );
            }
            Err(e) => log!("saver: failed to write {name}: {e}"),
        }
    }
}
