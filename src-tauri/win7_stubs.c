#define WINAPI __stdcall
#define INFINITE 0xFFFFFFFF
#define S_OK 0
#define E_OUTOFMEMER 0x8007000E

typedef void *PVOID;
typedef void *LPVOID;
typedef void *LPUNKNOWN;
typedef unsigned long DWORD;
typedef unsigned long HRESULT;
typedef unsigned long long SIZE_T;
typedef unsigned long long ULONGLONG;
typedef ULONGLONG CO_MTA_USAGE_COOKIE;

__declspec(dllimport) PVOID WINAPI LoadLibraryW(const unsigned short *);
__declspec(dllimport) PVOID WINAPI GetProcAddress(PVOID, const char *);
__declspec(dllimport) void WINAPI Sleep(DWORD);

void WINAPI WakeByAddressSingle(PVOID Address)
{
    (void)Address;
}

void WINAPI WakeByAddressAll(PVOID Address)
{
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
    if (dwMilliseconds == INFINITE) {
        dwMilliseconds = 1000;
    }
    Sleep(dwMilliseconds);
    return 1;
}

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
    if (pCookie) {
        *pCookie = (CO_MTA_USAGE_COOKIE)1;
    }
    return S_OK;
}
