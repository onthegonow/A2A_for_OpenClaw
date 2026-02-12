/**
 * A2A Client - Make calls to remote agents
 */

const https = require('https');
const http = require('http');

class A2AClient {
  constructor(options = {}) {
    this.timeout = options.timeout || 60000;
    this.caller = options.caller || {};
  }

  /**
   * Parse an a2a:// URL
   */
  static parseInvite(inviteUrl) {
    // Support both a2a:// and legacy oclaw:// schemes
    const match = inviteUrl.match(/^(?:a2a|oclaw):\/\/([^/]+)\/(.+)$/);
    if (!match) {
      throw new Error(`Invalid invite URL: ${inviteUrl}`);
    }
    return { host: match[1], token: match[2] };
  }

  /**
   * Call a remote agent
   * 
   * @param {string|object} endpoint - a2a:// URL or {host, token}
   * @param {string} message - Message to send
   * @param {object} options - Additional options
   * @returns {Promise<object>} Response from remote agent
   */
  async call(endpoint, message, options = {}) {
    let host, token;
    
    if (typeof endpoint === 'string') {
      ({ host, token } = A2AClient.parseInvite(endpoint));
    } else {
      ({ host, token } = endpoint);
    }

    const { conversationId, context, timeoutSeconds } = options;

    const body = JSON.stringify({
      message,
      conversation_id: conversationId,
      caller: this.caller,
      context,
      timeout_seconds: timeoutSeconds || 60
    });

    const isLocalhost = host === 'localhost' || host.startsWith('localhost:') || host.startsWith('127.');
    const hasExplicitPort = host.includes(':');
    const port = hasExplicitPort ? parseInt(host.split(':')[1]) : (isLocalhost ? 80 : 443);
    // Use HTTP for localhost or explicit non-443 ports, HTTPS otherwise
    const useHttp = isLocalhost || (hasExplicitPort && port !== 443);
    const protocol = useHttp ? http : https;
    const hostname = host.split(':')[0];

    return new Promise((resolve, reject) => {
      const req = protocol.request({
        hostname,
        port,
        path: '/api/a2a/invoke',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: this.timeout
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode >= 400) {
              reject(new A2AError(json.error || 'request_failed', json.message || data, res.statusCode));
            } else {
              resolve(json);
            }
          } catch (e) {
            reject(new A2AError('parse_error', `Failed to parse response: ${data}`, res.statusCode));
          }
        });
      });

      req.on('error', (e) => {
        reject(new A2AError('network_error', e.message));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new A2AError('timeout', 'Request timed out'));
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Explicitly end a remote conversation and trigger call conclusion
   * 
   * @param {string|object} endpoint - a2a:// URL or {host, token}
   * @param {string} conversationId - Conversation ID to conclude
   * @returns {Promise<object>} End response from remote agent
   */
  async end(endpoint, conversationId) {
    if (!conversationId) {
      throw new A2AError('missing_conversation_id', 'conversationId is required');
    }

    let host, token;
    
    if (typeof endpoint === 'string') {
      ({ host, token } = A2AClient.parseInvite(endpoint));
    } else {
      ({ host, token } = endpoint);
    }

    const body = JSON.stringify({
      conversation_id: conversationId
    });

    const isLocalhost = host === 'localhost' || host.startsWith('localhost:') || host.startsWith('127.');
    const hasExplicitPort = host.includes(':');
    const port = hasExplicitPort ? parseInt(host.split(':')[1]) : (isLocalhost ? 80 : 443);
    const useHttp = isLocalhost || (hasExplicitPort && port !== 443);
    const protocol = useHttp ? http : https;
    const hostname = host.split(':')[0];

    return new Promise((resolve, reject) => {
      const req = protocol.request({
        hostname,
        port,
        path: '/api/a2a/end',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: this.timeout
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode >= 400) {
              reject(new A2AError(json.error || 'request_failed', json.message || data, res.statusCode));
            } else {
              resolve(json);
            }
          } catch (e) {
            reject(new A2AError('parse_error', `Failed to parse response: ${data}`, res.statusCode));
          }
        });
      });

      req.on('error', (e) => {
        reject(new A2AError('network_error', e.message));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new A2AError('timeout', 'Request timed out'));
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Check if a remote agent is available
   */
  async ping(endpoint) {
    let host;
    
    if (typeof endpoint === 'string') {
      ({ host } = A2AClient.parseInvite(endpoint));
    } else {
      ({ host } = endpoint);
    }

    const isLocalhost = host === 'localhost' || host.startsWith('localhost:') || host.startsWith('127.');
    const hasExplicitPort = host.includes(':');
    const port = hasExplicitPort ? parseInt(host.split(':')[1]) : (isLocalhost ? 80 : 443);
    const useHttp = isLocalhost || (hasExplicitPort && port !== 443);
    const protocol = useHttp ? http : https;
    const hostname = host.split(':')[0];

    return new Promise((resolve, reject) => {
      const req = protocol.request({
        hostname,
        port,
        path: '/api/a2a/ping',
        method: 'GET',
        timeout: 5000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ pong: res.statusCode === 200 });
          }
        });
      });

      req.on('error', () => resolve({ pong: false }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ pong: false });
      });
      req.end();
    });
  }

  /**
   * Get A2A status of a remote
   */
  async status(endpoint) {
    let host;
    
    if (typeof endpoint === 'string') {
      ({ host } = A2AClient.parseInvite(endpoint));
    } else {
      ({ host } = endpoint);
    }

    const isLocalhost = host === 'localhost' || host.startsWith('localhost:') || host.startsWith('127.');
    const hasExplicitPort = host.includes(':');
    const port = hasExplicitPort ? parseInt(host.split(':')[1]) : (isLocalhost ? 80 : 443);
    const useHttp = isLocalhost || (hasExplicitPort && port !== 443);
    const protocol = useHttp ? http : https;
    const hostname = host.split(':')[0];

    return new Promise((resolve, reject) => {
      const req = protocol.request({
        hostname,
        port,
        path: '/api/a2a/status',
        method: 'GET',
        timeout: 5000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new A2AError('parse_error', 'Invalid status response'));
          }
        });
      });

      req.on('error', (e) => reject(new A2AError('network_error', e.message)));
      req.on('timeout', () => {
        req.destroy();
        reject(new A2AError('timeout', 'Request timed out'));
      });
      req.end();
    });
  }
}

class A2AError extends Error {
  constructor(code, message, statusCode = null) {
    super(message);
    this.name = 'A2AError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

module.exports = { A2AClient, A2AError };
