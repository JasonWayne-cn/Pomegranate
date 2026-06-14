// win7_stubs.c — Windows 7 兼容 C 桩函数
//
// 目的: 消除 PE 导入表中 Win8+ 才引入的 DLL 依赖。
//
// 原理: MSVC 链接器对默认库的符号解析优先级为：静态库 > 导入库。
//       cc crate 将本文件编译为 .lib，链接时桩函数定义优先于 DLL 导入。
//
// 限制: windows-sys 0.61+ 使用 #[link(kind = "raw-dylib")] 的导入无法被
//       C stub 覆盖。如果 combase.dll 依然出现在导入表，需降级 iana-time-zone
//       到 0.1.45 以切断 windows-core/windows-link 链路。

// ─── Windows SDK 头 ──────────────────────────
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <ole2.h>

// ─── api-ms-win-core-synch-l1-2-0.dll 桩 ─────
// 这组函数来自 Rust std 的 parking_lot / synchronization 依赖。
// Win7 没有 api-ms-win-core-synch-l1-2-0.dll，这些函数只在 Win8+ kernel32.dll 中。

VOID WINAPI WakeByAddressSingle(PVOID Address) {
    (VOID)Address;
}

VOID WINAPI WakeByAddressAll(PVOID Address) {
    (VOID)Address;
}

BOOL WINAPI WaitOnAddress(
    VOID volatile *Address,
    PVOID CompareAddress,
    SIZE_T AddressSize,
    DWORD dwMilliseconds)
{
    (VOID)Address;
    (VOID)CompareAddress;
    (VOID)AddressSize;
    // 退化实现: 用 Sleep 模拟等待。
    // Rust std 在调用 WaitOnAddress 前会检查 OS 版本，Win7 上不应执行此路径。
    if (dwMilliseconds == INFINITE) {
        dwMilliseconds = 1000;
    }
    Sleep(dwMilliseconds);
    return TRUE;
}

// ─── combase.dll 函数 → ole32.dll 转发 ────────
// Win8+ 将部分 COM 函数从 ole32.dll 移到了新 DLL combase.dll。
// Win7 的 ole32.dll 仍有这些函数，通过 GetProcAddress 动态查找并转发。

static HMODULE ole32_module(void) {
    static HMODULE h = NULL;
    if (!h) h = LoadLibraryW(L"ole32.dll");
    return h;
}

void WINAPI CoTaskMemFree_stub(LPVOID pv) {
    typedef void (WINAPI *fn)(LPVOID);
    static fn f = NULL;
    if (!f) f = (fn)GetProcAddress(ole32_module(), "CoTaskMemFree");
    if (f) f(pv);
}

LPVOID WINAPI CoTaskMemAlloc_stub(SIZE_T cb) {
    typedef LPVOID (WINAPI *fn)(SIZE_T);
    static fn f = NULL;
    if (!f) f = (fn)GetProcAddress(ole32_module(), "CoTaskMemAlloc");
    return f ? f(cb) : NULL;
}

HRESULT WINAPI CoCreateFreeThreadedMarshaler_stub(
    LPUNKNOWN punkOuter,
    LPUNKNOWN *ppunkMarshal)
{
    typedef HRESULT (WINAPI *fn)(LPUNKNOWN, LPUNKNOWN*);
    static fn f = NULL;
    if (!f) f = (fn)GetProcAddress(ole32_module(), "CoCreateFreeThreadedMarshaler");
    return f ? f(punkOuter, *ppunkMarshal) : E_OUTOFMEMORY;
}

// CoIncrementMTAUsage: Win7 上没有此函数。
// 返回 S_OK 并记录一次 MTA 使用（无实际效果），避免调用方崩溃。
HRESULT WINAPI CoIncrementMTAUsage_stub(CO_MTA_USAGE_COOKIE *pCookie) {
    if (pCookie) {
        *pCookie = (CO_MTA_USAGE_COOKIE)(ULONG_PTR)1;
    }
    return S_OK;
}
