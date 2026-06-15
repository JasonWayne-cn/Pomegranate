fn main() {
    #[cfg(target_os = "windows")]
    {
        println!("cargo:rustc-link-arg=/SUBSYSTEM:WINDOWS,6.01");
        println!("cargo:rustc-link-arg=/DELAYLOAD:api-ms-win-core-synch-l1-2-0.dll");
        println!("cargo:rustc-link-arg=/DELAYLOAD:combase.dll");
        println!("cargo:rustc-link-arg=/DELAYLOAD:bcryptprimitives.dll");
        println!("cargo:rustc-link-arg=/DELAYLOAD:api-ms-win-core-winrt-l1-1-0.dll");
        println!("cargo:rustc-link-arg=/DELAYLOAD:api-ms-win-core-winrt-string-l1-1-0.dll");
        println!("cargo:rustc-link-arg=delayimp.lib");

        cc::Build::new()
            .file("win7_stubs.c")
            .compile("win7_stubs");
    }

    tauri_build::build()
}
