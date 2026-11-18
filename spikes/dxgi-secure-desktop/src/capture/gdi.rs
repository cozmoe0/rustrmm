//! GDI fallback: `BitBlt` from the screen DC of the thread's desktop into a
//! DIB section. Works where Desktop Duplication does not (RDP sessions,
//! Microsoft Basic Display Adapter, odd drivers) at a higher CPU cost.
//! The screen DC is tied to the thread's desktop, so the capturer must be
//! dropped before `SetThreadDesktop` and recreated afterwards.

use std::time::{Duration, Instant};

use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CAPTUREBLT, CreateCompatibleDC, CreateDIBSection,
    DIB_RGB_COLORS, DeleteDC, DeleteObject, GdiFlush, GetDC, HBITMAP, HDC, HGDIOBJ, ROP_CODE,
    ReleaseDC, SRCCOPY, SelectObject,
};
use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};

use super::{CaptureError, FrameStatus, Image};

pub struct GdiCapturer {
    pub rect: RECT,
    pub last_process_ms: f64,
    screen_dc: HDC,
    mem_dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    bits: *const u8,
    width: i32,
    height: i32,
    buf: Vec<u8>,
    has_image: bool,
    interval: Option<Duration>,
    next_due: Instant,
}

/// Primary monitor in physical pixels (process is per-monitor DPI aware).
pub fn primary_rect() -> RECT {
    unsafe {
        RECT {
            left: 0,
            top: 0,
            right: GetSystemMetrics(SM_CXSCREEN),
            bottom: GetSystemMetrics(SM_CYSCREEN),
        }
    }
}

impl GdiCapturer {
    /// `fps == 0` means unpaced (as fast as BitBlt allows).
    pub fn new(rect: RECT, fps: u32) -> Result<Self, CaptureError> {
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width <= 0 || height <= 0 {
            return Err(CaptureError::NoOutput);
        }
        unsafe {
            let screen_dc = GetDC(None);
            if screen_dc.is_invalid() {
                return Err(CaptureError::Other(windows::core::Error::from_thread()));
            }
            let mem_dc = CreateCompatibleDC(Some(screen_dc));
            if mem_dc.is_invalid() {
                let err = windows::core::Error::from_thread();
                ReleaseDC(None, screen_dc);
                return Err(CaptureError::Other(err));
            }
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height, // negative = top-down rows
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits = std::ptr::null_mut();
            let bitmap = match CreateDIBSection(
                Some(screen_dc),
                &info,
                DIB_RGB_COLORS,
                &mut bits,
                None,
                0,
            ) {
                Ok(b) => b,
                Err(e) => {
                    let _ = DeleteDC(mem_dc);
                    ReleaseDC(None, screen_dc);
                    return Err(CaptureError::from_win(e));
                }
            };
            let previous = SelectObject(mem_dc, bitmap.into());
            Ok(Self {
                rect,
                last_process_ms: 0.0,
                screen_dc,
                mem_dc,
                bitmap,
                previous,
                bits: bits as *const u8,
                width,
                height,
                buf: Vec::new(),
                has_image: false,
                interval: (fps > 0).then(|| Duration::from_secs_f64(1.0 / fps as f64)),
                next_due: Instant::now(),
            })
        }
    }

    pub fn image(&self) -> Option<Image<'_>> {
        self.has_image.then(|| Image {
            width: self.width as u32,
            height: self.height as u32,
            bgra: &self.buf,
        })
    }

    pub fn next_frame(&mut self, timeout_ms: u32) -> Result<FrameStatus, CaptureError> {
        if let Some(interval) = self.interval {
            let now = Instant::now();
            if now < self.next_due {
                std::thread::sleep(
                    (self.next_due - now).min(Duration::from_millis(timeout_ms as u64)),
                );
                if Instant::now() < self.next_due {
                    return Ok(FrameStatus::Timeout);
                }
            }
            // Keep the cadence, but do not try to catch up after a stall.
            self.next_due = (self.next_due + interval).max(Instant::now());
        }

        let started = Instant::now();
        unsafe {
            BitBlt(
                self.mem_dc,
                0,
                0,
                self.width,
                self.height,
                Some(self.screen_dc),
                self.rect.left,
                self.rect.top,
                ROP_CODE(SRCCOPY.0 | CAPTUREBLT.0),
            )
        }
        .map_err(CaptureError::from_win)?;
        unsafe {
            let _ = GdiFlush();
        }
        let len = self.width as usize * self.height as usize * 4;
        self.buf.resize(len, 0);
        // SAFETY: the DIB section is width*height 32-bit pixels, top-down.
        unsafe { std::ptr::copy_nonoverlapping(self.bits, self.buf.as_mut_ptr(), len) };
        self.has_image = true;
        self.last_process_ms = started.elapsed().as_secs_f64() * 1000.0;
        // GDI cannot tell whether anything changed; every blit is a "new" frame.
        Ok(FrameStatus::New)
    }
}

impl Drop for GdiCapturer {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.mem_dc, self.previous);
            let _ = DeleteObject(self.bitmap.into());
            let _ = DeleteDC(self.mem_dc);
            ReleaseDC(None, self.screen_dc);
        }
    }
}
