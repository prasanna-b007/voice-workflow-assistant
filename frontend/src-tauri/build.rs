fn main() {
  // Load vulkan-1.dll only when Whisper first uses the GPU, not at startup, so Sonix
  // still starts on a PC with no Vulkan driver. whisper.rs tests for one in a separate
  // process before touching it.
  if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
    println!("cargo:rustc-link-arg-bins=/DELAYLOAD:vulkan-1.dll");
    println!("cargo:rustc-link-arg-bins=delayimp.lib");
  }
  tauri_build::build()
}
