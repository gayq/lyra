use bytes::BytesMut;
use futures_util::{Sink, SinkExt, Stream, StreamExt};
use wisp_mux::{ws::Payload, WispError};

pub struct MapErr<T: Unpin>(pub T);

impl<T: Stream<Item = Result<BytesMut, std::io::Error>> + Unpin> Stream for MapErr<T> {
	type Item = Result<Payload, WispError>;

	fn poll_next(
		mut self: std::pin::Pin<&mut Self>,
		cx: &mut std::task::Context<'_>,
	) -> std::task::Poll<Option<Self::Item>> {
		self.0
			.poll_next_unpin(cx)
			.map_err(|x| WispError::WsImplError(Box::new(x)))
			.map_ok(Into::into)
	}
}

impl<T: Sink<Payload, Error = std::io::Error> + Unpin> Sink<Payload> for MapErr<T> {
	type Error = WispError;

	fn poll_ready(
		mut self: std::pin::Pin<&mut Self>,
		cx: &mut std::task::Context<'_>,
	) -> std::task::Poll<Result<(), Self::Error>> {
		self.0
			.poll_ready_unpin(cx)
			.map_err(|x| WispError::WsImplError(Box::new(x)))
	}

	fn start_send(mut self: std::pin::Pin<&mut Self>, item: Payload) -> Result<(), Self::Error> {
		self.0
			.start_send_unpin(item)
			.map_err(|x| WispError::WsImplError(Box::new(x)))
	}

	fn poll_close(
		mut self: std::pin::Pin<&mut Self>,
		cx: &mut std::task::Context<'_>,
	) -> std::task::Poll<Result<(), Self::Error>> {
		self.0
			.poll_close_unpin(cx)
			.map_err(|x| WispError::WsImplError(Box::new(x)))
	}

	fn poll_flush(
		mut self: std::pin::Pin<&mut Self>,
		cx: &mut std::task::Context<'_>,
	) -> std::task::Poll<Result<(), Self::Error>> {
		self.0
			.poll_flush_unpin(cx)
			.map_err(|x| WispError::WsImplError(Box::new(x)))
	}
}
