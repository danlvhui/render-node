// Minimal Node wrapper: serves a plain HTTP page + health check,
// forwards WebSocket upgrades on WS_PATH to a bundled Xray core
// running a VLESS+WS inbound on loopback. TLS is terminated by the
// platform edge (the app's https address), as on other PaaS hosts.
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT || '3000', 10);
const UUID = process.env.UUID || '';
const WS_PATH = process.env.WS_PATH || '/ray';
const XRAY_PORT = 10000;

if (!UUID) {
  console.error('UUID env var is required');
  process.exit(1);
}

const config = {
  log: { loglevel: 'warning' },
  inbounds: [
    {
      listen: '127.0.0.1',
      port: XRAY_PORT,
      protocol: 'vless',
      settings: { clients: [{ id: UUID }], decryption: 'none' },
      streamSettings: {
        network: 'ws',
        wsSettings: { path: WS_PATH }
      }
    }
  ],
  outbounds: [{ protocol: 'freedom', tag: 'direct' }]
};

const cfgPath = path.join(__dirname, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify(config));

let xray = null;
function startXray() {
  xray = spawn(path.join(__dirname, 'xray'), ['run', '-config', cfgPath], {
    stdio: 'inherit'
  });
  xray.on('exit', (code) => {
    console.log('xray exited with code', code, '- restarting in 1s');
    setTimeout(startXray, 1000);
  });
}
startXray();

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><html><head><title>service</title></head>' +
        '<body><h1>service is running</h1><p>Status: OK</p></body></html>'
    );
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.on('upgrade', (req, socket, head) => {
  if (!req.url || !req.url.startsWith(WS_PATH)) {
    socket.destroy();
    return;
  }
  const upstream = net.connect(XRAY_PORT, '127.0.0.1', () => {
    let raw = req.method + ' ' + req.url + ' HTTP/' + req.httpVersion + '\r\n';
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      raw += req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1] + '\r\n';
    }
    raw += '\r\n';
    upstream.write(raw);
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('listening on port', PORT, 'ws path', WS_PATH);
});
