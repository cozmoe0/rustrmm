//! Lightweight performance sampler (CPU, memory, disk, network, disk I/O).

use std::time::Instant;

use rustrmm_proto::messages::{Heartbeat, MetricSample};
use sysinfo::{Disks, Networks, System};

pub struct Sampler {
    system: System,
    networks: Networks,
    disks: Disks,
    last: Instant,
}

impl Sampler {
    pub fn new() -> Self {
        let mut system = System::new().unwrap_or_else(|_| System::new_all().expect("sysinfo"));
        system.refresh_cpu_usage();
        system.refresh_memory();
        let networks = Networks::new_with_refreshed_list()
            .unwrap_or_else(|_| Networks::new().expect("sysinfo networks"));
        let disks = Disks::new_with_refreshed_list()
            .unwrap_or_else(|_| Disks::new().expect("sysinfo disks"));
        Self {
            system,
            networks,
            disks,
            last: Instant::now(),
        }
    }

    /// Takes a sample; rates are computed since the previous call.
    pub fn sample(&mut self) -> MetricSample {
        let elapsed = self.last.elapsed().as_secs_f64().max(0.001);
        self.last = Instant::now();
        self.system.refresh_cpu_usage();
        self.system.refresh_memory();
        self.networks.refresh(true);
        self.disks.refresh(true);

        let (rx, tx) = self.networks.values().fold((0u64, 0u64), |(r, t), n| {
            (r + n.received(), t + n.transmitted())
        });
        let (read, written) = self.disks.iter().fold((0u64, 0u64), |(r, w), d| {
            let u = d.usage();
            (r + u.read_bytes, w + u.written_bytes)
        });
        MetricSample {
            ts: chrono::Utc::now().timestamp(),
            cpu: self.system.global_cpu_usage(),
            mem: memory_pct(&self.system),
            disk: max_disk_pct(&self.disks),
            net_rx_bps: rx as f64 * 8.0 / elapsed,
            net_tx_bps: tx as f64 * 8.0 / elapsed,
            disk_read_bps: read as f64 / elapsed,
            disk_write_bps: written as f64 / elapsed,
            process_count: 0,
        }
    }

    pub fn heartbeat(&mut self, logged_in_user: Option<String>) -> Heartbeat {
        self.system.refresh_cpu_usage();
        self.system.refresh_memory();
        self.disks.refresh(true);
        Heartbeat {
            uptime_s: System::uptime().unwrap_or(0),
            cpu_pct: self.system.global_cpu_usage(),
            mem_pct: memory_pct(&self.system),
            disk_pct: max_disk_pct(&self.disks),
            logged_in_user,
        }
    }
}

fn memory_pct(system: &System) -> f32 {
    let total = system.total_memory();
    if total == 0 {
        0.0
    } else {
        (system.used_memory() as f64 / total as f64 * 100.0) as f32
    }
}

/// Highest usage among fixed, writable volumes larger than 1 GB.
fn max_disk_pct(disks: &Disks) -> f32 {
    disks
        .iter()
        .filter(|d| !d.is_removable() && !d.is_read_only() && d.total_space() > 1_000_000_000)
        .map(|d| {
            let total = d.total_space() as f64;
            ((total - d.available_space() as f64) / total * 100.0) as f32
        })
        .fold(0.0, f32::max)
}
