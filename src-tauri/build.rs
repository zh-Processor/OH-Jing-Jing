fn main() {
    println!("cargo:rerun-if-env-changed=OHJINGJING_BUNDLE_DSH");
    println!(
        "cargo:rustc-env=OHJINGJING_BUNDLED_DESKTOP_HARNESS={}",
        std::env::var("OHJINGJING_BUNDLE_DSH").unwrap_or_default()
    );
    println!(
        "cargo:rustc-env=OHJINGJING_TARGET={}",
        std::env::var("TARGET").unwrap()
    );
    tauri_build::build();
}
