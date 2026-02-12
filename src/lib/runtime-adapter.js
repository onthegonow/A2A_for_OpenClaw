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

  const genericAgentCommand = process.env.A2A_AGENT_COMMAND || '';
  const genericSummaryCommand = process.env.A2A_SUMMARY_COMMAND || '';
  const genericNotifyCommand = process.env.A2A_NOTIFY_COMMAND || '';

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

    if (genericAgentCommand) {
      try {
        const output = runCommand(genericAgentCommand, payload, {
          timeoutMs: context?.timeoutMs || 65000
        });
        const text = parseCommandTextOutput(output);
        if (text) {
          return text;
        }
      } catch (err) {
        runtimeError = err.message;
        console.error(`[a2a] Generic agent command failed: ${err.message}`);
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

    if (genericSummaryCommand) {
      try {
        const output = runCommand(genericSummaryCommand, payload, { timeoutMs: 35000 });
        const parsed = parseSummaryOutput(output);
        if (parsed && parsed.summary) {
          return parsed;
        }
      } catch (err) {
        reason = err.message;
        console.error(`[a2a] Generic summary command failed: ${err.message}`);
      }
    }

    return buildFallbackSummary(messages, callerInfo, reason);
  }

  async function runGenericNotify(payload) {
    if (!genericNotifyCommand) {
      return;
    }
    try {
      runCommand(genericNotifyCommand, payload, { timeoutMs: 10000 });
    } catch (err) {
      console.error(`[a2a] Generic notify command failed: ${err.message}`);
    }
  }

  async function runTurn({ sessionId, prompt, message, caller, context = {}, timeoutMs }) {
    if (modeInfo.mode !== 'openclaw') {
      return runGenericTurn({ message, caller, context });
    }

    try {
      return await runOpenClawTurn({ sessionId, prompt, timeoutMs });
    } catch (err) {
      if (!failoverEnabled) {
        throw err;
      }
      console.error(`[a2a] OpenClaw runtime failed, switching to generic fallback: ${err.message}`);
      return runGenericTurn({
        message,
        caller,
        context,
        runtimeError: `openclaw runtime unavailable: ${err.message}`
      });
    }
  }

  async function summarize({ sessionId, prompt, messages, callerInfo }) {
    if (modeInfo.mode !== 'openclaw') {
      return runGenericSummary({ messages, callerInfo });
    }

    try {
      const result = await runOpenClawSummary({
        sessionId,
        prompt,
        timeoutMs: 35000
      });
      if (result && result.summary) {
        return result;
      }
      return runGenericSummary({
        messages,
        callerInfo,
        reason: 'empty summary from openclaw runtime'
      });
    } catch (err) {
      if (!failoverEnabled) {
        throw err;
      }
      console.error(`[a2a] OpenClaw summary failed, using generic fallback: ${err.message}`);
      return runGenericSummary({
        messages,
        callerInfo,
        reason: `openclaw summary unavailable: ${err.message}`
      });
    }
  }

  async function notify({ level, token, caller, message, conversationId }) {
    const payload = {
      mode: 'a2a-notify',
      level,
      token: token || null,
      caller: caller || null,
      message,
      conversationId
    };

    if (modeInfo.mode !== 'openclaw') {
      return runGenericNotify(payload);
    }

    if (level !== 'all') {
      return;
    }

    const callerName = caller?.name || 'Unknown';
    const callerOwner = caller?.owner ? ` (${caller.owner})` : '';

    try {
      await runOpenClawNotify({ callerName, callerOwner, message: message || '' });
    } catch (err) {
      if (!failoverEnabled) {
        throw err;
      }
      console.error(`[a2a] OpenClaw notify failed, running generic notifier: ${err.message}`);
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
