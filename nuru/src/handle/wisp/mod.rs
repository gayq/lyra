#[cfg(feature = "twisp")]
pub mod twisp;
pub mod utils;
pub mod wispnet;

use std::{sync::Arc, time::Duration};

use anyhow::Context;
use cfg_if::cfg_if;
use event_listener::Event;
use futures_util::{future::Either, FutureExt, SinkExt, StreamExt};
use log::{debug, trace};
use tokio::{io::AsyncWriteExt, net::TcpStream, select, task::JoinSet, time::interval};
use tokio_util::compat::{FuturesAsyncReadCompatExt, FuturesAsyncWriteCompatExt};
use uuid::Uuid;
use wisp_mux::{packet::{CloseReason, ConnectPacket}, stream::MuxStream, ServerMux};
use wispnet::route_wispnet;

use crate::{
	route::{WispResult, WispStreamWrite, WispWsStreamWrite},
	stream::{ClientStream, ResolvedPacket},
	CLIENTS, CONFIG,
};

async fn copy_fast(
	mux: MuxStream<WispStreamWrite>,
	tcp: TcpStream,
	#[cfg(feature = "speed-limit")] read_limit: async_speed_limit::Limiter<
		async_speed_limit::clock::StandardClock,
	>,
	#[cfg(feature = "speed-limit")] write_limit: async_speed_limit::Limiter<
		async_speed_limit::clock::StandardClock,
	>,
) -> std::io::Result<()> {
	#[cfg(not(feature = "speed-limit"))]
	{
		let mut muxio = mux.into_async_rw().compat();
		let mut tcpio = tokio::io::BufReader::with_capacity(CONFIG.stream.buffer_size, tcp);
		tokio::io::copy_bidirectional_with_sizes(
			&mut muxio,
			&mut tcpio,
			CONFIG.stream.buffer_size,
			CONFIG.stream.buffer_size,
		)
		.await?;
		return Ok(());
	}

	#[cfg(feature = "speed-limit")]
	{
		let (muxrx, muxtx) = mux.into_async_rw().into_split();
		let mut muxrx = muxrx.compat();
		let mut muxtx = muxtx.compat_write();

		let (tcprx, mut tcptx) = tcp.into_split();
		let tcprx = read_limit.limit(tcprx);
		let mut tcptx = write_limit.limit(tcptx);
		let mut tcprx = tokio::io::BufReader::with_capacity(CONFIG.stream.buffer_size, tcprx);

		let mut t1 = tokio::spawn(async move { tokio::io::copy_buf(&mut muxrx, &mut tcptx).await });
		let mut t2 = tokio::spawn(async move { tokio::io::copy(&mut tcprx, &mut muxtx).await });

		let res = select! {
			res = &mut t1 => res,
			res = &mut t2 => res,
		};
		t1.abort();
		t2.abort();

		return match res {
			Ok(x) => x.map(|_| ()),
			Err(e) => Err(std::io::Error::new(std::io::ErrorKind::Other, e)),
		};
	}
}

async fn resolve_stream(
	connect: ConnectPacket,
	muxstream: &MuxStream<WispStreamWrite>,
) -> Option<(ConnectPacket, ConnectPacket, ClientStream)> {
	let requested_stream = connect.clone();

	let Ok(resolved) = ClientStream::resolve(connect).await else {
		let _ = muxstream.close(CloseReason::ServerStreamUnreachable).await;
		return None;
	};
	let (stream, resolved_stream) = match resolved {
		ResolvedPacket::Valid(connect) => {
			let resolved = connect.clone();
			let Ok(stream) = ClientStream::connect(connect).await else {
				let _ = muxstream.close(CloseReason::ServerStreamUnreachable).await;
				return None;
			};
			(stream, resolved)
		}
		ResolvedPacket::ValidWispnet(server, connect) => {
			let resolved = connect.clone();
			let Ok(stream) = route_wispnet(server, connect).await else {
				let _ = muxstream.close(CloseReason::ServerStreamUnreachable).await;
				return None;
			};
			(stream, resolved)
		}
		ResolvedPacket::NoResolvedAddrs => {
			let _ = muxstream.close(CloseReason::ServerStreamUnreachable).await;
			return None;
		}
		ResolvedPacket::Blocked => {
			let _ = muxstream
				.close(CloseReason::ServerStreamBlockedAddress)
				.await;
			return None;
		}
		ResolvedPacket::Invalid => {
			let _ = muxstream.close(CloseReason::ServerStreamInvalidInfo).await;
			return None;
		}
	};

	Some((requested_stream, resolved_stream, stream))
}

async fn forward_stream(
	muxstream: MuxStream<WispStreamWrite>,
	stream: ClientStream,
	resolved_stream: ConnectPacket,
	uuid: Uuid,
	#[cfg(feature = "twisp")] twisp_map: twisp::TwispMap,
	#[cfg(feature = "speed-limit")] read_limit: async_speed_limit::Limiter<
		async_speed_limit::clock::StandardClock,
	>,
	#[cfg(feature = "speed-limit")] write_limit: async_speed_limit::Limiter<
		async_speed_limit::clock::StandardClock,
	>,
) {
	match stream {
		ClientStream::Tcp(stream) => {
			let closer = muxstream.get_close_handle();

			let ret: anyhow::Result<()> = async {
				copy_fast(
					muxstream,
					stream,
					#[cfg(feature = "speed-limit")]
					read_limit,
					#[cfg(feature = "speed-limit")]
					write_limit,
				)
				.await?;
				Ok(())
			}
			.await;

			match ret {
				Ok(()) => {
					let _ = closer.close(CloseReason::Voluntary).await;
				}
				Err(_) => {
					let _ = closer.close(CloseReason::Unexpected).await;
				}
			}
		}
		ClientStream::Udp(stream) => {
			let closer = muxstream.get_close_handle();
			let (mut read, write) = muxstream.into_split();
			let mut write = write.into_async_write().compat_write();

			let ret: anyhow::Result<()> = async move {
				let stream_recv = Arc::new(stream);
				let stream_send = stream_recv.clone();

				let mut t1 = tokio::spawn(async move {
					let mut data = vec![0u8; 65507];
					loop {
						let size = stream_recv.recv(&mut data).await?;
						write.write_all(&data[..size]).await?;
					}
					#[allow(unreachable_code)]
					anyhow::Ok(())
				});

				let mut t2 = tokio::spawn(async move {
					while let Some(res) = read.next().await {
						stream_send.send(&res?).await?;
					}
					anyhow::Ok(())
				});

				let res = select! {
					res = &mut t1 => res,
					res = &mut t2 => res,
				};
				t1.abort();
				t2.abort();
				match res { Ok(x) => x, Err(e) => Err(anyhow::anyhow!(e)) }
			}
			.await;

			match ret {
				Ok(()) => {
					let _ = closer.close(CloseReason::Voluntary).await;
				}
				Err(_) => {
					let _ = closer.close(CloseReason::Unexpected).await;
				}
			}
		}
		#[cfg(feature = "twisp")]
		ClientStream::Pty(cmd, pty) => {
			let closer = muxstream.get_close_handle();
			let id = muxstream.get_stream_id();
			let (mut rx, mut tx) = muxstream.into_async_rw().into_split();

			match twisp::handle_twisp(id, &mut rx, &mut tx, twisp_map.clone(), pty, cmd).await {
				Ok(()) => {
					let _ = closer.close(CloseReason::Voluntary).await;
				}
				Err(_) => {
					let _ = closer.close(CloseReason::Unexpected).await;
				}
			}
		}
		ClientStream::Wispnet(stream, mux_id) => {
			Box::pin(wispnet::handle_stream(
				muxstream,
				stream,
				mux_id,
				uuid,
				resolved_stream,
				#[cfg(feature = "speed-limit")]
				read_limit,
				#[cfg(feature = "speed-limit")]
				write_limit,
			))
			.await;
		}
		ClientStream::NoResolvedAddrs => {
			let _ = muxstream.close(CloseReason::ServerStreamUnreachable).await;
		}
		ClientStream::Invalid => {
			let _ = muxstream.close(CloseReason::ServerStreamInvalidInfo).await;
		}
		ClientStream::Blocked => {
			let _ = muxstream
				.close(CloseReason::ServerStreamBlockedAddress)
				.await;
		}
	}
}

async fn handle_stream(
	connect: ConnectPacket,
	muxstream: MuxStream<WispStreamWrite>,
	id: String,
	event: Arc<Event>,
	#[cfg(feature = "twisp")] twisp_map: twisp::TwispMap,
	#[cfg(feature = "speed-limit")] read_limit: async_speed_limit::Limiter<
		async_speed_limit::clock::StandardClock,
	>,
	#[cfg(feature = "speed-limit")] write_limit: async_speed_limit::Limiter<
		async_speed_limit::clock::StandardClock,
	>,
) {
	let uuid = Uuid::new_v4();
	debug!("[{id}] [{uuid}] stream requested: {connect:?}");

	let Some((requested_stream, resolved_stream, stream)) = select! (
		x = resolve_stream(connect, &muxstream) => x,
		() = event.listen() => None
	) else {
		debug!("[{id}] [{uuid}] stream cancelled");
		return;
	};

	debug!("[{id}] [{uuid}] stream resolved and connected: {resolved_stream:?}");

	let client_state = CLIENTS.get(&id).map(|c| c.value().clone());
	if let Some(client) = client_state {
		client
			.0
			.insert(uuid, (requested_stream, resolved_stream.clone()));
	}

	let forward_fut = forward_stream(
		muxstream,
		stream,
		resolved_stream,
		uuid,
		#[cfg(feature = "twisp")]
		twisp_map,
		#[cfg(feature = "speed-limit")]
		read_limit,
		#[cfg(feature = "speed-limit")]
		write_limit,
	);

	select! {
		x = forward_fut => x,
		() = event.listen() => (),
	};

	debug!("[{id}] [{uuid}] stream disconnected");

	let client_state = CLIENTS.get(&id).map(|c| c.value().clone());
	if let Some(client) = client_state {
		client.0.remove(&uuid);
	}
}

pub async fn handle_wisp(stream: WispResult, is_v2: bool, id: String) -> anyhow::Result<()> {
	let (read, write) = stream;
	cfg_if! {
		if #[cfg(feature = "twisp")] {
			let twisp_map = twisp::new_map();
			let (extensions, required_extensions, buffer_size) = CONFIG.wisp.to_opts().await?;

			let extensions = match extensions {
				Some(mut exts) => {
					exts.add_extension(twisp::new_ext(twisp_map.clone()));
					Some(exts)
				},
				None => {
					None
				}
			};
		} else {
			let (extensions, required_extensions, buffer_size) = CONFIG.wisp.to_opts().await?;
		}
	}

	#[cfg(feature = "speed-limit")]
	let read_limiter = async_speed_limit::Limiter::builder(CONFIG.wisp.read_limit)
		.refill(Duration::from_secs(1))
		.clock(async_speed_limit::clock::StandardClock)
		.build();
	#[cfg(feature = "speed-limit")]
	let write_limiter = async_speed_limit::Limiter::builder(CONFIG.wisp.write_limit)
		.refill(Duration::from_secs(1))
		.clock(async_speed_limit::clock::StandardClock)
		.build();

	let (mux, fut) = Box::pin(
		Box::pin(ServerMux::new(
			read,
			write,
			buffer_size,
			if is_v2 { extensions } else { None },
		))
		.await
		.context("failed to create server multiplexor")?
		.with_required_extensions(&required_extensions),
	)
	.await?;
	let mux = Arc::new(mux);

	debug!(
		"[{id}] client connected with extensions {:?}, downgraded {:?}",
		mux.get_extension_ids(),
		mux.was_downgraded()
	);

	let mut set: JoinSet<()> = JoinSet::new();
	let event: Arc<Event> = Event::new().into();

	let mux_id = id.clone();
	set.spawn(fut.map(move |x| debug!("[{mux_id}] multiplexor result: {x:?}")));

	let ping_mux = mux.clone();
	let ping_event = event.clone();
	let ping_id = id.clone();
	let ping_interval_secs = CONFIG.wisp.ping_interval_secs.max(1);
	set.spawn(async move {
		let mut interval = interval(Duration::from_secs(ping_interval_secs));
		let send_ping = || async {
			let mut locked = ping_mux.lock_ws().await?;
			if let Either::Left(ws) = &mut *locked {
				<WispWsStreamWrite as SinkExt<tokio_websockets::Message>>::send(
					ws,
					tokio_websockets::Message::ping(&[] as &[u8]),
				)
				.await?;
			}
			anyhow::Ok(())
		};

		while (send_ping)().await.is_ok() {
			trace!("[{ping_id}] sent ping");
			select! {
				_ = interval.tick() => (),
				() = ping_event.listen() => break,
			};
		}
	});

	while let Some((connect, stream)) = mux.wait_for_stream().await {
		set.spawn(handle_stream(
			connect,
			stream,
			id.clone(),
			event.clone(),
			#[cfg(feature = "twisp")]
			twisp_map.clone(),
			#[cfg(feature = "speed-limit")]
			read_limiter.clone(),
			#[cfg(feature = "speed-limit")]
			write_limiter.clone(),
		));
	}

	debug!("[{id}] shutting down wisp client");

	let _ = mux.close().await;
	event.notify(usize::MAX);

	trace!("[{id}] waiting for tasks to close");

	while set.join_next().await.is_some() {}

	debug!("[{id}] client disconnected");

	Ok(())
}