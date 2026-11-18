#![no_main]

libfuzzer_sys::fuzz_target!(|data: &[u8]| rustrmm_fuzzing::frame_decode(data));
