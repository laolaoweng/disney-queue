# -*- coding: utf-8 -*-
"""h3_fetch.py —— 用 HTTP/3（QUIC/UDP 443）抓取 JSON。

为什么需要它：queue-times.com / api.themeparks.wiki 部署在 Cloudflare 后面，中国大陆
网络对这两个域名的 **TCP/TLS 握手** 会被重置（WinError 10054），但 QUIC 跑在 UDP 443、
ClientHello 里的 SNI 是加密的，实测可以正常拿到 200（2026-11-11 于上海电信实测）。

适用场景：**本机/自有服务器**采集（Windows 计划任务、树莓派、海外 VPS 均可）。微信小程序
的 wx.request 只支持 TCP 上的 HTTP/1.1/2，不能直接用 HTTP/3，所以小程序端仍需一个 HTTPS
中继（见 README「两条实时数据链路」）。

依赖：`pip install aioquic`（仅这个模块需要；collect.py 的 --input/--fixture 模式和 GitHub
Actions 里的 TCP 模式都不依赖它，模块是延迟 import 的）。

用法::

    python collector/h3_fetch.py https://queue-times.com/parks/30/queue_times.json
"""

from __future__ import annotations

import asyncio
import json
import ssl
import sys
from urllib.parse import urlsplit

DEFAULT_TIMEOUT = 20
USER_AGENT = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/131.0 Safari/537.36 '
              'disney-queue-collector/1.0 (+data pipeline)')


class H3Error(Exception):
    """HTTP/3 抓取失败（依赖缺失、超时、状态码非 2xx 等）。"""


def _require_aioquic():
    try:
        from aioquic.asyncio.client import connect
        from aioquic.asyncio.protocol import QuicConnectionProtocol
        from aioquic.h3.connection import H3_ALPN, H3Connection
        from aioquic.h3.events import DataReceived, HeadersReceived
        from aioquic.quic.configuration import QuicConfiguration
    except ImportError as exc:  # pragma: no cover - 依赖缺失路径
        raise H3Error('未安装 aioquic（pip install aioquic）: %s' % exc)
    return {
        'connect': connect,
        'QuicConnectionProtocol': QuicConnectionProtocol,
        'H3_ALPN': H3_ALPN,
        'H3Connection': H3Connection,
        'DataReceived': DataReceived,
        'HeadersReceived': HeadersReceived,
        'QuicConfiguration': QuicConfiguration,
    }


async def _request(host, port, path, timeout, user_agent):
    mods = _require_aioquic()
    QuicConnectionProtocol = mods['QuicConnectionProtocol']
    H3Connection = mods['H3Connection']
    HeadersReceived = mods['HeadersReceived']
    DataReceived = mods['DataReceived']

    class _Client(QuicConnectionProtocol):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.http = H3Connection(self._quic)
            self.status = None
            self.body = bytearray()
            self.done = asyncio.Event()

        def quic_event_received(self, event):
            for http_event in self.http.handle_event(event):
                if isinstance(http_event, HeadersReceived):
                    for key, value in http_event.headers:
                        if key == b':status':
                            self.status = int(value)
                elif isinstance(http_event, DataReceived):
                    self.body.extend(http_event.data)
                    if http_event.stream_ended:
                        self.done.set()
                if getattr(http_event, 'stream_ended', False):
                    self.done.set()

        def send_get(self):
            stream_id = self._quic.get_next_available_stream_id()
            self.http.send_headers(
                stream_id=stream_id,
                headers=[
                    (b':method', b'GET'),
                    (b':scheme', b'https'),
                    (b':authority', host.encode()),
                    (b':path', path.encode()),
                    (b'user-agent', user_agent.encode()),
                    (b'accept', b'application/json, text/plain, */*'),
                    (b'accept-language', b'en-US,en;q=0.9'),
                ],
                end_stream=True,
            )
            self.transmit()

    configuration = mods['QuicConfiguration'](is_client=True,
                                              alpn_protocols=mods['H3_ALPN'])
    configuration.verify_mode = ssl.CERT_NONE
    configuration.server_name = host

    async with mods['connect'](host, port, configuration=configuration,
                               create_protocol=_Client, wait_connected=True) as client:
        client.send_get()
        try:
            await asyncio.wait_for(client.done.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            raise H3Error('HTTP/3 读取超时（%ss）: https://%s%s' % (timeout, host, path))
        if client.status is None:
            raise H3Error('HTTP/3 没有返回状态码: https://%s%s' % (host, path))
        if not (200 <= client.status < 300):
            raise H3Error('HTTP/3 状态码 %d: https://%s%s' % (client.status, host, path))
        return client.status, bytes(client.body)


def fetch_bytes(url, timeout=DEFAULT_TIMEOUT, user_agent=USER_AGENT):
    """GET 一个 https URL（HTTP/3），返回响应体 bytes。失败抛 H3Error。"""
    parts = urlsplit(url)
    if parts.scheme != 'https':
        raise H3Error('HTTP/3 只支持 https URL: %r' % url)
    host = parts.hostname
    if not host:
        raise H3Error('URL 缺少主机名: %r' % url)
    port = parts.port or 443
    path = parts.path or '/'
    if parts.query:
        path += '?' + parts.query
    try:
        _, body = asyncio.run(_request(host, port, path, timeout, user_agent))
    except H3Error:
        raise
    except Exception as exc:  # aioquic 内部异常（握手超时、UDP 被丢包等）
        raise H3Error('HTTP/3 抓取失败（%s: %s）: %s'
                      % (exc.__class__.__name__, exc, url))
    return body


def fetch_json(url, timeout=DEFAULT_TIMEOUT, retries=2, log=print, user_agent=USER_AGENT):
    """GET 并解析 JSON；失败按 attempts 线性退避重试。"""
    import time
    last_error = None
    attempts = max(1, int(retries))
    for attempt in range(1, attempts + 1):
        try:
            body = fetch_bytes(url, timeout=timeout, user_agent=user_agent)
            return json.loads(body.decode('utf-8', errors='replace'))
        except H3Error as exc:
            last_error = exc
        except ValueError as exc:  # json 解析失败
            last_error = H3Error('JSON 解析失败: %s' % exc)
        if attempt < attempts:
            wait = min(2 ** (attempt - 1), 8)
            log('[h3] 第 %d/%d 次失败（%s），%ds 后重试' % (attempt, attempts, last_error, wait))
            time.sleep(wait)
    raise H3Error('HTTP/3 抓取失败: %s (%s)' % (url, last_error))


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv:
        print('用法: python collector/h3_fetch.py <https URL>')
        return 2
    url = argv[0]
    try:
        body = fetch_bytes(url)
    except H3Error as exc:
        print('[h3] FAILED: %s' % exc, file=sys.stderr)
        return 2
    print('[h3] OK %d bytes' % len(body))
    text = body.decode('utf-8', errors='replace')
    print(text[:2000])
    return 0


if __name__ == '__main__':
    sys.exit(main())
