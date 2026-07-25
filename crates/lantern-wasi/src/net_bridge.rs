//! lantern: virtual network bridge for browser builds.
//!
//! The host page owns a WebSocket to the Aero-style proxy and mirrors it onto
//! a dedicated preopened WASI fd. Frames use Aero's WS multiplexing protocol
//! (`[1B type][4B stream_id BE][payload]`, type 0=data / 1=open / 2=close);
//! across the fd boundary each frame is additionally length-prefixed with a
//! `u32` BE because fds are byte streams, not message streams. Stream 0
//! (control/registration) is handled by the page and never reaches us.
//!
//! Each opened stream becomes a `tokio::io::duplex` pair: one end feeds
//! Pumpkin's `JavaClient::new_virtual`, the other is pumped to/from the fd.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

/// Live counters for the metrics panel.
pub static OPEN_STREAMS: AtomicUsize = AtomicUsize::new(0);
pub static OUT_QUEUE: AtomicUsize = AtomicUsize::new(0);

use pumpkin::net::java::JavaClient;
use pumpkin::server::Server;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

/// The bridge is mounted by the page at ./net.sock inside the preopened cwd
/// (a raw fd can't be a preopen — wasi-libc only accepts directories there).
const NET_SOCK_PATH: &str = "net.sock";

const MSG_DATA: u8 = 0;
const MSG_OPEN: u8 = 1;
const MSG_CLOSE: u8 = 2;

/// How often we poll the fd when it has no data. The page side has no way to
/// wake us, so this bounds added latency per hop.
const POLL_INTERVAL: Duration = Duration::from_millis(3);

pub(crate) fn open_socket(path: &str) -> std::io::Result<u32> {
    use std::os::fd::IntoRawFd;
    let file = std::fs::OpenOptions::new().read(true).write(true).open(path)?;
    Ok(file.into_raw_fd() as u32)
}

fn open_bridge() -> std::io::Result<u32> {
    open_socket(NET_SOCK_PATH)
}

pub(crate) fn fd_read_now(fd: u32, buf: &mut [u8]) -> usize {
    let iov = wasi::Iovec {
        buf: buf.as_mut_ptr(),
        buf_len: buf.len(),
    };
    unsafe { wasi::fd_read(fd, &[iov]).unwrap_or(0) }
}

pub(crate) fn fd_write_all(fd: u32, mut data: &[u8]) {
    while !data.is_empty() {
        let iov = wasi::Ciovec {
            buf: data.as_ptr(),
            buf_len: data.len(),
        };
        match unsafe { wasi::fd_write(fd, &[iov]) } {
            Ok(0) | Err(_) => break,
            Ok(n) => data = &data[n..],
        }
    }
}

fn frame(msg_type: u8, stream_id: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(9 + payload.len());
    out.extend_from_slice(&(5 + payload.len() as u32).to_be_bytes());
    out.push(msg_type);
    out.extend_from_slice(&stream_id.to_be_bytes());
    out.extend_from_slice(payload);
    out
}

pub fn spawn(server: Arc<Server>) {
    let fd = match open_bridge() {
        Ok(fd) => fd,
        Err(e) => {
            tracing::warn!("net_bridge: no {NET_SOCK_PATH} mounted, networking disabled: {e}");
            return;
        }
    };
    tracing::info!("net_bridge: connected via {NET_SOCK_PATH} (fd {fd})");
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();

    // Writer: serializes all outbound frames onto the fd.
    tokio::spawn(async move {
        while let Some(f) = out_rx.recv().await {
            OUT_QUEUE.store(out_rx.len(), Ordering::Relaxed);
            fd_write_all(fd, &f);
        }
    });

    // Reader/demux: polls the fd, reassembles frames, routes them to streams.
    tokio::spawn(async move {
        let mut acc: Vec<u8> = Vec::new();
        let mut buf = vec![0u8; 64 * 1024];
        let mut conns: HashMap<u32, tokio::io::WriteHalf<tokio::io::DuplexStream>> = HashMap::new();

        loop {
            let n = fd_read_now(fd, &mut buf);
            if n == 0 {
                tokio::time::sleep(POLL_INTERVAL).await;
                continue;
            }
            acc.extend_from_slice(&buf[..n]);

            loop {
                if acc.len() < 4 {
                    break;
                }
                let flen = u32::from_be_bytes([acc[0], acc[1], acc[2], acc[3]]) as usize;
                if acc.len() < 4 + flen || flen < 5 {
                    if flen < 5 {
                        tracing::error!("net_bridge: corrupt frame (len {flen}), resetting");
                        acc.clear();
                    }
                    break;
                }
                let frame_bytes: Vec<u8> = acc.drain(..4 + flen).skip(4).collect();
                let msg_type = frame_bytes[0];
                let sid = u32::from_be_bytes([
                    frame_bytes[1],
                    frame_bytes[2],
                    frame_bytes[3],
                    frame_bytes[4],
                ]);
                let payload = &frame_bytes[5..];

                match msg_type {
                    MSG_OPEN => {
                        tracing::info!("net_bridge: stream {sid} opened (new client)");
                        let (ours, theirs) = tokio::io::duplex(1024 * 1024);
                        let (mut read_half, write_half) = tokio::io::split(ours);
                        conns.insert(sid, write_half);
                        OPEN_STREAMS.store(conns.len(), Ordering::Relaxed);

                        // Outbound pump: server → frames on the fd.
                        let tx = out_tx.clone();
                        tokio::spawn(async move {
                            let mut b = vec![0u8; 32 * 1024];
                            loop {
                                match read_half.read(&mut b).await {
                                    Ok(0) | Err(_) => break,
                                    Ok(n) => {
                                        if tx.send(frame(MSG_DATA, sid, &b[..n])).is_err() {
                                            break;
                                        }
                                    }
                                }
                            }
                            let _ = tx.send(frame(MSG_CLOSE, sid, &[]));
                        });

                        // A synthetic address; stream ids are unique per session.
                        let addr =
                            SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 88, 0, 1)), sid as u16);
                        let client = JavaClient::new_virtual(theirs, addr, u64::from(sid));
                        tokio::spawn(pumpkin::run_java_client(client, server.clone()));
                    }
                    MSG_DATA => {
                        if let Some(w) = conns.get_mut(&sid) {
                            if w.write_all(payload).await.is_err() {
                                conns.remove(&sid);
                            }
                        }
                    }
                    MSG_CLOSE => {
                        // Dropping the write half EOFs the client's reader.
                        conns.remove(&sid);
                        OPEN_STREAMS.store(conns.len(), Ordering::Relaxed);
                        tracing::info!("net_bridge: stream {sid} closed");
                    }
                    other => {
                        tracing::warn!("net_bridge: unknown msg type {other}");
                    }
                }
            }
        }
    });
}
