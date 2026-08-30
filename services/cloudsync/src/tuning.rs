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
    let ram_mb = sys.total_memory() / (1024 * 1024);
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);

    tracing::info!("detected system: {}mb ram, {} cores", ram_mb, cores);

    compute(ram_mb, cores)
}

fn compute(ram_mb: u64, cores: usize) -> CloudSyncTuning {
    let db_pool_max = (cores as u32).clamp(4, 12);
    let db_pool_min_idle = (db_pool_max / 6).max(1);

    let body_limit_mb = (ram_mb / 128).clamp(8, 64) as usize;
    let auth_work_min = 1;
    let auth_work_max = cores.clamp(2, 32);
    let auth_work_permits = cores.div_ceil(2).clamp(auth_work_min, auth_work_max);
    let sync_work_min = 1;
    let sync_memory_bound = (ram_mb as usize / body_limit_mb.saturating_mul(6)).max(1);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heavy_work_and_database_limits_stay_bounded() {
        let tiny = compute(256, 1);
        assert_eq!(tiny.sync_work_permits, 1);
        assert_eq!(tiny.db_pool_max, 4);
        assert_eq!(tiny.body_limit_mb, 8);

        let large = compute(65_536, 64);
        assert_eq!(large.sync_work_permits, 16);
        assert_eq!(large.db_pool_max, 12);
        assert_eq!(large.body_limit_mb, 64);
        assert_eq!(large.auth_work_permits, 32);
        assert!(large.db_pool_max as i64 * large.db_cache_size_kb <= 384 * 1024);
    }
}
