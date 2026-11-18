//! Small in-memory token-bucket rate limiter keyed by (bucket, key).

use std::time::{Duration, Instant};

use dashmap::DashMap;

#[derive(Debug, Clone, Copy)]
pub struct Limit {
    /// Maximum burst.
    pub capacity: f64,
    /// Tokens added per second.
    pub refill_per_sec: f64,
}

impl Limit {
    /// `count` requests per `period`, all of which may be used in a burst.
    pub const fn per(count: u32, period: Duration) -> Self {
        Self {
            capacity: count as f64,
            refill_per_sec: count as f64 / period.as_secs_f64(),
        }
    }
}

struct Bucket {
    tokens: f64,
    updated: Instant,
}

#[derive(Default)]
pub struct RateLimiter {
    buckets: DashMap<(&'static str, String), Bucket>,
}

impl RateLimiter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Consumes one token; returns false when the caller should be rejected.
    pub fn check(&self, bucket: &'static str, key: &str, limit: Limit) -> bool {
        let now = Instant::now();
        let mut entry = self
            .buckets
            .entry((bucket, key.to_string()))
            .or_insert_with(|| Bucket {
                tokens: limit.capacity,
                updated: now,
            });
        let elapsed = now.duration_since(entry.updated).as_secs_f64();
        entry.tokens = (entry.tokens + elapsed * limit.refill_per_sec).min(limit.capacity);
        entry.updated = now;
        if entry.tokens >= 1.0 {
            entry.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    /// Drops buckets idle for longer than `idle` (call periodically).
    pub fn sweep(&self, idle: Duration) {
        let now = Instant::now();
        self.buckets
            .retain(|_, b| now.duration_since(b.updated) < idle);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforces_burst_and_isolates_keys() {
        let limiter = RateLimiter::new();
        let limit = Limit::per(3, Duration::from_secs(60));
        assert!(limiter.check("login", "1.2.3.4", limit));
        assert!(limiter.check("login", "1.2.3.4", limit));
        assert!(limiter.check("login", "1.2.3.4", limit));
        assert!(!limiter.check("login", "1.2.3.4", limit));
        assert!(limiter.check("login", "5.6.7.8", limit));
        assert!(limiter.check("setup", "1.2.3.4", limit));
    }
}
