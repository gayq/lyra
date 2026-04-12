use anyhow::{bail, Context, Result};
use base64::{prelude::BASE64_STANDARD, Engine};
use bytes::Bytes;
use http_body_util::Empty;
use hyper::{header::HeaderValue, upgrade::OnUpgrade, Request, Response};
use sha1::{Digest, Sha1};

pub fn is_upgrade_request<B>(request: &hyper::Request<B>) -> bool {
	header_contains_value(request.headers(), hyper::header::CONNECTION, "Upgrade")
		&& header_contains_value(request.headers(), hyper::header::UPGRADE, "websocket")
}

fn header_contains_value(
	headers: &hyper::HeaderMap,
	header: impl hyper::header::AsHeaderName,
	value: impl AsRef<[u8]>,
) -> bool {
	let value = value.as_ref();
	for header in headers.get_all(header) {
		if header
			.as_bytes()
			.split(|&c| c == b',')
			.any(|x| trim(x).eq_ignore_ascii_case(value))
		{
			return true;
		}
	}
	false
}

fn trim(data: &[u8]) -> &[u8] {
	trim_end(trim_start(data))
}

fn trim_start(data: &[u8]) -> &[u8] {
	if let Some(start) = data.iter().position(|x| !x.is_ascii_whitespace()) {
		&data[start..]
	} else {
		b""
	}
}

fn trim_end(data: &[u8]) -> &[u8] {
	if let Some(last) = data.iter().rposition(|x| !x.is_ascii_whitespace()) {
		&data[..=last]
	} else {
		b""
	}
}

fn sec_websocket_protocol(key: &[u8]) -> String {
	let mut sha1 = Sha1::new();
	sha1.update(key);
	sha1.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"); // magic string
	let result = sha1.finalize();
	BASE64_STANDARD.encode(&result[..])
}

pub fn upgrade<B>(request: &mut Request<B>) -> Result<(Response<Empty<Bytes>>, OnUpgrade)> {
	let key = request
		.headers()
		.get("Sec-WebSocket-Key")
		.context("missing Sec-WebSocket-Key")?;
	if request
		.headers()
		.get("Sec-WebSocket-Version")
		.map(HeaderValue::as_bytes)
		!= Some(b"13")
	{
		bail!("invalid Sec-WebSocket-Version, not 13");
	}

	let response = Response::builder()
		.status(hyper::StatusCode::SWITCHING_PROTOCOLS)
		.header(hyper::header::CONNECTION, "upgrade")
		.header(hyper::header::UPGRADE, "websocket")
		.header(
			"Sec-WebSocket-Accept",
			&sec_websocket_protocol(key.as_bytes()),
		)
		.body(Empty::new())
		.context("failed to build upgrade response")?;

	Ok((response, hyper::upgrade::on(request)))
}