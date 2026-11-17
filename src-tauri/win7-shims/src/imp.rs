//! Win7 IAT 覆盖符号（仅在 **bin** crate 中内联编译）
//!
//! Rust x64 通过 `__imp_<func>` IAT 槽位间接调用导入函数。直接在 bin 目标中
//! 定义同名符号，链接器的 `/FORCE:MULTIPLE`（我们的 object 在导入库之前）
//! 会采用这里的定义，从而从 PE 导入表中彻底移除 Win8+ API。
//!
//! 注意：本模块 **不能** 编译进 lib/cdylib——`__imp_` 是保留名，会令 .exp
//! 生成器报 LNK1106。因此只由 `src/main.rs` 与 `mcp/src/main.rs` 引入。

#![allow(non_upper_case_globals)]

use crate::win7_shims::*;

macro_rules! import_pointer {
    ($sym:literal, $imp:ident, $func:ident, ($($arg:ty),* $(,)?), $ret:ty) => {
        #[export_name = $sym]
        pub static $imp: unsafe extern "system" fn($($arg),*) -> $ret = $func;
    };
}

import_pointer!("__imp_WaitOnAddress", IMP_WaitOnAddress, WaitOnAddress, (PVOID, PVOID, SIZE_T, DWORD), BOOL);
import_pointer!("__imp_WakeByAddressSingle", IMP_WakeByAddressSingle, WakeByAddressSingle, (PVOID), ());
import_pointer!("__imp_WakeByAddressAll", IMP_WakeByAddressAll, WakeByAddressAll, (PVOID), ());
import_pointer!(
    "__imp_RtlWaitOnAddress",
    IMP_RtlWaitOnAddress,
    RtlWaitOnAddress,
    (PVOID, PVOID, SIZE_T, *const i64),
    i32
);
import_pointer!("__imp_RtlWakeAddressSingle", IMP_RtlWakeAddressSingle, RtlWakeAddressSingle, (PVOID), ());
import_pointer!("__imp_RtlWakeAddressAll", IMP_RtlWakeAddressAll, RtlWakeAddressAll, (PVOID), ());
import_pointer!(
    "__imp_CoIncrementMTAUsage",
    IMP_CoIncrementMTAUsage,
    CoIncrementMTAUsage,
    (*mut CO_MTA_USAGE_COOKIE),
    i32
);
import_pointer!("__imp_CoTaskMemAlloc", IMP_CoTaskMemAlloc, CoTaskMemAlloc, (SIZE_T), PVOID);
import_pointer!("__imp_CoTaskMemFree", IMP_CoTaskMemFree, CoTaskMemFree, (PVOID), ());
import_pointer!(
    "__imp_CoCreateFreeThreadedMarshaler",
    IMP_CoCreateFreeThreadedMarshaler,
    CoCreateFreeThreadedMarshaler,
    (PVOID, *mut PVOID),
    i32
);
import_pointer!(
    "__imp_RoGetAgileReference",
    IMP_RoGetAgileReference,
    RoGetAgileReference,
    (u32, PVOID, PVOID, PVOID, *mut PVOID),
    HRESULT
);
import_pointer!("__imp_ProcessPrng", IMP_ProcessPrng, ProcessPrng, (PVOID, ULONGLONG), BOOL);
import_pointer!(
    "__imp_GetSystemTimePreciseAsFileTime",
    IMP_GetSystemTimePreciseAsFileTime,
    GetSystemTimePreciseAsFileTime,
    (LPFILETIME),
    ()
);
import_pointer!(
    "__imp_DiscardVirtualMemory",
    IMP_DiscardVirtualMemory,
    DiscardVirtualMemory,
    (PVOID, SIZE_T),
    u32
);
import_pointer!(
    "__imp_GetCurrentThreadStackLimits",
    IMP_GetCurrentThreadStackLimits,
    GetCurrentThreadStackLimits,
    (*mut usize, *mut usize),
    ()
);
import_pointer!(
    "__imp_SetThreadDescription",
    IMP_SetThreadDescription,
    SetThreadDescription,
    (HANDLE, *const u16),
    HRESULT
);
import_pointer!(
    "__imp_GetThreadDescription",
    IMP_GetThreadDescription,
    GetThreadDescription,
    (HANDLE, *mut *mut u16),
    HRESULT
);
import_pointer!(
    "__imp_EventSetInformation",
    IMP_EventSetInformation,
    EventSetInformation,
    (u64, u32, PVOID, u32),
    u32
);

/// 在 bin 的 `main` 最开头调用，确保所有 `__imp_*` 定义被链接器拉入。
pub fn force_link() {
    let anchors: [*const (); 19] = [
        &IMP_WaitOnAddress as *const _ as *const (),
        &IMP_WakeByAddressSingle as *const _ as *const (),
        &IMP_WakeByAddressAll as *const _ as *const (),
        &IMP_RtlWaitOnAddress as *const _ as *const (),
        &IMP_RtlWakeAddressSingle as *const _ as *const (),
        &IMP_RtlWakeAddressAll as *const _ as *const (),
        &IMP_CoIncrementMTAUsage as *const _ as *const (),
        &IMP_CoTaskMemAlloc as *const _ as *const (),
        &IMP_CoTaskMemFree as *const _ as *const (),
        &IMP_CoCreateFreeThreadedMarshaler as *const _ as *const (),
        &IMP_RoGetAgileReference as *const _ as *const (),
        &IMP_ProcessPrng as *const _ as *const (),
        &IMP_GetSystemTimePreciseAsFileTime as *const _ as *const (),
        &IMP_DiscardVirtualMemory as *const _ as *const (),
        &IMP_GetCurrentThreadStackLimits as *const _ as *const (),
        &IMP_SetThreadDescription as *const _ as *const (),
        &IMP_GetThreadDescription as *const _ as *const (),
        &IMP_EventSetInformation as *const _ as *const (),
        // 直接调用形式的 ALTERNATENAME 目标，必须被拉入 bin
        (win7_fn_EventSetInformation
            as unsafe extern "system" fn(u64, u32, PVOID, u32) -> u32) as *const (),
    ];
    std::hint::black_box(anchors);
}
