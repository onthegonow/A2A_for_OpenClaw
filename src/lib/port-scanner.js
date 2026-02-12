/**
 * Port Scanner Utility
 *
 * Zero-dependency port availability checker using Node's net module.
 * Used by the server to find an open port at startup.
 */

const net = require('net');

/**
 * Check if a port is available on the given host.
 * @param {number} port
 * @param {string} [host='0.0.0.0']
 * @returns {Promise<boolean>}
 */
function isPortAvailable(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
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

module.exports = { isPortAvailable, findAvailablePort };
