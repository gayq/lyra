use std::sync::OnceLock;

pub struct SystemSpecs {
    pub total_ram_mb: u64,
    pub cpu_cores: usize,
}

static SPECS: OnceLock<SystemSpecs> = OnceLock::new();

pub fn get_specs() -> &'static SystemSpecs {
    SPECS.get_or_init(detect)
}

fn detect() -> SystemSpecs {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    let total_ram_mb = sys.total_memory() / (1024 * 1024);
    let cpu_cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);

    log::info!(
        "detected system: {}MB RAM, {} cores",
        total_ram_mb,
        cpu_cores
    );

    SystemSpecs {
        total_ram_mb,
        cpu_cores,
    }
}

pub fn wisp_buffer_size() -> u32 {
    let ram = get_specs().total_ram_mb;
    if ram < 2048 {
        65536
    } else if ram < 4096 {
        131072
    } else if ram < 8192 {
        262144
    } else {
        524288
    }
}

pub fn stream_buffer_size() -> usize {
    let ram = get_specs().total_ram_mb;
    if ram < 2048 {
        131072
    } else if ram < 4096 {
        262144
    } else if ram < 8192 {
        524288
    } else {
        1048576
    }
}

pub fn resolve_cache_max() -> u64 {
    let ram = get_specs().total_ram_mb;
    let max = (ram * 1024 / 200 * 5 / 1000).max(10_000).min(2_000_000);
    max
}

pub fn max_message_size() -> usize {
    let ram = get_specs().total_ram_mb;
    if ram < 4096 {
        8 * 1024 * 1024
    } else if ram < 16384 {
        32 * 1024 * 1024
    } else {
        64 * 1024 * 1024
    }
}