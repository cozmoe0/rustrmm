//! Windows remote desktop: a LocalSystem service launches a helper into the user's session
//! (`launch`), talks to it over a SYSTEM-only named pipe (`pipe`), and relays its frames to the
//! tunnel (`host`). The helper (`helper`) captures with DXGI/GDI following the input desktop
//! (`capture`, `desktop`), injects input (`input`), syncs the clipboard (`clipboard`) and shows
//! the session banner (`banner`).

mod banner;
mod capture;
mod clipboard;
mod desktop;
mod helper;
mod host;
mod input;
mod launch;
pub(crate) mod pipe;
mod session;

pub use helper::{main as helper_main, screenshot as own_screenshot, selftest, set_dpi_awareness};
pub use host::{bench, screenshot, serve};
pub use session::list as list_sessions;
