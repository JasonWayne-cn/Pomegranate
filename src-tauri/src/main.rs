// Prevents additional console window on Windows (all profiles, Win7 compat)
#![windows_subsystem = "windows"]

// Win7 兼容：在 bin 目标中内联 stub 与 `__imp_*` IAT 覆盖符号。
// 不能放进 lib（cdylib）——`__imp_` 是保留名，会导致 .exp 生成器 LNK1106。
#[cfg(all(target_os = "windows", feature = "win7-compat"))]
#[path = "../win7-shims/src/lib.rs"]
mod win7_shims;
#[cfg(all(target_os = "windows", feature = "win7-compat"))]
#[path = "../win7-shims/src/imp.rs"]
mod win7_imp;

fn main() {
    #[cfg(all(target_os = "windows", feature = "win7-compat"))]
    win7_imp::force_link();

    intelligent_notebook_lib::run()
}
