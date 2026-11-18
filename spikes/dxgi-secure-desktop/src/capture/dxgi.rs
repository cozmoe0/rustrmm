//! DXGI Desktop Duplication (`IDXGIOutput1::DuplicateOutput` /
//! `IDXGIOutput5::DuplicateOutput1`) on a D3D11 device created on the
//! adapter that owns the output (required on hybrid-GPU laptops, otherwise
//! DuplicateOutput fails with DXGI_ERROR_UNSUPPORTED).

use std::time::Instant;

use windows::Win32::Foundation::{HMODULE, RECT};
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
    CreateDXGIFactory1, DXGI_ERROR_NOT_FOUND, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
    IDXGIAdapter1, IDXGIFactory1, IDXGIOutput, IDXGIOutput1, IDXGIOutput5, IDXGIOutputDuplication,
    IDXGIResource,
};
use windows::core::Interface;

use super::{CaptureError, FrameStatus, Image};

#[derive(Clone, Debug)]
pub struct OutputInfo {
    pub index: usize,
    pub adapter_name: String,
    pub device_name: String,
    pub rect: RECT,
    pub attached: bool,
    pub rotation: i32,
}

impl OutputInfo {
    pub fn is_primary(&self) -> bool {
        self.attached && self.rect.left == 0 && self.rect.top == 0
    }
}

pub struct OutputEntry {
    pub adapter: IDXGIAdapter1,
    pub output: IDXGIOutput,
    pub info: OutputInfo,
}

fn utf16_z(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

pub fn list_outputs() -> windows::core::Result<Vec<OutputEntry>> {
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1()? };
    let mut entries = Vec::new();
    for a in 0u32.. {
        let adapter = match unsafe { factory.EnumAdapters1(a) } {
            Ok(adapter) => adapter,
            Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(e) => return Err(e),
        };
        let adapter_name = utf16_z(&unsafe { adapter.GetDesc1()? }.Description);
        for o in 0u32.. {
            let output = match unsafe { adapter.EnumOutputs(o) } {
                Ok(output) => output,
                Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
                Err(e) => return Err(e),
            };
            let desc = unsafe { output.GetDesc()? };
            let info = OutputInfo {
                index: entries.len(),
                adapter_name: adapter_name.clone(),
                device_name: utf16_z(&desc.DeviceName),
                rect: desc.DesktopCoordinates,
                attached: desc.AttachedToDesktop.as_bool(),
                rotation: desc.Rotation.0,
            };
            entries.push(OutputEntry {
                adapter: adapter.clone(),
                output,
                info,
            });
        }
    }
    Ok(entries)
}

/// Explicit index, else the primary output, else the first attached one.
pub fn pick_output(entries: Vec<OutputEntry>, want: Option<usize>) -> Option<OutputEntry> {
    let index = match want {
        Some(i) => i,
        None => entries
            .iter()
            .position(|e| e.info.is_primary())
            .or_else(|| entries.iter().position(|e| e.info.attached))?,
    };
    entries.into_iter().nth(index)
}

/// One D3D11 device per adapter, reused across duplications and desktop
/// switches. Measured here: D3D11CreateDevice 110-160 ms, DuplicateOutput1
/// ~2 ms, so recreating only the duplication makes desktop switches cheap.
#[derive(Default)]
pub struct DeviceCache {
    entry: Option<CachedDevice>,
    /// A reused device that fails to duplicate is replaced once, to rule out
    /// desktop affinity of the device itself; reset after a success.
    fresh_retry_done: bool,
}

struct CachedDevice {
    luid: (u32, i32),
    device: ID3D11Device,
    context: ID3D11DeviceContext,
}

impl DeviceCache {
    /// Returns (device, context, reused).
    fn get(
        &mut self,
        adapter: &IDXGIAdapter1,
    ) -> Result<(ID3D11Device, ID3D11DeviceContext, bool), CaptureError> {
        let desc = unsafe { adapter.GetDesc1() }.map_err(CaptureError::from_win)?;
        let luid = (desc.AdapterLuid.LowPart, desc.AdapterLuid.HighPart);
        if let Some(cached) = &self.entry {
            let removed = unsafe { cached.device.GetDeviceRemovedReason() }.is_err();
            if cached.luid == luid && !removed {
                return Ok((cached.device.clone(), cached.context.clone(), true));
            }
            if removed {
                log!("dxgi: cached device was removed; creating a new one");
            }
        }
        let (device, context) = create_device(adapter)?;
        self.entry = Some(CachedDevice {
            luid,
            device: device.clone(),
            context: context.clone(),
        });
        Ok((device, context, false))
    }

    pub fn invalidate(&mut self) {
        self.entry = None;
    }
}

fn outcome<T>(result: &Result<T, CaptureError>) -> String {
    match result {
        Ok(_) => "ok".into(),
        Err(e) => e.to_string(),
    }
}

pub struct DxgiCapturer {
    pub last_process_ms: f64,
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    duplication: IDXGIOutputDuplication,
    staging: Option<(ID3D11Texture2D, u32, u32)>,
    holding_frame: bool,
    width: u32,
    height: u32,
    buf: Vec<u8>,
    has_image: bool,
    acquired: u32,
}

impl DxgiCapturer {
    pub fn new(want: Option<usize>, devices: &mut DeviceCache) -> Result<Self, CaptureError> {
        let ms = |a: Instant, b: Instant| (b - a).as_secs_f64() * 1000.0;
        let t0 = Instant::now();
        let entries = list_outputs().map_err(CaptureError::from_win)?;
        let entry = pick_output(entries, want).ok_or(CaptureError::NoOutput)?;
        let t1 = Instant::now();
        let (mut device, mut context, reused) = devices.get(&entry.adapter)?;
        let t2 = Instant::now();
        let mut duplicated = duplicate(&entry.output, &device);
        let t3 = Instant::now();
        log!(
            "dxgi: setup: enumerate {:.1} ms, device {} {:.1} ms, duplicate {:.1} ms -> {}",
            ms(t0, t1),
            if reused { "reused" } else { "created" },
            ms(t1, t2),
            ms(t2, t3),
            outcome(&duplicated)
        );
        if reused
            && !devices.fresh_retry_done
            && matches!(
                &duplicated,
                Err(CaptureError::AccessDenied | CaptureError::Unsupported)
            )
        {
            devices.fresh_retry_done = true;
            devices.invalidate();
            let (fresh_device, fresh_context, _) = devices.get(&entry.adapter)?;
            duplicated = duplicate(&entry.output, &fresh_device);
            log!(
                "dxgi: retried with a freshly created device -> {}",
                outcome(&duplicated)
            );
            device = fresh_device;
            context = fresh_context;
        }
        let (duplication, via1) = duplicated?;
        devices.fresh_retry_done = false;
        let desc = unsafe { duplication.GetDesc() };
        log!(
            "dxgi: duplicating output #{} {} on '{}' ({}x{} @ {}/{} Hz, rotation {}, format {}, image in system memory {}) via {}",
            entry.info.index,
            entry.info.device_name,
            entry.info.adapter_name,
            desc.ModeDesc.Width,
            desc.ModeDesc.Height,
            desc.ModeDesc.RefreshRate.Numerator,
            desc.ModeDesc.RefreshRate.Denominator.max(1),
            desc.Rotation.0,
            desc.ModeDesc.Format.0,
            desc.DesktopImageInSystemMemory.as_bool(),
            if via1 {
                "DuplicateOutput1"
            } else {
                "DuplicateOutput"
            },
        );
        if desc.Rotation.0 > 1 {
            log!(
                "dxgi: output is rotated; frames are in the panel's native orientation and need rotating"
            );
        }
        Ok(Self {
            last_process_ms: 0.0,
            device,
            context,
            duplication,
            staging: None,
            holding_frame: false,
            width: 0,
            height: 0,
            buf: Vec::new(),
            has_image: false,
            acquired: 0,
        })
    }

    pub fn image(&self) -> Option<Image<'_>> {
        self.has_image.then(|| Image {
            width: self.width,
            height: self.height,
            bgra: &self.buf,
        })
    }

    fn release_frame(&mut self) {
        if self.holding_frame {
            let _ = unsafe { self.duplication.ReleaseFrame() };
            self.holding_frame = false;
        }
    }

    pub fn next_frame(&mut self, timeout_ms: u32) -> Result<FrameStatus, CaptureError> {
        self.release_frame();
        let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut resource: Option<IDXGIResource> = None;
        if let Err(e) = unsafe {
            self.duplication
                .AcquireNextFrame(timeout_ms, &mut info, &mut resource)
        } {
            if e.code() == DXGI_ERROR_WAIT_TIMEOUT {
                return Ok(FrameStatus::Timeout);
            }
            return Err(CaptureError::from_win(e));
        }
        self.holding_frame = true;
        self.acquired += 1;
        if self.acquired <= 3 {
            log!(
                "dxgi: acquire #{}: LastPresentTime={} AccumulatedFrames={} LastMouseUpdateTime={} metadata={} B resource={}",
                self.acquired,
                info.LastPresentTime,
                info.AccumulatedFrames,
                info.LastMouseUpdateTime,
                info.TotalMetadataBufferSize,
                resource.is_some()
            );
        }

        // LastPresentTime == 0: only the pointer changed and the surface is
        // NOT valid. Observed: the very first acquire after DuplicateOutput1
        // is such a pointer-only frame with an all-black surface; the real
        // full-desktop image follows a few ms later. Never copy these.
        let Some(resource) = resource else {
            return Ok(FrameStatus::PointerOnly);
        };
        if info.LastPresentTime == 0 {
            return Ok(FrameStatus::PointerOnly);
        }

        let started = Instant::now();
        let texture: ID3D11Texture2D = resource.cast().map_err(CaptureError::from_win)?;
        drop(resource);
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { texture.GetDesc(&mut desc) };
        if desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM
            && desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM_SRGB
        {
            return Err(CaptureError::UnexpectedFormat(desc.Format.0));
        }
        let staging = self.staging_for(&desc)?;
        unsafe { self.context.CopyResource(&staging, &texture) };
        drop(texture);
        // Hand the surface back to DWM as soon as the copy is queued.
        self.release_frame();

        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
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
            // SAFETY: Map returned a readable surface of `rows` rows of
            // RowPitch >= row bytes; `buf` holds rows * row bytes.
            unsafe {
                std::ptr::copy_nonoverlapping(
                    src.add(y * mapped.RowPitch as usize),
                    self.buf.as_mut_ptr().add(y * row),
                    row,
                );
            }
        }
        unsafe { self.context.Unmap(&staging, 0) };

        self.width = desc.Width;
        self.height = desc.Height;
        self.has_image = true;
        self.last_process_ms = started.elapsed().as_secs_f64() * 1000.0;
        Ok(FrameStatus::New)
    }

    /// CPU-readable copy target, recreated if the desktop size changes.
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
        unsafe { self.device.CreateTexture2D(&desc, None, Some(&mut texture)) }
            .map_err(CaptureError::from_win)?;
        let texture = texture.ok_or(CaptureError::NoOutput)?;
        self.staging = Some((texture.clone(), src.Width, src.Height));
        Ok(texture)
    }
}

impl Drop for DxgiCapturer {
    fn drop(&mut self) {
        self.release_frame();
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

/// Prefers `DuplicateOutput1` (Windows 10 1703+): it lets us ask for BGRA8,
/// which keeps HDR / FP16 desktops readable. Falls back to `DuplicateOutput`.
fn duplicate(
    output: &IDXGIOutput,
    device: &ID3D11Device,
) -> Result<(IDXGIOutputDuplication, bool), CaptureError> {
    if let Ok(output5) = output.cast::<IDXGIOutput5>() {
        match unsafe { output5.DuplicateOutput1(device, 0, &[DXGI_FORMAT_B8G8R8A8_UNORM]) } {
            Ok(duplication) => return Ok((duplication, true)),
            Err(e) => {
                let err = CaptureError::from_win(e);
                // Permission / transition errors are not fixed by the older API.
                if matches!(
                    err,
                    CaptureError::AccessDenied
                        | CaptureError::SessionDisconnected
                        | CaptureError::NotCurrentlyAvailable
                ) {
                    return Err(err);
                }
                log!("dxgi: DuplicateOutput1 failed ({err}); trying DuplicateOutput");
            }
        }
    }
    let output1: IDXGIOutput1 = output.cast().map_err(CaptureError::from_win)?;
    let duplication = unsafe { output1.DuplicateOutput(device) }.map_err(CaptureError::from_win)?;
    Ok((duplication, false))
}
