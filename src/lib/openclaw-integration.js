/**
 * OpenClaw Integration for A2A
 * 
 * Provides owner-context summarization using OpenClaw's agent system.
 */

const fs = require('fs');
const path = require('path');

/**
 * Load owner context from OpenClaw workspace files
 */
function loadOwnerContext(workspaceDir = process.cwd()) {
  const context = {
    goals: [],
    interests: [],
    context: '',
    user: null,
    memory: null
  };

  // Load USER.md
  const userPath = path.join(workspaceDir, 'USER.md');
  if (fs.existsSync(userPath)) {
    context.user = fs.readFileSync(userPath, 'utf8');
    // Extract goals from USER.md
    const goalsMatch = context.user.match(/##\s*(?:Goals|Current|Seeking)[^\n]*\n([\s\S]*?)(?=\n##|$)/i);
    if (goalsMatch) {
      context.goals = goalsMatch[1]
        .split('\n')
        .filter(l => l.trim().startsWith('-') || l.trim().startsWith('*'))
        .map(l => l.replace(/^[\s\-\*]+/, '').trim())
        .filter(Boolean);
    }
    // Extract interests
    const interestsMatch = context.user.match(/##\s*(?:Interests|Projects)[^\n]*\n([\s\S]*?)(?=\n##|$)/i);
    if (interestsMatch) {
      context.interests = interestsMatch[1]
        .split('\n')
        .filter(l => l.trim().startsWith('-') || l.trim().startsWith('*'))
        .map(l => l.replace(/^[\s\-\*]+/, '').trim())
        .filter(Boolean);
    }
  }

  // Load recent memory
  const memoryDir = path.join(workspaceDir, 'memory');
  if (fs.existsSync(memoryDir)) {
    const files = fs.readdirSync(memoryDir)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse()
      .slice(0, 3); // Last 3 memory files
    
    context.memory = files.map(f => {
      const content = fs.readFileSync(path.join(memoryDir, f), 'utf8');
      return `## ${f}\n${content}`;
    }).join('\n\n');
  }

  // Load MEMORY.md if exists
  const mainMemoryPath = path.join(workspaceDir, 'MEMORY.md');
  if (fs.existsSync(mainMemoryPath)) {
    const mainMemory = fs.readFileSync(mainMemoryPath, 'utf8');
    context.memory = mainMemory + '\n\n' + (context.memory || '');
  }

  return context;
}

/**
 * Build summary prompt for agent
 * 
 * Philosophy: A2A is collaborative AND adversarial. Each agent tries
 * to maximize value for their owner while finding genuine mutual wins.
 * Track the exchange balance AND surface partnership opportunities.
 */
function buildSummaryPrompt(messages, ownerContext, callerInfo = {}) {
  const messageText = messages.map(m => {
    const role = m.direction === 'inbound' ? `[Caller${callerInfo.name ? ` - ${callerInfo.name}` : ''}]` : '[You]';
    return `${role}: ${m.content}`;
  }).join('\n\n');

  const goalsSection = ownerContext.goals?.length ? `### Current Goals\n- ${ownerContext.goals.join('\n- ')}` : '';
  const interestsSection = ownerContext.interests?.length ? `### Interests\n- ${ownerContext.interests.join('\n- ')}` : '';

  return `You just finished a A2A agent-to-agent call. Analyze it strategically for your owner.

## Philosophy
A2A is cooperative AND adversarial. Each agent maximizes value for their own owner — but the best outcomes are mutual wins. Your job:

1. **Track the exchange** — what did we get vs give?
2. **Find mutual value** — what can BOTH parties gain?
3. **Surface alignment** — does this connect to owner's goals?
4. **Advise strategically** — protect interests while building relationships

## Your Owner's Context
${ownerContext.user ? `### From USER.md\n${ownerContext.user.slice(0, 2000)}` : ''}

${goalsSection}

${interestsSection}

## The Conversation
${messageText}

## Caller Context
${callerInfo.name ? `Name: ${callerInfo.name}` : 'Unknown caller'}
${callerInfo.context ? `Context: ${callerInfo.context}` : ''}

## Your Task
Analyze as a strategic advisor. Return JSON:

{
  "summary": "Brief neutral summary (shareable)",
  
  "exchange": {
    "weGot": ["info, commitments, or value we extracted"],
    "weGave": ["info, compute, or commitments we provided"],
    "balance": "favorable | even | unfavorable",
    "fair": true
  },
  
  "mutualValue": {
    "found": true,
    "opportunities": ["potential wins for BOTH sides"],
    "alignment": "how this connects to owner's goals"
  },
  
  "actionItems": {
    "owner": ["what YOUR OWNER should do"],
    "caller": ["what THEY committed to or should do"],
    "joint": ["things to do TOGETHER"]
  },
  
  "trust": {
    "assessment": "appropriate | too_high | too_low",
    "recommendation": "maintain | increase | decrease | revoke",
    "pattern": "What's their angle? Genuine partner or extractive?"
  },
  
  "ownerBrief": "2-3 sentences: the strategic takeaway for your owner",
  "followUp": "concrete next step to advance this relationship (if any)"
}

Think like a strategic advisor: protect your owner's interests AND find mutual wins.

JSON:`;
}

/**
 * Create an OpenClaw summarizer that uses exec to call the agent
 * This works by writing a prompt file and using openclaw's CLI
 */
function createExecSummarizer(workspaceDir = process.cwd()) {
  const { execSync } = require('child_process');
  
  return async function(messages, callerInfo = {}) {
    const ownerContext = loadOwnerContext(workspaceDir);
    const prompt = buildSummaryPrompt(messages, ownerContext, callerInfo);
    
    // Write prompt to temp file
    const tmpFile = `/tmp/a2a-summary-${Date.now()}.txt`;
    fs.writeFileSync(tmpFile, prompt);
    
    try {
      // Call openclaw CLI to get agent response
      // This assumes openclaw has a way to do single-shot prompts
      const result = execSync(
        `cat "${tmpFile}" | openclaw prompt --json 2>/dev/null || echo '{}'`,
        { encoding: 'utf8', timeout: 30000 }
      );
      
      // Parse JSON from response
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      
      return {
        summary: result.slice(0, 500),
        ownerSummary: null,
        relevance: 'unknown',
        goalsTouched: [],
        actionItems: [],
        followUp: null,
        notes: null
      };
    } catch (err) {
      console.error('[a2a] Exec summarizer failed:', err.message);
      return { summary: null };
    } finally {
      // Cleanup
      try { fs.unlinkSync(tmpFile); } catch (e) {}
    }
  };
}

/**
 * Create a summarizer that posts to a local HTTP endpoint
 * OpenClaw can expose an internal summarization endpoint
 */
function createHttpSummarizer(endpoint = 'http://localhost:3000/api/summarize') {
  const http = require('http');
  const https = require('https');
  
  return async function(messages, callerInfo = {}) {
    const ownerContext = loadOwnerContext();
    const prompt = buildSummaryPrompt(messages, ownerContext, callerInfo);
    
    return new Promise((resolve) => {
      const url = new URL(endpoint);
      const client = url.protocol === 'https:' ? https : http;
      
      const req = client.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve({ summary: data.slice(0, 500) });
          }
        });
      });
      
      req.on('error', (err) => {
        console.error('[a2a] HTTP summarizer failed:', err.message);
        resolve({ summary: null });
      });
      
      req.write(JSON.stringify({ prompt, messages, callerInfo }));
      req.end();
    });
  };
}

/**
 * Create a summarizer using sessions_send to the main OpenClaw session
 * This is the preferred method when running inside OpenClaw
 */
function createSessionSummarizer(gatewayUrl, gatewayToken) {
  const http = require('http');
  const https = require('https');
  
  return async function(messages, callerInfo = {}) {
    const ownerContext = loadOwnerContext();
    const prompt = buildSummaryPrompt(messages, ownerContext, callerInfo);
    
    // Send to OpenClaw gateway's internal API
    return new Promise((resolve) => {
      const url = new URL(gatewayUrl || 'http://localhost:3000');
      const client = url.protocol === 'https:' ? https : http;
      
      const req = client.request({
        hostname: url.hostname,
        port: url.port,
        path: '/api/internal/summarize',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${gatewayToken || process.env.OPENCLAW_TOKEN}`
        },
        timeout: 60000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            resolve(result.summary || result);
          } catch (e) {
            resolve({ summary: data.slice(0, 500) });
          }
        });
      });
      
      req.on('error', (err) => {
        console.error('[a2a] Session summarizer failed:', err.message);
        resolve({ summary: null });
      });
      
      req.write(JSON.stringify({ prompt }));
      req.end();
    });
  };
}

/**
 * Auto-detect best summarizer based on environment
 */
function createAutoSummarizer(options = {}) {
  const workspaceDir = options.workspaceDir || process.env.OPENCLAW_WORKSPACE || process.cwd();
  
  // If gateway URL provided, use session summarizer
  if (options.gatewayUrl || process.env.OPENCLAW_GATEWAY_URL) {
    console.log('[a2a] Using session summarizer');
    return createSessionSummarizer(
      options.gatewayUrl || process.env.OPENCLAW_GATEWAY_URL,
      options.gatewayToken || process.env.OPENCLAW_TOKEN
    );
  }
  
  // If HTTP endpoint provided, use that
  if (options.summaryEndpoint) {
    console.log('[a2a] Using HTTP summarizer');
    return createHttpSummarizer(options.summaryEndpoint);
  }
  
  // Fall back to exec summarizer
  console.log('[a2a] Using exec summarizer');
  return createExecSummarizer(workspaceDir);
}

module.exports = {
  loadOwnerContext,
  buildSummaryPrompt,
  createExecSummarizer,
  createHttpSummarizer,
  createSessionSummarizer,
  createAutoSummarizer
};
