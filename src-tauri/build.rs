fn main() {
    #[cfg(target_os = "windows")]
    {
        // 锁定 PE 子系统版本为 Windows 7 (6.1)，防止引入 Win8+ API
        // 使用 rustc-link-arg 而非全局 rustflags：避免影响 build script 的编译
        //（build script 需要 console 子系统，不能用 GUI 子系统）
        println!("cargo:rustc-link-arg=/SUBSYSTEM:WINDOWS,6.01");

        // DELAYLOAD api-ms-win-core-synch-l1-2-0.dll：
        // Win7 没有此 DLL。将其所有导入标记为延迟加载，函数首次调用时才解析。
        // Rust std 调用 WaitOnAddress 前会检查 OS 版本，Win7 不会真正调用，
        // 但链接器需要 DELAYLOAD 来避免进程启动时加载失败。
        // C stub (win7_stubs.c) 提供兜底实现以防万一。
        println!("cargo:rustc-link-arg=/DELAYLOAD:api-ms-win-core-synch-l1-2-0.dll");
    }

    #[cfg(all(target_os = "windows", not(debug_assertions)))]
    {
        // release 模式：编译 Win7 C stub 函数
        // 使用 cc crate 编译 win7_stubs.c 为静态库，链接时优先于 DLL 导入库
        cc::Build::new()
            .file("win7_stubs.c")
            .compile("win7_stubs");
    }

    #[cfg(all(target_os = "windows", debug_assertions))]
    {
        // debug 模式也编译，方便本地调试
        cc::Build::new()
            .file("win7_stubs.c")
            .compile("win7_stubs");
    }

    tauri_build::build()
}
