// DELAYLOAD + __imp_ ALTERNATENAME + FORCE:MULTIPLE
// （与 kb-mcp sidecar 共用同一份链接参数）
include!("win7-shims/link_args.rs");

fn main() {
    // Win7 兼容链接参数仅在 `win7-compat` feature 启用时生效。
    // 普通 Win10/Win11 构建保持 Tauri 默认链接行为，不引入 stub / DELAYLOAD，
    // 避免兼容层对现代系统产生任何行为差异。
    if std::env::var("CARGO_FEATURE_WIN7_COMPAT").is_ok() {
        #[cfg(target_os = "windows")]
        {
            // Release 模式强制 WINDOWS,6.01 兼容 Win7；
            // Debug 保留 CONSOLE 子系统便于查看日志。
            #[cfg(not(debug_assertions))]
            println!("cargo:rustc-link-arg=/SUBSYSTEM:WINDOWS,6.01");

            win7_link_args();
        }
    }

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=win7-shims/link_args.rs");
    tauri_build::build()
}
