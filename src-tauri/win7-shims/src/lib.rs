//! Windows 7 compatibility stubs shared by the desktop app and the kb-mcp sidecar.
//!
//! 这些函数在 Windows 8+ 由系统 DLL 提供，Windows 7 上不存在。启用 `win7-compat`
//! feature 时通过 `#[no_mangle]` 导出，配合 build.rs 的 `/DEF` 与 `/FORCE:MULTIPLE`
//! 覆盖 Rust std / windows crate / parking_lot 等 rlib 中的导入 thunk。
//!
//! 运行时策略：
//! - Win8+：加载真实 DLL 并转发（行为与系统原生一致）
//! - Win7：使用安全回退（RtlGenRandom、Sleep 轮询、no-op 等）
//!
//! # Safety
//! 所有 `#[no_mangle] extern "system"` 函数直接暴露给链接器/OS，参数名沿用
//! Windows API 的 CamelCase 形式。

#![allow(
    non_snake_case,
    non_camel_case_types,
    non_upper_case_globals,
    dead_code,
    clippy::missing_safety_doc
)]

use std::ffi::c_void;
use std::sync::OnceLock;

// ─── Windows API 类型 ───────────────────────────────────────────

pub type PVOID = *mut c_void;
pub type HMODULE = *mut c_void;
pub type DWORD = u32;
pub type SIZE_T = usize;
pub type ULONGLONG = u64;
pub type CO_MTA_USAGE_COOKIE = ULONGLONG;
pub type BOOL = i32;
pub type HANDLE = *mut c_void;
pub type HRESULT = i32;

const INFINITE: DWORD = 0xFFFF_FFFF;
const S_OK: i32 = 0;
const E_NOTIMPL: HRESULT = 0x8000_4001_u32 as i32;
const STATUS_SUCCESS: i32 = 0;
const STATUS_TIMEOUT: i32 = 0x0000_0102;

/// FILETIME 结构体定义（与 Windows API 兼容）
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct FILETIME {
    pub dw_low_date_time: u32,
    pub dw_high_date_time: u32,
}

pub type LPFILETIME = *mut FILETIME;

// ─── FFI imports（kernel32 / advapi32，所有 Windows 版本均存在）───

extern "system" {
    fn LoadLibraryW(lpLibFileName: *const u16) -> HMODULE;
    fn GetProcAddress(hModule: HMODULE, lpProcName: *const u8) -> *mut c_void;
    fn Sleep(dwMilliseconds: DWORD);
    fn SystemFunction036(RandomBuffer: PVOID, RandomBufferLength: u32) -> u8;
    fn GetSystemTimeAsFileTime(lpSystemTimeAsFileTime: *mut FILETIME);
}

// ─── 辅助函数 ───────────────────────────────────────────────────

unsafe fn load_library(name: &str) -> HMODULE {
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { LoadLibraryW(wide.as_ptr()) }
}

/// 解析 DLL 导出并缓存。返回 0 表示函数不存在。
fn resolve(cache: &'static OnceLock<usize>, dll: &str, func: &str) -> usize {
    *cache.get_or_init(|| unsafe {
        let module = load_library(dll);
        if module.is_null() {
            return 0;
        }
        let name = format!("{func}\0");
        GetProcAddress(module, name.as_ptr()) as usize
    })
}

/// 按大小比较两个内存地址的内容，返回 1=不同、0=相同、-1=不支持的大小
unsafe fn compare_bytes(a: *const c_void, b: *const c_void, size: SIZE_T) -> BOOL {
    match size {
        1 => (*(a as *const u8) != *(b as *const u8)) as BOOL,
        2 => (unsafe { *(a as *const u16) } != unsafe { *(b as *const u16) }) as BOOL,
        4 => (unsafe { *(a as *const u32) } != unsafe { *(b as *const u32) }) as BOOL,
        8 => (unsafe { *(a as *const u64) } != unsafe { *(b as *const u64) }) as BOOL,
        _ => -1,
    }
}

/// WaitOnAddress 的轮询回退：值不变则每 1ms 让出 CPU，直到超时。
unsafe fn wait_poll(Address: PVOID, CompareAddress: PVOID, AddressSize: SIZE_T, ms: DWORD) -> BOOL {
    if Address.is_null() || CompareAddress.is_null() {
        return 0;
    }
    let started = unsafe { GetTickCount() };
    loop {
        match unsafe { compare_bytes(Address, CompareAddress, AddressSize) } {
            -1 => return 0,
            1 => return 1,
            _ => {}
        }
        if ms != INFINITE {
            let elapsed = unsafe { GetTickCount() }.wrapping_sub(started);
            if elapsed >= ms {
                return 0;
            }
        }
        unsafe { Sleep(1) };
    }
}

extern "system" {
    fn GetTickCount() -> DWORD;
}

// ═══════════════════════════════════════════════════════════════
// api-ms-win-core-synch-l1-2-0.dll (Win8+)
// ═══════════════════════════════════════════════════════════════

static WAIT_ON_ADDRESS: OnceLock<usize> = OnceLock::new();
static WAKE_SINGLE: OnceLock<usize> = OnceLock::new();
static WAKE_ALL: OnceLock<usize> = OnceLock::new();

#[no_mangle]
pub unsafe extern "system" fn WaitOnAddress(
    Address: PVOID,
    CompareAddress: PVOID,
    AddressSize: SIZE_T,
    dwMilliseconds: DWORD,
) -> BOOL {
    let addr = resolve(
        &WAIT_ON_ADDRESS,
        "api-ms-win-core-synch-l1-2-0.dll",
        "WaitOnAddress",
    );
    if addr != 0 {
        let f: unsafe extern "system" fn(PVOID, PVOID, SIZE_T, DWORD) -> BOOL =
            unsafe { std::mem::transmute(addr) };
        return unsafe { f(Address, CompareAddress, AddressSize, dwMilliseconds) };
    }
    let ms = if dwMilliseconds == INFINITE { 1000 } else { dwMilliseconds };
    unsafe { wait_poll(Address, CompareAddress, AddressSize, ms) }
}

#[no_mangle]
pub unsafe extern "system" fn WakeByAddressSingle(Address: PVOID) {
    let addr = resolve(
        &WAKE_SINGLE,
        "api-ms-win-core-synch-l1-2-0.dll",
        "WakeByAddressSingle",
    );
    if addr != 0 {
        let f: unsafe extern "system" fn(PVOID) = unsafe { std::mem::transmute(addr) };
        unsafe { f(Address) };
    }
}

#[no_mangle]
pub unsafe extern "system" fn WakeByAddressAll(Address: PVOID) {
    let addr = resolve(&WAKE_ALL, "api-ms-win-core-synch-l1-2-0.dll", "WakeByAddressAll");
    if addr != 0 {
        let f: unsafe extern "system" fn(PVOID) = unsafe { std::mem::transmute(addr) };
        unsafe { f(Address) };
    }
}

// ═══════════════════════════════════════════════════════════════
// ntdll.dll (Win8+) — RtlWaitOnAddress / RtlWakeAddress*
// Bun sidecar 与部分运行时使用；Win7 用轮询/空操作回退
// ═══════════════════════════════════════════════════════════════

static RTL_WAIT: OnceLock<usize> = OnceLock::new();
static RTL_WAKE_SINGLE: OnceLock<usize> = OnceLock::new();
static RTL_WAKE_ALL: OnceLock<usize> = OnceLock::new();

#[no_mangle]
pub unsafe extern "system" fn RtlWaitOnAddress(
    Address: PVOID,
    CompareAddress: PVOID,
    AddressSize: SIZE_T,
    Timeout: *const i64,
) -> i32 {
    let addr = resolve(&RTL_WAIT, "ntdll.dll", "RtlWaitOnAddress");
    if addr != 0 {
        let f: unsafe extern "system" fn(PVOID, PVOID, SIZE_T, *const i64) -> i32 =
            unsafe { std::mem::transmute(addr) };
        return unsafe { f(Address, CompareAddress, AddressSize, Timeout) };
    }

    let ms = if Timeout.is_null() {
        INFINITE
    } else {
        let t = unsafe { *Timeout };
        // LARGE_INTEGER：负数表示相对时间（100ns），正数为绝对时间（保守按 1s 处理）
        if t < 0 {
            (t.saturating_neg() / 10_000).min(u32::MAX as i64) as DWORD
        } else {
            1000
        }
    };
    if unsafe { wait_poll(Address, CompareAddress, AddressSize, ms) } != 0 {
        STATUS_SUCCESS
    } else {
        STATUS_TIMEOUT
    }
}

#[no_mangle]
pub unsafe extern "system" fn RtlWakeAddressSingle(Address: PVOID) {
    let addr = resolve(&RTL_WAKE_SINGLE, "ntdll.dll", "RtlWakeAddressSingle");
    if addr != 0 {
        let f: unsafe extern "system" fn(PVOID) = unsafe { std::mem::transmute(addr) };
        unsafe { f(Address) };
    }
}

#[no_mangle]
pub unsafe extern "system" fn RtlWakeAddressAll(Address: PVOID) {
    let addr = resolve(&RTL_WAKE_ALL, "ntdll.dll", "RtlWakeAddressAll");
    if addr != 0 {
        let f: unsafe extern "system" fn(PVOID) = unsafe { std::mem::transmute(addr) };
        unsafe { f(Address) };
    }
}

// ═══════════════════════════════════════════════════════════════
// combase.dll (Win8+) — CoIncrementMTAUsage / CoTaskMem* / Marshaler
// ═══════════════════════════════════════════════════════════════

static CO_INC_MTA: OnceLock<usize> = OnceLock::new();
static OLE32_CO_TASK_ALLOC: OnceLock<usize> = OnceLock::new();
static OLE32_CO_TASK_FREE: OnceLock<usize> = OnceLock::new();
static OLE32_CO_FTM: OnceLock<usize> = OnceLock::new();
static RO_AGILE: OnceLock<usize> = OnceLock::new();

#[no_mangle]
pub unsafe extern "system" fn CoIncrementMTAUsage(pCookie: *mut CO_MTA_USAGE_COOKIE) -> i32 {
    let addr = resolve(&CO_INC_MTA, "combase.dll", "CoIncrementMTAUsage");
    if addr != 0 {
        let f: unsafe extern "system" fn(*mut CO_MTA_USAGE_COOKIE) -> i32 =
            unsafe { std::mem::transmute(addr) };
        return unsafe { f(pCookie) };
    }
    if !pCookie.is_null() {
        unsafe { *pCookie = 1 };
    }
    S_OK
}

#[no_mangle]
pub unsafe extern "system" fn CoTaskMemAlloc(cb: SIZE_T) -> PVOID {
    let addr = resolve(&OLE32_CO_TASK_ALLOC, "ole32.dll", "CoTaskMemAlloc");
    if addr != 0 {
        let f: unsafe extern "system" fn(SIZE_T) -> PVOID = unsafe { std::mem::transmute(addr) };
        return unsafe { f(cb) };
    }
    std::ptr::null_mut()
}

#[no_mangle]
pub unsafe extern "system" fn CoTaskMemFree(pv: PVOID) {
    let addr = resolve(&OLE32_CO_TASK_FREE, "ole32.dll", "CoTaskMemFree");
    if addr != 0 {
        let f: unsafe extern "system" fn(PVOID) = unsafe { std::mem::transmute(addr) };
        unsafe { f(pv) };
    }
}

#[no_mangle]
pub unsafe extern "system" fn CoCreateFreeThreadedMarshaler(
    punkOuter: PVOID,
    ppunkMarshal: *mut PVOID,
) -> i32 {
    let addr = resolve(&OLE32_CO_FTM, "ole32.dll", "CoCreateFreeThreadedMarshaler");
    if addr != 0 {
        let f: unsafe extern "system" fn(PVOID, *mut PVOID) -> i32 =
            unsafe { std::mem::transmute(addr) };
        return unsafe { f(punkOuter, ppunkMarshal) };
    }
    if !ppunkMarshal.is_null() {
        unsafe { *ppunkMarshal = std::ptr::null_mut() };
    }
    0x8007_000E_u32 as i32 // E_OUTOFMEMORY
}

#[no_mangle]
pub unsafe extern "system" fn RoGetAgileReference(
    _options: u32,
    _iid: PVOID,
    _punk: PVOID,
    _riid: PVOID,
    ppAgileReference: *mut PVOID,
) -> HRESULT {
    let addr = resolve(&RO_AGILE, "ole32.dll", "RoGetAgileReference");
    if addr != 0 {
        let f: unsafe extern "system" fn(u32, PVOID, PVOID, PVOID, *mut PVOID) -> HRESULT =
            unsafe { std::mem::transmute(addr) };
        return unsafe { f(_options, _iid, _punk, _riid, ppAgileReference) };
    }
    if !ppAgileReference.is_null() {
        unsafe { *ppAgileReference = std::ptr::null_mut() };
    }
    E_NOTIMPL
}

// ═══════════════════════════════════════════════════════════════
// bcryptprimitives.dll (Win8+) — ProcessPrng
// ═══════════════════════════════════════════════════════════════

#[no_mangle]
pub unsafe extern "system" fn ProcessPrng(pbData: PVOID, cbData: ULONGLONG) -> BOOL {
    if cbData > 0xFFFF_FFFF {
        return 0xC000_000D_u32 as i32; // STATUS_INVALID_PARAMETER
    }
    let ok = unsafe { SystemFunction036(pbData, cbData as u32) };
    if ok != 0 {
        0
    } else {
        0xC000_000F_u32 as i32 // STATUS_UNSUCCESSFUL
    }
}

// ═══════════════════════════════════════════════════════════════
// kernel32.dll (Win8+) — GetSystemTimePreciseAsFileTime
// ═══════════════════════════════════════════════════════════════

static GST_PRECISE: OnceLock<usize> = OnceLock::new();
static DISCARD_VM: OnceLock<usize> = OnceLock::new();
static GET_STACK_LIMITS: OnceLock<usize> = OnceLock::new();
static SET_THREAD_DESC: OnceLock<usize> = OnceLock::new();
static GET_THREAD_DESC: OnceLock<usize> = OnceLock::new();
static EVENT_SET_INFO: OnceLock<usize> = OnceLock::new();

#[no_mangle]
pub unsafe extern "system" fn GetSystemTimePreciseAsFileTime(lpSystemTimeAsFileTime: LPFILETIME) {
    let addr = resolve(
        &GST_PRECISE,
        "kernel32.dll",
        "GetSystemTimePreciseAsFileTime",
    );
    if addr != 0 {
        let f: unsafe extern "system" fn(LPFILETIME) = unsafe { std::mem::transmute(addr) };
        unsafe { f(lpSystemTimeAsFileTime) };
        return;
    }
    unsafe { GetSystemTimeAsFileTime(lpSystemTimeAsFileTime) };
}

#[no_mangle]
pub unsafe extern "system" fn DiscardVirtualMemory(VirtualAddress: PVOID, Size: SIZE_T) -> u32 {
    let addr = resolve(&DISCARD_VM, "kernel32.dll", "DiscardVirtualMemory");
    if addr != 0 {
        let f: unsafe extern "system" fn(PVOID, SIZE_T) -> u32 = unsafe { std::mem::transmute(addr) };
        return unsafe { f(VirtualAddress, Size) };
    }
    let _ = (VirtualAddress, Size);
    0 // ERROR_SUCCESS（纯性能提示，no-op 安全）
}

#[cfg(target_arch = "x86_64")]
unsafe fn teb_stack_limits() -> (usize, usize) {
    // x64 TEB: GS:[0x30] → TEB；NT_TIB.StackBase @ +0x08，StackLimit @ +0x10
    let teb: usize;
    unsafe {
        std::arch::asm!(
            "mov {}, gs:[0x30]",
            out(reg) teb,
            options(nostack, preserves_flags, readonly)
        );
    }
    let base = unsafe { *((teb + 0x08) as *const usize) };
    let limit = unsafe { *((teb + 0x10) as *const usize) };
    (limit, base)
}

#[no_mangle]
pub unsafe extern "system" fn GetCurrentThreadStackLimits(LowLimit: *mut usize, HighLimit: *mut usize) {
    let addr = resolve(&GET_STACK_LIMITS, "kernel32.dll", "GetCurrentThreadStackLimits");
    if addr != 0 {
        let f: unsafe extern "system" fn(*mut usize, *mut usize) =
            unsafe { std::mem::transmute(addr) };
        unsafe { f(LowLimit, HighLimit) };
        return;
    }
    #[cfg(target_arch = "x86_64")]
    {
        let (low, high) = unsafe { teb_stack_limits() };
        if !LowLimit.is_null() {
            unsafe { *LowLimit = low };
        }
        if !HighLimit.is_null() {
            unsafe { *HighLimit = high };
        }
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        if !LowLimit.is_null() {
            unsafe { *LowLimit = 0 };
        }
        if !HighLimit.is_null() {
            unsafe { *HighLimit = 0 };
        }
    }
}

#[no_mangle]
pub unsafe extern "system" fn SetThreadDescription(
    hThread: HANDLE,
    lpThreadDescription: *const u16,
) -> HRESULT {
    let addr = resolve(&SET_THREAD_DESC, "kernel32.dll", "SetThreadDescription");
    if addr != 0 {
        let f: unsafe extern "system" fn(HANDLE, *const u16) -> HRESULT =
            unsafe { std::mem::transmute(addr) };
        return unsafe { f(hThread, lpThreadDescription) };
    }
    let _ = (hThread, lpThreadDescription);
    E_NOTIMPL
}

#[no_mangle]
pub unsafe extern "system" fn GetThreadDescription(
    hThread: HANDLE,
    ppszThreadDescription: *mut *mut u16,
) -> HRESULT {
    let addr = resolve(&GET_THREAD_DESC, "kernel32.dll", "GetThreadDescription");
    if addr != 0 {
        let f: unsafe extern "system" fn(HANDLE, *mut *mut u16) -> HRESULT =
            unsafe { std::mem::transmute(addr) };
        return unsafe { f(hThread, ppszThreadDescription) };
    }
    let _ = hThread;
    if !ppszThreadDescription.is_null() {
        unsafe { *ppszThreadDescription = std::ptr::null_mut() };
    }
    E_NOTIMPL
}

// ═══════════════════════════════════════════════════════════════
// advapi32.dll (Win8+) — EventSetInformation
// ═══════════════════════════════════════════════════════════════

/// 直接调用形式的别名目标。
/// Rust 对 `EventSetInformation` 生成的是 `call EventSetInformation`（经导入库 thunk），
/// 而不是 x64 IAT 的 `__imp_` 间接调用；因此 build.rs 额外用
/// `/ALTERNATENAME:EventSetInformation=win7_fn_EventSetInformation` 把直接调用
/// 重定向到本函数，避免静态导入。
#[no_mangle]
pub unsafe extern "system" fn win7_fn_EventSetInformation(
    RegHandle: u64,
    InformationClass: u32,
    EventInformation: PVOID,
    InformationLength: u32,
) -> u32 {
    unsafe { EventSetInformation(RegHandle, InformationClass, EventInformation, InformationLength) }
}

#[no_mangle]
pub unsafe extern "system" fn EventSetInformation(
    RegHandle: u64,
    InformationClass: u32,
    EventInformation: PVOID,
    InformationLength: u32,
) -> u32 {
    let addr = resolve(&EVENT_SET_INFO, "advapi32.dll", "EventSetInformation");
    if addr != 0 {
        let f: unsafe extern "system" fn(u64, u32, PVOID, u32) -> u32 =
            unsafe { std::mem::transmute(addr) };
        return unsafe { f(RegHandle, InformationClass, EventInformation, InformationLength) };
    }
    let _ = (RegHandle, InformationClass, EventInformation, InformationLength);
    0 // ERROR_SUCCESS
}

// ═══════════════════════════════════════════════════════════════
// 链接器锚点
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// IAT 覆盖：Rust / windows crate 在 x64 上通过 `__imp_<func>`
// 间接调用导入函数。仅定义同名函数不足以消除导入，必须同时定义
// `__imp_<func>` 数据符号（函数指针），链接器才会用我们的定义满足
// 导入槽位，并跳过 kernel32.lib 等导入库 / DELAYLOAD thunk。
// ═══════════════════════════════════════════════════════════════

// 符号名使用 win7_imp_ 前缀（而非 __imp_），避免与 kernel32.lib 等导入库
// 产生同名多重定义（LNK2005/LNK1106）；build.rs 通过
// `/ALTERNATENAME:__imp_<func>=win7_imp_<func>` 把 IAT 引用重定向到这里。
// 注意：不能直接导出 `__imp_*` 符号——cdylib 的 .exp 生成器会因保留名报 LNK1106。

macro_rules! import_pointer {
    ($imp:ident, $func:ident, ($($arg:ty),* $(,)?), $ret:ty) => {
        #[no_mangle]
        pub static $imp: unsafe extern "system" fn($($arg),*) -> $ret = $func;
    };
}

import_pointer!(win7_imp_WaitOnAddress, WaitOnAddress, (PVOID, PVOID, SIZE_T, DWORD), BOOL);
import_pointer!(win7_imp_WakeByAddressSingle, WakeByAddressSingle, (PVOID), ());
import_pointer!(win7_imp_WakeByAddressAll, WakeByAddressAll, (PVOID), ());
import_pointer!(
    win7_imp_RtlWaitOnAddress,
    RtlWaitOnAddress,
    (PVOID, PVOID, SIZE_T, *const i64),
    i32
);
import_pointer!(win7_imp_RtlWakeAddressSingle, RtlWakeAddressSingle, (PVOID), ());
import_pointer!(win7_imp_RtlWakeAddressAll, RtlWakeAddressAll, (PVOID), ());
import_pointer!(
    win7_imp_CoIncrementMTAUsage,
    CoIncrementMTAUsage,
    (*mut CO_MTA_USAGE_COOKIE),
    i32
);
import_pointer!(win7_imp_CoTaskMemAlloc, CoTaskMemAlloc, (SIZE_T), PVOID);
import_pointer!(win7_imp_CoTaskMemFree, CoTaskMemFree, (PVOID), ());
import_pointer!(
    win7_imp_CoCreateFreeThreadedMarshaler,
    CoCreateFreeThreadedMarshaler,
    (PVOID, *mut PVOID),
    i32
);
import_pointer!(
    win7_imp_RoGetAgileReference,
    RoGetAgileReference,
    (u32, PVOID, PVOID, PVOID, *mut PVOID),
    HRESULT
);
import_pointer!(win7_imp_ProcessPrng, ProcessPrng, (PVOID, ULONGLONG), BOOL);
import_pointer!(
    win7_imp_GetSystemTimePreciseAsFileTime,
    GetSystemTimePreciseAsFileTime,
    (LPFILETIME),
    ()
);
import_pointer!(
    win7_imp_DiscardVirtualMemory,
    DiscardVirtualMemory,
    (PVOID, SIZE_T),
    u32
);
import_pointer!(
    win7_imp_GetCurrentThreadStackLimits,
    GetCurrentThreadStackLimits,
    (*mut usize, *mut usize),
    ()
);
import_pointer!(
    win7_imp_SetThreadDescription,
    SetThreadDescription,
    (HANDLE, *const u16),
    HRESULT
);
import_pointer!(
    win7_imp_GetThreadDescription,
    GetThreadDescription,
    (HANDLE, *mut *mut u16),
    HRESULT
);
import_pointer!(
    win7_imp_EventSetInformation,
    EventSetInformation,
    (u64, u32, PVOID, u32),
    u32
);

/// 引用全部 IAT 覆盖符号与 stub 函数，确保它们在各自 CGU/object 中被
/// 链接器拉入，并参与 `/ALTERNATENAME` 解析。
/// 仅引用其中一个函数不足以覆盖 debug 构建的 CGU 分区。
pub fn force_link() {
    let anchors: [*const (); 36] = [
        &win7_imp_WaitOnAddress as *const _ as *const (),
        &win7_imp_WakeByAddressSingle as *const _ as *const (),
        &win7_imp_WakeByAddressAll as *const _ as *const (),
        &win7_imp_RtlWaitOnAddress as *const _ as *const (),
        &win7_imp_RtlWakeAddressSingle as *const _ as *const (),
        &win7_imp_RtlWakeAddressAll as *const _ as *const (),
        &win7_imp_CoIncrementMTAUsage as *const _ as *const (),
        &win7_imp_CoTaskMemAlloc as *const _ as *const (),
        &win7_imp_CoTaskMemFree as *const _ as *const (),
        &win7_imp_CoCreateFreeThreadedMarshaler as *const _ as *const (),
        &win7_imp_RoGetAgileReference as *const _ as *const (),
        &win7_imp_ProcessPrng as *const _ as *const (),
        &win7_imp_GetSystemTimePreciseAsFileTime as *const _ as *const (),
        &win7_imp_DiscardVirtualMemory as *const _ as *const (),
        &win7_imp_GetCurrentThreadStackLimits as *const _ as *const (),
        &win7_imp_SetThreadDescription as *const _ as *const (),
        &win7_imp_GetThreadDescription as *const _ as *const (),
        &win7_imp_EventSetInformation as *const _ as *const (),
        (WaitOnAddress as unsafe extern "system" fn(PVOID, PVOID, SIZE_T, DWORD) -> BOOL) as *const (),
        (WakeByAddressSingle as unsafe extern "system" fn(PVOID)) as *const (),
        (WakeByAddressAll as unsafe extern "system" fn(PVOID)) as *const (),
        (RtlWaitOnAddress as unsafe extern "system" fn(PVOID, PVOID, SIZE_T, *const i64) -> i32)
            as *const (),
        (RtlWakeAddressSingle as unsafe extern "system" fn(PVOID)) as *const (),
        (RtlWakeAddressAll as unsafe extern "system" fn(PVOID)) as *const (),
        (CoIncrementMTAUsage as unsafe extern "system" fn(*mut CO_MTA_USAGE_COOKIE) -> i32)
            as *const (),
        (CoTaskMemAlloc as unsafe extern "system" fn(SIZE_T) -> PVOID) as *const (),
        (CoTaskMemFree as unsafe extern "system" fn(PVOID)) as *const (),
        (CoCreateFreeThreadedMarshaler as unsafe extern "system" fn(PVOID, *mut PVOID) -> i32)
            as *const (),
        (RoGetAgileReference as unsafe extern "system" fn(u32, PVOID, PVOID, PVOID, *mut PVOID) -> HRESULT)
            as *const (),
        (ProcessPrng as unsafe extern "system" fn(PVOID, ULONGLONG) -> BOOL) as *const (),
        (GetSystemTimePreciseAsFileTime as unsafe extern "system" fn(LPFILETIME)) as *const (),
        (DiscardVirtualMemory as unsafe extern "system" fn(PVOID, SIZE_T) -> u32) as *const (),
        (GetCurrentThreadStackLimits as unsafe extern "system" fn(*mut usize, *mut usize))
            as *const (),
        (SetThreadDescription as unsafe extern "system" fn(HANDLE, *const u16) -> HRESULT)
            as *const (),
        (GetThreadDescription as unsafe extern "system" fn(HANDLE, *mut *mut u16) -> HRESULT)
            as *const (),
        (EventSetInformation as unsafe extern "system" fn(u64, u32, PVOID, u32) -> u32)
            as *const (),
    ];
    std::hint::black_box(anchors);
}
