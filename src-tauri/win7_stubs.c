// win7_stubs.c — Windows 7 兼容 C 桩函数
//
// 目的: 消除 PE 导入表中 Win8+ 才引入的 DLL 依赖。
//
// 原理: MSVC 链接器对默认库的符号解析优先级为：静态库 > 导入库。
//       cc crate 将本文件编译为 .lib，链接时桩函数定义优先于 DLL 导入。
//
// 注意: 本文件不包含 <windows.h>，避免编译时 MSVC include 路径缺失。
//       需要的 Windows 类型和 API 均通过精简前向声明提供。

// ─── 精简类型前向声明 ──────────────────────────
typedef void *PVOID;
typedef unsigned int UINT;
typedef const void *LPCVOID;
typedef void *LPVOID;
typedef unsigned int HRESULT;
typedef unsigned long DWORD;
typedef unsigned long ULONG;
typedef unsigned long *PULONG;
typedef unsigned long long ULONGLONG;
typedef unsigned long long *PULONGLONG;
typedef unsigned long long SIZE_T;
#define WINAPI __stdcall
#define INFINITE 0xFFFFFFFF
#define S_OK 0
#define E_OUTOFMEMER 0x8007000E
typedef DWORD (WINAPI *PTHREAD_START_ROUTINE)(LPVOID);

// 这些类型仅用于 CoIncrementMTAUsage 的 cookie
typedef ULONGLONG CO_MTA_USAGE_COOKIE;

// 这些类型仅用于 CoCreateFreeThreadedMarshaler
typedef void *LPUNKNOWN;

// ─── 动态链接辅助 ─────────────────────────────
// 使用内部声明代替包含 <windows.h>
__declspec(dllimport) void *__stdcall LoadLibraryW(const wchar_t *);
__declspec(dllimport) void *__stdcall GetProcAddress(void *, const char *);
__declspec(dllimport) void __stdcall Sleep(DWORD);

// ─── api-ms-win-core-synch-l1-2-0.dll 桩 ─────

void WINAPI WakeByAddressSingle(PVOID Address) {
    (void)Address;
}

void WINAPI WakeByAddressAll(PVOID Address) {
    (void)Address;
}

int WINAPI WaitOnAddress(
    void volatile *Address,
    void *CompareAddress,
    SIZE_T AddressSize,
    DWORD dwMilliseconds)
{
    (void)Address;
    (void)CompareAddress;
    (void)AddressSize;
    // Rust std 先在 Win7 检查版本，不应走这里，万一到了 Sleep 兜底
    if (dwMilliseconds == INFINITE) {
        dwMilliseconds = 1000;
    }
    Sleep(dwMilliseconds);
    return 1;
}

// ─── combase.dll → ole32.dll 转发 ─────────────

static void *ole32_module(void) {
    static void *h = 0;
    if (!h) h = LoadLibraryW(L"ole32.dll");
    return h;
}

static void *lookup_ole32(const char *name) {
    void *mod = ole32_module();
    return mod ? GetProcAddress(mod, name) : 0;
}

void WINAPI CoTaskMemFree(LPVOID pv) {
    typedef void (WINAPI *fn)(LPVOID);
    fn f = (fn)lookup_ole32("CoTaskMemFree");
    if (f) f(pv);
}

LPVOID WINAPI CoTaskMemAlloc(SIZE_T cb) {
    typedef LPVOID (WINAPI *fn)(SIZE_T);
    fn f = (fn)lookup_ole32("CoTaskMemAlloc");
    return f ? f(cb) : 0;
}

HRESULT WINAPI CoCreateFreeThreadedMarshaler(
    LPUNKNOWN punkOuter,
    LPUNKNOWN *ppunkMarshal)
{
    typedef HRESULT (WINAPI *fn)(LPUNKNOWN, LPUNKNOWN*);
    fn f = (fn)lookup_ole32("CoCreateFreeThreadedMarshaler");
    if (f) return f(punkOuter, ppunkMarshal);
    if (ppunkMarshal) *ppunkMarshal = 0;
    return E_OUTOFMEMER;
}

HRESULT WINAPI CoIncrementMTAUsage(CO_MTA_USAGE_COOKIE *pCookie) {
    if (pCookie) {
        *pCookie = (CO_MTA_USAGE_COOKIE)1;
    }
    return S_OK;
}
