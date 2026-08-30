use std::{
    os::fd::{AsRawFd, RawFd},
    sync::Arc,
};

use async_trait::async_trait;
use bytes::{Buf, Bytes};
use dashmap::DashMap;
use pty_process::Pty;
use tokio::{io::copy, process::Child, select};
use tokio_util::compat::{FuturesAsyncReadCompatExt, FuturesAsyncWriteCompatExt};
use wisp_mux::{
    extensions::{
        AnyProtocolExtension, AnyProtocolExtensionBuilder, ProtocolExtension,
        ProtocolExtensionBuilder,
    },
    stream::{MuxStreamAsyncRead, MuxStreamAsyncWrite},
    ws::{TransportRead as WebSocketRead, TransportWrite as WebSocketWrite},
    WispError,
};

use crate::route::WispStreamWrite;

pub type TwispMap = Arc<DashMap<u32, RawFd>>;

pub const STREAM_TYPE: u8 = 0x03;

#[derive(Debug, Clone)]
pub struct TWispServerProtocolExtension(TwispMap);

impl TWispServerProtocolExtension {
    const ID: u8 = 0xF0;
}

#[async_trait]
impl ProtocolExtension for TWispServerProtocolExtension {
    fn get_id(&self) -> u8 {
        Self::ID
    }

    fn get_supported_packets(&self) -> &'static [u8] {
        &[0xF0]
    }

    fn get_congestion_stream_types(&self) -> &'static [u8] {
        &[0x03]
    }

    fn encode(&self) -> Bytes {
        Bytes::new()
    }

    async fn handle_handshake(
        &mut self,
        _: &mut dyn WebSocketRead,
        _: &mut dyn WebSocketWrite,
    ) -> std::result::Result<(), WispError> {
        Ok(())
    }

    async fn handle_packet(
        &mut self,
        packet_type: u8,
        mut packet: Bytes,
        _: &mut dyn WebSocketRead,
        _: &mut dyn WebSocketWrite,
    ) -> std::result::Result<(), WispError> {
        if packet_type == 0xF0 {
            if packet.remaining() < 4 + 2 + 2 {
                return Err(WispError::PacketTooSmall);
            }
            let stream_id = packet.get_u32_le();
            let row = packet.get_u16_le();
            let col = packet.get_u16_le();

            if let Some(pty) = self.0.get(&stream_id) {
                let _ = set_term_size(*pty, row, col);
            }
        }
        Ok(())
    }

    fn box_clone(&self) -> Box<dyn ProtocolExtension + Sync + Send> {
        Box::new(self.clone())
    }
}

pub struct TWispServerProtocolExtensionBuilder(TwispMap);

impl ProtocolExtensionBuilder for TWispServerProtocolExtensionBuilder {
    fn get_id(&self) -> u8 {
        TWispServerProtocolExtension::ID
    }

    fn build_from_bytes(
        &mut self,
        _: Bytes,
        _: wisp_mux::Role,
    ) -> std::result::Result<AnyProtocolExtension, WispError> {
        Ok(TWispServerProtocolExtension(self.0.clone()).into())
    }

    fn build_to_extension(&mut self, _: wisp_mux::Role) -> Result<AnyProtocolExtension, WispError> {
        Ok(TWispServerProtocolExtension(self.0.clone()).into())
    }
}

fn set_term_size(fd: RawFd, row: u16, col: u16) -> anyhow::Result<()> {
    let size = libc::winsize {
        ws_row: row,
        ws_col: col,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let ioctl_result = unsafe { libc::ioctl(fd, libc::TIOCSWINSZ, std::ptr::addr_of!(size)) };
    if ioctl_result == -1 {
        Err(nix::errno::Errno::from_raw(
            std::io::Error::last_os_error().raw_os_error().unwrap_or(0),
        )
        .into())
    } else {
        Ok(())
    }
}

pub fn new_map() -> TwispMap {
    Arc::new(DashMap::new())
}

pub fn new_ext(map: TwispMap) -> AnyProtocolExtensionBuilder {
    TWispServerProtocolExtensionBuilder(map).into()
}

pub async fn handle_twisp(
    id: u32,
    stream_read: &mut MuxStreamAsyncRead<WispStreamWrite>,
    stream_write: &mut MuxStreamAsyncWrite<WispStreamWrite>,
    map: TwispMap,
    mut pty: Pty,
    mut cmd: Child,
) -> anyhow::Result<()> {
    map.insert(id, pty.as_raw_fd());
    let forwarding_result = async {
        let (mut pty_read, mut pty_write) = pty.split();
        let mut stream_read = stream_read.compat();
        let mut stream_write = stream_write.compat_write();

        select! {
            copy_result = copy(&mut pty_read, &mut stream_write) => copy_result.map(|_| {}),
            copy_result = copy(&mut stream_read, &mut pty_write) => copy_result.map(|_| {}),
            wait_result = cmd.wait() => wait_result.map(|_| {}),
        }?;
        Ok(())
    }
    .await;
    map.remove(&id);
    let _ = cmd.kill().await;
    forwarding_result
}
