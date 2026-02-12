/**
 * OpenClaw Integration for A2A Federation
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
 * Philosophy: Every call is a potential collaboration. Find mutual value,
 * create action items for BOTH sides, and surface opportunities that align
 * with owner's goals.
 */
function buildSummaryPrompt(messages, ownerContext, callerInfo = {}) {
  const messageText = messages.map(m => {
    const role = m.direction === 'inbound' ? `[Caller${callerInfo.name ? ` - ${callerInfo.name}` : ''}]` : '[You]';
    return `${role}: ${m.content}`;
  }).join('\n\n');

  const goalsSection = ownerContext.goals?.length ? `### Current Goals\n- ${ownerContext.goals.join('\n- ')}` : '';
  const interestsSection = ownerContext.interests?.length ? `### Interests\n- ${ownerContext.interests.join('\n- ')}` : '';

  return `You just finished a federated agent-to-agent call. Summarize it from your owner's perspective.

## Philosophy
Every inbound call is a potential collaboration opportunity. Your job is to:
1. Find MUTUAL value - what can both parties gain?
2. Create action items for BOTH sides - not just your owner
3. Surface alignment with owner's goals and interests
4. Identify concrete next steps that move the relationship forward

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
Analyze this conversation through the lens of MUTUAL COLLABORATION. Return JSON:

{
  "summary": "Brief neutral summary of what was discussed",
  "ownerSummary": "What this means for YOUR OWNER - opportunities, risks, relevance",
  "relevance": "low" | "medium" | "high",
  "goalsTouched": ["owner goals this relates to"],
  
  "ownerActionItems": ["specific things YOUR OWNER should do"],
  "callerActionItems": ["things the CALLER committed to or should do"],
  "jointActionItems": ["things to do TOGETHER"],
  
  "collaborationOpportunity": {
    "exists": true,
    "description": "What could we build/do together?",
    "alignment": "How does this align with owner's mission?"
  },
  
  "followUp": "Suggested next step to move this forward",
  "notes": "Other insights - who is this caller? What's their angle? Trust level?"
}

Think like a strategic advisor. This summary helps your owner decide if/how to pursue this relationship.

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
