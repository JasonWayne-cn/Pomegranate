fn main() {
    // 锁定 PE 子系统版本为 Windows 7 (6.1)，防止引入 Win8+ API
    // 使用 rustc-link-arg 而非全局 rustflags：避免影响 build script 的编译
    //（build script 需要 console 子系统，不能用 GUI 子系统）
    #[cfg(target_os = "windows")]
    println!("cargo:rustc-link-arg=/SUBSYSTEM:WINDOWS,6.01");
    tauri_build::build()
}
