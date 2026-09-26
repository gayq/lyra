use axum::extract::ws::{Message, WebSocket};
use axum::http::{HeaderMap, HeaderValue};
use futures_util::{sink::SinkExt, stream::StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    client_async_tls_with_config,
    tungstenite::{
        client::IntoClientRequest,
        protocol::{Message as TungsteniteMessage, WebSocketConfig},
    },
    MaybeTlsStream, WebSocketStream,
};
use url::Url;

pub type UpstreamSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;
pub const MAX_MESSAGE_SIZE: usize = 8 * 1024 * 1024;

pub fn selected_protocol(
    headers: &HeaderMap,
    offered: &HeaderMap,
) -> Result<Option<String>, &'static str> {
    let mut selected = headers.get_all("sec-websocket-protocol").iter();
    let Some(value) = selected.next() else {
        return Ok(None);
    };
    let protocol = value
        .to_str()
        .map_err(|_| "invalid websocket protocol... /ᐠ - ˕ -マ")?;
    if selected.next().is_some()
        || protocol.is_empty()
        || protocol.contains(',')
        || !offered
            .get_all("sec-websocket-protocol")
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(','))
            .any(|v| v.trim() == protocol)
    {
        return Err("invalid websocket protocol... /ᐠ - ˕ -マ");
    }
    Ok(Some(protocol.to_owned()))
}

pub async fn connect(
    target: &str,
    validation_url: &Url,
    headers: &HeaderMap,
) -> Result<(UpstreamSocket, Option<String>), &'static str> {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let addresses = crate::safe_dns::resolve_public_target(validation_url).await?;
        let socket = TcpStream::connect(addresses.as_slice())
            .await
            .map_err(|_| "websocket connection failed... /ᐠ - ˕ -マ")?;
        handshake(target, validation_url, headers, socket).await
    })
    .await
    .map_err(|_| "websocket handshake timed out... /ᐠ - ˕ -マ")?
}

async fn handshake(
    target: &str,
    validation_url: &Url,
    headers: &HeaderMap,
    socket: TcpStream,
) -> Result<(UpstreamSocket, Option<String>), &'static str> {
    let _ = socket.set_nodelay(true);
    let mut request = target
        .into_client_request()
        .map_err(|_| "invalid websocket target... /ᐠ - ˕ -マ")?;
    if headers.contains_key("origin") {
        request.headers_mut().insert(
            "origin",
            HeaderValue::from_str(&validation_url.origin().ascii_serialization())
                .map_err(|_| "invalid websocket origin... /ᐠ - ˕ -マ")?,
        );
    }
    let protocols = headers
        .get_all("sec-websocket-protocol")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>()
        .join(",");
    if !protocols.is_empty() {
        request.headers_mut().insert(
            "sec-websocket-protocol",
            HeaderValue::from_str(&protocols)
                .map_err(|_| "invalid websocket protocol... /ᐠ - ˕ -マ")?,
        );
    }
    for name in ["cookie", "authorization"] {
        for value in headers.get_all(name) {
            request.headers_mut().append(name, value.clone());
        }
    }
    let config = WebSocketConfig {
        max_message_size: Some(MAX_MESSAGE_SIZE),
        max_frame_size: Some(MAX_MESSAGE_SIZE),
        ..Default::default()
    };
    let (upstream, response) = client_async_tls_with_config(request, socket, Some(config), None)
        .await
        .map_err(|_| "websocket handshake failed... /ᐠ - ˕ -マ")?;
    let protocol = selected_protocol(response.headers(), headers)?;
    Ok((upstream, protocol))
}

pub async fn handle_socket(client_socket: WebSocket, ws_stream: UpstreamSocket) {
    let (mut client_sender, mut client_receiver) = client_socket.split();

    let (mut upstream_sender, mut upstream_receiver) = ws_stream.split();

    let client_to_upstream = async move {
        while let Some(msg) = client_receiver.next().await {
            if let Ok(msg) = msg {
                let tungstenite_msg = match msg {
                    Message::Text(t) => TungsteniteMessage::Text(t),
                    Message::Binary(b) => TungsteniteMessage::Binary(b),
                    Message::Ping(b) => TungsteniteMessage::Ping(b),
                    Message::Pong(b) => TungsteniteMessage::Pong(b),
                    Message::Close(_) => TungsteniteMessage::Close(None),
                };
                if upstream_sender.send(tungstenite_msg).await.is_err() {
                    break;
                }
            } else {
                break;
            }
        }
    };

    let upstream_to_client = async move {
        while let Some(msg) = upstream_receiver.next().await {
            if let Ok(msg) = msg {
                let axum_msg = match msg {
                    TungsteniteMessage::Text(t) => Message::Text(t),
                    TungsteniteMessage::Binary(b) => Message::Binary(b),
                    TungsteniteMessage::Ping(b) => Message::Ping(b),
                    TungsteniteMessage::Pong(b) => Message::Pong(b),
                    TungsteniteMessage::Close(_) => Message::Close(None),
                    TungsteniteMessage::Frame(_) => continue,
                };
                if client_sender.send(axum_msg).await.is_err() {
                    break;
                }
            } else {
                break;
            }
        }
    };

    tokio::select! {
        _ = client_to_upstream => {}
        _ = upstream_to_client => {}
    }
}