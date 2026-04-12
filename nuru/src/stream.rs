use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    str::FromStr,
    sync::atomic::{AtomicU64, Ordering},
    sync::OnceLock,
    time::Duration,
};

use anyhow::Context;
use base64::{prelude::BASE64_STANDARD, Engine};
use bytes::BytesMut;
use cfg_if::cfg_if;
use futures_util::{SinkExt, StreamExt};
use hyper::upgrade::Upgraded;
use hyper_util::rt::TokioIo;
use log::debug;
use regex::RegexSet;
use socket2::SockRef;
use tokio::net::{TcpStream, UdpSocket};
use tokio::time::timeout;
use tokio_websockets::{CloseCode, Message, Payload, WebSocketStream};
use wisp_mux::{packet::{ConnectPacket, StreamType}, stream::MuxStream};

use moka::sync::Cache as MokaCache;

use crate::{route::WispStreamWrite, CONFIG, RESOLVER};

#[derive(Clone)]
enum CachedResolvedPacket {
    Valid(ConnectPacket),
    ValidWispnet(u32, ConnectPacket),
    NoResolvedAddrs,
    Blocked,
    Invalid,
}

static RESOLVE_CACHE: OnceLock<MokaCache<String, CachedResolvedPacket>> = OnceLock::new();

fn get_resolve_cache() -> &'static MokaCache<String, CachedResolvedPacket> {
    RESOLVE_CACHE.get_or_init(|| {
        let ttl = crate::CONFIG.wisp.resolve_cache_ttl_secs.max(1);
        let max_entries = crate::CONFIG.wisp.resolve_cache_max_entries.max(1) as u64;
        MokaCache::builder()
            .max_capacity(max_entries)
            .time_to_live(std::time::Duration::from_secs(ttl))
            .build()
    })
}

static RESOLVE_CACHE_HITS: AtomicU64 = AtomicU64::new(0);
static RESOLVE_CACHE_MISSES: AtomicU64 = AtomicU64::new(0);

pub fn resolve_cache_stats() -> (usize, u64, u64) {
    let entries = RESOLVE_CACHE
        .get()
        .map(|c| c.entry_count() as usize)
        .unwrap_or(0);
    (
        entries,
        RESOLVE_CACHE_HITS.load(Ordering::Relaxed),
        RESOLVE_CACHE_MISSES.load(Ordering::Relaxed),
    )
}

pub fn clear_resolve_cache() {
    if let Some(cache) = RESOLVE_CACHE.get() {
        cache.invalidate_all();
    }
}

fn stream_type_cache_key(stream_type: StreamType) -> &'static str {
    match stream_type {
        StreamType::Tcp => "tcp",
        StreamType::Udp => "udp",
        StreamType::Other(_) => "other",
    }
}

fn resolve_cache_key(packet: &ConnectPacket) -> String {
    let stream = stream_type_cache_key(packet.stream_type);
    let mut key = String::with_capacity(stream.len() + packet.host.len() + 8);
    key.push_str(stream);
    key.push('|');
    key.push_str(&packet.port.to_string());
    key.push('|');
    key.push_str(&packet.host);
    key
}

fn to_cached(packet: &ResolvedPacket) -> CachedResolvedPacket {
    match packet {
        ResolvedPacket::Valid(x) => CachedResolvedPacket::Valid(x.clone()),
        ResolvedPacket::ValidWispnet(server, x) => {
            CachedResolvedPacket::ValidWispnet(*server, x.clone())
        }
        ResolvedPacket::NoResolvedAddrs => CachedResolvedPacket::NoResolvedAddrs,
        ResolvedPacket::Blocked => CachedResolvedPacket::Blocked,
        ResolvedPacket::Invalid => CachedResolvedPacket::Invalid,
    }
}

fn from_cached(packet: &CachedResolvedPacket) -> ResolvedPacket {
    match packet {
        CachedResolvedPacket::Valid(x) => ResolvedPacket::Valid(x.clone()),
        CachedResolvedPacket::ValidWispnet(server, x) => {
            ResolvedPacket::ValidWispnet(*server, x.clone())
        }
        CachedResolvedPacket::NoResolvedAddrs => ResolvedPacket::NoResolvedAddrs,
        CachedResolvedPacket::Blocked => ResolvedPacket::Blocked,
        CachedResolvedPacket::Invalid => ResolvedPacket::Invalid,
    }
}

fn match_addr(str: &str, allowed: &RegexSet, blocked: &RegexSet) -> bool {
    blocked.is_match(str) && !allowed.is_match(str)
}

fn allowed_set(stream_type: StreamType) -> &'static RegexSet {
    match stream_type {
        StreamType::Tcp => CONFIG.stream.allowed_tcp_hosts(),
        StreamType::Udp => CONFIG.stream.allowed_udp_hosts(),
        StreamType::Other(_) => unreachable!(),
    }
}

fn blocked_set(stream_type: StreamType) -> &'static RegexSet {
    match stream_type {
        StreamType::Tcp => CONFIG.stream.blocked_tcp_hosts(),
        StreamType::Udp => CONFIG.stream.blocked_udp_hosts(),
        StreamType::Other(_) => unreachable!(),
    }
}

pub enum ClientStream {
    Tcp(TcpStream),
    Udp(UdpSocket),
    #[cfg(feature = "twisp")]
    Pty(tokio::process::Child, pty_process::Pty),
    Wispnet(MuxStream<WispStreamWrite>, String),

    NoResolvedAddrs,
    Blocked,
    Invalid,
}

fn ipv4_is_global(addr: Ipv4Addr) -> bool {
    !(addr.octets()[0] == 0
        || addr.is_private()
        || (addr.octets()[0] == 100 && (addr.octets()[1] & 0b1100_0000 == 0b0100_0000))
        || addr.is_loopback()
        || addr.is_link_local()
        || (addr.octets()[0] == 192
            && addr.octets()[1] == 0
            && addr.octets()[2] == 0
            && addr.octets()[3] != 9
            && addr.octets()[3] != 10)
        || addr.is_documentation()
        || (addr.octets()[0] == 198 && (addr.octets()[1] & 0xfe) == 18)
        || (addr.octets()[0] & 240 == 240)
        || addr.is_broadcast())
}
fn ipv6_is_global(addr: Ipv6Addr) -> bool {
    !(addr.is_unspecified()
        || addr.is_loopback()
        || matches!(addr.segments(), [0, 0, 0, 0, 0, 0xffff, _, _])
        || matches!(addr.segments(), [0x64, 0xff9b, 1, _, _, _, _, _])
        || matches!(addr.segments(), [0x100, 0, 0, 0, _, _, _, _])
        || (matches!(addr.segments(), [0x2001, b, _, _, _, _, _, _] if b < 0x200)
            && !(u128::from_be_bytes(addr.octets()) == 0x2001_0001_0000_0000_0000_0000_0000_0001
                || u128::from_be_bytes(addr.octets())
                    == 0x2001_0001_0000_0000_0000_0000_0000_0002
                || matches!(addr.segments(), [0x2001, 3, _, _, _, _, _, _])
                || matches!(addr.segments(), [0x2001, 4, 0x112, _, _, _, _, _])
                || matches!(addr.segments(), [0x2001, b, _, _, _, _, _, _] if (0x20..=0x3F).contains(&b))))
        || matches!(addr.segments(), [0x2002, _, _, _, _, _, _, _])
        || ((addr.segments()[0] == 0x2001) && (addr.segments()[1] == 0xdb8))
        || (addr.segments()[0] & 0xfe00) == 0xfc00
        || (addr.segments()[0] & 0xfe00) == 0xfc00)
}
fn is_global(addr: IpAddr) -> bool {
    match addr {
        IpAddr::V4(x) => ipv4_is_global(x),
        IpAddr::V6(x) => ipv6_is_global(x),
    }
}

pub enum ResolvedPacket {
    Valid(ConnectPacket),
    ValidWispnet(u32, ConnectPacket),
    NoResolvedAddrs,
    Blocked,
    Invalid,
}

impl ClientStream {
    pub async fn resolve(packet: ConnectPacket) -> anyhow::Result<ResolvedPacket> {
        let cache_key = resolve_cache_key(&packet);
        let cache = get_resolve_cache();
        if let Some(cached_packet) = cache.get(&cache_key) {
            RESOLVE_CACHE_HITS.fetch_add(1, Ordering::Relaxed);
            return Ok(from_cached(&cached_packet));
        }
        RESOLVE_CACHE_MISSES.fetch_add(1, Ordering::Relaxed);

        if CONFIG.wisp.has_wispnet() && packet.host.ends_with(".wisp") {
            if let Some(wispnet_server) = packet.host.split(".wisp").next() {
                debug!("routing {:?} through wispnet", packet);
                let decoded = BASE64_STANDARD
                    .decode(wispnet_server)
                    .context("failed to decode wispnet server")?;
                let server_id = u32::from_str(
                    &String::from_utf8(decoded).context("wispnet server was not a string")?,
                )
                .context("failed to parse wispnet server from string")?;
                let resolved = ResolvedPacket::ValidWispnet(server_id, packet);
                cache.insert(cache_key.clone(), to_cached(&resolved));
                return Ok(resolved);
            }
        }

        cfg_if! {
            if #[cfg(feature = "twisp")] {
                if let StreamType::Other(ty) = packet.stream_type {
                    if ty == crate::handle::wisp::twisp::STREAM_TYPE && CONFIG.stream.allow_twisp && CONFIG.wisp.wisp_v2 {
                            let resolved = ResolvedPacket::Valid(packet);
                            cache.insert(cache_key.clone(), to_cached(&resolved));
                            return Ok(resolved);
                        }
                        let resolved = ResolvedPacket::Invalid;
                        cache.insert(cache_key.clone(), to_cached(&resolved));
                        return Ok(resolved);
                }
            } else {
                if matches!(packet.stream_type, StreamType::Other(_)) {
                        let resolved = ResolvedPacket::Invalid;
                        cache.insert(cache_key.clone(), to_cached(&resolved));
                        return Ok(resolved);
                    }
            }
        }

        if !CONFIG.stream.allow_udp && packet.stream_type == StreamType::Udp {
            let resolved = ResolvedPacket::Blocked;
            cache.insert(cache_key.clone(), to_cached(&resolved));
            return Ok(resolved);
        }

        if CONFIG
            .stream
            .blocked_ports()
            .iter()
            .any(|x| x.contains(&packet.port))
            && !CONFIG
                .stream
                .allowed_ports()
                .iter()
                .any(|x| x.contains(&packet.port))
        {
            let resolved = ResolvedPacket::Blocked;
            cache.insert(cache_key.clone(), to_cached(&resolved));
            return Ok(resolved);
        }

        if IpAddr::from_str(&packet.host).is_ok() {
            if !CONFIG.stream.allow_direct_ip {
                let resolved = ResolvedPacket::Blocked;
                cache.insert(cache_key.clone(), to_cached(&resolved));
                return Ok(resolved);
            }
        }

        if match_addr(
            &packet.host,
            allowed_set(packet.stream_type),
            blocked_set(packet.stream_type),
        ) {
            let resolved = ResolvedPacket::Blocked;
            cache.insert(cache_key.clone(), to_cached(&resolved));
            return Ok(resolved);
        }

        if match_addr(
            &packet.host,
            CONFIG.stream.allowed_hosts(),
            CONFIG.stream.blocked_hosts(),
        ) && !allowed_set(packet.stream_type).is_match(&packet.host)
        {
            let resolved = ResolvedPacket::Blocked;
            cache.insert(cache_key.clone(), to_cached(&resolved));
            return Ok(resolved);
        }

        let resolve_timeout = Duration::from_millis(CONFIG.stream.resolve_timeout_ms.max(100));
        let resolved_iter = timeout(resolve_timeout, RESOLVER.resolve(packet.host.clone()))
            .await
            .context("failed to resolve hostname: timeout")?
            .context("failed to resolve hostname")?;
        let packet = resolved_iter
            .filter(|x| CONFIG.server.resolve_ipv6 || x.is_ipv4())
            .map(|addr| {
                if addr.is_loopback() && !CONFIG.stream.allow_loopback {
                    return ResolvedPacket::Blocked;
                }

                if addr.is_multicast() && !CONFIG.stream.allow_multicast {
                    return ResolvedPacket::Blocked;
                }

                if (is_global(addr) && !CONFIG.stream.allow_global)
                    || (!is_global(addr) && !CONFIG.stream.allow_non_global)
                {
                    return ResolvedPacket::Blocked;
                }

                ResolvedPacket::Valid(ConnectPacket {
                    stream_type: packet.stream_type,
                    host: addr.to_string(),
                    port: packet.port,
                })
            })
            .next();

        let resolved = packet.unwrap_or(ResolvedPacket::NoResolvedAddrs);
        cache.insert(cache_key.clone(), to_cached(&resolved));
        Ok(resolved)
    }

    pub async fn connect(packet: ConnectPacket) -> anyhow::Result<Self> {
        match packet.stream_type {
            StreamType::Tcp => {
                let ipaddr =
                    IpAddr::from_str(&packet.host).context("failed to parse hostname as ipaddr")?;
                let connect_timeout =
                    Duration::from_millis(CONFIG.stream.connect_timeout_ms.max(100));
                let stream = timeout(
                    connect_timeout,
                    TcpStream::connect(SocketAddr::new(ipaddr, packet.port)),
                )
                .await
                .context("failed to connect to host: timeout")?
                .with_context(|| format!("failed to connect to host {}", packet.host))?;

                if CONFIG.stream.tcp_nodelay {
                    stream
                        .set_nodelay(true)
                        .context("failed to set tcp nodelay")?;
                }

                let sock_ref = SockRef::from(&stream);
                let keepalive = socket2::TcpKeepalive::new()
                    .with_time(Duration::from_secs(30))
                    .with_interval(Duration::from_secs(10));
                let _ = sock_ref.set_tcp_keepalive(&keepalive);

                Ok(ClientStream::Tcp(stream))
            }
            StreamType::Udp => {
                if !CONFIG.stream.allow_udp {
                    return Ok(ClientStream::Blocked);
                }

                let ipaddr =
                    IpAddr::from_str(&packet.host).context("failed to parse hostname as ipaddr")?;

                let bind_addr = if ipaddr.is_ipv4() {
                    SocketAddr::new(Ipv4Addr::new(0, 0, 0, 0).into(), 0)
                } else {
                    SocketAddr::new(Ipv6Addr::new(0, 0, 0, 0, 0, 0, 0, 0).into(), 0)
                };

                let stream = UdpSocket::bind(bind_addr).await?;

                let connect_timeout =
                    Duration::from_millis(CONFIG.stream.connect_timeout_ms.max(100));
                timeout(
                    connect_timeout,
                    stream.connect(SocketAddr::new(ipaddr, packet.port)),
                )
                .await
                .context("failed to connect udp socket: timeout")??;

                Ok(ClientStream::Udp(stream))
            }
            #[cfg(feature = "twisp")]
            StreamType::Other(crate::handle::wisp::twisp::STREAM_TYPE) => {
                if !CONFIG.stream.allow_twisp {
                    return Ok(ClientStream::Blocked);
                }

                let cmdline: Vec<std::ffi::OsString> = shell_words::split(&packet.host)?
                    .into_iter()
                    .map(Into::into)
                    .collect();
                let pty = pty_process::Pty::new()?;

                let cmd = pty_process::Command::new(&cmdline[0])
                    .args(&cmdline[1..])
                    .spawn(&pty.pts()?)?;

                Ok(ClientStream::Pty(cmd, pty))
            }
            StreamType::Other(_) => Ok(ClientStream::Invalid),
        }
    }
}

pub enum WebSocketFrame {
    Data(BytesMut),
    Close,
    Ignore,
}

pub struct WebSocketStreamWrapper(pub WebSocketStream<TokioIo<Upgraded>>);

impl WebSocketStreamWrapper {
    pub async fn read(&mut self) -> Option<Result<WebSocketFrame, tokio_websockets::Error>> {
        let frame = self.0.next().await?;
        match frame {
            Ok(frame) if frame.is_binary() || frame.is_text() => {
                Some(Ok(WebSocketFrame::Data(frame.into_payload().into())))
            }
            Ok(frame) if frame.is_close() => Some(Ok(WebSocketFrame::Close)),
            Ok(_) => Some(Ok(WebSocketFrame::Ignore)),
            Err(err) => Some(Err(err)),
        }
    }

    pub async fn write(&mut self, data: impl Into<Payload>) -> Result<(), tokio_websockets::Error> {
        self.0.send(Message::binary(data)).await
    }

    pub async fn close(
        &mut self,
        code: CloseCode,
        reason: &str,
    ) -> Result<(), tokio_websockets::Error> {
        self.0.send(Message::close(Some(code), reason)).await?;
        self.0.close().await
    }
}