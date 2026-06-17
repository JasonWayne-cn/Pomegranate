#define WINAPI __stdcall
#define INFINITE 0xFFFFFFFF
#define S_OK 0
#define E_OUTOFMEMER 0x8007000E

typedef void *PVOID;
typedef void *LPVOID;
typedef void *LPUNKNOWN;
typedef void *HMODULE;
typedef unsigned long DWORD;
typedef unsigned long HRESULT;
typedef unsigned long long SIZE_T;
typedef unsigned long long ULONGLONG;
typedef ULONGLONG CO_MTA_USAGE_COOKIE;

__declspec(dllimport) PVOID WINAPI LoadLibraryW(const unsigned short *);
__declspec(dllimport) PVOID WINAPI GetProcAddress(PVOID, const char *);

// ═══════════════════════════════════════════════════════
// 运行时检测：Win7 缺 DLL → stub；Win8+ → 转发真实实现
// ═══════════════════════════════════════════════════════

// ─── WaitOnAddress / WakeByAddressSingle / WakeByAddressAll ───
// 来源: api-ms-win-core-synch-l1-2-0.dll (Win8+)
// Win7 上此 DLL 不存在，Rust std 也不使用这些函数（回退到 SleepConditionVariableCS）
// 但链接时必须提供符号，否则 DELAYLOAD 失败程序无法启动
// 修复策略：运行时加载真实 DLL → 转发；加载失败 → stub

static HMODULE synch_dll;
static int synch_inited;

static void synch_init(void)
{
    if (synch_inited) return;
    synch_dll = LoadLibraryW((const unsigned short *)L"api-ms-win-core-synch-l1-2-0.dll");
    synch_inited = 1;
}

void WINAPI WakeByAddressSingle(PVOID Address)
{
    synch_init();
    if (synch_dll) {
        typedef void (WINAPI *fn)(PVOID);
        fn f = (fn)GetProcAddress(synch_dll, "WakeByAddressSingle");
        if (f) { f(Address); return; }
    }
    (void)Address;
}

void WINAPI WakeByAddressAll(PVOID Address)
{
    synch_init();
    if (synch_dll) {
        typedef void (WINAPI *fn)(PVOID);
        fn f = (fn)GetProcAddress(synch_dll, "WakeByAddressAll");
        if (f) { f(Address); return; }
    }
    (void)Address;
}

int WINAPI WaitOnAddress(
    void volatile *Address,
    void *CompareAddress,
    SIZE_T AddressSize,
    DWORD dwMilliseconds)
{
    synch_init();
    if (synch_dll) {
        typedef int (WINAPI *fn)(void volatile *, void *, SIZE_T, DWORD);
        fn f = (fn)GetProcAddress(synch_dll, "WaitOnAddress");
        if (f) return f(Address, CompareAddress, AddressSize, dwMilliseconds);
    }
    // Win7 fallback: Sleep-based wait（Rust std 在 Win7 上不用此函数，
    // 此 stub 仅为防止链接符号缺失导致程序无法启动）
    (void)Address;
    (void)CompareAddress;
    (void)AddressSize;
    if (dwMilliseconds == INFINITE) {
        dwMilliseconds = 1000;
    }
    typedef void (WINAPI *SleepFn)(DWORD);
    PVOID k32 = LoadLibraryW((const unsigned short *)L"kernel32.dll");
    SleepFn fn = k32 ? (SleepFn)GetProcAddress(k32, "Sleep") : 0;
    if (fn) fn(dwMilliseconds);
    return 1;
}

// ─── COM runtime (combase.dll / ole32.dll) ───
// CoTaskMemFree / CoTaskMemAlloc / CoCreateFreeThreadedMarshaler
//   所有 Windows 版本的 ole32.dll 都提供，直接转发即可
// CoIncrementMTAUsage
//   Win8+ 在 combase.dll，Win7 需 stub

static PVOID ole32_module(void)
{
    static PVOID h = 0;
    if (!h) h = LoadLibraryW((const unsigned short *)L"ole32.dll");
    return h;
}

static PVOID lookup_ole32(const char *name)
{
    PVOID mod = ole32_module();
    return mod ? GetProcAddress(mod, name) : 0;
}

void WINAPI CoTaskMemFree(LPVOID pv)
{
    typedef void (WINAPI *fn)(LPVOID);
    fn f = (fn)lookup_ole32("CoTaskMemFree");
    if (f) f(pv);
}

LPVOID WINAPI CoTaskMemAlloc(SIZE_T cb)
{
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

HRESULT WINAPI CoIncrementMTAUsage(CO_MTA_USAGE_COOKIE *pCookie)
{
    // 先试 combase.dll (Win8+)，失败则 stub (Win7)
    static HMODULE combase;
    static int combase_inited;
    if (!combase_inited) {
        combase = LoadLibraryW((const unsigned short *)L"combase.dll");
        combase_inited = 1;
    }
    if (combase) {
        typedef HRESULT (WINAPI *fn)(CO_MTA_USAGE_COOKIE *);
        fn f = (fn)GetProcAddress(combase, "CoIncrementMTAUsage");
        if (f) return f(pCookie);
    }
    // Win7 stub
    if (pCookie) {
        *pCookie = (CO_MTA_USAGE_COOKIE)1;
    }
    return S_OK;
}

// ─── ProcessPrng (bcryptprimitives.dll, Win8+) → RtlGenRandom (advapi32.dll, XP+) ───
// getrandom crate 在 Windows 上默认调用 ProcessPrng。
// Win7 的 bcryptprimitives.dll 不含此函数，但 advapi32.dll 的 SystemFunction036
// (RtlGenRandom) 自 XP 起就可用，签名兼容。此转发对所有 Windows 版本都是正确且安全的。

__declspec(dllimport) unsigned char WINAPI SystemFunction036(void *, unsigned long);

int WINAPI ProcessPrng(void *pbData, unsigned long long cbData)
{
    if (cbData > 0xFFFFFFFFull) {
        return 0xC000000D; // STATUS_INVALID_PARAMETER
    }
    // SystemFunction036/RtlGenRandom: TRUE=成功, FALSE=失败
    // ProcessPrng: 0=成功, 非0=NTSTATUS错误码
    return SystemFunction036(pbData, (unsigned long)cbData) ? 0 : 0xC000000F;
}
