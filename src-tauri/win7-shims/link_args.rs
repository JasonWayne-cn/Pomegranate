// Win7 兼容共享链接参数（由 src-tauri/build.rs 与 mcp/build.rs include!）
//
// 1. DELAYLOAD：Win8+ DLL 不在启动阶段解析
// 2. bin 目标中内联的 `__imp_<func>` 定义（win7-shims/src/imp.rs）通过
//    /FORCE:MULTIPLE 覆盖系统导入库中的同名 IAT 符号，彻底消除导入表项。
// 3. /ALTERNATENAME 仅用于以直接调用形式引用的 EventSetInformation。

fn win7_link_args() {
    println!("cargo:rustc-link-arg=/DELAYLOAD:api-ms-win-core-synch-l1-2-0.dll");
    println!("cargo:rustc-link-arg=/DELAYLOAD:combase.dll");
    println!("cargo:rustc-link-arg=/DELAYLOAD:bcryptprimitives.dll");
    println!("cargo:rustc-link-arg=/DELAYLOAD:api-ms-win-core-winrt-l1-1-0.dll");
    println!("cargo:rustc-link-arg=/DELAYLOAD:api-ms-win-core-winrt-string-l1-1-0.dll");
    println!("cargo:rustc-link-arg=delayimp.lib");

    // advapi32!EventSetInformation 由 Rust 以直接调用形式引用（非 __imp_），
    // 需要把函数符号本身重定向到同名包装函数。
    println!("cargo:rustc-link-arg=/ALTERNATENAME:EventSetInformation=win7_fn_EventSetInformation");

    println!("cargo:rustc-link-arg=/FORCE:MULTIPLE");
}
