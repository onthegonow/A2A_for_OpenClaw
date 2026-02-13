/**
 * Runtime adapter for inbound A2A calls.
 *
 * Modes:
 * - openclaw: uses `openclaw` CLI for turn handling, summaries, notifications
 * - generic: platform-agnostic fallback that never hard-fails calls
 *
 * Selection:
 * - A2A_RUNTIME=openclaw|generic|auto (default: auto)
 * - auto picks openclaw if CLI exists, otherwise generic
 *
 * Generic bridge hooks:
 * - A2A_AGENT_COMMAND   command that receives JSON payload on stdin and returns text or JSON
 * - A2A_SUMMARY_COMMAND command that receives JSON payload on stdin and returns summary text/JSON
 * - A2A_NOTIFY_COMMAND  command that receives JSON payload on stdin for owner notifications
 */

const { execSync, spawnSync } = require('child_process');
const { createLogger } = require('./logger');

function commandExists(command) {
  try {
    execSync(`command -v ${command}`, { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

function cleanText(value, maxLength = 300) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeCommandText(command) {
  return String(command || '').trim().slice(0, 160);
}

function payloadAuditLength(payload) {
  const raw = JSON.stringify(payload || {});
  return Number.isFinite(raw?.length) ? raw.length : 0;
}

function toBool(value, fallback = true) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  return !(normalized === '0' || normalized === 'false' || normalized === 'no');
}

function resolveRuntimeMode() {
  const requested = String(process.env.A2A_RUNTIME || 'auto').trim().toLowerCase();
  const hasOpenClaw = commandExists('openclaw');

  if (requested === 'generic') {
    return {
      mode: 'generic',
      requested,
      hasOpenClaw,
      reason: 'A2A_RUNTIME=generic'
    };
  }

  if (requested === 'openclaw') {
    if (hasOpenClaw) {
      return {
        mode: 'openclaw',
        requested,
        hasOpenClaw,
        reason: 'A2A_RUNTIME=openclaw'
      };
    }
    return {
      mode: 'generic',
      requested,
      hasOpenClaw,
      warning: 'A2A_RUNTIME=openclaw but openclaw CLI not found, falling back to generic runtime',
      reason: 'forced-openclaw-missing'
    };
  }

  if (hasOpenClaw) {
    return {
      mode: 'openclaw',
      requested: 'auto',
      hasOpenClaw,
      reason: 'openclaw CLI detected'
    };
  }

  return {
    mode: 'generic',
    requested: 'auto',
    hasOpenClaw,
    reason: 'openclaw CLI not detected'
  };
}

function normalizeOpenClawOutput(raw) {
  const lines = String(raw || '')
    .split('\n')
    .filter(line => {
      if (!line.trim()) return false;
      if (line.includes('[telegram-topic-tracker]')) return false;
      if (line.includes('Plugin registered')) return false;
      return true;
    });
  return lines.join('\n').trim();
}

function parseCommandTextOutput(rawOutput, keys = ['response', 'text', 'message']) {
  const output = String(rawOutput || '').trim();
  if (!output) {
    return '';
  }

  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === 'object') {
      for (const key of keys) {
        if (typeof parsed[key] === 'string' && parsed[key].trim()) {
          return parsed[key].trim();
        }
      }
    }
  } catch (err) {
    // Plain text output is valid for bridge commands.
  }

  return output;
}

function parseSummaryOutput(rawOutput) {
  const output = String(rawOutput || '').trim();
  if (!output) {
    return null;
  }

  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === 'object') {
      const summary = cleanText(parsed.summary || parsed.text || parsed.message, 1500);
      return {
        ...parsed,
        summary: summary || null,
        ownerSummary: cleanText(
          parsed.ownerSummary || parsed.owner_summary || summary || '',
          1500
        ) || null
      };
    }
  } catch (err) {
    // Plain text is also acceptable.
  }

  const summary = cleanText(output, 1500);
  return {
    summary,
    ownerSummary: summary
  };
}

function runCommand(command, payload, options = {}) {
  const payloadJson = JSON.stringify(payload || {});
  const timeoutMs = options.timeoutMs || 60000;
  return execSync(command, {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
    input: payloadJson,
    cwd: options.cwd || process.cwd(),
    env: {
      ...process.env,
      A2A_PAYLOAD_JSON: payloadJson
    }
  });
}

function escapeCliValue(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')     // Backslashes first
    .replace(/"/g, '\\"')       // Double quotes
    .replace(/\$/g, '\\$')      // Dollar signs (variable expansion)
    .replace(/`/g, '\\`')       // Backticks (command substitution)
    .replace(/!/g, '\\!')       // History expansion in some shells
    .replace(/\n/g, '\\n')      // Newlines
    .replace(/\r/g, '');        // Carriage returns
}

function buildFallbackResponse(message, context = {}, reason = null) {
  const callerName = cleanText(context.callerName || context.caller?.name || 'caller');
  const ownerName = cleanText(context.ownerName || 'the owner');
  const allowedTopics = Array.isArray(context.allowedTopics)
    ? context.allowedTopics.filter(Boolean).slice(0, 4)
    : [];
  const topicText = allowedTopics.length > 0
    ? allowedTopics.join(', ')
    : 'permitted topics';
  const excerpt = cleanText(message, 220) || 'No message content provided.';

  let prefix = `I am running in generic A2A mode for ${ownerName}.`;
  if (reason) {
    prefix = `I switched to generic fallback mode (${cleanText(reason, 120)}).`;
  }

  return `${prefix} I received from ${callerName}: "${excerpt}". ` +
    `We can still work through concrete overlap on ${topicText} and line up actionable next steps. ` +
    `What outcome should we target first?`;
}

function buildFallbackSummary(messages = [], callerInfo = {}, reason = null) {
  const inbound = messages.filter(m => m.direction === 'inbound');
  const outbound = messages.filter(m => m.direction !== 'inbound');
  const caller = cleanText(callerInfo?.name || 'Unknown caller');
  const lastInbound = inbound.length > 0
    ? cleanText(inbound[inbound.length - 1].content, 220)
    : '';

  const summary = [
    `Call concluded with ${caller}.`,
    `Inbound turns: ${inbound.length}. Outbound turns: ${outbound.length}.`,
    lastInbound ? `Latest caller request: "${lastInbound}".` : '',
    reason ? `Summary mode: ${cleanText(reason, 140)}.` : 'Summary mode: generic fallback.'
  ].filter(Boolean).join(' ');

  return {
    summary,
    ownerSummary: summary,
    relevance: 'unknown',
    goalsTouched: [],
    ownerActionItems: [],
    callerActionItems: [],
    jointActionItems: [],
    collaborationOpportunity: {
      found: false,
      rationale: 'Generic fallback summary (no platform-specific summarizer configured)'
    },
    followUp: lastInbound
      ? `Clarify the next concrete step for: ${lastInbound}`
      : 'Ask both owners to confirm desired follow-up scope.',
    notes: reason
      ? `Fallback summary generated after runtime issue: ${cleanText(reason, 180)}`
      : 'Fallback summary generated by generic runtime.'
  };
}

function createRuntimeAdapter(options = {}) {
  const workspaceDir = options.workspaceDir || process.cwd();
  const modeInfo = resolveRuntimeMode();
  const failoverEnabled = toBool(process.env.A2A_RUNTIME_FAILOVER, true);
  const logger = options.logger || createLogger({ component: 'a2a.runtime' });

  const genericAgentCommand = process.env.A2A_AGENT_COMMAND || '';
  const genericSummaryCommand = process.env.A2A_SUMMARY_COMMAND || '';
  const genericNotifyCommand = process.env.A2A_NOTIFY_COMMAND || '';

  logger.info('Runtime adapter initialized', {
    event: 'runtime_initialized',
    data: {
      mode: modeInfo.mode,
      requested_mode: modeInfo.requested,
      reason: modeInfo.reason,
      has_openclaw: modeInfo.hasOpenClaw,
      failover_enabled: failoverEnabled
    }
  });

  async function runOpenClawTurn({ sessionId, prompt, timeoutMs }) {
    const timeoutSeconds = Math.max(5, Math.min(300, Math.round((timeoutMs || 65000) / 1000)));
    // Use spawnSync with stdin to avoid shell escaping issues with complex prompts
    const result = spawnSync('openclaw', [
      'agent',
      '--session-id', sessionId,
      '--message', prompt,
      '--timeout', String(timeoutSeconds)
    ], {
      encoding: 'utf8',
      timeout: (timeoutMs || 65000) + 5000,
      maxBuffer: 1024 * 1024,
      cwd: workspaceDir,
      env: { ...process.env, FORCE_COLOR: '0' }
    });
    const output = (result.stdout || '') + (result.stderr || '');
    if (result.error) {
      throw result.error;
    }
    return normalizeOpenClawOutput(output) || '[Sub-agent returned empty response]';
  }

  async function runOpenClawSummary({ sessionId, prompt, timeoutMs }) {
    const timeoutSeconds = Math.max(5, Math.min(120, Math.round((timeoutMs || 35000) / 1000)));
    // Use spawnSync with stdin to avoid shell escaping issues with complex prompts
    const result = spawnSync('openclaw', [
      'agent',
      '--session-id', sessionId,
      '--message', prompt,
      '--timeout', String(timeoutSeconds)
    ], {
      encoding: 'utf8',
      timeout: (timeoutMs || 35000) + 5000,
      cwd: workspaceDir,
      env: { ...process.env, FORCE_COLOR: '0' }
    });
    const output = (result.stdout || '') + (result.stderr || '');
    if (result.error) {
      throw result.error;
    }
    const summaryText = cleanText(normalizeOpenClawOutput(output), 1500);
    if (!summaryText) {
      return null;
    }
    return {
      summary: summaryText,
      ownerSummary: summaryText
    };
  }

  async function runOpenClawNotify({ callerName, callerOwner, message }) {
    const notification = `🤝 **A2A Call**\nFrom: ${callerName}${callerOwner}\n> ${message.slice(0, 150)}...`;
    // Use spawnSync to avoid shell escaping issues
    spawnSync('openclaw', [
      'message', 'send',
      '--channel', 'telegram',
      '--message', notification
    ], { timeout: 10000, stdio: 'pipe' });
  }

  async function runGenericTurn({ message, caller, context, runtimeError }) {
    const payload = {
      mode: 'a2a-turn',
      message,
      caller: caller || {},
      context: context || {}
    };
    const traceId = context?.traceId || context?.trace_id;
    const requestId = context?.requestId || context?.request_id;
    const conversationId = context?.conversationId || context?.conversation_id;
    const startAt = Date.now();

    logger.debug('Invoking generic agent command', {
      event: 'generic_agent_command_start',
      traceId,
      requestId,
      conversationId,
      data: {
        command: normalizeCommandText(genericAgentCommand),
        payload_bytes: payloadAuditLength(payload)
      }
    });

    if (genericAgentCommand) {
      try {
        const output = runCommand(genericAgentCommand, payload, {
          timeoutMs: context?.timeoutMs || 65000
        });
        const text = parseCommandTextOutput(output);
        logger.debug('Generic agent command completed', {
          event: 'generic_agent_command_complete',
          traceId,
          requestId,
          conversationId,
          data: {
            command: normalizeCommandText(genericAgentCommand),
            duration_ms: Date.now() - startAt,
            output_length: String(output || '').length
          }
        });
        if (text) {
          return text;
        }
      } catch (err) {
        runtimeError = err.message;
        logger.error('Generic agent command failed', {
          event: 'generic_agent_command_failed',
          traceId,
          requestId,
          conversationId,
          error_code: 'GENERIC_AGENT_COMMAND_FAILED',
          hint: 'Verify A2A_AGENT_COMMAND exits 0 and returns valid text/JSON response.',
          error: err,
          data: {
            command_present: Boolean(genericAgentCommand),
            command: normalizeCommandText(genericAgentCommand),
            payload_bytes: payloadAuditLength(payload),
            duration_ms: Date.now() - startAt
          }
        });
      }
    }

    return buildFallbackResponse(message, {
      caller,
      callerName: caller?.name,
      ownerName: context?.ownerName,
      allowedTopics: context?.allowedTopics
    }, runtimeError);
  }

  async function runGenericSummary({ messages, callerInfo, reason }) {
    const payload = {
      mode: 'a2a-summary',
      messages,
      caller: callerInfo || {}
    };
    const traceId = callerInfo?.trace_id || callerInfo?.traceId;
    const requestId = callerInfo?.request_id || callerInfo?.requestId;
    const conversationId = callerInfo?.conversation_id || callerInfo?.conversationId;
    const startAt = Date.now();

    if (genericSummaryCommand) {
      try {
        const output = runCommand(genericSummaryCommand, payload, { timeoutMs: 35000 });
        const parsed = parseSummaryOutput(output);
        logger.debug('Generic summary command completed', {
          event: 'generic_summary_command_complete',
          traceId,
          requestId,
          conversationId,
          data: {
            command: normalizeCommandText(genericSummaryCommand),
            payload_bytes: payloadAuditLength(payload),
            output_length: String(output || '').length
          }
        });
        if (parsed && parsed.summary) {
          return parsed;
        }
      } catch (err) {
        reason = err.message;
        logger.error('Generic summary command failed', {
          event: 'generic_summary_command_failed',
          traceId,
          requestId,
          conversationId,
          error_code: 'GENERIC_SUMMARY_COMMAND_FAILED',
          hint: 'Verify A2A_SUMMARY_COMMAND returns JSON with summary field or plain text.',
          error: err,
          data: {
            command_present: Boolean(genericSummaryCommand),
            command: normalizeCommandText(genericSummaryCommand),
            payload_bytes: payloadAuditLength(payload),
            duration_ms: Date.now() - startAt
          }
        });
      }
    }

    return buildFallbackSummary(messages, callerInfo, reason);
  }

  async function runGenericNotify(payload) {
    if (!genericNotifyCommand) {
      return;
    }
    const traceId = payload?.trace_id || payload?.traceId;
    const requestId = payload?.request_id || payload?.requestId;
    const conversationId = payload?.conversationId;
    const startAt = Date.now();
    logger.debug('Invoking generic notify command', {
      event: 'generic_notify_command_start',
      traceId,
      requestId,
      conversationId,
      data: {
        command: normalizeCommandText(genericNotifyCommand),
        payload_bytes: payloadAuditLength(payload)
      }
    });
    try {
      runCommand(genericNotifyCommand, payload, { timeoutMs: 10000 });
      logger.debug('Generic notify command completed', {
        event: 'generic_notify_command_complete',
        traceId,
        requestId,
        conversationId,
        data: {
          command: normalizeCommandText(genericNotifyCommand),
          duration_ms: Date.now() - startAt
        }
      });
    } catch (err) {
      logger.error('Generic notify command failed', {
        event: 'generic_notify_command_failed',
        traceId,
        requestId,
        conversationId,
        tokenId: payload?.token?.id,
        error_code: 'GENERIC_NOTIFY_COMMAND_FAILED',
        hint: 'Validate A2A_NOTIFY_COMMAND and downstream notifier transport availability.',
        error: err,
        data: {
          command_present: Boolean(genericNotifyCommand),
          command: normalizeCommandText(genericNotifyCommand),
          payload_bytes: payloadAuditLength(payload),
          duration_ms: Date.now() - startAt
        }
      });
    }
  }

  async function runTurn({ sessionId, prompt, message, caller, context = {}, timeoutMs }) {
    const traceId = context?.traceId || context?.trace_id;
    const requestId = context?.requestId || context?.request_id;
    const conversationId = context?.conversationId || context?.conversation_id;
    if (modeInfo.mode !== 'openclaw') {
      return runGenericTurn({ message, caller, context });
    }

    const startAt = Date.now();
    logger.debug('Invoking openclaw turn', {
      event: 'openclaw_turn_start',
      traceId,
      requestId,
      conversationId,
      data: {
        session_id: sessionId,
        timeout_ms: timeoutMs
      }
    });

    try {
      const response = await runOpenClawTurn({ sessionId, prompt, timeoutMs });
      logger.debug('OpenClaw turn completed', {
        event: 'openclaw_turn_complete',
        traceId,
        requestId,
        conversationId,
        data: {
          session_id: sessionId,
          duration_ms: Date.now() - startAt
        }
      });
      return response;
    } catch (err) {
      if (!failoverEnabled) {
        logger.error('OpenClaw turn failed', {
          event: 'openclaw_turn_failed',
          traceId,
          requestId,
          conversationId,
          error_code: 'OPENCLAW_TURN_FAILED',
          hint: 'Inspect OpenClaw CLI output, timeout settings, and environment PATH.',
          error: err,
          data: {
            session_id: sessionId,
            timeout_ms: timeoutMs,
            duration_ms: Date.now() - startAt
          }
        });
        throw err;
      }
      logger.warn('OpenClaw runtime failed, switching to generic fallback', {
        event: 'openclaw_turn_failed_fallback',
        traceId,
        requestId,
        conversationId,
        error_code: 'OPENCLAW_TURN_FAILED_FALLBACK',
        hint: 'Inspect OpenClaw CLI health or set A2A_RUNTIME=generic for explicit fallback mode.',
        error: err,
        data: {
          duration_ms: Date.now() - startAt,
          failover_enabled: failoverEnabled
        }
      });
      return runGenericTurn({
        message,
        caller,
        context,
        runtimeError: `openclaw runtime unavailable: ${err.message}`
      });
    }
  }

  async function summarize({ sessionId, prompt, messages, callerInfo, traceId, conversationId }) {
    const effectiveTraceId = traceId || callerInfo?.trace_id || callerInfo?.traceId;
    const requestId = callerInfo?.request_id || callerInfo?.requestId;
    const effectiveConversationId = conversationId || callerInfo?.conversation_id || callerInfo?.conversationId;
    if (modeInfo.mode !== 'openclaw') {
      return runGenericSummary({ messages, callerInfo });
    }
    const startAt = Date.now();
    logger.debug('Invoking openclaw summary', {
      event: 'openclaw_summary_start',
      traceId: effectiveTraceId,
      requestId,
      conversationId: effectiveConversationId,
      data: {
        session_id: sessionId,
        message_count: Array.isArray(messages) ? messages.length : 0
      }
    });

    try {
      const result = await runOpenClawSummary({
        sessionId,
        prompt,
        timeoutMs: 35000
      });
      if (result && result.summary) {
        logger.debug('OpenClaw summary completed', {
          event: 'openclaw_summary_complete',
          traceId: effectiveTraceId,
          requestId,
          conversationId: effectiveConversationId,
          data: {
            session_id: sessionId,
            duration_ms: Date.now() - startAt
          }
        });
        return result;
      }
      logger.warn('OpenClaw summary returned empty output; using generic fallback', {
        event: 'openclaw_summary_empty',
        traceId: effectiveTraceId,
        requestId,
        conversationId: effectiveConversationId,
        data: {
          session_id: sessionId,
          duration_ms: Date.now() - startAt
        }
      });
      return runGenericSummary({
        messages,
        callerInfo,
        reason: 'empty summary from openclaw runtime'
      });
    } catch (err) {
      if (!failoverEnabled) {
        logger.error('OpenClaw summary failed', {
          event: 'openclaw_summary_failed',
          traceId: effectiveTraceId,
          requestId,
          conversationId: effectiveConversationId,
          error_code: 'OPENCLAW_SUMMARY_FAILED',
          hint: 'Inspect summary message length, timeout configuration, and CLI stderr output.',
          error: err,
          data: {
            session_id: sessionId,
            duration_ms: Date.now() - startAt
          }
        });
        throw err;
      }
      logger.warn('OpenClaw summary failed, using generic fallback', {
        event: 'openclaw_summary_failed_fallback',
        traceId: effectiveTraceId,
        requestId,
        conversationId: effectiveConversationId,
        error_code: 'OPENCLAW_SUMMARY_FAILED_FALLBACK',
        hint: 'Inspect OpenClaw summary session output and summarizer prompt input.',
        error: err,
        data: {
          session_id: sessionId,
          duration_ms: Date.now() - startAt,
          failover_enabled: failoverEnabled
        }
      });
      return runGenericSummary({
        messages,
        callerInfo,
        reason: `openclaw summary unavailable: ${err.message}`
      });
    }
  }

  async function notify({ level, token, caller, message, conversationId, traceId }) {
    const requestId = token?.request_id || token?.requestId || null;
    const payload = {
      mode: 'a2a-notify',
      level,
      token: token || null,
      caller: caller || null,
      message,
      conversationId,
      traceId,
      requestId
    };

    logger.debug('Owner notify requested', {
      event: 'notify_requested',
      traceId,
      requestId,
      conversationId,
      tokenId: token?.id,
      data: { level }
    });

    if (modeInfo.mode !== 'openclaw') {
      return runGenericNotify(payload);
    }

    if (level !== 'all') {
      return;
    }

    const callerName = caller?.name || 'Unknown';
    const callerOwner = caller?.owner ? ` (${caller.owner})` : '';
    const notifyStart = Date.now();

    try {
      await runOpenClawNotify({ callerName, callerOwner, message: message || '' });
      logger.debug('OpenClaw notify completed', {
        event: 'openclaw_notify_complete',
        traceId,
        requestId,
        conversationId,
        tokenId: token?.id,
        data: {
          duration_ms: Date.now() - notifyStart
        }
      });
    } catch (err) {
      if (!failoverEnabled) {
        throw err;
      }
      logger.warn('OpenClaw notify failed, running generic notifier', {
        event: 'openclaw_notify_failed_fallback',
        traceId,
        requestId,
        conversationId,
        tokenId: token?.id,
        error_code: 'OPENCLAW_NOTIFY_FAILED_FALLBACK',
        hint: 'Check OpenClaw messaging channel config and notify permissions.',
        error: err,
        data: {
          failover_enabled: failoverEnabled,
          duration_ms: Date.now() - notifyStart
        }
      });
      logger.debug('OpenClaw notify fallback to generic notifier', {
        event: 'openclaw_notify_generic_fallback',
        traceId,
        requestId,
        conversationId,
        tokenId: token?.id
      });
      await runGenericNotify(payload);
    }
  }

  return {
    mode: modeInfo.mode,
    requestedMode: modeInfo.requested,
    hasOpenClaw: modeInfo.hasOpenClaw,
    reason: modeInfo.reason,
    warning: modeInfo.warning || null,
    failoverEnabled,
    runTurn,
    summarize,
    notify,
    buildFallbackResponse
  };
}

module.exports = {
  createRuntimeAdapter,
  resolveRuntimeMode,
  buildFallbackResponse
};
