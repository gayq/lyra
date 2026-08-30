use std::collections::HashMap;

use serde::Serialize;
use wisp_mux::packet::{ConnectPacket, StreamType};

use crate::{connection_gate, stream::resolve_cache_stats, stream_gate, CLIENTS, CONFIG};

fn format_stream_type(stream_type: StreamType) -> &'static str {
    match stream_type {
        StreamType::Tcp => "tcp",
        StreamType::Udp => "udp",
        #[cfg(feature = "twisp")]
        StreamType::Other(crate::handle::wisp::twisp::STREAM_TYPE) => "twisp",
        StreamType::Other(_) => unreachable!(),
    }
}

#[derive(Serialize)]
struct MemoryStats {
    #[cfg(not(target_os = "windows"))]
    active: usize,
    #[cfg(not(target_os = "windows"))]
    allocated: usize,
    #[cfg(not(target_os = "windows"))]
    mapped: usize,
    #[cfg(not(target_os = "windows"))]
    metadata: usize,
    #[cfg(not(target_os = "windows"))]
    resident: usize,
    #[cfg(not(target_os = "windows"))]
    retained: usize,
}

#[derive(Serialize)]
struct StreamStats {
    stream_type: String,
    requested: String,
    resolved: String,
}

impl From<(ConnectPacket, ConnectPacket)> for StreamStats {
    fn from(value: (ConnectPacket, ConnectPacket)) -> Self {
        Self {
            stream_type: format_stream_type(value.0.stream_type).to_string(),
            requested: format!("{}:{}", value.0.host, value.0.port),
            resolved: format!("{}:{}", value.1.host, value.1.port),
        }
    }
}

#[derive(Serialize)]
struct ClientStats {
    client_type: String,
    streams: HashMap<String, StreamStats>,
}

#[derive(Serialize)]
struct ServerStats {
    config: String,
    clients: HashMap<String, ClientStats>,
    memory: MemoryStats,
    resolve_cache: ResolveCacheStats,
    capacity: CapacityStats,
}

#[derive(Serialize)]
struct ResolveCacheStats {
    entries: usize,
    hits: u64,
    misses: u64,
}

#[derive(Serialize)]
struct GateStats {
    active: usize,
    limit: usize,
    minimum: usize,
    maximum: usize,
    peak: usize,
    waits: u64,
    rejected: u64,
}

#[derive(Serialize)]
struct CapacityStats {
    connections: GateStats,
    streams: GateStats,
}

fn gate_stats(gate: &adaptive_capacity::AdaptiveGate) -> GateStats {
    let snapshot = gate.snapshot();
    GateStats {
        active: snapshot.active,
        limit: snapshot.limit,
        minimum: snapshot.minimum,
        maximum: snapshot.maximum,
        peak: snapshot.peak,
        waits: snapshot.waits,
        rejected: snapshot.rejected,
    }
}

pub async fn generate_stats() -> anyhow::Result<String> {
    #[cfg(not(target_os = "windows"))]
    let memory = {
        use tikv_jemalloc_ctl::stats::{active, allocated, mapped, metadata, resident, retained};
        tikv_jemalloc_ctl::epoch::advance()?;
        MemoryStats {
            active: active::read()?,
            allocated: allocated::read()?,
            mapped: mapped::read()?,
            metadata: metadata::read()?,
            resident: resident::read()?,
            retained: retained::read()?,
        }
    };
    #[cfg(target_os = "windows")]
    let memory = MemoryStats {};

    let mut clients = HashMap::with_capacity(CLIENTS.len());
    for client in CLIENTS.iter() {
        let id = client.key().clone();
        let stream_map = client.value().0.clone();
        let client_type = client.value().1.clone();
        clients.insert(
            id,
            ClientStats {
                client_type,
                streams: stream_map
                    .iter()
                    .map(|x| (x.key().to_string(), StreamStats::from(x.value().clone())))
                    .collect(),
            },
        );
    }

    let stats = ServerStats {
        config: CONFIG.ser()?,
        clients,
        memory,
        resolve_cache: {
            let (entries, hits, misses) = resolve_cache_stats();
            ResolveCacheStats {
                entries,
                hits,
                misses,
            }
        },
        capacity: CapacityStats {
            connections: gate_stats(connection_gate()),
            streams: gate_stats(stream_gate()),
        },
    };

    Ok(serde_json::to_string_pretty(&stats)?)
}
