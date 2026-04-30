use sysinfo::System;

pub struct CloudSyncTuning {
    pub db_pool_max: u32,
    pub db_pool_min_idle: u32,
    pub write_semaphore_permits: usize,
    pub db_cache_size_kb: i64,
    pub body_limit_mb: usize,
}

pub fn detect() -> CloudSyncTuning {
    let mut sys = System::new();
    sys.refresh_memory();
    let ram_mb = sys.total_memory() / (1024 * 1024);
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);

    tracing::info!(
        "detected system: {}MB RAM, {} cores",
        ram_mb,
        cores
    );

    compute(ram_mb, cores)
}

fn compute(ram_mb: u64, cores: usize) -> CloudSyncTuning {
    let db_pool_max = ((cores * 2) as u32).max(4).min(32);
    let db_pool_min_idle = (db_pool_max / 5).max(2);

    let write_semaphore_permits = (cores * 6).max(4).min(100);

    let db_cache_size_kb = if ram_mb < 4096 {
        8000
    } else if ram_mb < 8192 {
        16000
    } else if ram_mb < 16384 {
        32000
    } else {
        64000
    };

    let body_limit_mb = if ram_mb < 4096 { 40 } else { 80 };

    CloudSyncTuning {
        db_pool_max,
        db_pool_min_idle,
        write_semaphore_permits,
        db_cache_size_kb,
        body_limit_mb,
    }
}