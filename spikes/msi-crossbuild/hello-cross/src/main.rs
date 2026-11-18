fn main() {
    println!(
        "hello from {} ({}), built by cargo-zigbuild",
        std::env::consts::ARCH,
        std::env::consts::OS
    );
}
