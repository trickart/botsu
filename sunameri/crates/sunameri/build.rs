// Boa(JS エンジン)の再帰はスタックを多く使うため、macOS ではメインスレッドのスタックを 512MB にする
// (仮想サイズのみ。実際に使った分だけコミットされる)。Linux では ulimit -s またはスレッド生成で対処する。
fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os == "macos" {
        println!("cargo:rustc-link-arg-bins=-Wl,-stack_size,0x20000000");
    }
}
