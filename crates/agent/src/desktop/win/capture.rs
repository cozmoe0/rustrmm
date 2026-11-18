//! Windows screen capture: DXGI Desktop Duplication with dirty and move rectangles, a paced GDI
//! fallback, and pointer tracking, following the input desktop. This is the DXGI spike's proven
//! capture loop (`spikes/dxgi-secure-desktop`) turned into a [`FrameSource`]:
//!
//! * every call polls `OpenInputDesktop` and re-attaches the thread on a change (UAC, lock
//!   screen), dropping the duplication and GDI DCs first but keeping the D3D11 device;
//! * `DuplicateOutput1` (BGRA8) on a device created on the output's adapter; frames with
//!   `LastPresentTime == 0` are pointer-only and never copied;
//! * `DXGI_ERROR_UNSUPPORTED` → one retry, then GDI at 12 fps, with DXGI retried every 10 s;
//!   access-denied style errors are a transition (wait), and after ~2 s on the input desktop
//!   fall back to GDI too;
//! * the cursor comes from `GetCursorInfo` and, when the handle changes, `GetIconInfo`.
//!
//! Every unsafe block is a plain Win32/COM call whose pointers are locals valid for the call.

use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};
use rustrmm_proto::desktop::MonitorInfo;
use windows::Win32::Foundation::{E_ACCESSDENIED, HMODULE, LPARAM, RECT};
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_9_1, D3D_FEATURE_LEVEL_10_0, D3D_FEATURE_LEVEL_10_1,
    D3D_FEATURE_LEVEL_11_0,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ,
    D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_B8G8R8A8_UNORM_SRGB, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, DXGI_ERROR_ACCESS_DENIED, DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_MORE_DATA,
    DXGI_ERROR_NOT_CURRENTLY_AVAILABLE, DXGI_ERROR_NOT_FOUND, DXGI_ERROR_SESSION_DISCONNECTED,
    DXGI_ERROR_UNSUPPORTED, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
    DXGI_OUTDUPL_MOVE_RECT, IDXGIAdapter1, IDXGIFactory1, IDXGIOutput, IDXGIOutput1, IDXGIOutput5,
    IDXGIOutputDuplication, IDXGIResource,
};
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CAPTUREBLT, CreateCompatibleDC,
    CreateDIBSection, DIB_RGB_COLORS, DeleteDC, DeleteObject, EnumDisplayMonitors, GdiFlush, GetDC,
    GetDIBits, GetMonitorInfoW, GetObjectW, HBITMAP, HDC, HGDIOBJ, HMONITOR, MONITORINFO,
    MONITORINFOEXW, RGBQUAD, ROP_CODE, ReleaseDC, SRCCOPY, SelectObject,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::{
    CURSOR_SHOWING, CURSORINFO, GetCursorInfo, GetIconInfo, HICON, ICONINFO, MONITORINFOF_PRIMARY,
};
use windows::core::{BOOL, Interface};

use super::desktop::Follower;
use crate::desktop::cursor::{self, Shape};
use crate::desktop::engine::{Captured, CursorPoll, FrameSource};
use crate::desktop::tiles::{MoveRect, Rect};

const GDI_FPS: u32 = 12;

// ------------------------------------------------------------------ errors

#[derive(Debug)]
enum CaptureError {
    AccessLost,
    Unsupported,
    AccessDenied,
    Transient,
    NoOutput,
    Other(windows::core::Error),
}

impl CaptureError {
    fn from_win(e: windows::core::Error) -> Self {
        let code = e.code();
        if code == DXGI_ERROR_ACCESS_LOST {
            Self::AccessLost
        } else if code == DXGI_ERROR_UNSUPPORTED {
            Self::Unsupported
        } else if code == E_ACCESSDENIED || code == DXGI_ERROR_ACCESS_DENIED {
            Self::AccessDenied
        } else if code == DXGI_ERROR_SESSION_DISCONNECTED
            || code == DXGI_ERROR_NOT_CURRENTLY_AVAILABLE
        {
            Self::Transient
        } else {
            Self::Other(e)
        }
    }
}

impl std::fmt::Display for CaptureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AccessLost => f.write_str("DXGI_ERROR_ACCESS_LOST"),
            Self::Unsupported => f.write_str("DXGI_ERROR_UNSUPPORTED"),
            Self::AccessDenied => f.write_str("access denied"),
            Self::Transient => f.write_str("desktop duplication temporarily unavailable"),
            Self::NoOutput => f.write_str("no matching display output"),
            Self::Other(e) => write!(f, "{e}"),
        }
    }
}

// ------------------------------------------------------------------ monitors

#[derive(Debug, Clone)]
struct Monitor {
    info: MonitorInfo,
    device: String,
    rect: RECT,
}

fn utf16_z(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

unsafe extern "system" fn collect_monitor(
    monitor: HMONITOR,
    _dc: HDC,
    _rect: *mut RECT,
    data: LPARAM,
) -> BOOL {
    // SAFETY: `data` is the address of the Vec passed by `enumerate_monitors`, alive for the
    // duration of EnumDisplayMonitors.
    let list = unsafe { &mut *(data.0 as *mut Vec<HMONITOR>) };
    list.push(monitor);
    BOOL(1)
}

/// The displays of the thread's desktop: primary first, then left to right. Ids are positions
/// in that order.
fn enumerate_monitors() -> Vec<Monitor> {
    let mut handles: Vec<HMONITOR> = Vec::new();
    // SAFETY: the callback only pushes into `handles`, which outlives the call.
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(collect_monitor),
            LPARAM(&mut handles as *mut Vec<HMONITOR> as isize),
        );
    }
    let mut monitors: Vec<Monitor> = handles
        .into_iter()
        .filter_map(|h| {
            let mut info = MONITORINFOEXW {
                monitorInfo: MONITORINFO {
                    cbSize: size_of::<MONITORINFOEXW>() as u32,
                    ..Default::default()
                },
                ..Default::default()
            };
            // SAFETY: cbSize announces the extended structure.
            if !unsafe { GetMonitorInfoW(h, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO) }
                .as_bool()
            {
                return None;
            }
            let rect = info.monitorInfo.rcMonitor;
            let (mut dpi_x, mut dpi_y) = (96u32, 96u32);
            // SAFETY: valid monitor handle and out pointers.
            let _ = unsafe { GetDpiForMonitor(h, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) };
            let device = utf16_z(&info.szDevice);
            Some(Monitor {
                info: MonitorInfo {
                    id: 0,
                    name: device.clone(),
                    x: rect.left,
                    y: rect.top,
                    width: (rect.right - rect.left).max(0) as u32,
                    height: (rect.bottom - rect.top).max(0) as u32,
                    primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
                    scale: dpi_x as f32 / 96.0,
                },
                device,
                rect,
            })
        })
        .filter(|m| m.info.width > 0 && m.info.height > 0)
        .collect();
    monitors.sort_by_key(|m| (!m.info.primary, m.info.x, m.info.y));
    for (i, m) in monitors.iter_mut().enumerate() {
        m.info.id = i as u32;
    }
    monitors
}

// ------------------------------------------------------------------ DXGI

struct OutputEntry {
    adapter: IDXGIAdapter1,
    output: IDXGIOutput,
    device_name: String,
    rect: RECT,
}

fn list_outputs() -> windows::core::Result<Vec<OutputEntry>> {
    // SAFETY: COM factory creation and enumeration; every out value is owned by the wrapper.
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1()? };
    let mut entries = Vec::new();
    for a in 0u32.. {
        let adapter = match unsafe { factory.EnumAdapters1(a) } {
            Ok(adapter) => adapter,
            Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(e) => return Err(e),
        };
        for o in 0u32.. {
            let output = match unsafe { adapter.EnumOutputs(o) } {
                Ok(output) => output,
                Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
                Err(e) => return Err(e),
            };
            let desc = unsafe { output.GetDesc()? };
            if !desc.AttachedToDesktop.as_bool() {
                continue;
            }
            entries.push(OutputEntry {
                adapter: adapter.clone(),
                output,
                device_name: utf16_z(&desc.DeviceName),
                rect: desc.DesktopCoordinates,
            });
        }
    }
    Ok(entries)
}

/// One D3D11 device per adapter, reused across duplications and desktop switches (the spike
/// measured 110–160 ms per device versus ~2 ms per duplication).
#[derive(Default)]
struct DeviceCache {
    entry: Option<(i64, ID3D11Device, ID3D11DeviceContext)>,
    fresh_retry_done: bool,
}

impl DeviceCache {
    fn get(
        &mut self,
        adapter: &IDXGIAdapter1,
    ) -> Result<(ID3D11Device, ID3D11DeviceContext, bool), CaptureError> {
        // SAFETY: plain COM getter.
        let desc = unsafe { adapter.GetDesc1() }.map_err(CaptureError::from_win)?;
        let luid =
            (i64::from(desc.AdapterLuid.HighPart) << 32) | i64::from(desc.AdapterLuid.LowPart);
        if let Some((cached, device, context)) = &self.entry {
            // SAFETY: plain COM call on a live device.
            let removed = unsafe { device.GetDeviceRemovedReason() }.is_err();
            if *cached == luid && !removed {
                return Ok((device.clone(), context.clone(), true));
            }
        }
        let (device, context) = create_device(adapter)?;
        self.entry = Some((luid, device.clone(), context.clone()));
        Ok((device, context, false))
    }

    fn invalidate(&mut self) {
        self.entry = None;
    }
}

fn create_device(
    adapter: &IDXGIAdapter1,
) -> Result<(ID3D11Device, ID3D11DeviceContext), CaptureError> {
    let levels = [
        D3D_FEATURE_LEVEL_11_0,
        D3D_FEATURE_LEVEL_10_1,
        D3D_FEATURE_LEVEL_10_0,
        D3D_FEATURE_LEVEL_9_1,
    ];
    let mut device = None;
    let mut context = None;
    // SAFETY: out pointers are locals; the adapter outlives the call.
    unsafe {
        D3D11CreateDevice(
            adapter,
            D3D_DRIVER_TYPE_UNKNOWN,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
    }
    .map_err(CaptureError::from_win)?;
    match (device, context) {
        (Some(d), Some(c)) => Ok((d, c)),
        _ => Err(CaptureError::NoOutput),
    }
}

fn duplicate(
    output: &IDXGIOutput,
    device: &ID3D11Device,
) -> Result<IDXGIOutputDuplication, CaptureError> {
    if let Ok(output5) = output.cast::<IDXGIOutput5>() {
        // SAFETY: plain COM call; the format slice outlives it.
        match unsafe { output5.DuplicateOutput1(device, 0, &[DXGI_FORMAT_B8G8R8A8_UNORM]) } {
            Ok(d) => return Ok(d),
            Err(e) => {
                let err = CaptureError::from_win(e);
                if matches!(err, CaptureError::AccessDenied | CaptureError::Transient) {
                    return Err(err);
                }
            }
        }
    }
    let output1: IDXGIOutput1 = output.cast().map_err(CaptureError::from_win)?;
    // SAFETY: plain COM call.
    unsafe { output1.DuplicateOutput(device) }.map_err(CaptureError::from_win)
}

enum Frame {
    New {
        dirty: Option<Vec<Rect>>,
        moves: Vec<MoveRect>,
    },
    Unchanged,
}

struct DxgiCapturer {
    context: ID3D11DeviceContext,
    device: ID3D11Device,
    duplication: IDXGIOutputDuplication,
    staging: Option<(ID3D11Texture2D, u32, u32)>,
    holding: bool,
    width: u32,
    height: u32,
    buf: Vec<u8>,
    has_image: bool,
    /// The first image of a duplication has no usable dirty rectangles.
    fresh: bool,
    metadata: Vec<u8>,
}

impl DxgiCapturer {
    fn new(monitor: &Monitor, devices: &mut DeviceCache) -> Result<Self, CaptureError> {
        let entries = list_outputs().map_err(CaptureError::from_win)?;
        let entry = entries
            .into_iter()
            .find(|e| {
                e.device_name.eq_ignore_ascii_case(&monitor.device)
                    || (e.rect.left == monitor.rect.left && e.rect.top == monitor.rect.top)
            })
            .ok_or(CaptureError::NoOutput)?;
        let (mut device, mut context, reused) = devices.get(&entry.adapter)?;
        let mut duplicated = duplicate(&entry.output, &device);
        if reused
            && !devices.fresh_retry_done
            && matches!(
                duplicated,
                Err(CaptureError::AccessDenied | CaptureError::Unsupported)
            )
        {
            // Rule out desktop affinity of a reused device once.
            devices.fresh_retry_done = true;
            devices.invalidate();
            let (d, c, _) = devices.get(&entry.adapter)?;
            duplicated = duplicate(&entry.output, &d);
            device = d;
            context = c;
        }
        let duplication = duplicated?;
        devices.fresh_retry_done = false;
        // SAFETY: plain COM getter.
        let desc = unsafe { duplication.GetDesc() };
        // Rotated outputs come in panel orientation; GDI gives the right one.
        if desc.Rotation.0 > 1 {
            return Err(CaptureError::Unsupported);
        }
        Ok(Self {
            context,
            device,
            duplication,
            staging: None,
            holding: false,
            width: 0,
            height: 0,
            buf: Vec::new(),
            has_image: false,
            fresh: true,
            metadata: Vec::new(),
        })
    }

    fn release(&mut self) {
        if self.holding {
            // SAFETY: a frame is held by this duplication.
            let _ = unsafe { self.duplication.ReleaseFrame() };
            self.holding = false;
        }
    }

    fn next(&mut self, timeout: Duration) -> Result<Frame, CaptureError> {
        self.release();
        let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut resource: Option<IDXGIResource> = None;
        let ms = u32::try_from(timeout.as_millis()).unwrap_or(100);
        // SAFETY: out pointers are locals.
        if let Err(e) = unsafe {
            self.duplication
                .AcquireNextFrame(ms, &mut info, &mut resource)
        } {
            if e.code() == DXGI_ERROR_WAIT_TIMEOUT {
                return Ok(Frame::Unchanged);
            }
            return Err(CaptureError::from_win(e));
        }
        self.holding = true;
        // LastPresentTime == 0: only the pointer changed and the surface is not valid (the very
        // first acquire after duplicating is such a frame, with an all-black surface).
        let Some(resource) = resource else {
            return Ok(Frame::Unchanged);
        };
        if info.LastPresentTime == 0 {
            return Ok(Frame::Unchanged);
        }
        let (dirty, moves) = if self.fresh {
            (None, Vec::new())
        } else {
            self.metadata(info.TotalMetadataBufferSize)
        };
        let texture: ID3D11Texture2D = resource.cast().map_err(CaptureError::from_win)?;
        drop(resource);
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        // SAFETY: out pointer is a local.
        unsafe { texture.GetDesc(&mut desc) };
        if desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM
            && desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM_SRGB
        {
            return Err(CaptureError::Unsupported);
        }
        let staging = self.staging_for(&desc)?;
        // SAFETY: both textures belong to this device and have the same size and format.
        unsafe { self.context.CopyResource(&staging, &texture) };
        drop(texture);
        // Hand the surface back to DWM as soon as the copy is queued.
        self.release();
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        // SAFETY: the staging texture is CPU-readable; `mapped` is a local.
        unsafe {
            self.context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
        }
        .map_err(CaptureError::from_win)?;
        let row = desc.Width as usize * 4;
        let rows = desc.Height as usize;
        self.buf.resize(row * rows, 0);
        let src = mapped.pData as *const u8;
        for y in 0..rows {
            // SAFETY: Map returned `rows` rows of RowPitch >= row bytes; `buf` holds rows * row.
            unsafe {
                std::ptr::copy_nonoverlapping(
                    src.add(y * mapped.RowPitch as usize),
                    self.buf.as_mut_ptr().add(y * row),
                    row,
                );
            }
        }
        // SAFETY: mapped above.
        unsafe { self.context.Unmap(&staging, 0) };
        let resized = (self.width, self.height) != (desc.Width, desc.Height);
        self.width = desc.Width;
        self.height = desc.Height;
        self.has_image = true;
        self.fresh = false;
        Ok(Frame::New {
            dirty: if resized { None } else { dirty },
            moves: if resized { Vec::new() } else { moves },
        })
    }

    /// Move and dirty rectangles of the held frame (`None` dirty when unavailable).
    fn metadata(&mut self, total: u32) -> (Option<Vec<Rect>>, Vec<MoveRect>) {
        if total == 0 {
            return (Some(Vec::new()), Vec::new());
        }
        self.metadata.resize(total as usize, 0);
        let mut moves = Vec::new();
        let mut needed = 0u32;
        // SAFETY: the buffer holds `total` bytes, suitably aligned for DXGI_OUTDUPL_MOVE_RECT
        // reads via read_unaligned below.
        let got = unsafe {
            self.duplication.GetFrameMoveRects(
                total,
                self.metadata.as_mut_ptr().cast::<DXGI_OUTDUPL_MOVE_RECT>(),
                &mut needed,
            )
        };
        match got {
            Ok(()) => {
                let n = needed as usize / size_of::<DXGI_OUTDUPL_MOVE_RECT>();
                for i in 0..n {
                    // SAFETY: `i < n` items were written into the buffer.
                    let m: DXGI_OUTDUPL_MOVE_RECT = unsafe {
                        std::ptr::read_unaligned(
                            self.metadata
                                .as_ptr()
                                .cast::<DXGI_OUTDUPL_MOVE_RECT>()
                                .add(i),
                        )
                    };
                    let d = m.DestinationRect;
                    if m.SourcePoint.x < 0 || m.SourcePoint.y < 0 || d.left < 0 || d.top < 0 {
                        continue;
                    }
                    moves.push(MoveRect {
                        src_x: m.SourcePoint.x as u32,
                        src_y: m.SourcePoint.y as u32,
                        dst: Rect::new(
                            d.left as u32,
                            d.top as u32,
                            (d.right - d.left).max(0) as u32,
                            (d.bottom - d.top).max(0) as u32,
                        ),
                    });
                }
            }
            Err(e) if e.code() == DXGI_ERROR_MORE_DATA => return (None, Vec::new()),
            Err(_) => return (None, Vec::new()),
        }
        let mut needed = 0u32;
        // SAFETY: as above, for RECTs.
        let got = unsafe {
            self.duplication.GetFrameDirtyRects(
                total,
                self.metadata.as_mut_ptr().cast::<RECT>(),
                &mut needed,
            )
        };
        if got.is_err() {
            return (None, Vec::new());
        }
        let n = needed as usize / size_of::<RECT>();
        let mut dirty = Vec::with_capacity(n);
        for i in 0..n {
            // SAFETY: `i < n` RECTs were written.
            let r: RECT =
                unsafe { std::ptr::read_unaligned(self.metadata.as_ptr().cast::<RECT>().add(i)) };
            if r.right > r.left && r.bottom > r.top && r.left >= 0 && r.top >= 0 {
                dirty.push(Rect::new(
                    r.left as u32,
                    r.top as u32,
                    (r.right - r.left) as u32,
                    (r.bottom - r.top) as u32,
                ));
            }
        }
        (Some(dirty), moves)
    }

    fn staging_for(&mut self, src: &D3D11_TEXTURE2D_DESC) -> Result<ID3D11Texture2D, CaptureError> {
        if let Some((texture, w, h)) = &self.staging
            && *w == src.Width
            && *h == src.Height
        {
            return Ok(texture.clone());
        }
        let desc = D3D11_TEXTURE2D_DESC {
            Width: src.Width,
            Height: src.Height,
            MipLevels: 1,
            ArraySize: 1,
            Format: src.Format,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut texture = None;
        // SAFETY: valid description; out pointer is a local.
        unsafe { self.device.CreateTexture2D(&desc, None, Some(&mut texture)) }
            .map_err(CaptureError::from_win)?;
        let texture = texture.ok_or(CaptureError::NoOutput)?;
        self.staging = Some((texture.clone(), src.Width, src.Height));
        Ok(texture)
    }
}

impl Drop for DxgiCapturer {
    fn drop(&mut self) {
        self.release();
    }
}

// ------------------------------------------------------------------ GDI

/// `BitBlt` from the thread desktop's screen DC into a DIB section, paced. The DC belongs to the
/// desktop, so the capturer is dropped before every `SetThreadDesktop`.
struct GdiCapturer {
    rect: RECT,
    screen_dc: HDC,
    mem_dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    bits: *const u8,
    width: i32,
    height: i32,
    buf: Vec<u8>,
    has_image: bool,
    interval: Duration,
    next_due: Instant,
}

impl GdiCapturer {
    fn new(rect: RECT) -> Result<Self, CaptureError> {
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width <= 0 || height <= 0 {
            return Err(CaptureError::NoOutput);
        }
        // SAFETY: GDI objects created here are owned by the capturer and freed in Drop; every
        // failure path frees what was created so far.
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
                    biHeight: -height,
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
                screen_dc,
                mem_dc,
                bitmap,
                previous,
                bits: bits as *const u8,
                width,
                height,
                buf: Vec::new(),
                has_image: false,
                interval: Duration::from_secs_f64(1.0 / f64::from(GDI_FPS)),
                next_due: Instant::now(),
            })
        }
    }

    fn next(&mut self, timeout: Duration) -> Result<Frame, CaptureError> {
        let now = Instant::now();
        if now < self.next_due {
            std::thread::sleep((self.next_due - now).min(timeout));
            if Instant::now() < self.next_due {
                return Ok(Frame::Unchanged);
            }
        }
        self.next_due = (self.next_due + self.interval).max(Instant::now());
        // SAFETY: both DCs are valid; the DIB is `width`×`height` 32-bit pixels.
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
        // SAFETY: flushes pending GDI work so the DIB bits are complete.
        unsafe {
            let _ = GdiFlush();
        }
        let len = self.width as usize * self.height as usize * 4;
        self.buf.resize(len, 0);
        // SAFETY: the DIB section holds `len` bytes, top-down.
        unsafe { std::ptr::copy_nonoverlapping(self.bits, self.buf.as_mut_ptr(), len) };
        self.has_image = true;
        // GDI cannot tell what changed; the engine compares every tile.
        Ok(Frame::New {
            dirty: None,
            moves: Vec::new(),
        })
    }
}

impl Drop for GdiCapturer {
    fn drop(&mut self) {
        // SAFETY: objects created in `new`, released exactly once.
        unsafe {
            SelectObject(self.mem_dc, self.previous);
            let _ = DeleteObject(self.bitmap.into());
            let _ = DeleteDC(self.mem_dc);
            ReleaseDC(None, self.screen_dc);
        }
    }
}

enum Capturer {
    Dxgi(DxgiCapturer),
    Gdi(GdiCapturer),
}

impl Capturer {
    fn image(&self) -> Option<(&[u8], u32, u32)> {
        match self {
            Self::Dxgi(c) => c.has_image.then_some((&c.buf[..], c.width, c.height)),
            Self::Gdi(c) => c
                .has_image
                .then_some((&c.buf[..], c.width as u32, c.height as u32)),
        }
    }
}

// ------------------------------------------------------------------ cursor

#[derive(Default)]
struct CursorTracker {
    last_handle: isize,
}

impl CursorTracker {
    fn poll(&mut self, origin: (i32, i32)) -> Option<CursorPoll> {
        let mut info = CURSORINFO {
            cbSize: size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        // SAFETY: cbSize is set; out pointer is a local.
        unsafe { GetCursorInfo(&mut info) }.ok()?;
        let visible = info.flags.0 & CURSOR_SHOWING.0 != 0;
        let handle = info.hCursor.0 as isize;
        let shape = if visible && handle != 0 && handle != self.last_handle {
            let shape = cursor_shape(HICON(info.hCursor.0));
            if shape.is_some() {
                self.last_handle = handle;
            }
            shape
        } else {
            None
        };
        Some(CursorPoll {
            x: info.ptScreenPos.x - origin.0,
            y: info.ptScreenPos.y - origin.1,
            visible,
            shape,
        })
    }
}

/// `BITMAPINFO` with room for the two-entry colour table of a 1 bpp bitmap.
#[repr(C)]
struct MonoInfo {
    header: BITMAPINFOHEADER,
    colors: [RGBQUAD; 2],
}

fn read_bits(dc: HDC, bitmap: HBITMAP, width: i32, height: i32, bpp: u16) -> Option<Vec<u8>> {
    let pitch = ((width as usize * bpp as usize).div_ceil(32)) * 4;
    let mut buf = vec![0u8; pitch * height as usize];
    let mut info = MonoInfo {
        header: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: bpp,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        colors: [RGBQUAD::default(); 2],
    };
    // SAFETY: `buf` holds `height` rows of `pitch` bytes; `info` has room for the colour table.
    let lines = unsafe {
        GetDIBits(
            dc,
            bitmap,
            0,
            height as u32,
            Some(buf.as_mut_ptr().cast()),
            &mut info as *mut MonoInfo as *mut BITMAPINFO,
            DIB_RGB_COLORS,
        )
    };
    (lines == height).then_some(buf)
}

fn cursor_shape(icon: HICON) -> Option<Shape> {
    let mut ii = ICONINFO::default();
    // SAFETY: out pointer is a local; the returned bitmaps are deleted below.
    unsafe { GetIconInfo(icon, &mut ii) }.ok()?;
    let result = (|| {
        let mut bm = BITMAP::default();
        // SAFETY: valid bitmap handle; `bm` is sized for the call.
        let got = unsafe {
            GetObjectW(
                ii.hbmMask.into(),
                size_of::<BITMAP>() as i32,
                Some(&mut bm as *mut BITMAP as *mut _),
            )
        };
        if got == 0 {
            return None;
        }
        // SAFETY: screen DC acquired and released around the reads (no lasting desktop binding).
        let dc = unsafe { GetDC(None) };
        let shape = if !ii.hbmColor.is_invalid() {
            let (w, h) = (bm.bmWidth, bm.bmHeight);
            let color = read_bits(dc, ii.hbmColor, w, h, 32);
            let mask = read_bits(dc, ii.hbmMask, w, h, 1);
            color
                .map(|c| {
                    let mask_pitch = (w as usize).div_ceil(32) * 4;
                    cursor::bgra_to_rgba(
                        &c,
                        w as usize,
                        h as usize,
                        w as usize * 4,
                        mask.as_deref().map(|m| (m, mask_pitch)),
                    )
                })
                .map(|rgba| (w, h, rgba))
        } else {
            // Monochrome: the mask bitmap holds AND then XOR, so it is twice the cursor height.
            let (w, h2) = (bm.bmWidth, bm.bmHeight);
            read_bits(dc, ii.hbmMask, w, h2, 1).map(|m| {
                let pitch = (w as usize).div_ceil(32) * 4;
                (
                    w,
                    h2 / 2,
                    cursor::mono_to_rgba(&m, w as usize, (h2 / 2) as usize, pitch),
                )
            })
        };
        // SAFETY: acquired above.
        unsafe { ReleaseDC(None, dc) };
        let (w, h, rgba) = shape?;
        Some(Shape {
            hot_x: ii.xHotspot as u16,
            hot_y: ii.yHotspot as u16,
            width: w as u16,
            height: h as u16,
            rgba,
        })
    })();
    // SAFETY: GetIconInfo created these bitmaps for us.
    unsafe {
        if !ii.hbmColor.is_invalid() {
            let _ = DeleteObject(ii.hbmColor.into());
        }
        if !ii.hbmMask.is_invalid() {
            let _ = DeleteObject(ii.hbmMask.into());
        }
    }
    result
}

// ------------------------------------------------------------------ the source

#[derive(Default)]
struct Retry {
    unsupported: u32,
    denied: u32,
    retry_at: Option<Instant>,
}

/// DXGI (or GDI) capture of one monitor of the input desktop.
pub struct WinSource {
    follower: Follower,
    capturer: Option<Capturer>,
    devices: DeviceCache,
    retry: Retry,
    monitors: Vec<Monitor>,
    active: u32,
    cursor: CursorTracker,
    force_gdi: bool,
    /// Last image, kept across capturer changes so the engine always has a frame.
    method: &'static str,
}

impl WinSource {
    /// Must be called on the thread that will capture (it binds to that thread's desktop).
    pub fn new(force_gdi: bool) -> Result<Self> {
        let mut follower = Follower::new();
        follower.follow(|| {});
        let monitors = enumerate_monitors();
        if monitors.is_empty() {
            return Err(anyhow!("no display is attached to this session"));
        }
        Ok(Self {
            follower,
            capturer: None,
            devices: DeviceCache::default(),
            retry: Retry::default(),
            monitors,
            active: 0,
            cursor: CursorTracker::default(),
            force_gdi,
            method: "dxgi",
        })
    }

    fn monitor(&self) -> Option<&Monitor> {
        self.monitors
            .iter()
            .find(|m| m.info.id == self.active)
            .or_else(|| self.monitors.first())
    }

    /// Creates a capturer; `None` means "waited, try again".
    fn create(&mut self) -> Option<Capturer> {
        let monitor = self.monitor()?.clone();
        if !self.force_gdi && self.retry.retry_at.is_none_or(|t| Instant::now() >= t) {
            match DxgiCapturer::new(&monitor, &mut self.devices) {
                Ok(c) => {
                    self.retry = Retry::default();
                    self.method = "dxgi";
                    return Some(Capturer::Dxgi(c));
                }
                Err(CaptureError::Unsupported) => {
                    self.retry.unsupported += 1;
                    if self.retry.unsupported == 1 {
                        std::thread::sleep(Duration::from_millis(250));
                        return None;
                    }
                    tracing::info!(desktop = %self.follower.current, "desktop duplication unsupported; using GDI");
                    self.retry.retry_at = Some(Instant::now() + Duration::from_secs(10));
                }
                Err(e @ (CaptureError::AccessDenied | CaptureError::Transient)) => {
                    self.retry.denied += 1;
                    if self.retry.denied < 8 {
                        // A transition: not yet on the new input desktop.
                        std::thread::sleep(Duration::from_millis(250));
                        return None;
                    }
                    tracing::info!(desktop = %self.follower.current, error = %e, "desktop duplication refused; using GDI");
                    self.retry.denied = 0;
                    self.retry.retry_at = Some(Instant::now() + Duration::from_secs(10));
                }
                Err(e) => {
                    self.devices.invalidate();
                    tracing::info!(error = %e, "desktop duplication failed; using GDI");
                    self.retry.retry_at = Some(Instant::now() + Duration::from_secs(5));
                }
            }
        }
        match GdiCapturer::new(monitor.rect) {
            Ok(c) => {
                self.method = "gdi";
                Some(Capturer::Gdi(c))
            }
            Err(e) => {
                tracing::warn!(error = %e, "GDI capture failed");
                std::thread::sleep(Duration::from_millis(500));
                None
            }
        }
    }
}

impl FrameSource for WinSource {
    fn method(&self) -> &'static str {
        self.method
    }

    fn monitors(&self) -> Vec<MonitorInfo> {
        self.monitors.iter().map(|m| m.info.clone()).collect()
    }

    fn active_monitor(&self) -> u32 {
        self.monitor().map(|m| m.info.id).unwrap_or(0)
    }

    fn select_monitor(&mut self, id: u32) -> Result<()> {
        let fresh = enumerate_monitors();
        if !fresh.is_empty() {
            self.monitors = fresh;
        }
        if !self.monitors.iter().any(|m| m.info.id == id) {
            return Err(anyhow!("no monitor with id {id}"));
        }
        self.active = id;
        self.capturer = None;
        Ok(())
    }

    fn capture(&mut self, timeout: Duration) -> Result<Captured> {
        // 1. Follow the input desktop.
        let capturer = &mut self.capturer;
        if self.follower.follow(|| *capturer = None) {
            self.retry = Retry::default();
            let fresh = enumerate_monitors();
            if !fresh.is_empty() {
                self.monitors = fresh;
            }
        }
        // 2. On GDI, give DXGI another chance when the retry timer fires.
        if matches!(self.capturer, Some(Capturer::Gdi(_)))
            && !self.force_gdi
            && self.retry.retry_at.is_some_and(|t| Instant::now() >= t)
        {
            self.capturer = None;
        }
        // 3. Ensure a capturer.
        if self.capturer.is_none() {
            match self.create() {
                Some(c) => self.capturer = Some(c),
                None => return Ok(Captured::Idle),
            }
        }
        let result = match self.capturer.as_mut() {
            Some(Capturer::Dxgi(c)) => c.next(timeout),
            Some(Capturer::Gdi(c)) => c.next(timeout),
            None => return Ok(Captured::Idle),
        };
        match result {
            Ok(Frame::New { dirty, moves }) => Ok(Captured::Frame { dirty, moves }),
            Ok(Frame::Unchanged) => Ok(Captured::Idle),
            Err(CaptureError::AccessLost) => {
                // Desktop switch or mode change: recreate (cheap with the cached device).
                self.capturer = None;
                Ok(Captured::Idle)
            }
            Err(e) => {
                tracing::debug!(error = %e, "capture error; recreating");
                self.capturer = None;
                self.devices.invalidate();
                std::thread::sleep(Duration::from_millis(200));
                Ok(Captured::Idle)
            }
        }
    }

    fn image(&self) -> Option<(&[u8], u32, u32)> {
        self.capturer.as_ref().and_then(Capturer::image)
    }

    fn cursor(&mut self) -> Option<CursorPoll> {
        let origin = self
            .monitor()
            .map(|m| (m.info.x, m.info.y))
            .unwrap_or((0, 0));
        self.cursor.poll(origin)
    }

    fn desktop(&self) -> String {
        self.follower.current.clone()
    }
}
