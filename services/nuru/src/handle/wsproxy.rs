use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use log::debug;
use std::str::FromStr;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    select,
};
use tokio_websockets::CloseCode;
use uuid::Uuid;
use wisp_mux::packet::{CloseReason, ConnectPacket, StreamType};

use crate::{
    handle::wisp::wispnet::route_wispnet,
    stream::{ClientStream, ResolvedPacket, WebSocketFrame, WebSocketStreamWrapper},
    CLIENTS, CONFIG, POSITIVE,
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
            .close(
                CloseCode::POLICY_VIOLATION,
                negative_message!("udp is blocked"),
            )
            .await;
        return Ok(());
    }

    let Some(last_segment) = path.rsplit('/').next() else {
        let _ = ws
            .close(
                CloseCode::POLICY_VIOLATION,
                negative_message!("invalid path"),
            )
            .await;
        return Ok(());
    };
    let Some((host, port_str)) = last_segment.split_once(':') else {
        let _ = ws
            .close(
                CloseCode::POLICY_VIOLATION,
                negative_message!("invalid host"),
            )
            .await;
        return Ok(());
    };
    let host = host.to_string();
    let Some(port) = FromStr::from_str(port_str).ok() else {
        let _ = ws
            .close(
                CloseCode::POLICY_VIOLATION,
                negative_message!("invalid port"),
            )
            .await;
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
            .close(
                CloseCode::INTERNAL_SERVER_ERROR,
                negative_message!("failed to resolve host"),
            )
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
                        negative_message!("failed to connect to host"),
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
                        negative_message!("failed to connect to host"),
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
                    negative_message!("host did not resolve to any addresses"),
                )
                .await;
            return Ok(());
        }
        ResolvedPacket::Blocked => {
            let _ = ws
                .close(
                    CloseCode::POLICY_VIOLATION,
                    negative_message!("host is blocked"),
                )
                .await;
            return Ok(());
        }
        ResolvedPacket::Invalid => {
            let _ = ws
                .close(
                    CloseCode::POLICY_VIOLATION,
                    negative_message!("invalid host/port/type combination"),
                )
                .await;
            return Ok(());
        }
    };

    let uuid = Uuid::new_v4();

    debug!(
        "new wsproxy client id {:?} connected: (stream uuid {:?}) {:?} {:?}{}",
        id, uuid, requested_stream, resolved_stream, POSITIVE
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
            let forwarding_result: anyhow::Result<()> = async {
                loop {
                    select! {
                        frame = ws.read() => {
                            match frame.transpose()? {
                                Some(WebSocketFrame::Data(payload)) => {
                                    stream.write_all(&payload).await?;
                                }
                                Some(WebSocketFrame::Close) => {
                                    stream.shutdown().await?;
                                }
                                Some(WebSocketFrame::Ignore) => {}
                                None => break Ok(()),
                            }
                        }
                        read_result = stream.fill_buf() => {
                            let buffer = read_result?;
                            let length = buffer.len();
                            if length == 0 {
                                break Ok(());
                            }
                            let chunk = Bytes::copy_from_slice(&buffer[..length]);
                            stream.consume(length);
                            ws.write(chunk).await?;
                        }
                    }
                }
            }
            .await;
            match forwarding_result {
                Ok(()) => {
                    let _ = ws.close(CloseCode::NORMAL_CLOSURE, "").await;
                }
                Err(_) => {
                    let _ = ws
                        .close(
                            CloseCode::INTERNAL_SERVER_ERROR,
                            negative_message!("stream forwarding failed"),
                        )
                        .await;
                }
            }
        }
        ClientStream::Udp(stream) => {
            let forwarding_result: anyhow::Result<()> = async {
                let mut datagram = vec![0u8; 65507];
                loop {
                    select! {
                        frame = ws.read() => {
                            match frame.transpose()? {
                                Some(WebSocketFrame::Data(payload)) => {
                                    stream.send(&payload).await?;
                                }
                                Some(WebSocketFrame::Close | WebSocketFrame::Ignore) => {}
                                None => break Ok(()),
                            }
                        }
                        size = stream.recv(&mut datagram) => {
                            let size = size?;
                            let chunk = Bytes::copy_from_slice(&datagram[..size]);
                            ws.write(chunk).await?;
                        }
                    }
                }
            }
            .await;
            match forwarding_result {
                Ok(()) => {
                    let _ = ws.close(CloseCode::NORMAL_CLOSURE, "").await;
                }
                Err(_) => {
                    let _ = ws
                        .close(
                            CloseCode::INTERNAL_SERVER_ERROR,
                            negative_message!("stream forwarding failed"),
                        )
                        .await;
                }
            }
        }
        #[cfg(feature = "twisp")]
        ClientStream::Pty(_) => {
            let _ = ws
                .close(
                    CloseCode::POLICY_VIOLATION,
                    negative_message!("twisp is not supported"),
                )
                .await;
        }
        ClientStream::Wispnet(mut stream, mux_id) => {
            let client_state = CLIENTS.get(&mux_id).map(|c| c.value().clone());
            if let Some(client) = client_state {
                client
                    .0
                    .insert(uuid, (resolved_stream.clone(), resolved_stream));
            }

            let forwarding_result: anyhow::Result<()> = async {
                loop {
                    select! {
                        frame = ws.read() => {
                            match frame.transpose()? {
                                Some(WebSocketFrame::Data(payload)) => {
                                    stream.send(payload.into()).await?;
                                }
                                Some(WebSocketFrame::Close) => {
                                    wisp_mux::stream::MuxStream::close(
                                        stream.as_ref(),
                                        CloseReason::Voluntary,
                                    )
                                    .await?;
                                }
                                Some(WebSocketFrame::Ignore) => {}
                                None => break,
                            }
                        }
                        frame = stream.next() => {
                            let Some(frame) = frame else {
                                break;
                            };
                            ws.write(frame?).await?;
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

            match forwarding_result {
                Ok(()) => {
                    let _ = ws.close(CloseCode::NORMAL_CLOSURE, "").await;
                }
                Err(_) => {
                    let _ = ws
                        .close(
                            CloseCode::INTERNAL_SERVER_ERROR,
                            negative_message!("stream forwarding failed"),
                        )
                        .await;
                }
            }
        }
        ClientStream::NoResolvedAddrs => {
            let _ = ws
                .close(
                    CloseCode::INTERNAL_SERVER_ERROR,
                    negative_message!("host did not resolve to any addresses"),
                )
                .await;
            return Ok(());
        }
        ClientStream::Blocked => {
            let _ = ws
                .close(
                    CloseCode::POLICY_VIOLATION,
                    negative_message!("host is blocked"),
                )
                .await;
        }
        ClientStream::Invalid => {
            let _ = ws
                .close(
                    CloseCode::POLICY_VIOLATION,
                    negative_message!("host is invalid"),
                )
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
