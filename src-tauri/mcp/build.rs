include!("../win7-shims/link_args.rs");

fn main() {
    // kb-mcp 是独立 Rust 进程（stdio MCP sidecar），std / getrandom / parking_lot
    // 同样会静态导入 Win8+ API，因此在 win7-compat feature 下复用主应用的
    // win7-shims 源码与链接参数。子系统保持 CONSOLE（stdio 通道）。
    if std::env::var("CARGO_FEATURE_WIN7_COMPAT").is_ok() {
        #[cfg(target_os = "windows")]
        {
            println!("cargo:rustc-link-arg=/SUBSYSTEM:CONSOLE,6.01");
            win7_link_args();
        }
    }

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=../win7-shims/link_args.rs");
}
