use anyhow::Context;
use rustls_pemfile::{certs, private_key};
#[cfg(not(target_os = "windows"))]
use std::os::fd::AsFd;
use std::{
    io::{BufReader, Cursor},
    net::SocketAddr,
    path::PathBuf,
    pin::Pin,
    str::FromStr,
    sync::Arc,
};
#[cfg(not(target_os = "windows"))]
use tokio::fs::{remove_file, try_exists};
#[cfg(not(target_os = "windows"))]
use tokio::net::{unix, UnixListener, UnixStream};
use tokio::{
    fs::File,
    io::{AsyncBufRead, AsyncRead, AsyncWrite, ReadHalf, WriteHalf},
    net::{tcp, TcpListener, TcpSocket, TcpStream},
};

#[cfg(target_os = "windows")]
type UnixStream = TcpStream;
#[cfg(target_os = "windows")]
type UnixListener = TcpListener;
#[cfg(target_os = "windows")]
mod unix {
    pub type OwnedReadHalf = tokio::net::tcp::OwnedReadHalf;
    pub type OwnedWriteHalf = tokio::net::tcp::OwnedWriteHalf;
}
use tokio_rustls::{rustls, server::TlsStream, TlsAcceptor};
#[cfg(not(target_os = "windows"))]
use uuid::Uuid;

use crate::{
    config::{BindAddr, SocketType},
    CONFIG,
};

pub enum Quintet<A, B, C, D, E> {
    One(A),
    Two(B),
    Three(C),
    Four(D),
    Five(E),
}

impl<
        A: AsyncRead + Unpin,
        B: AsyncRead + Unpin,
        C: AsyncRead + Unpin,
        D: AsyncRead + Unpin,
        E: AsyncRead + Unpin,
    > AsyncRead for Quintet<A, B, C, D, E>
{
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            Self::One(x) => Pin::new(x).poll_read(cx, buf),
            Self::Two(x) => Pin::new(x).poll_read(cx, buf),
            Self::Three(x) => Pin::new(x).poll_read(cx, buf),
            Self::Four(x) => Pin::new(x).poll_read(cx, buf),
            Self::Five(x) => Pin::new(x).poll_read(cx, buf),
        }
    }
}

impl<
        A: AsyncBufRead + Unpin,
        B: AsyncBufRead + Unpin,
        C: AsyncBufRead + Unpin,
        D: AsyncBufRead + Unpin,
        E: AsyncBufRead + Unpin,
    > AsyncBufRead for Quintet<A, B, C, D, E>
{
    fn poll_fill_buf(
        self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<&[u8]>> {
        match self.get_mut() {
            Self::One(x) => Pin::new(x).poll_fill_buf(cx),
            Self::Two(x) => Pin::new(x).poll_fill_buf(cx),
            Self::Three(x) => Pin::new(x).poll_fill_buf(cx),
            Self::Four(x) => Pin::new(x).poll_fill_buf(cx),
            Self::Five(x) => Pin::new(x).poll_fill_buf(cx),
        }
    }

    fn consume(self: Pin<&mut Self>, amt: usize) {
        match self.get_mut() {
            Self::One(x) => Pin::new(x).consume(amt),
            Self::Two(x) => Pin::new(x).consume(amt),
            Self::Three(x) => Pin::new(x).consume(amt),
            Self::Four(x) => Pin::new(x).consume(amt),
            Self::Five(x) => Pin::new(x).consume(amt),
        }
    }
}

impl<
        A: AsyncWrite + Unpin,
        B: AsyncWrite + Unpin,
        C: AsyncWrite + Unpin,
        D: AsyncWrite + Unpin,
        E: AsyncWrite + Unpin,
    > AsyncWrite for Quintet<A, B, C, D, E>
{
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<Result<usize, std::io::Error>> {
        match self.get_mut() {
            Self::One(x) => Pin::new(x).poll_write(cx, buf),
            Self::Two(x) => Pin::new(x).poll_write(cx, buf),
            Self::Three(x) => Pin::new(x).poll_write(cx, buf),
            Self::Four(x) => Pin::new(x).poll_write(cx, buf),
            Self::Five(x) => Pin::new(x).poll_write(cx, buf),
        }
    }

    fn is_write_vectored(&self) -> bool {
        match self {
            Self::One(x) => x.is_write_vectored(),
            Self::Two(x) => x.is_write_vectored(),
            Self::Three(x) => x.is_write_vectored(),
            Self::Four(x) => x.is_write_vectored(),
            Self::Five(x) => x.is_write_vectored(),
        }
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        bufs: &[std::io::IoSlice<'_>],
    ) -> std::task::Poll<Result<usize, std::io::Error>> {
        match self.get_mut() {
            Self::One(x) => Pin::new(x).poll_write_vectored(cx, bufs),
            Self::Two(x) => Pin::new(x).poll_write_vectored(cx, bufs),
            Self::Three(x) => Pin::new(x).poll_write_vectored(cx, bufs),
            Self::Four(x) => Pin::new(x).poll_write_vectored(cx, bufs),
            Self::Five(x) => Pin::new(x).poll_write_vectored(cx, bufs),
        }
    }

    fn poll_flush(
        self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), std::io::Error>> {
        match self.get_mut() {
            Self::One(x) => Pin::new(x).poll_flush(cx),
            Self::Two(x) => Pin::new(x).poll_flush(cx),
            Self::Three(x) => Pin::new(x).poll_flush(cx),
            Self::Four(x) => Pin::new(x).poll_flush(cx),
            Self::Five(x) => Pin::new(x).poll_flush(cx),
        }
    }

    fn poll_shutdown(
        self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), std::io::Error>> {
        match self.get_mut() {
            Self::One(x) => Pin::new(x).poll_shutdown(cx),
            Self::Two(x) => Pin::new(x).poll_shutdown(cx),
            Self::Three(x) => Pin::new(x).poll_shutdown(cx),
            Self::Four(x) => Pin::new(x).poll_shutdown(cx),
            Self::Five(x) => Pin::new(x).poll_shutdown(cx),
        }
    }
}

pub struct Duplex<A, B>(A, B);

impl<A, B> Duplex<A, B> {
    pub fn new(a: A, b: B) -> Self {
        Self(a, b)
    }

    pub fn into_split(self) -> (A, B) {
        (self.0, self.1)
    }
}

impl<A: AsyncRead + Unpin, B: Unpin> AsyncRead for Duplex<A, B> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_read(cx, buf)
    }
}

impl<A: AsyncBufRead + Unpin, B: Unpin> AsyncBufRead for Duplex<A, B> {
    fn poll_fill_buf(
        self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<&[u8]>> {
        Pin::new(&mut self.get_mut().0).poll_fill_buf(cx)
    }

    fn consume(self: Pin<&mut Self>, amt: usize) {
        Pin::new(&mut self.get_mut().0).consume(amt);
    }
}

impl<A: Unpin, B: AsyncWrite + Unpin> AsyncWrite for Duplex<A, B> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<Result<usize, std::io::Error>> {
        Pin::new(&mut self.get_mut().1).poll_write(cx, buf)
    }

    fn is_write_vectored(&self) -> bool {
        self.1.is_write_vectored()
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        bufs: &[std::io::IoSlice<'_>],
    ) -> std::task::Poll<Result<usize, std::io::Error>> {
        Pin::new(&mut self.get_mut().1).poll_write_vectored(cx, bufs)
    }

    fn poll_flush(
        self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), std::io::Error>> {
        Pin::new(&mut self.get_mut().1).poll_flush(cx)
    }

    fn poll_shutdown(
        self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), std::io::Error>> {
        Pin::new(&mut self.get_mut().1).poll_shutdown(cx)
    }
}

pub type ServerStream =
    Quintet<TcpStream, TlsStream<TcpStream>, UnixStream, TlsStream<UnixStream>, Duplex<File, File>>;
pub type ServerStreamRead = Quintet<
    tcp::OwnedReadHalf,
    ReadHalf<TlsStream<TcpStream>>,
    unix::OwnedReadHalf,
    ReadHalf<TlsStream<UnixStream>>,
    File,
>;
pub type ServerStreamWrite = Quintet<
    tcp::OwnedWriteHalf,
    WriteHalf<TlsStream<TcpStream>>,
    unix::OwnedWriteHalf,
    WriteHalf<TlsStream<UnixStream>>,
    File,
>;

pub trait ServerStreamExt {
    fn split(self) -> (ServerStreamRead, ServerStreamWrite);
}

impl ServerStreamExt for ServerStream {
    fn split(self) -> (ServerStreamRead, ServerStreamWrite) {
        match self {
            Self::One(x) => {
                let (r, w) = x.into_split();
                (Quintet::One(r), Quintet::One(w))
            }
            Self::Two(x) => {
                let (r, w) = tokio::io::split(x);
                (Quintet::Two(r), Quintet::Two(w))
            }
            Self::Three(x) => {
                let (r, w) = x.into_split();
                (Quintet::Three(r), Quintet::Three(w))
            }
            Self::Four(x) => {
                let (r, w) = tokio::io::split(x);
                (Quintet::Four(r), Quintet::Four(w))
            }
            Self::Five(x) => {
                let (r, w) = x.into_split();
                (Quintet::Five(r), Quintet::Five(w))
            }
        }
    }
}

pub enum ServerListener {
    Tcp(TcpListener),
    TlsTcp(TcpListener, TlsAcceptor),
    Unix(UnixListener),
    TlsUnix(UnixListener, TlsAcceptor),
    File(Option<PathBuf>),
}

impl ServerListener {
    async fn bind_tcp(bind: &BindAddr) -> anyhow::Result<TcpListener> {
        if let Ok(addr) = SocketAddr::from_str(&bind.1) {
            let listener = if addr.is_ipv4() {
                TcpSocket::new_v4()?
            } else {
                TcpSocket::new_v6()?
            };

            listener.set_reuseaddr(true).context(negative_message!(
                "failed to set socket reuse address option"
            ))?;

            if CONFIG.server.runtime.is_thread_per_core() {
                #[cfg(not(target_os = "windows"))]
                listener
                    .set_reuseport(true)
                    .context(negative_message!("failed to set socket reuse port option"))?;
            }

            listener.bind(addr).with_context(|| {
                format!(
                    "failed to bind to tcp address `{}`{}",
                    bind.1,
                    crate::NEGATIVE
                )
            })?;
            Ok(listener.listen(4096)?)
        } else {
            TcpListener::bind(&bind.1).await.with_context(|| {
                format!(
                    "failed to bind to tcp address `{}`{}",
                    bind.1,
                    crate::NEGATIVE
                )
            })
        }
    }

    async fn bind_unix(#[allow(unused_variables)] bind: &BindAddr) -> anyhow::Result<UnixListener> {
        #[cfg(not(target_os = "windows"))]
        {
            if try_exists(&bind.1).await? {
                remove_file(&bind.1).await?;
            }
            UnixListener::bind(&bind.1).with_context(|| {
                format!(
                    "failed to bind to unix socket at `{}`{}",
                    bind.1,
                    crate::NEGATIVE
                )
            })
        }
        #[cfg(target_os = "windows")]
        {
            anyhow::bail!(negative_message!(
                "unix sockets are not supported on windows"
            ))
        }
    }

    async fn create_tls() -> anyhow::Result<TlsAcceptor> {
        let tls_keypair = CONFIG
            .server
            .tls_keypair
            .as_ref()
            .context(negative_message!("no tls keypair provided"))?;

        let mut public = BufReader::new(Cursor::new(
            tokio::fs::read(&tls_keypair[0])
                .await
                .context(negative_message!("failed to read public key"))?,
        ));
        let public = certs(&mut public)
            .collect::<Result<Vec<_>, _>>()
            .context(negative_message!("failed to parse public key"))?;
        let mut private = BufReader::new(Cursor::new(
            tokio::fs::read(&tls_keypair[1])
                .await
                .context(negative_message!("failed to read private key"))?,
        ));
        let private = private_key(&mut private)
            .context(negative_message!("failed to parse private key"))?
            .context(negative_message!("no private key found"))?;

        let tls_config = Arc::new(
            rustls::ServerConfig::builder()
                .with_no_client_auth()
                .with_single_cert(public, private)
                .context(negative_message!("failed to create server config"))?,
        );

        Ok(TlsAcceptor::from(tls_config))
    }

    pub async fn new(bind: &BindAddr) -> anyhow::Result<Self> {
        Ok(match bind.0 {
            SocketType::Tcp => Self::Tcp(Self::bind_tcp(bind).await?),
            SocketType::TlsTcp => {
                Self::TlsTcp(Self::bind_tcp(bind).await?, Self::create_tls().await?)
            }
            SocketType::Unix => Self::Unix(Self::bind_unix(bind).await?),
            SocketType::TlsUnix => {
                Self::TlsUnix(Self::bind_unix(bind).await?, Self::create_tls().await?)
            }
            SocketType::File => Self::File(Some(bind.1.clone().into())),
        })
    }

    async fn accept_tcp(listener: &mut TcpListener) -> anyhow::Result<(TcpStream, String)> {
        let (stream, addr) = listener
            .accept()
            .await
            .context(negative_message!("failed to accept tcp connection"))?;
        if CONFIG.server.tcp_nodelay {
            stream
                .set_nodelay(true)
                .context(negative_message!("failed to set tcp nodelay"))?;
            #[cfg(target_os = "linux")]
            {
                let _ = socket2::SockRef::from(&stream).set_tcp_quickack(true);
            }
        }
        Ok((stream, addr.to_string()))
    }

    async fn accept_unix(
        #[allow(unused_variables)] listener: &mut UnixListener,
    ) -> anyhow::Result<(UnixStream, String)> {
        #[cfg(not(target_os = "windows"))]
        {
            let (stream, addr) = listener
                .accept()
                .await
                .context(negative_message!("failed to accept unix socket connection"))?;

            Ok((
                stream,
                addr.as_pathname().and_then(|x| x.to_str()).map_or_else(
                    || Uuid::new_v4().to_string() + "-unix_socket",
                    ToString::to_string,
                ),
            ))
        }
        #[cfg(target_os = "windows")]
        {
            anyhow::bail!(negative_message!(
                "unix sockets are not supported on windows"
            ))
        }
    }

    pub async fn accept(&mut self) -> anyhow::Result<(ServerStream, String)> {
        match self {
            Self::Tcp(x) => {
                let (x, y) = Self::accept_tcp(x).await?;
                Ok((Quintet::One(x), y))
            }
            Self::TlsTcp(tcp, tls) => {
                let (x, y) = Self::accept_tcp(tcp).await?;
                let x = tls.accept(x).await?;
                Ok((Quintet::Two(x), y))
            }
            Self::Unix(x) => {
                let (x, y) = Self::accept_unix(x).await?;
                Ok((Quintet::Three(x), y))
            }
            Self::TlsUnix(unix, tls) => {
                let (x, y) = Self::accept_unix(unix).await?;
                let x = tls.accept(x).await?;
                Ok((Quintet::Four(x), y))
            }
            Self::File(path) => {
                if let Some(path) = path.take() {
                    let rx = File::options()
                        .read(true)
                        .write(false)
                        .open(&path)
                        .await
                        .context(negative_message!("failed to open read file"))?;

                    if CONFIG.server.file_raw_mode {
                        #[cfg(not(target_os = "windows"))]
                        {
                            let mut termios = nix::sys::termios::tcgetattr(rx.as_fd())
                                .context(negative_message!("failed to get termios for read file"))?
                                .clone();
                            nix::sys::termios::cfmakeraw(&mut termios);
                            nix::sys::termios::tcsetattr(
                                rx.as_fd(),
                                nix::sys::termios::SetArg::TCSANOW,
                                &termios,
                            )
                            .context(negative_message!("failed to set raw mode for read file"))?;
                        }
                    }

                    let tx = File::options()
                        .read(false)
                        .write(true)
                        .open(&path)
                        .await
                        .context(negative_message!("failed to open write file"))?;

                    if CONFIG.server.file_raw_mode {
                        #[cfg(not(target_os = "windows"))]
                        {
                            let mut termios = nix::sys::termios::tcgetattr(tx.as_fd())
                                .context(negative_message!("failed to get termios for write file"))?
                                .clone();
                            nix::sys::termios::cfmakeraw(&mut termios);
                            nix::sys::termios::tcsetattr(
                                tx.as_fd(),
                                nix::sys::termios::SetArg::TCSANOW,
                                &termios,
                            )
                            .context(negative_message!("failed to set raw mode for write file"))?;
                        }
                    }

                    Ok((
                        Quintet::Five(Duplex::new(rx, tx)),
                        path.to_string_lossy().to_string(),
                    ))
                } else {
                    std::future::pending().await
                }
            }
        }
    }
}
