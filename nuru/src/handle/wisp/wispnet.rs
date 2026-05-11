use std::sync::atomic::{AtomicU32, Ordering};

use anyhow::{Context, Result};
use async_trait::async_trait;
use bytes::{Buf, BufMut, Bytes, BytesMut};
use futures_util::{SinkExt, StreamExt};
use lazy_static::lazy_static;
use log::debug;
use tokio::select;
use uuid::Uuid;
use dashmap::DashMap;
use wisp_mux::{
	extensions::{
		AnyProtocolExtension, ProtocolExtension, ProtocolExtensionBuilder, ProtocolExtensionListExt,
	},
	packet::{CloseReason, ConnectPacket},
	stream::{MuxStream, MuxStreamRead, MuxStreamWrite},
	ws::{TransportRead, TransportWrite},
	ClientMux, Role, WispError, WispV2Handshake,
};

use crate::{route::{WispResult, WispStreamWrite}, stream::ClientStream, CLIENTS};

struct WispnetClient {
	mux: ClientMux<WispStreamWrite>,
	id: String,
	private: bool,
}

lazy_static! {
	static ref WISPNET_SERVERS: DashMap<u32, WispnetClient> = DashMap::new();
	static ref WISPNET_IDS: AtomicU32 = AtomicU32::new(0);
}

struct WispnetServerProtocolExtensionBuilder(u32);
impl WispnetServerProtocolExtensionBuilder {
	const ID: u8 = 0xF1;
}

#[async_trait]
impl ProtocolExtensionBuilder for WispnetServerProtocolExtensionBuilder {
	fn get_id(&self) -> u8 {
		Self::ID
	}

	fn build_from_bytes(
		&mut self,
		mut bytes: Bytes,
		_: Role,
	) -> Result<AnyProtocolExtension, WispError> {
		if bytes.remaining() < 1 {
			return Err(WispError::PacketTooSmall);
		};
		Ok(WispnetServerProtocolExtension(self.0, bytes.get_u8() != 0).into())
	}

	fn build_to_extension(&mut self, _: Role) -> Result<AnyProtocolExtension, WispError> {
		Ok(WispnetServerProtocolExtension(self.0, false).into())
	}
}

#[derive(Debug, Copy, Clone)]
struct WispnetServerProtocolExtension(u32, pub bool);
impl WispnetServerProtocolExtension {
	const ID: u8 = 0xF1;
}

#[async_trait]
impl ProtocolExtension for WispnetServerProtocolExtension {
	fn get_id(&self) -> u8 {
		Self::ID
	}
	fn get_supported_packets(&self) -> &'static [u8] {
		&[Self::ID]
	}
	fn get_congestion_stream_types(&self) -> &'static [u8] {
		&[]
	}
	fn encode(&self) -> Bytes {
		let mut out = BytesMut::new();
		out.put_u32_le(self.0);
		out.freeze()
	}

	async fn handle_handshake(
		&mut self,
		_: &mut dyn TransportRead,
		_: &mut dyn TransportWrite,
	) -> Result<(), WispError> {
		Ok(())
	}

	async fn handle_packet(
		&mut self,
		packet_type: u8,
		mut packet: Bytes,
		_: &mut dyn TransportRead,
		write: &mut dyn TransportWrite,
	) -> Result<(), WispError> {
		if packet_type == Self::ID {
			if packet.remaining() < 4 {
				return Err(WispError::PacketTooSmall);
			}
			let id = packet.get_u32_le();
			if id != 0 {
				return Err(WispError::InvalidStreamId(id));
			}

			let mut out = BytesMut::new();
			out.put_u8(Self::ID);
			out.put_u32_le(0);

			for client in WISPNET_SERVERS.iter() {
				if !client.value().private {
					out.put_u32_le(*client.key());
				}
			}

			write.send(out.into()).await?;
		}
		Ok(())
	}

	fn box_clone(&self) -> Box<dyn ProtocolExtension + Sync + Send> {
		Box::new(*self)
	}
}

pub async fn route_wispnet(server: u32, packet: ConnectPacket) -> Result<ClientStream> {
	if let Some(server) = WISPNET_SERVERS.get(&server) {
		let stream = server
			.value()
			.mux
			.new_stream(packet.stream_type, packet.host, packet.port)
			.await
			.context("failed to connect to wispnet server")?;
		Ok(ClientStream::Wispnet(stream, server.value().id.clone()))
	} else {
		Ok(ClientStream::NoResolvedAddrs)
	}
}

async fn copy_wisp(
	mut rx: MuxStreamRead<WispStreamWrite>,
	mut tx: MuxStreamWrite<WispStreamWrite>,
	#[cfg(feature = "speed-limit")] limiter: async_speed_limit::Limiter<
		async_speed_limit::clock::StandardClock,
	>,
) -> Result<()> {
	while let Some(data) = rx.next().await {
		let data = data?;

		#[cfg(feature = "speed-limit")]
		limiter.consume(data.len()).await;
		tx.send(data).await?;
	}
	Ok(())
}

pub async fn handle_stream(
	mux: MuxStream<WispStreamWrite>,
	wisp: MuxStream<WispStreamWrite>,
	mux_id: String,
	uuid: Uuid,
	resolved_stream: ConnectPacket,
	#[cfg(feature = "speed-limit")] read_limit: async_speed_limit::Limiter<
		async_speed_limit::clock::StandardClock,
	>,
	#[cfg(feature = "speed-limit")] write_limit: async_speed_limit::Limiter<
		async_speed_limit::clock::StandardClock,
	>,
) {
	let client_state = CLIENTS.get(&mux_id).map(|c| c.value().clone());
	if let Some(client) = client_state {
		client
			.0
			.insert(uuid, (resolved_stream.clone(), resolved_stream));
	}

	let closer = mux.get_close_handle();

	let (muxread, muxwrite) = mux.into_split();
	let (wispread, wispwrite) = wisp.into_split();
	let _ = select! {
		x = copy_wisp(muxread, wispwrite, #[cfg(feature = "speed-limit")] write_limit) => x,
		x = copy_wisp(wispread, muxwrite, #[cfg(feature = "speed-limit")] read_limit) => x,
	};

	let _ = closer
		.close(closer.get_close_reason().unwrap_or(CloseReason::Unknown))
		.await;

	let client_state = CLIENTS.get(&mux_id).map(|c| c.value().clone());
	if let Some(client) = client_state {
		client.0.remove(&uuid);
	}
}

pub async fn handle_wispnet(stream: WispResult, id: String) -> Result<()> {
	let (read, write) = stream;
	let net_id = WISPNET_IDS.fetch_add(1, Ordering::SeqCst);

	let extensions = vec![WispnetServerProtocolExtensionBuilder(net_id).into()];

	let (mux, fut) = Box::pin(
		ClientMux::new(read, write, Some(WispV2Handshake::new(extensions)))
			.await
			.context("failed to create client multiplexor")?
			.with_required_extensions(&[WispnetServerProtocolExtension::ID]),
	)
	.await
	.context("wispnet client did not have wispnet extension")?;

	let is_private = mux
		.get_extensions()
		.find_extension::<WispnetServerProtocolExtension>()
		.context("failed to find wispnet extension")?
		.1;

	WISPNET_SERVERS.insert(
		net_id,
		WispnetClient {
			mux,
			id: id.clone(),
			private: is_private,
		},
	);

	let ret = fut.await;
	debug!("wispnet client id {:?} multiplexor result {:?}", id, ret);

	WISPNET_SERVERS.remove(&net_id);

	Ok(())
}
