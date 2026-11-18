//! Frames from long-running work (patch scans and installs, software actions) that must reach
//! the server even when the connection drops and comes back while the work runs.
//!
//! Work pushes encoded frames here; every session drains the queue, removing a frame only after
//! it was written to the socket. The queue lives in memory (bounded), so it survives reconnects
//! but not an agent restart.

use std::collections::VecDeque;
use std::sync::{LazyLock, Mutex};

use rustrmm_proto::commands::CommandResult;
use tokio::sync::Notify;

const MAX_FRAMES: usize = 200;

struct Outbox {
    queue: Mutex<VecDeque<Vec<u8>>>,
    notify: Notify,
}

static OUTBOX: LazyLock<Outbox> = LazyLock::new(|| Outbox {
    queue: Mutex::new(VecDeque::new()),
    notify: Notify::new(),
});

/// Queues a typed message for the server.
pub fn push<M: rustrmm_proto::Message>(message: &M) {
    match rustrmm_proto::encode(message) {
        Ok(frame) => push_frame(frame),
        Err(e) => tracing::warn!(error = %e, "could not encode a queued message"),
    }
}

/// Queues a command result.
pub fn result(result: CommandResult) {
    push(&result);
}

fn push_frame(frame: Vec<u8>) {
    if let Ok(mut queue) = OUTBOX.queue.lock() {
        if queue.len() >= MAX_FRAMES {
            queue.pop_front();
        }
        queue.push_back(frame);
    }
    OUTBOX.notify.notify_one();
}

/// The oldest queued frame, without removing it.
pub fn peek() -> Option<Vec<u8>> {
    OUTBOX.queue.lock().ok().and_then(|q| q.front().cloned())
}

/// Removes the oldest frame (after it was sent).
pub fn pop() {
    if let Ok(mut queue) = OUTBOX.queue.lock() {
        queue.pop_front();
    }
}

/// Resolves when something was queued.
pub async fn notified() {
    OUTBOX.notify.notified().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_stay_until_popped() {
        while peek().is_some() {
            pop();
        }
        result(CommandResult {
            cmd_id: "c1".into(),
            status: "succeeded".into(),
            message: String::new(),
            data: serde_json::Value::Null,
        });
        let first = peek().expect("queued");
        assert_eq!(peek().expect("still queued"), first);
        let frame = rustrmm_proto::Frame::decode(&first).expect("frame");
        assert_eq!(frame.t, "command_result");
        pop();
        assert!(peek().is_none());
    }
}
