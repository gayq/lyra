fn main() {
	println!("cargo:rustc-env=VERGEN_GIT_SHA=unknown");
	println!("cargo:rustc-env=VERGEN_GIT_DIRTY=false");
	println!("cargo:rustc-env=VERGEN_RUSTC_SEMVER=unknown");
	println!("cargo:rustc-env=VERGEN_RUSTC_HOST_TRIPLE=unknown");
}