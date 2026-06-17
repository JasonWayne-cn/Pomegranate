//! Win7 兼容性 stub 函数 —— 替代 win7_stubs.c
//!
//! 提供 api-ms-win-core-synch-l1-2-0、combase、bcryptprimitives 等 Win8+ DLL
//! 中函数的 stub 实现。通过 #[no_mangle] extern "system" 导出。
//!
//! 注意：ole32.dll 函数（CoTaskMemFree/CoTaskMemAlloc/CoCreateFreeThreadedMarshaler）
//! 在所有 Windows 版本均存在且 ole32.lib 始终链接，不可 stub（会 LNK1169 重复定义）。
//!
//! 运行时行为：
//! - Win8+: 真实 DLL 存在，stub 加载并转发到真实实现
//! - Win7:  DLL 不存在，使用安全 fallback
//!
//! # Safety
//! 所有 #[no_mangle] 函数均为 `unsafe extern "system"`，直接暴露给 linker/OS。
//! 参数名保留 Windows API 原始 CamelCase（非 Rust snake_case），需全局允许 non_snake_case。

#![allow(non_snake_case, non_camel_case_types)]

use std::ffi::c_void;
use std::sync::Once;

// ─── Windows API 类型 ───

type PVOID = *mut c_void;
type HMODULE = *mut c_void;
type DWORD = u32;
type SIZE_T = u64;
type ULONGLONG = u64;
type CO_MTA_USAGE_COOKIE = ULONGLONG;
type BOOL = i32;

const INFINITE: DWORD = 0xFFFFFFFF;
const S_OK: i32 = 0;

// ─── FFI imports (kernel32 / advapi32，所有 Windows 版本均存在) ───

extern "system" {
    fn LoadLibraryW(lpLibFileName: *const u16) -> HMODULE;
    fn GetProcAddress(hModule: HMODULE, lpProcName: *const u8) -> *mut c_void;
    fn Sleep(dwMilliseconds: DWORD);
    fn SystemFunction036(RandomBuffer: PVOID, RandomBufferLength: u32) -> u8;
}

// ─── 辅助函数 ───

unsafe fn load_library(name: &str) -> HMODULE {
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { LoadLibraryW(wide.as_ptr()) }
}

// ═══════════════════════════════════════════════════════
// api-ms-win-core-synch-l1-2-0.dll (Win8+)
// ═══════════════════════════════════════════════════════

static SYNCH_INIT: Once = Once::new();
static mut SYNCH_DLL: HMODULE = std::ptr::null_mut();

unsafe fn synch_init() {
    SYNCH_INIT.call_once(|| {
        unsafe {
            SYNCH_DLL = load_library("api-ms-win-core-synch-l1-2-0.dll");
        }
    });
}

#[no_mangle]
pub unsafe extern "system" fn WakeByAddressSingle(Address: PVOID) {
    unsafe {
        synch_init();
        if !SYNCH_DLL.is_null() {
            let f: Option<unsafe extern "system" fn(PVOID)> =
                std::mem::transmute(GetProcAddress(SYNCH_DLL, b"WakeByAddressSingle\0".as_ptr()));
            if let Some(f) = f {
                f(Address);
                return;
            }
        }
    }
    let _ = Address;
}

#[no_mangle]
pub unsafe extern "system" fn WakeByAddressAll(Address: PVOID) {
    unsafe {
        synch_init();
        if !SYNCH_DLL.is_null() {
            let f: Option<unsafe extern "system" fn(PVOID)> =
                std::mem::transmute(GetProcAddress(SYNCH_DLL, b"WakeByAddressAll\0".as_ptr()));
            if let Some(f) = f {
                f(Address);
                return;
            }
        }
    }
    let _ = Address;
}

#[no_mangle]
pub unsafe extern "system" fn WaitOnAddress(
    Address: *mut c_void,
    CompareAddress: *mut c_void,
    AddressSize: SIZE_T,
    dwMilliseconds: DWORD,
) -> BOOL {
    unsafe {
        synch_init();
        if !SYNCH_DLL.is_null() {
            let f: Option<
                unsafe extern "system" fn(*mut c_void, *mut c_void, SIZE_T, DWORD) -> BOOL,
            > = std::mem::transmute(GetProcAddress(SYNCH_DLL, b"WaitOnAddress\0".as_ptr()));
            if let Some(f) = f {
                return f(Address, CompareAddress, AddressSize, dwMilliseconds);
            }
        }
    }
    let _ = Address;
    let _ = CompareAddress;
    let _ = AddressSize;
    let ms = if dwMilliseconds == INFINITE { 1000 } else { dwMilliseconds };
    unsafe { Sleep(ms) };
    1
}

// ═══════════════════════════════════════════════════════
// combase.dll (Win8+) — CoIncrementMTAUsage
// ═══════════════════════════════════════════════════════

#[no_mangle]
pub unsafe extern "system" fn CoIncrementMTAUsage(pCookie: *mut CO_MTA_USAGE_COOKIE) -> i32 {
    static COMBASE_INIT: Once = Once::new();
    static mut COMBASE_DLL: HMODULE = std::ptr::null_mut();

    unsafe {
        COMBASE_INIT.call_once(|| {
            COMBASE_DLL = load_library("combase.dll");
        });

        if !COMBASE_DLL.is_null() {
            let f: Option<unsafe extern "system" fn(*mut CO_MTA_USAGE_COOKIE) -> i32> =
                std::mem::transmute(GetProcAddress(
                    COMBASE_DLL,
                    b"CoIncrementMTAUsage\0".as_ptr(),
                ));
            if let Some(f) = f {
                return f(pCookie);
            }
        }
    }

    // Win7 stub
    if !pCookie.is_null() {
        unsafe { *pCookie = 1 as CO_MTA_USAGE_COOKIE };
    }
    S_OK
}

// ═══════════════════════════════════════════════════════
// bcryptprimitives.dll (Win8+) — ProcessPrng
// 转发到 RtlGenRandom/SystemFunction036 (advapi32.dll, XP+)
// ═══════════════════════════════════════════════════════

#[no_mangle]
pub unsafe extern "system" fn ProcessPrng(pbData: PVOID, cbData: ULONGLONG) -> BOOL {
    if cbData > 0xFFFF_FFFF {
        return 0xC000_000D_u32 as i32; // STATUS_INVALID_PARAMETER
    }
    let ok = unsafe { SystemFunction036(pbData, cbData as u32) };
    if ok != 0 {
        0 // STATUS_SUCCESS
    } else {
        0xC000_000F_u32 as i32 // STATUS_UNSUCCESSFUL
    }
}
