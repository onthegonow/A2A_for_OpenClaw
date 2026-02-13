/**
 * Port Scanner Utility
 *
 * Zero-dependency port availability checker using Node's net module.
 * Used by the server to find an open port at startup.
 */

const net = require('net');

/**
 * Attempt to bind a port and return a structured result.
 * Useful for distinguishing "already in use" from "permission denied".
 *
 * @param {number} port
 * @param {string} [host='0.0.0.0']
 * @returns {Promise<{ ok: boolean, code?: string, message?: string }>}
 */
function tryBindPort(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => resolve({ ok: false, code: err && err.code ? String(err.code) : 'ERROR', message: err ? String(err.message || '') : '' }));
    server.once('listening', () => server.close(() => resolve({ ok: true })));
    server.listen(port, host);
  });
}

/**
 * Check if a port is available on the given host for binding by the current user.
 * @param {number} port
 * @param {string} [host='0.0.0.0']
 * @returns {Promise<boolean>}
 */
function isPortAvailable(port, host = '0.0.0.0') {
  return tryBindPort(port, host).then((res) => Boolean(res && res.ok));
}

/**
 * Find the first available port from a list of candidates.
 * @param {number[]} candidates - Ports to try in order
 * @param {string} [host='0.0.0.0']
 * @returns {Promise<number|null>} - First available port, or null if all busy
 */
async function findAvailablePort(candidates, host = '0.0.0.0') {
  for (const port of candidates) {
    if (await isPortAvailable(port, host)) return port;
  }
  return null;
}

/**
 * Check whether a TCP listener exists on the given host/port.
 * This does NOT require binding privileges; it simply attempts to connect.
 *
 * @param {number} port
 * @param {string} [host='127.0.0.1']
 * @param {object} [options]
 * @param {number} [options.timeoutMs=400]
 * @returns {Promise<{ listening: boolean, code?: string, message?: string }>}
 */
function isPortListening(port, host = '127.0.0.1', options = {}) {
  const timeoutMs = Number.parseInt(String(options.timeoutMs || 400), 10) || 400;

  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (e) {}
      resolve(result);
    };

    socket.setTimeout(timeoutMs, () => finish({ listening: false, code: 'ETIMEDOUT', message: 'connect_timeout' }));
    socket.once('connect', () => finish({ listening: true }));
    socket.once('error', (err) => {
      const code = err && err.code ? String(err.code) : 'ERROR';
      finish({ listening: false, code, message: err ? String(err.message || '') : '' });
    });
  });
}

module.exports = { tryBindPort, isPortAvailable, isPortListening, findAvailablePort };
