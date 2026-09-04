#![doc(html_no_source)]
#![deny(clippy::todo)]
#![allow(unexpected_cfgs)]

use std::{fs::read_to_string, net::IpAddr, time::Duration};

use adaptive_capacity::{spawn_rebalancer, AdaptiveGate, CapacityTarget, Workload};
use anyhow::{anyhow, Context, Result};
use clap::Parser;
use config::{
    validate_config_cache, BindAddr, Cli, Config, RuntimeFlavor, SocketType, StatsEndpoint,
};
use handle::{handle_wisp, handle_wsproxy, wisp::wispnet::handle_wispnet};
use hickory_resolver::{
    config::{NameServerConfigGroup, ResolverConfig},
    name_server::TokioConnectionProvider,
    system_conf::read_system_conf,
    TokioResolver,
};
use lazy_static::lazy_static;
use listener::ServerListener;
use log::{error, info, trace, warn};
use route::{route_stats, ServerRouteResult};
use stats::generate_stats;
#[cfg(not(target_os = "windows"))]
use tokio::signal::unix::{signal, SignalKind};

use dashmap::DashMap;
use std::sync::{Arc, OnceLock};
use tokio::{runtime, task::JoinSet};
use uuid::Uuid;
use wisp_mux::packet::ConnectPacket;

pub(crate) const NEGATIVE: &str = "... /ᐠ - ˕ -マ";
pub(crate) const POSITIVE: &str = "!! (˵◝ ⩊  ◜˵マ";

macro_rules! negative_message {
    ($message:literal) => {
        concat!($message, "... /ᐠ - ˕ -マ")
    };
}

pub mod config;
#[doc(hidden)]
mod handle;
#[doc(hidden)]
mod listener;
#[doc(hidden)]
mod route;
#[doc(hidden)]
mod stats;
#[doc(hidden)]
mod stream;
pub mod tuning;
#[doc(hidden)]
mod upgrade;
#[doc(hidden)]
mod util_chain;
#[doc(hidden)]
mod util_map_err;

type Client = (Arc<DashMap<Uuid, (ConnectPacket, ConnectPacket)>>, String);

#[doc(hidden)]
#[derive(Debug)]
pub enum Resolver {
    Hickory(Box<TokioResolver>),
    System,
}

impl Resolver {
    pub async fn resolve(&self, host: String) -> anyhow::Result<Box<dyn Iterator<Item = IpAddr>>> {
        match self {
            Self::Hickory(resolver) => Ok(Box::new(resolver.lookup_ip(host).await?.into_iter())
                as Box<dyn Iterator<Item = IpAddr>>),
            Self::System => Ok(Box::new(
                tokio::net::lookup_host(host + ":0")
                    .await?
                    .map(|address| address.ip()),
            ) as Box<dyn Iterator<Item = IpAddr>>),
        }
    }

    pub fn clear_cache(&self) {
        match self {
            Self::Hickory(resolver) => resolver.clear_cache(),
            Self::System => {}
        }
    }
}

lazy_static! {
    #[doc(hidden)]
    pub static ref CLI: Cli = Cli::parse();
    #[doc(hidden)]
    pub static ref CONFIG: Config = {
        if let Some(path) = &CLI.config {
            Config::de(
                &read_to_string(path)
                    .context(negative_message!("failed to read config"))
                    .unwrap(),
            )
            .context(negative_message!("failed to parse config"))
            .unwrap()
        } else {
            Config::default()
        }
    };
    pub static ref CLIENTS: DashMap<String, Client> = DashMap::new();
    #[doc(hidden)]
    pub static ref RESOLVER: Resolver = {
        if CONFIG.stream.dns_servers.is_empty() {
            if let Ok((config, opts)) = read_system_conf() {
                Resolver::Hickory(Box::new(TokioResolver::builder_with_config(config, TokioConnectionProvider::default()).with_options(opts).build()))
            } else {
                warn!(
                    "unable to read system dns configuration; using the system resolver without caching{}",
                    NEGATIVE
                );
                Resolver::System
            }
        } else {
            Resolver::Hickory(Box::new(TokioResolver::builder_with_config(ResolverConfig::from_parts(
                    None,
                    Vec::new(),
                    NameServerConfigGroup::from_ips_clear(&CONFIG.stream.dns_servers, 53, true),
                ), TokioConnectionProvider::default()).build()))

        }
    };
}

static CONNECTION_GATE: OnceLock<Arc<AdaptiveGate>> = OnceLock::new();
static STREAM_GATE: OnceLock<Arc<AdaptiveGate>> = OnceLock::new();

pub fn connection_gate() -> &'static Arc<AdaptiveGate> {
    CONNECTION_GATE
        .get()
        .expect(negative_message!("connection capacity is not initialized"))
}

pub fn stream_gate() -> &'static Arc<AdaptiveGate> {
    STREAM_GATE
        .get()
        .expect(negative_message!("stream capacity is not initialized"))
}

fn init_capacity() {
    if CONNECTION_GATE.get().is_some() {
        return;
    }
    let specs = tuning::get_specs();
    let memory_bytes = specs.total_ram_mb.saturating_mul(1024 * 1024);
    let connection_memory = (CONFIG.wisp.buffer_size as u64)
        .saturating_mul(4)
        .saturating_add(512 * 1024);
    let stream_memory = (CONFIG.stream.buffer_size as u64)
        .saturating_mul(2)
        .saturating_add(128 * 1024);
    let connection_min = specs.cpu_cores.max(1);
    let connection_max = memory_bytes
        .saturating_div(8)
        .saturating_div(connection_memory)
        .max(connection_min as u64)
        .min(specs.cpu_cores.saturating_mul(256) as u64) as usize;
    let connection_initial = specs
        .cpu_cores
        .saturating_mul(32)
        .clamp(connection_min, connection_max);
    let stream_min = specs.cpu_cores.saturating_mul(2).max(1);
    let stream_max = memory_bytes
        .saturating_div(4)
        .saturating_div(stream_memory)
        .max(stream_min as u64)
        .min(specs.cpu_cores.saturating_mul(512) as u64) as usize;
    let stream_initial = specs
        .cpu_cores
        .saturating_mul(64)
        .clamp(stream_min, stream_max);
    let connections = AdaptiveGate::new(connection_min, connection_initial, connection_max);
    let streams = AdaptiveGate::new(stream_min, stream_initial, stream_max);
    let _ = CONNECTION_GATE.set(connections.clone());
    let _ = STREAM_GATE.set(streams.clone());
    spawn_rebalancer(
        vec![
            CapacityTarget::new(connections, connection_memory, Workload::Io),
            CapacityTarget::new(streams, stream_memory, Workload::Io),
        ],
        Duration::from_secs(2),
    );
}

#[doc(hidden)]
#[cfg(not(target_os = "windows"))]
#[global_allocator]
static JEMALLOCATOR: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

#[doc(hidden)]
fn main() -> Result<()> {
    if CLI.default_config {
        println!("{}", Config::default().ser()?);
        return Ok(());
    }

    env_logger::builder()
        .filter_level(CONFIG.server.log_level)
        .parse_default_env()
        .init();

    let cores = tuning::get_specs().cpu_cores;
    let mut builder: runtime::Builder = match CONFIG.server.runtime {
        RuntimeFlavor::SingleThread => runtime::Builder::new_current_thread(),
        RuntimeFlavor::MultiThread | RuntimeFlavor::ThreadPerCore => {
            let mut builder = runtime::Builder::new_multi_thread();
            builder.worker_threads(cores);
            builder
        }
        #[cfg(tokio_unstable)]
        RuntimeFlavor::MultiThreadAlt => {
            let mut builder = runtime::Builder::new_multi_thread_alt();
            builder.worker_threads(cores);
            builder
        }
    };

    builder.enable_all();
    let rt = builder.build()?;

    rt.block_on(async_main())
}

#[doc(hidden)]
async fn async_init() {
    #[cfg(feature = "tokio-console")]
    console_subscriber::init();

    validate_config_cache().await;
    init_capacity();

    info!("nuru listening on {}{}", CONFIG.server.bind.1, POSITIVE);
}

#[doc(hidden)]
async fn async_main() -> Result<()> {
    async_init().await;

    tokio::spawn(listen_stats_cli());

    if let Some(bind_addr) = CONFIG
        .server
        .stats_endpoint
        .as_ref()
        .and_then(StatsEndpoint::get_bindaddr)
    {
        tokio::spawn(listen_stats(bind_addr));
    }

    listen_wisp_shards().await
}

#[doc(hidden)]
fn wisp_listener_shards() -> usize {
    listener_shards(
        &CONFIG.server.runtime,
        CONFIG.server.bind.0,
        tuning::get_specs().cpu_cores,
    )
}

#[doc(hidden)]
fn listener_shards(runtime: &RuntimeFlavor, socket_type: SocketType, cores: usize) -> usize {
    if runtime.is_thread_per_core()
        && matches!(socket_type, SocketType::Tcp | SocketType::TlsTcp)
        && !cfg!(target_os = "windows")
    {
        cores.max(1)
    } else {
        1
    }
}

#[doc(hidden)]
async fn listen_wisp_shards() -> Result<()> {
    let mut listeners = JoinSet::new();
    for _ in 0..wisp_listener_shards() {
        listeners.spawn(listen_wisp());
    }

    match listeners.join_next().await {
        Some(Ok(result)) => result,
        Some(Err(error)) => Err(anyhow!(error)),
        None => Ok(()),
    }
}

#[doc(hidden)]
async fn listen_stats_cli() {
    #[cfg(not(target_os = "windows"))]
    {
        let mut sig = signal(SignalKind::user_defined1())
            .expect(negative_message!("failed to register the stats signal"));
        while sig.recv().await.is_some() {
            match generate_stats().await {
                Ok(stats) => info!("stats:\n{}{}", stats, POSITIVE),
                Err(err) => error!("failed to create stats: {:?}{}", err, NEGATIVE),
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        let mut sig = tokio::signal::windows::ctrl_c()
            .expect(negative_message!("failed to register the stats signal"));
        while sig.recv().await.is_some() {
            match generate_stats().await {
                Ok(stats) => info!("stats:\n{}{}", stats, POSITIVE),
                Err(err) => error!("failed to create stats: {:?}{}", err, NEGATIVE),
            }
        }
    }
}

#[doc(hidden)]
async fn listen_stats(bind_addr: BindAddr) -> Result<()> {
    info!("stats server listening on {:?}{}", bind_addr, POSITIVE);
    let mut stats_listener = ServerListener::new(&bind_addr).await.with_context(|| {
        format!(
            "failed to bind to address {} for the stats server{}",
            bind_addr.1, NEGATIVE
        )
    })?;

    loop {
        match stats_listener.accept().await {
            Ok((stream, _)) => {
                tokio::spawn(async move {
                    if let Err(e) = Box::pin(route_stats(stream)).await {
                        error!("failed to route stats client: {:?}{}", e, NEGATIVE);
                    }
                });
            }
            Err(e) => {
                error!("failed to accept stats client: {:?}{}", e, NEGATIVE);
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

#[doc(hidden)]
async fn listen_wisp() -> Result<()> {
    let mut listener = ServerListener::new(&CONFIG.server.bind)
        .await
        .with_context(|| {
            format!(
                "failed to bind to address {}{}",
                CONFIG.server.bind.1, NEGATIVE
            )
        })?;

    let stats_endpoint = CONFIG
        .server
        .stats_endpoint
        .as_ref()
        .and_then(StatsEndpoint::get_endpoint);

    loop {
        let stats_endpoint = stats_endpoint.clone();
        match listener.accept().await {
            Ok((stream, client_id)) => {
                tokio::spawn(async move {
                    let route_result = Box::pin(route::route(
                        stream,
                        stats_endpoint,
                        move |stream, maybe_ip| {
                            let client_id = if let Some(ip) = maybe_ip {
                                format!("{client_id} ({ip})")
                            } else {
                                client_id
                            };

                            trace!("routed {:?}: {}", client_id, stream);
                            handle_stream(stream, client_id);
                        },
                    ))
                    .await;

                    if let Err(error) = route_result {
                        error!("failed to route client: {:?}{}", error, NEGATIVE);
                    }
                });
            }
            Err(error) => {
                error!("failed to accept client: {:?}{}", error, NEGATIVE);
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

#[doc(hidden)]
fn handle_stream(stream: ServerRouteResult, id: String) {
    let Some(connection_permit) = connection_gate().try_acquire() else {
        warn!("tunnel capacity is temporarily exhausted{}", NEGATIVE);
        return;
    };
    tokio::spawn(async move {
        let _connection_permit = connection_permit;
        CLIENTS.insert(id.clone(), (Arc::new(DashMap::new()), format!("{stream}")));
        let handler_result = match stream {
            ServerRouteResult::Wisp {
                stream,
                has_ws_protocol,
            } => Box::pin(handle_wisp(stream, has_ws_protocol, id.clone())).await,
            ServerRouteResult::Wispnet { stream } => {
                Box::pin(handle_wispnet(stream, id.clone())).await
            }
            ServerRouteResult::WsProxy { stream, path, udp } => {
                Box::pin(handle_wsproxy(stream, id.clone(), path, udp)).await
            }
        };
        if let Err(error) = handler_result {
            error!("failed to handle client: {:?}{}", error, NEGATIVE);
        }
        CLIENTS.remove(&id);
    });
}

#[cfg(test)]
mod tests {
    use super::{listener_shards, RuntimeFlavor, SocketType, NEGATIVE, POSITIVE};

    #[test]
    fn runtime_endings_are_exact() {
        assert_eq!(
            negative_message!("request failed"),
            "request failed... /ᐠ - ˕ -マ"
        );
        assert_eq!(NEGATIVE, "... /ᐠ - ˕ -マ");
        assert_eq!(POSITIVE, "!! (˵◝ ⩊  ◜˵マ");
    }

    #[test]
    fn listener_sharding_is_safe_for_the_transport() {
        assert_eq!(
            listener_shards(&RuntimeFlavor::MultiThread, SocketType::Tcp, 8),
            1
        );
        assert_eq!(
            listener_shards(&RuntimeFlavor::ThreadPerCore, SocketType::Unix, 8),
            1
        );
        assert_eq!(
            listener_shards(&RuntimeFlavor::ThreadPerCore, SocketType::Tcp, 0),
            1
        );
        assert_eq!(
            listener_shards(&RuntimeFlavor::ThreadPerCore, SocketType::Tcp, 8),
            if cfg!(target_os = "windows") { 1 } else { 8 }
        );
    }
}
