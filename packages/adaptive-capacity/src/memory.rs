use std::path::{Component, Path};

pub fn memory_budget(total: u64, available: u64) -> (u64, u64) {
    if !cfg!(target_os = "linux") {
        return (total, available);
    }
    let Ok(membership) = std::fs::read_to_string("/proc/self/cgroup") else {
        return (total, available);
    };
    constrain(total, available, &membership, |path| {
        std::fs::read_to_string(path).ok()
    })
}

fn constrain(
    mut total: u64,
    mut available: u64,
    membership: &str,
    read: impl Fn(&Path) -> Option<String>,
) -> (u64, u64) {
    let Some(group) = membership
        .lines()
        .find_map(|line| line.strip_prefix("0::/"))
    else {
        return (total, available);
    };
    let relative = Path::new(group);
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return (total, available);
    }
    let root = Path::new("/sys/fs/cgroup");
    let mut directory = root.join(relative);
    loop {
        let number = |name: &str| {
            read(&directory.join(name)).and_then(|value| value.trim().parse::<u64>().ok())
        };
        let limit = [number("memory.high"), number("memory.max")]
            .into_iter()
            .flatten()
            .min();
        if let Some(limit) = limit {
            total = total.min(limit);
            if let Some(used) = number("memory.current") {
                available = available.min(limit.saturating_sub(used));
            } else {
                available = available.min(limit);
            }
        }
        if directory == root || !directory.pop() {
            break;
        }
    }
    (total, available.min(total))
}