use sysinfo::System;

pub struct CloudSyncTuning {
    pub db_pool_max: u32,
    pub db_pool_min_idle: u32,
    pub auth_work_min: usize,
    pub auth_work_permits: usize,
    pub auth_work_max: usize,
    pub sync_work_min: usize,
    pub sync_work_permits: usize,
    pub sync_work_max: usize,
    pub db_cache_size_kb: i64,
    pub db_mmap_size: i64,
    pub body_limit_mb: usize,
}

pub fn detect() -> CloudSyncTuning {
    let mut sys = System::new();
    sys.refresh_memory();
    let (memory_bytes, _) =
        adaptive_capacity::memory_budget(sys.total_memory(), sys.available_memory());
    let host_ram_mb = memory_bytes / (1024 * 1024);
    let configured_ram_mb = std::env::var("CLOUDSYNC_MEMORY_MB")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value >= 128);
    let ram_mb = configured_ram_mb
        .map(|limit| limit.min(host_ram_mb))
        .unwrap_or(host_ram_mb);
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);

    tracing::info!("detected system: {}mb usable ram, {} cores", ram_mb, cores);

    compute(ram_mb, cores)
}

fn compute(ram_mb: u64, cores: usize) -> CloudSyncTuning {
    let db_pool_max = (cores as u32).clamp(4, 12);
    let db_pool_min_idle = (db_pool_max / 6).max(1);

    let body_limit_mb = (ram_mb / 24).clamp(16, 64) as usize;
    let auth_work_min = 1;
    let auth_work_max = cores.clamp(2, 32);
    let auth_work_permits = cores.div_ceil(2).clamp(auth_work_min, auth_work_max);
    let sync_work_min = 1;
    let sync_memory_budget_mb = (ram_mb as usize).saturating_mul(3) / 5;
    let sync_memory_bound = (sync_memory_budget_mb / 192).max(1);
    let sync_work_max = cores
        .saturating_mul(2)
        .min(sync_memory_bound)
        .clamp(sync_work_min, 16);
    let sync_work_permits = cores.clamp(sync_work_min, sync_work_max);

    let db_cache_size_kb = if ram_mb < 4096 {
        8 * 1024
    } else if ram_mb < 8192 {
        16 * 1024
    } else {
        32 * 1024
    };

    let db_mmap_size = if ram_mb < 4096 {
        64 * 1024 * 1024
    } else if ram_mb < 8192 {
        128 * 1024 * 1024
    } else {
        256 * 1024 * 1024
    };

    CloudSyncTuning {
        db_pool_max,
        db_pool_min_idle,
        auth_work_min,
        auth_work_permits,
        auth_work_max,
        sync_work_min,
        sync_work_permits,
        sync_work_max,
        db_cache_size_kb,
        db_mmap_size,
        body_limit_mb,
    }
}