#!/usr/bin/env node

/**
 * Gemini Bridge - CLI Orchestrator and Universal OpenAI-Compatible Proxy
 * Connects to active browser webchat (Gemini, ChatGPT, Claude) via WebSocket on port 8765.
 * Provides OpenAI API proxy (/v1/chat/completions, /v1/models) and interactive agent loop.
 */

const { WebSocketServer } = require('ws');
const readline = require('readline');
const http = require('http');
const fs = require('fs');
const path = require('path');
const tools = require('./tools');

const MIME_MAP = {
  // Images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  // Documents
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.text': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.rtf': 'application/rtf',
  // Office formats
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Code & Data
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.jsx': 'text/javascript',
  '.py': 'text/x-python',
  '.sh': 'text/x-shellscript',
  '.bash': 'text/x-shellscript',
  '.zsh': 'text/x-shellscript',
  '.sql': 'text/x-sql',
  '.java': 'text/x-java-source',
  '.c': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.h': 'text/x-c',
  '.hpp': 'text/x-c++',
  '.rs': 'text/x-rust',
  '.go': 'text/x-go',
  // Archives
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.7z': 'application/x-7z-compressed',
  // Audio & Video
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
};

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

const stagedFiles = new Map();

function resolveFileItem(item, index = 1) {
  if (!item) return null;

  // Staged file reference by ID (e.g. file-...)
  if (typeof item === 'string' && stagedFiles.has(item)) {
    return stagedFiles.get(item);
  }
  if (typeof item === 'object' && item.file_id && stagedFiles.has(item.file_id)) {
    return stagedFiles.get(item.file_id);
  }

  // 1. If item is a string
  if (typeof item === 'string') {
    const trimmed = item.trim();

    // Data URL
    if (trimmed.startsWith('data:')) {
      const match = trimmed.match(/^data:([^;]+);base64,(.*)$/s);
      if (match) {
        const mime = match[1];
        const ext = Object.keys(MIME_MAP).find((k) => MIME_MAP[k] === mime) || '.bin';
        const rawExt = ext.startsWith('.') ? ext.slice(1) : ext;
        return {
          name: `upload_${Date.now()}_${index}.${rawExt}`,
          type: mime,
          data: match[2],
          size: Math.round((match[2].length * 3) / 4)
        };
      }
    }

    // Local file path or file:// URL
    let candidatePath = trimmed;
    if (candidatePath.startsWith('file://')) {
      candidatePath = candidatePath.replace(/^file:\/\//, '');
    }
    if (candidatePath.startsWith('~')) {
      candidatePath = path.join(process.env.HOME || '', candidatePath.slice(1));
    }
    const resolvedPath = path.resolve(process.cwd(), candidatePath);
    if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
      const buffer = fs.readFileSync(resolvedPath);
      return {
        name: path.basename(resolvedPath),
        type: getMimeType(resolvedPath),
        data: buffer.toString('base64'),
        size: buffer.length,
        path: resolvedPath
      };
    }

    // Raw base64 string
    return {
      name: `binary_${Date.now()}_${index}.bin`,
      type: 'application/octet-stream',
      data: trimmed,
      size: Math.round((trimmed.length * 3) / 4)
    };
  }

  // 2. If item is an object
  if (typeof item === 'object') {
    const itemPath = item.path || item.filepath || item.file_path;
    if (itemPath) {
      let candidate = itemPath;
      if (candidate.startsWith('file://')) candidate = candidate.replace(/^file:\/\//, '');
      if (candidate.startsWith('~')) candidate = path.join(process.env.HOME || '', candidate.slice(1));
      const resolved = path.resolve(process.cwd(), candidate);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        const buffer = fs.readFileSync(resolved);
        return {
          name: item.name || path.basename(resolved),
          type: item.type || item.mime || getMimeType(resolved),
          data: buffer.toString('base64'),
          size: buffer.length,
          path: resolved
        };
      }
    }

    let base64Data = item.data || item.base64 || item.content || '';
    let mimeType = item.type || item.mime || item.mimeType || 'application/octet-stream';
    let fileName = item.name || item.filename || `file_${Date.now()}_${index}`;

    if (typeof base64Data === 'string' && base64Data.startsWith('data:')) {
      const m = base64Data.match(/^data:([^;]+);base64,(.*)$/s);
      if (m) {
        if (!item.type && !item.mime) mimeType = m[1];
        base64Data = m[2];
      }
    }

    if (base64Data) {
      if (!fileName.includes('.')) {
        const ext = Object.keys(MIME_MAP).find((k) => MIME_MAP[k] === mimeType) || '.bin';
        const rawExt = ext.startsWith('.') ? ext.slice(1) : ext;
        fileName = `${fileName}.${rawExt}`;
      }
      return {
        name: fileName,
        type: mimeType,
        data: base64Data,
        size: item.size || Math.round((base64Data.length * 3) / 4)
      };
    }
  }

  return null;
}

// CLI Argument Parsing
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Gemini Bridge - Universal Webchat Agent Orchestrator & OpenAI Proxy

USAGE:
  node cli.js [OPTIONS]
  npx gemini-bridge [OPTIONS]

OPTIONS:
  -p, --port <number>   Port for WebSocket server and OpenAI HTTP proxy (default: 8765)
  --safe                Enable humanized pacing and safety delays (default: enabled)
  --fast                Disable safety pacing delays for faster execution
  -t, --test            Verify syntax, test configuration, and exit cleanly
  -h, --help            Show this help manual

ENDPOINTS:
  GET  /v1/models             OpenAI-compatible models list
  POST /v1/chat/completions   OpenAI-compatible chat completion (streaming & non-streaming)
  WS   ws://localhost:<port>  Bi-directional communication with Chrome extension
`);
  process.exit(0);
}

if (args.includes('--test')) {
  console.log('\x1b[32m[Gemini Bridge Test]\x1b[0m Syntax and configuration valid.');
  process.exit(0);
}

const isSafeMode = !args.includes('--fast');

let configuredPort = process.env.PORT || process.env.WS_PORT || 8765;
const portArgIndex = args.findIndex((arg) => arg === '-p' || arg === '--port');
if (portArgIndex !== -1 && args[portArgIndex + 1]) {
  configuredPort = parseInt(args[portArgIndex + 1], 10) || configuredPort;
}

const WS_PORT = configuredPort;
const PHONE_ENDPOINT = process.env.PHONE_ENDPOINT || 'http://localhost:8000';

let activeSocket = null;
let browserSocket = null;
let pendingResponseResolver = null;
let pendingResponseRejecter = null;
let activePlatform = 'Gemini';
let activeModel = 'gemini-web';

const SYSTEM_TOOL_SPEC = `
You have access to the following local developer tools on the user's laptop.
To invoke a tool, output a single JSON block wrapped inside a \`\`\`tool_call markdown fence.

Available tools:
1. run_command: Execute shell commands locally.
   Format:
   \`\`\`tool_call
   { "tool": "run_command", "args": { "command": "npm test" } }
   \`\`\`

2. read_file: Read file contents with optional line slice.
   Format:
   \`\`\`tool_call
   { "tool": "read_file", "args": { "path": "src/index.js", "startLine": 1, "endLine": 50 } }
   \`\`\`

3. write_file: Write or create a file.
   Format:
   \`\`\`tool_call
   { "tool": "write_file", "args": { "path": "src/index.js", "content": "..." } }
   \`\`\`

Rules:
- Make one tool call per turn when you need environment inspection or code edits.
- When your task is complete and you do not need more tools, reply with your final response without any \`\`\`tool_call block.
`;

function parseToolCall(responseText) {
  if (!responseText) return null;

  // 1. Markdown code blocks: ```tool_call ... ``` or ```json ... ```
  const toolCallRegex = /```(?:tool_call|json|bash)?\s*([\s\S]*?)```/g;
  let match;
  while ((match = toolCallRegex.exec(responseText)) !== null) {
    const rawContent = match[1].trim();
    try {
      const parsed = JSON.parse(rawContent);
      if (parsed.tool && parsed.args) return parsed;
      if (parsed.name && (parsed.arguments || parsed.args)) {
        return { tool: parsed.name, args: parsed.arguments || parsed.args };
      }
    } catch {}
  }

  // 2. Direct JSON object containing "tool" and "args"
  const jsonBraceRegex = /\{[\s\S]*?"tool"\s*:\s*"[^"]+"[\s\S]*?"args"\s*:\s*\{[\s\S]*?\}\s*\}/;
  const directMatch = responseText.match(jsonBraceRegex);
  if (directMatch) {
    try {
      const parsed = JSON.parse(directMatch[0]);
      if (parsed.tool && parsed.args) return parsed;
    } catch {}
  }

  // 3. OpenAI format { "name": "...", "arguments": {...} }
  const openaiStyleRegex = /\{[\s\S]*?"name"\s*:\s*"[^"]+"[\s\S]*?"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/;
  const openaiMatch = responseText.match(openaiStyleRegex);
  if (openaiMatch) {
    try {
      const parsed = JSON.parse(openaiMatch[0]);
      return { tool: parsed.name, args: parsed.arguments };
    } catch {}
  }

  return null;
}

/**
 * Checks phone System 1 microservice with ultra-short timeout and zero-crash fallback
 */
function queryPhoneSystem1(pathEndpoint, payload) {
  return new Promise((resolve) => {
    try {
      const data = JSON.stringify(payload);
      const url = new URL(pathEndpoint, PHONE_ENDPOINT);
      const req = http.request(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data)
          },
          timeout: 400
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            try {
              resolve(JSON.parse(body));
            } catch {
              resolve(null);
            }
          });
        }
      );

      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.write(data);
      req.end();
    } catch {
      resolve(null);
    }
  });
}

function sendPromptToChrome(promptText, files = []) {
  return new Promise((resolve, reject) => {
    const targetWs = browserSocket || activeSocket;
    if (!targetWs || targetWs.readyState !== 1) {
      return reject(
        new Error(`Browser extension is not connected on ws://localhost:${WS_PORT}. Please open ${activePlatform} in Chrome.`)
      );
    }
    pendingResponseResolver = resolve;
    pendingResponseRejecter = reject;

    const filesArray = Array.isArray(files) ? files : files ? [files] : [];
    const resolvedFiles = filesArray
      .map((f, idx) => resolveFileItem(f, idx + 1))
      .filter(Boolean);

    targetWs.send(
      JSON.stringify({
        type: 'PROMPT',
        text: promptText,
        files: resolvedFiles,
        images: resolvedFiles,
        safeMode: isSafeMode
      })
    );
  });
}

async function runAgentLoop(userGoal) {
  let promptToSend = `${SYSTEM_TOOL_SPEC}\n\nUser Task: ${userGoal}`;
  let turn = 1;
  const maxTurns = 25;

  while (turn <= maxTurns) {
    console.log(`\n\x1b[36m[Turn ${turn}] Routing prompt to ${activePlatform} (${activeModel})...\x1b[0m`);
    let responseText;
    try {
      responseText = await sendPromptToChrome(promptToSend);
    } catch (err) {
      console.error(`\x1b[31m[Bridge Error]\x1b[0m ${err.message}`);
      break;
    }

    const toolCall = parseToolCall(responseText);

    if (!toolCall) {
      console.log(`\n\x1b[32m=== Final Assistant Response ===\x1b[0m\n${responseText}\n`);
      break;
    }

    console.log(`\n\x1b[33m[Tool Call]\x1b[0m ${toolCall.tool}`);
    console.log(JSON.stringify(toolCall.args, null, 2));

    if (toolCall.tool === 'run_command') {
      const riskCheck = await queryPhoneSystem1('/risk', { command: toolCall.args.command });
      if (riskCheck && riskCheck.requires_confirmation) {
        console.log(
          `\x1b[31m[Phone System 1 Warning]\x1b[0m Command flagged high-risk: ${riskCheck.reason || 'Destructive potential'}`
        );
      }
    }

    let toolResult;
    if (toolCall.tool === 'run_command') {
      toolResult = await tools.run_command(toolCall.args);
    } else if (toolCall.tool === 'read_file') {
      toolResult = await tools.read_file(toolCall.args);
    } else if (toolCall.tool === 'write_file') {
      toolResult = await tools.write_file(toolCall.args);
    } else {
      toolResult = { error: `Unknown tool: ${toolCall.tool}` };
    }

    const pruned = await queryPhoneSystem1('/prune', { output: JSON.stringify(toolResult, null, 2) });
    const formattedOutput = pruned && pruned.output ? pruned.output : JSON.stringify(toolResult, null, 2);

    promptToSend = `[Tool Result: ${toolCall.tool}]\n\`\`\`json\n${formattedOutput}\n\`\`\`\nPlease inspect this result and proceed with your next tool call or your final response.`;
    turn++;

    // Safety pacing: 1500ms human reading pace pause before sending subsequent automated prompts
    if (isSafeMode) {
      console.log(`\x1b[90m[Safety Mode] Human reading pace pause (1500ms)...\x1b[0m`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  if (turn > maxTurns) {
    console.log('\x1b[31m[Agent Notice]\x1b[0m Reached maximum conversation turns.');
  }
}

function parseMultipartBuffer(buffer, boundary) {
  const boundaryBuffer = Buffer.from('--' + boundary);
  let start = 0;
  const files = [];

  while (start < buffer.length) {
    const idx = buffer.indexOf(boundaryBuffer, start);
    if (idx === -1) break;
    const nextIdx = buffer.indexOf(boundaryBuffer, idx + boundaryBuffer.length);
    if (nextIdx === -1) break;

    const part = buffer.slice(idx + boundaryBuffer.length, nextIdx);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headerStr = part.slice(0, headerEnd).toString('utf8');
      let data = part.slice(headerEnd + 4);
      if (data.length >= 2 && data[data.length - 2] === 13 && data[data.length - 1] === 10) {
        data = data.slice(0, data.length - 2);
      }

      const filenameMatch = headerStr.match(/filename="([^"]+)"/i);
      const mimeMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);

      if (filenameMatch) {
        const filename = filenameMatch[1];
        const mime = mimeMatch ? mimeMatch[1].trim() : getMimeType(filename);
        files.push({
          name: filename,
          type: mime,
          data: data.toString('base64'),
          size: data.length
        });
      }
    }
    start = nextIdx;
  }
  return files;
}

function formatOpenAIMessagesToPrompt(messages, toolsList, extraFiles = []) {
  let prompt = '';
  const files = [];

  // 1. Process extra files from root request payload (e.g. payload.files or payload.images)
  if (Array.isArray(extraFiles)) {
    for (let i = 0; i < extraFiles.length; i++) {
      const resolved = resolveFileItem(extraFiles[i], files.length + 1);
      if (resolved) files.push(resolved);
    }
  }

  if (Array.isArray(toolsList) && toolsList.length > 0) {
    prompt += `You have access to the following developer tools on the user's laptop:\n`;
    for (const t of toolsList) {
      if (t.function) {
        prompt += `- ${t.function.name}: ${t.function.description || ''}\n  Parameters: ${JSON.stringify(
          t.function.parameters || {}
        )}\n`;
      }
    }
    prompt += `\nTo invoke a tool, output a single JSON block wrapped inside a \`\`\`tool_call markdown fence:
\`\`\`tool_call
{ "tool": "tool_name", "args": { ... } }
\`\`\`
If no tool is needed, simply write your direct response.\n\n`;
  }

  if (Array.isArray(messages)) {
    prompt += messages
      .map((m) => {
        const roleLabel = m.role === 'system' ? 'System' : m.role === 'user' ? 'User' : 'Assistant';
        let textContent = '';
        if (typeof m.content === 'string') {
          textContent = m.content;
        } else if (Array.isArray(m.content)) {
          for (const part of m.content) {
            if (!part) continue;
            if (part.type === 'text' && part.text) {
              textContent += (textContent ? '\n' : '') + part.text;
            } else if (part.type === 'image_url' && part.image_url && part.image_url.url) {
              const res = resolveFileItem(part.image_url.url, files.length + 1);
              if (res) files.push(res);
            } else if (part.type === 'image' && part.source) {
              const res = resolveFileItem(
                {
                  name: `image_${files.length + 1}.png`,
                  type: part.source.media_type || 'image/png',
                  data: part.source.data
                },
                files.length + 1
              );
              if (res) files.push(res);
            } else if (part.type === 'document' && part.source) {
              const res = resolveFileItem(
                {
                  name: `document_${files.length + 1}.pdf`,
                  type: part.source.media_type || 'application/pdf',
                  data: part.source.data
                },
                files.length + 1
              );
              if (res) files.push(res);
            } else if (part.type === 'file' || part.type === 'input_file' || part.type === 'binary') {
              const res = resolveFileItem(part.file || part, files.length + 1);
              if (res) files.push(res);
            }
          }
        } else {
          textContent = JSON.stringify(m.content);
        }
        if (m.tool_call_id || m.role === 'tool') {
          return `[Tool Result (${m.name || 'output'})]:\n${textContent}`;
        }
        return `[${roleLabel}]:\n${textContent}`;
      })
      .join('\n\n');
  }

  return { promptText: prompt, files };
}

function start() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url, `http://localhost:${WS_PORT}`);
    const pathname = parsedUrl.pathname;

    if (req.method === 'GET' && pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const now = Math.floor(Date.now() / 1000);
      res.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: activeModel, object: 'model', created: now, owned_by: activePlatform.toLowerCase() },
            { id: 'gemini-4-hydrogen', object: 'model', created: now, owned_by: 'google' },
            { id: 'hydrogen', object: 'model', created: now, owned_by: 'google' },
            { id: 'hydrogen-low', object: 'model', created: now, owned_by: 'google' },
            { id: 'gemini-4-hydrogen-low', object: 'model', created: now, owned_by: 'google' },
            { id: 'hydrogen-medium', object: 'model', created: now, owned_by: 'google' },
            { id: 'gemini-4-hydrogen-medium', object: 'model', created: now, owned_by: 'google' },
            { id: 'hydrogen-high', object: 'model', created: now, owned_by: 'google' },
            { id: 'gemini-4-hydrogen-high', object: 'model', created: now, owned_by: 'google' },
            { id: 'gemini-hydrogen', object: 'model', created: now, owned_by: 'google' },
            { id: 'argon', object: 'model', created: now, owned_by: 'google' },
            { id: 'gemini-4-argon', object: 'model', created: now, owned_by: 'google' },
            { id: 'gpt-6.1-sol', object: 'model', created: now, owned_by: 'openai' },
            { id: 'gpt-6-astra', object: 'model', created: now, owned_by: 'openai' },
            { id: 'fable-5.5', object: 'model', created: now, owned_by: 'anthropic' },
            { id: 'fable-5.1', object: 'model', created: now, owned_by: 'anthropic' },
            { id: 'claude-opus-5-5', object: 'model', created: now, owned_by: 'anthropic' },
            { id: 'gemini-web', object: 'model', created: now, owned_by: 'google' }
          ]
        })
      );
      return;
    }

    if (req.method === 'GET' && (pathname === '/v1/files' || pathname === '/files')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const fileList = Array.from(stagedFiles.entries()).map(([id, f]) => ({
        id,
        object: 'file',
        bytes: f.size,
        created_at: Math.floor(Date.now() / 1000),
        filename: f.name,
        purpose: 'user_data',
        status: 'processed'
      }));
      res.end(JSON.stringify({ object: 'list', data: fileList }));
      return;
    }

    if (req.method === 'POST' && (pathname === '/upload' || pathname === '/v1/files')) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        try {
          const buffer = Buffer.concat(chunks);
          const contentType = req.headers['content-type'] || '';
          let filesToStage = [];

          if (contentType.includes('multipart/form-data')) {
            const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
            if (boundaryMatch) {
              const boundary = boundaryMatch[1].trim();
              filesToStage = parseMultipartBuffer(buffer, boundary);
            }
          } else if (contentType.includes('application/json')) {
            const json = JSON.parse(buffer.toString('utf8') || '{}');
            const fileItem = resolveFileItem(json);
            if (fileItem) filesToStage.push(fileItem);
          } else {
            const filename = req.headers['x-filename'] || `binary_${Date.now()}.bin`;
            const mime = contentType || getMimeType(filename);
            filesToStage.push({
              name: filename,
              type: mime,
              data: buffer.toString('base64'),
              size: buffer.length
            });
          }

          if (filesToStage.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'No valid binary or file payload found' } }));
            return;
          }

          const stagedResults = [];
          for (const f of filesToStage) {
            const fileId = `file-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
            stagedFiles.set(fileId, f);
            stagedResults.push({
              id: fileId,
              object: 'file',
              bytes: f.size,
              created_at: Math.floor(Date.now() / 1000),
              filename: f.name,
              purpose: 'user_data',
              status: 'processed'
            });
          }

          const promptParam = parsedUrl.searchParams.get('prompt');
          const autoSend = parsedUrl.searchParams.get('send') === 'true' || !!promptParam;

          if (autoSend) {
            const targetWs = browserSocket || activeSocket;
            if (!targetWs || targetWs.readyState !== 1) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: {
                    message: `Browser extension is not connected on ws://localhost:${WS_PORT}. Please open ${activePlatform} in Chrome.`
                  }
                })
              );
              return;
            }
            console.log(
              `\n\x1b[35m[HTTP Upload]\x1b[0m Forwarding ${filesToStage.length} attached file(s) to ${activePlatform} (${activeModel})...`
            );
            const promptToSend = promptParam || 'Please inspect and analyze this uploaded file.';
            const responseText = await sendPromptToChrome(promptToSend, filesToStage);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                files: stagedResults,
                response: responseText
              })
            );
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(stagedResults.length === 1 ? stagedResults[0] : { object: 'list', data: stagedResults }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: err.message } }));
        }
      });
      return;
    }

    if (req.method === 'POST' && (pathname === '/v1/chat/completions' || pathname === '/v1/vision/chat/completions' || pathname === '/chat/completions')) {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}');
          const stream = payload.stream === true;
          const requestedModel = payload.model || activeModel;
          const extraFiles = payload.files || payload.images || [];
          const { promptText, files } = formatOpenAIMessagesToPrompt(payload.messages || [], payload.tools, extraFiles);
          const targetWs = browserSocket || activeSocket;

          if (!targetWs || targetWs.readyState !== 1) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: {
                  message: `Browser extension is not connected on ws://localhost:${WS_PORT}. Please open ${activePlatform} in Chrome.`
                }
              })
            );
            return;
          }

          console.log(`\n\x1b[36m[OpenAI Proxy] Routing request for '${requestedModel}' to ${activePlatform} (Attachments: ${files.length})...\x1b[0m`);
          const responseText = await sendPromptToChrome(promptText, files);
          const toolCall = parseToolCall(responseText);

          if (stream) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive'
            });
            const chunkId = 'chatcmpl-' + Date.now();
            const chunk = {
              id: chunkId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: requestedModel,
              choices: [
                {
                  index: 0,
                  delta: toolCall
                    ? {
                        tool_calls: [
                          {
                            index: 0,
                            id: 'call_' + Math.random().toString(36).substring(2, 9),
                            type: 'function',
                            function: {
                              name: toolCall.tool,
                              arguments: JSON.stringify(toolCall.args)
                            }
                          }
                        ]
                      }
                    : { content: responseText },
                  finish_reason: toolCall ? 'tool_calls' : 'stop'
                }
              ]
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            let messageObj = { role: 'assistant', content: responseText };
            let finishReason = 'stop';

            if (toolCall) {
              const toolCallId = 'call_' + Math.random().toString(36).substring(2, 9);
              messageObj = {
                role: 'assistant',
                content: responseText.replace(/```(?:tool_call|json)?\s*[\s\S]*?```/g, '').trim(),
                tool_calls: [
                  {
                    id: toolCallId,
                    type: 'function',
                    function: {
                      name: toolCall.tool,
                      arguments: JSON.stringify(toolCall.args)
                    }
                  }
                ]
              };
              finishReason = 'tool_calls';
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                id: 'chatcmpl-' + Date.now(),
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: requestedModel,
                choices: [
                  {
                    index: 0,
                    message: messageObj,
                    finish_reason: finishReason
                  }
                ]
              })
            );
          }
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: err.message } }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found' } }));
  });

  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    // Send initial configuration
    ws.send(JSON.stringify({ type: 'CONFIG', safeMode: isSafeMode }));

    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);
        if (data.type === 'HELLO' || data.type === 'STATUS') {
          browserSocket = ws;
          activeSocket = ws;
          if (data.platform) activePlatform = data.platform;
          if (data.model) activeModel = data.model;
          if (data.log) console.log(`\x1b[34m[Extension Log]\x1b[0m ${data.log}`);
          console.log(`\n\x1b[32m[Bridge Connected]\x1b[0m Platform: ${activePlatform} | Model: ${activeModel}`);
        } else if (data.type === 'RESPONSE' && pendingResponseResolver) {
          const resolve = pendingResponseResolver;
          pendingResponseResolver = null;
          pendingResponseRejecter = null;
          resolve(data.text);
        } else if (data.type === 'ERROR') {
          console.error(`\x1b[31m[Extension Error]\x1b[0m ${data.message}`);
          if (pendingResponseRejecter) {
            const reject = pendingResponseRejecter;
            pendingResponseResolver = null;
            pendingResponseRejecter = null;
            reject(new Error(data.message));
          }
        } else if ((data.type === 'PROMPT' || data.messages) && ws !== browserSocket) {
          // Client calling via WebSocket directly (e.g. ws://localhost:8765)
          let clientPrompt = data.text || '';
          let clientFiles = (data.files || data.images || []).map((f, i) => resolveFileItem(f, i + 1)).filter(Boolean);
          if (!clientPrompt && data.messages) {
            const parsed = formatOpenAIMessagesToPrompt(data.messages, data.tools, clientFiles);
            clientPrompt = parsed.promptText;
            clientFiles = parsed.files;
          }
          console.log(`\n\x1b[36m[Client WS] Routing request to ${activePlatform} (Attachments: ${clientFiles.length})...\x1b[0m`);
          try {
            const resText = await sendPromptToChrome(clientPrompt, clientFiles);
            ws.send(JSON.stringify({ type: 'RESPONSE', text: resText }));
          } catch (wsErr) {
            ws.send(JSON.stringify({ type: 'ERROR', message: wsErr.message }));
          }
        }
      } catch (err) {
        console.error('[CLI] Failed to parse message:', err);
      }
    });

    ws.on('close', () => {
      if (ws === browserSocket || ws === activeSocket) {
        console.log('\n\x1b[31m[Bridge Disconnected]\x1b[0m Browser extension detached.');
        browserSocket = null;
        activeSocket = null;
      }
    });
  });

  server.listen(WS_PORT, () => {
    console.log(`\x1b[35m=== Gemini Bridge Orchestrator & Universal Proxy ===\x1b[0m`);
    console.log(`HTTP/OpenAI API: http://localhost:${WS_PORT}/v1`);
    console.log(`File Upload:     POST http://localhost:${WS_PORT}/upload, /v1/files`);
    console.log(`WebSocket Bridge: ws://localhost:${WS_PORT}`);
    console.log(`Safety Mode:     ${isSafeMode ? '\x1b[32mEnabled (1500ms pacing + humanized jitter)\x1b[0m' : '\x1b[33mDisabled (--fast active)\x1b[0m'}`);
    console.log(`Waiting for browser connection (Gemini / ChatGPT / Claude)...`);
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\ngemini-bridge> '
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input === 'exit' || input === 'quit') {
      console.log('Exiting Gemini Bridge...');
      process.exit(0);
    }

    if (!activeSocket) {
      console.log('\x1b[33mNotice: Browser extension is not connected yet.\x1b[0m');
      console.log('1. Open Chrome at https://gemini.google.com, https://chatgpt.com, or https://claude.ai');
      console.log('2. Ensure the unpacked Gemini Bridge extension is loaded and active.');
      rl.prompt();
      return;
    }

    if (
      input.startsWith('/upload ') ||
      input.startsWith('/attach ') ||
      input.startsWith('upload ') ||
      input.startsWith('attach ')
    ) {
      const rest = input.replace(/^\/(?:upload|attach)\s+|^upload\s+|^attach\s+/, '').trim();
      let targetPath = '';
      let promptText = '';

      if (rest.startsWith('"')) {
        const nextQuote = rest.indexOf('"', 1);
        if (nextQuote !== -1) {
          targetPath = rest.slice(1, nextQuote);
          promptText = rest.slice(nextQuote + 1).trim();
        }
      } else if (rest.startsWith("'")) {
        const nextQuote = rest.indexOf("'", 1);
        if (nextQuote !== -1) {
          targetPath = rest.slice(1, nextQuote);
          promptText = rest.slice(nextQuote + 1).trim();
        }
      }

      if (!targetPath) {
        const spaceIdx = rest.indexOf(' ');
        if (spaceIdx !== -1) {
          targetPath = rest.slice(0, spaceIdx).trim();
          promptText = rest.slice(spaceIdx + 1).trim();
        } else {
          targetPath = rest;
          promptText = 'Please inspect this uploaded file and explain its contents.';
        }
      }

      const fileObj = resolveFileItem(targetPath);
      if (!fileObj) {
        console.log(`\x1b[31m[File Error]\x1b[0m Could not locate or read file: ${targetPath}`);
        rl.prompt();
        return;
      }

      console.log(`\x1b[35m[File Upload]\x1b[0m Staging ${fileObj.name} (${fileObj.type}, ${fileObj.size} bytes)...`);
      try {
        console.log(`\x1b[36m[Turn 1] Uploading to ${activePlatform} (${activeModel}) and submitting prompt...\x1b[0m`);
        const resText = await sendPromptToChrome(promptText, [fileObj]);
        console.log(`\n\x1b[32m=== Assistant Response ===\x1b[0m\n${resText}\n`);
      } catch (err) {
        console.error(`\x1b[31m[Bridge Error]\x1b[0m ${err.message}`);
      }
      rl.prompt();
      return;
    }

    await runAgentLoop(input);
    rl.prompt();
  });
}

start();
