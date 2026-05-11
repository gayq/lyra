#![doc(html_no_source)]
#![deny(clippy::todo)]
#![allow(unexpected_cfgs)]

use std::{fs::read_to_string, future::Future, net::IpAddr, pin::Pin};

use anyhow::{anyhow, Context, Result};
use clap::Parser;
use config::{validate_config_cache, BindAddr, Cli, Config, RuntimeFlavor, StatsEndpoint};
use futures_util::{future::select_all, FutureExt, TryFutureExt};
use handle::{handle_wisp, handle_wsproxy, wisp::wispnet::handle_wispnet};
use hickory_resolver::{
    config::{NameServerConfigGroup, ResolverConfig},
    name_server::TokioConnectionProvider,
    system_conf::read_system_conf,
    TokioResolver,
};
use lazy_static::lazy_static;
use listener::ServerListener;
use log::{debug, error, info, trace, warn};
use route::{route_stats, ServerRouteResult};
use stats::generate_stats;
#[cfg(not(target_os = "windows"))]
use tokio::signal::unix::{signal, SignalKind};

use dashmap::DashMap;
use std::sync::Arc;
use tokio::{runtime, sync::oneshot};
use uuid::Uuid;
use wisp_mux::packet::ConnectPacket;

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
                tokio::net::lookup_host(host + ":0").await?.map(|x| x.ip()),
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
                    .context("failed to read config")
                    .unwrap(),
            )
            .context("failed to parse config")
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
                warn!("unable to read system dns configuration. using system dns resolver with no caching");
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

    let mut builder: runtime::Builder = match CONFIG.server.runtime {
        RuntimeFlavor::SingleThread => runtime::Builder::new_current_thread(),
        RuntimeFlavor::MultiThread => runtime::Builder::new_multi_thread(),
        #[cfg(tokio_unstable)]
        RuntimeFlavor::MultiThreadAlt => runtime::Builder::new_multi_thread_alt(),

        RuntimeFlavor::ThreadPerCore => return threadpercore_main(),
    };

    builder.enable_all();
    let rt = builder.build()?;

    rt.block_on(async move {
        tokio::spawn(async_main()).await??;
        Ok(())
    })
}

#[doc(hidden)]
async fn async_init() {
    #[cfg(feature = "tokio-console")]
    console_subscriber::init();

    validate_config_cache().await;

    info!("listening on {}!!", CONFIG.server.bind.1);

    trace!("CLI: {:#?}", &*CLI);
    trace!("CONFIG: {:#?}", &*CONFIG);
    trace!("RESOLVER: {:?}", &*RESOLVER);
}

#[doc(hidden)]
fn threadpercore_main() -> Result<()> {
    let rt = runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;

    rt.block_on(async_init());

    let cores = std::thread::available_parallelism()?.get();

    let mut threads = Vec::with_capacity(cores);

    for _ in 1..cores {
        threads.push(Box::pin(
            threadpercore_init_thread(listen_wisp())
                .map_err(|x| anyhow!(x))
                .map(|x| x?),
        ) as Pin<Box<dyn Future<Output = Result<()>>>>);
    }

    rt.block_on(async move {
        tokio::spawn(listen_stats_cli());

        if let Some(bind_addr) = CONFIG
            .server
            .stats_endpoint
            .as_ref()
            .and_then(StatsEndpoint::get_bindaddr)
        {
            tokio::spawn(listen_stats(bind_addr));
        }

        let wisp = Box::pin(
            tokio::spawn(listen_wisp())
                .map_err(|x| anyhow!(x))
                .map(|x| x?),
        ) as Pin<Box<dyn Future<Output = Result<()>>>>;

        select_all(threads.into_iter().chain(std::iter::once(wisp)))
            .await
            .0
    })
}

#[doc(hidden)]
fn threadpercore_init_thread<T: Send + 'static>(
    func: impl Future<Output = Result<T>> + Sync + Send + 'static,
) -> oneshot::Receiver<Result<T>> {
    let (tx, rx) = oneshot::channel();
    std::thread::spawn(move || {
        let ret = (|| {
            let rt = runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;

            debug!("created threadpercore thread");

            rt.block_on(func)
        })();

        let _ = tx.send(ret.context("thread per core thread failed"));
    });
    rx
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

    listen_wisp().await
}

#[doc(hidden)]
async fn listen_stats_cli() {
    #[cfg(not(target_os = "windows"))]
    {
        let mut sig = signal(SignalKind::user_defined1()).unwrap();
        while sig.recv().await.is_some() {
            match generate_stats().await {
                Ok(stats) => info!("Stats:\n{}", stats),
                Err(err) => error!("error while creating stats {:?}", err),
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        let mut sig = tokio::signal::windows::ctrl_c().unwrap();
        while sig.recv().await.is_some() {
            match generate_stats().await {
                Ok(stats) => info!("Stats:\n{}", stats),
                Err(err) => error!("error while creating stats {:?}", err),
            }
        }
    }
}

#[doc(hidden)]
async fn listen_stats(bind_addr: BindAddr) -> Result<()> {
    info!("stats server listening on {:?}", bind_addr);
    let mut stats_listener = ServerListener::new(&bind_addr)
        .await
        .with_context(|| format!("failed to bind to address {} for stats server", bind_addr.1))?;

    loop {
        match stats_listener.accept().await {
            Ok((stream, _)) => {
                tokio::spawn(async move {
                    if let Err(e) = Box::pin(route_stats(stream)).await {
                        error!("error while routing stats client: {:?}", e);
                    }
                });
            }
            Err(e) => error!("error while accepting stats client: {:?}", e),
        }
    }
}

#[doc(hidden)]
async fn listen_wisp() -> Result<()> {
    let mut listener = ServerListener::new(&CONFIG.server.bind)
        .await
        .with_context(|| format!("failed to bind to address {}", CONFIG.server.bind.1))?;

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
                    let res = Box::pin(route::route(
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

                    if let Err(e) = res {
                        error!("error while routing client: {:?}", e);
                    }
                });
            }
            Err(e) => error!("error while accepting client: {:?}", e),
        }
    }
}

#[doc(hidden)]
fn handle_stream(stream: ServerRouteResult, id: String) {
    tokio::spawn(async move {
        CLIENTS.insert(id.clone(), (Arc::new(DashMap::new()), format!("{stream}")));
        let res = match stream {
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
        if let Err(e) = res {
            error!("error while handling client: {:?}", e);
        }
        CLIENTS.remove(&id);
    });
}