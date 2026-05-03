use std::str::FromStr;

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use log::debug;
use tokio::{io::{AsyncBufReadExt, AsyncWriteExt, BufReader}, select};
use tokio_websockets::CloseCode;
use uuid::Uuid;
use wisp_mux::packet::{CloseReason, ConnectPacket, StreamType};

use crate::{
	handle::wisp::wispnet::route_wispnet,
	stream::{ClientStream, ResolvedPacket, WebSocketFrame, WebSocketStreamWrapper},
	CLIENTS, CONFIG,
};

#[allow(clippy::too_many_lines)]
pub async fn handle_wsproxy(
	mut ws: WebSocketStreamWrapper,
	id: String,
	path: String,
	udp: bool,
) -> anyhow::Result<()> {
	if udp && !CONFIG.stream.allow_wsproxy_udp {
		let _ = ws
			.close(CloseCode::POLICY_VIOLATION, "udp is blocked")
			.await;
		return Ok(());
	}

	let Some(last_segment) = path.rsplit('/').next() else {
		let _ = ws.close(CloseCode::POLICY_VIOLATION, "invalid path").await;
		return Ok(());
	};
	let Some((host, port_str)) = last_segment.split_once(':') else {
		let _ = ws.close(CloseCode::POLICY_VIOLATION, "invalid host").await;
		return Ok(());
	};
	let host = host.to_string();
	let Some(port) = FromStr::from_str(port_str).ok() else {
		let _ = ws.close(CloseCode::POLICY_VIOLATION, "invalid port").await;
		return Ok(());
	};

	let connect = ConnectPacket {
		stream_type: if udp {
			StreamType::Udp
		} else {
			StreamType::Tcp
		},
		host,
		port,
	};

	let requested_stream = connect.clone();

	let Ok(resolved) = ClientStream::resolve(connect).await else {
		let _ = ws
			.close(CloseCode::INTERNAL_SERVER_ERROR, "failed to resolve host")
			.await;
		return Ok(());
	};
	let (stream, resolved_stream) = match resolved {
		ResolvedPacket::Valid(connect) => {
			let resolved = connect.clone();
			let Ok(stream) = ClientStream::connect(connect).await else {
				let _ = ws
					.close(
						CloseCode::INTERNAL_SERVER_ERROR,
						"failed to connect to host",
					)
					.await;
				return Ok(());
			};
			(stream, resolved)
		}
		ResolvedPacket::ValidWispnet(server, connect) => {
			let resolved = connect.clone();
			let Ok(stream) = route_wispnet(server, connect).await else {
				let _ = ws
					.close(
						CloseCode::INTERNAL_SERVER_ERROR,
						"failed to connect to host",
					)
					.await;
				return Ok(());
			};
			(stream, resolved)
		}
		ResolvedPacket::NoResolvedAddrs => {
			let _ = ws
				.close(
					CloseCode::INTERNAL_SERVER_ERROR,
					"host did not resolve to any addrs",
				)
				.await;
			return Ok(());
		}
		ResolvedPacket::Blocked => {
			let _ = ws
				.close(CloseCode::POLICY_VIOLATION, "host is blocked")
				.await;
			return Ok(());
		}
		ResolvedPacket::Invalid => {
			let _ = ws
				.close(
					CloseCode::POLICY_VIOLATION,
					"invalid host/port/type combination",
				)
				.await;
			return Ok(());
		}
	};

	let uuid = Uuid::new_v4();

	debug!(
		"new wsproxy client id {:?} connected: (stream uuid {:?}) {:?} {:?}",
		id, uuid, requested_stream, resolved_stream
	);

	let client_state = CLIENTS.get(&id).map(|c| c.value().clone());
	if let Some(client) = client_state {
		client
			.0
			.insert(uuid, (requested_stream, resolved_stream.clone()));
	}

	match stream {
		ClientStream::Tcp(stream) => {
			let mut stream = BufReader::with_capacity(CONFIG.stream.buffer_size, stream);
			let ret: anyhow::Result<()> = async {
				loop {
					select! {
						x = ws.read() => {
							match x.transpose()? {
								Some(WebSocketFrame::Data(data)) => {
									stream.write_all(&data).await?;
								}
								Some(WebSocketFrame::Close) => {
									stream.shutdown().await?;
								}
								Some(WebSocketFrame::Ignore) => {}
								None => break Ok(()),
							}
						}
						x = stream.fill_buf() => {
							let x = x?;
							let len = x.len();
							if len == 0 {
								break Ok(());
							}
							let chunk = Bytes::copy_from_slice(&x[..len]);
							stream.consume(len);
							ws.write(chunk).await?;
						}
					}
				}
			}
			.await;
			match ret {
				Ok(()) => {
					let _ = ws.close(CloseCode::NORMAL_CLOSURE, "").await;
				}
				Err(x) => {
					let _ = ws.close(CloseCode::NORMAL_CLOSURE, &x.to_string()).await;
				}
			}
		}
		ClientStream::Udp(stream) => {
			let ret: anyhow::Result<()> = async {
				let mut data = vec![0u8; 65507];
				loop {
					select! {
						x = ws.read() => {
							match x.transpose()? {
								Some(WebSocketFrame::Data(data)) => {
									stream.send(&data).await?;
								}
								Some(WebSocketFrame::Close | WebSocketFrame::Ignore) => {}
								None => break Ok(()),
							}
						}
						size = stream.recv(&mut data) => {
							let size = size?;
							let chunk = Bytes::copy_from_slice(&data[..size]);
							ws.write(chunk).await?;
						}
					}
				}
			}
			.await;
			match ret {
				Ok(()) => {
					let _ = ws.close(CloseCode::NORMAL_CLOSURE, "").await;
				}
				Err(x) => {
					let _ = ws.close(CloseCode::NORMAL_CLOSURE, &x.to_string()).await;
				}
			}
		}
		#[cfg(feature = "twisp")]
		ClientStream::Pty(_, _) => {
			let _ = ws
				.close(CloseCode::POLICY_VIOLATION, "twisp is not supported")
				.await;
		}
		ClientStream::Wispnet(mut stream, mux_id) => {
			let client_state = CLIENTS.get(&mux_id).map(|c| c.value().clone());
			if let Some(client) = client_state {
				client
					.0
					.insert(uuid, (resolved_stream.clone(), resolved_stream));
			}

			let ret: anyhow::Result<()> = async {
				loop {
					select! {
						x = ws.read() => {
							match x.transpose()? {
								Some(WebSocketFrame::Data(data)) => {
									stream.send(data.into()).await?;
								}
								Some(WebSocketFrame::Close) => {
									stream.close(CloseReason::Voluntary).await?;
								}
								Some(WebSocketFrame::Ignore) => {}
								None => break,
							}
						}
						x = stream.next() => {
							let Some(x) = x else {
								break;
							};
							ws.write(x?).await?;
						}
					}
				}
				Ok(())
			}
			.await;

			let client_state = CLIENTS.get(&mux_id).map(|c| c.value().clone());
			if let Some(client) = client_state {
				client.0.remove(&uuid);
			}

			match ret {
				Ok(()) => {
					let _ = ws.close(CloseCode::NORMAL_CLOSURE, "").await;
				}
				Err(x) => {
					let _ = ws.close(CloseCode::NORMAL_CLOSURE, &x.to_string()).await;
				}
			}
		}
		ClientStream::NoResolvedAddrs => {
			let _ = ws
				.close(
					CloseCode::INTERNAL_SERVER_ERROR,
					"host did not resolve to any addrs",
				)
				.await;
			return Ok(());
		}
		ClientStream::Blocked => {
			let _ = ws
				.close(CloseCode::POLICY_VIOLATION, "host is blocked")
				.await;
		}
		ClientStream::Invalid => {
			let _ = ws
				.close(CloseCode::POLICY_VIOLATION, "host is invalid")
				.await;
		}
	}

	debug!(
		"wsproxy client id {:?} disconnected (stream uuid {:?})",
		id, uuid
	);

	let client_state = CLIENTS.get(&id).map(|c| c.value().clone());
	if let Some(client) = client_state {
		client.0.remove(&uuid);
	}

	Ok(())
}