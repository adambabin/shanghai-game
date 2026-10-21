// Peer-to-peer connections through PeerJS. The host's browser is the game server;
// everyone else connects straight to it using the room code.

const PREFIX = 'shanghai-family-rummy-';
// WebRTC can take a long time to notice a peer vanished (closed tab, phone asleep), so both sides ping.
const PING_MS = 3000;
const STALE_MS = 10000;
// A link that hasn't opened by now is stuck (often a phone on mobile data that can't get through): say so, and redial.
const SLOW_MS = 15000;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function randomCode() {
  let s = '';
  for (let i = 0; i < 5; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

function peerOptions() {
  // ?peerserver=host:port lets a self-hosted PeerJS server stand in for the free public one
  const custom = new URLSearchParams(location.search).get('peerserver');
  if (!custom) return { debug: 1 };
  const [host, port] = custom.split(':');
  return { host, port: Number(port) || 9000, path: '/', secure: location.protocol === 'https:', debug: 1 };
}

// Host side. onMessage(connId, msg), onClose(connId). Returns { send, close }.
export function openRoom(code, { onReady, onMessage, onClose, onError }) {
  const conns = new Map();
  const lastSeen = new Map();
  let peer;
  let destroyed = false;
  let attempts = 0;

  const drop = (conn) => {
    if (!conns.has(conn.connectionId)) return;
    conns.delete(conn.connectionId);
    lastSeen.delete(conn.connectionId);
    try {
      conn.close();
    } catch {}
    onClose(conn.connectionId);
  };
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const conn of conns.values()) if (now - (lastSeen.get(conn.connectionId) || now) > STALE_MS) drop(conn);
  }, PING_MS);

  const start = () => {
    peer = new window.Peer(PREFIX + code, peerOptions());
    peer.on('open', () => {
      attempts = 0;
      onReady && onReady();
    });
    peer.on('connection', (conn) => {
      conn.on('open', () => {
        conns.set(conn.connectionId, conn);
        lastSeen.set(conn.connectionId, Date.now());
      });
      conn.on('data', (data) => {
        lastSeen.set(conn.connectionId, Date.now());
        if (data && data.t === 'ping') return conn.send({ t: 'pong' });
        onMessage(conn.connectionId, data);
      });
      conn.on('close', () => drop(conn));
      conn.on('error', () => {});
    });
    peer.on('disconnected', () => {
      // lost the signalling server; existing games keep working but reconnect so new joins do too
      if (!destroyed && !peer.destroyed) setTimeout(() => !destroyed && peer.reconnect(), 2000);
    });
    peer.on('error', (e) => {
      if (e.type === 'unavailable-id' && attempts++ < 10) {
        // the old host tab may still hold the id for a moment after a refresh
        peer.destroy();
        setTimeout(() => !destroyed && start(), 3000);
        return;
      }
      if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error') {
        onError && onError("Can't reach the connection server. Check your internet connection.");
        return;
      }
      if (e.type !== 'peer-unavailable') onError && onError(e.message || String(e));
    });
  };
  start();

  return {
    send(connId, msg) {
      const c = conns.get(connId);
      if (c && c.open) c.send(msg);
    },
    close() {
      destroyed = true;
      clearInterval(sweep);
      peer && peer.destroy();
    },
  };
}

// Client side. Keeps trying to reconnect if the link drops.
export function joinRoom(code, { onOpen, onMessage, onStatus }) {
  let peer;
  let conn;
  let closed = false;
  let retryTimer;
  let lastSeen = 0;
  let dialTimer;
  let connected = false;
  let tryingSince = Date.now(); // when we last lost (or never had) a working link
  // after SLOW_MS without getting through, report 'slow' instead of 'connecting' until it works
  let noHost = false; // a wrong code (or a closed host page) keeps its own message while we retry
  const status = (s, detail) => {
    if (s === 'no-host') noHost = true;
    if (s === 'connected') noHost = false;
    if (s === 'connecting' && noHost) s = 'no-host';
    else if (s === 'connecting' && !connected && Date.now() - tryingSince >= SLOW_MS) s = 'slow';
    onStatus && onStatus(s, detail);
  };
  const slowCheck = setInterval(() => {
    if (!connected && !closed && Date.now() - tryingSince >= SLOW_MS) status('connecting');
  }, 1000);
  const pinger = setInterval(() => {
    if (!conn || !conn.open) return;
    if (Date.now() - lastSeen > STALE_MS) {
      // host went quiet: start over
      const dead = conn;
      conn = null;
      connected = false;
      tryingSince = Date.now();
      try {
        dead.close();
      } catch {}
      status('connecting');
      retry();
      return;
    }
    conn.send({ t: 'ping' });
  }, PING_MS);

  const connect = () => {
    if (closed) return;
    status('connecting');
    if (!peer || peer.destroyed) {
      peer = new window.Peer(peerOptions());
      peer.on('open', dial);
      peer.on('error', (e) => {
        if (e.type === 'peer-unavailable') status('no-host');
        else status('error', e.message || String(e));
        retry();
      });
      peer.on('disconnected', () => !closed && !peer.destroyed && peer.reconnect());
    } else dial();
  };

  const dial = () => {
    if (closed) return;
    const c = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
    conn = c;
    // a link that never opens doesn't always report an error, so give up on it and dial again
    clearTimeout(dialTimer);
    dialTimer = setTimeout(() => {
      if (conn !== c || c.open) return;
      conn = null;
      try {
        c.close();
      } catch {}
      retry();
    }, SLOW_MS);
    c.on('open', () => {
      clearTimeout(dialTimer);
      lastSeen = Date.now();
      connected = true;
      status('connected');
      onOpen && onOpen();
    });
    c.on('data', (data) => {
      lastSeen = Date.now();
      if (data && data.t === 'pong') return;
      onMessage(data);
    });
    c.on('close', () => {
      if (conn !== c) return;
      if (connected) tryingSince = Date.now();
      connected = false;
      status('connecting');
      retry();
    });
  };

  const retry = () => {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, 2500);
  };

  connect();

  return {
    send(msg) {
      if (conn && conn.open) conn.send(msg);
    },
    close() {
      closed = true;
      clearInterval(pinger);
      clearInterval(slowCheck);
      clearTimeout(retryTimer);
      clearTimeout(dialTimer);
      peer && peer.destroy();
    },
  };
}
