import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// --- Gemini API Keys from environment (supports multiple comma-separated keys) ---
const GEMINI_API_KEYS = [
  ...(process.env.GEMINI_API_KEY ? [process.env.GEMINI_API_KEY.trim()] : []),
  ...(process.env.GEMINI_API_KEYS ? process.env.GEMINI_API_KEYS.split(',').map(k => k.trim()).filter(Boolean) : []),
].filter((v, i, a) => a.indexOf(v) === i); // deduplicate

let activeKeyIndex = 0;
const HAS_SERVER_KEY = GEMINI_API_KEYS.length > 0;

function getActiveKey() {
  return GEMINI_API_KEYS[activeKeyIndex] || GEMINI_API_KEYS[0] || '';
}

function rotateKey() {
  if (GEMINI_API_KEYS.length <= 1) return false;
  activeKeyIndex = (activeKeyIndex + 1) % GEMINI_API_KEYS.length;
  console.log(`Rotated to key #${activeKeyIndex + 1}/${GEMINI_API_KEYS.length}`);
  return true;
}

const SYSTEM_PROMPT = `You are Nexus, a friendly and brilliant AI assistant. You are helpful, creative, and concise. You use markdown formatting when it improves readability. You excel at coding, writing, analysis, math, and general knowledge. Keep your answers clear and well-structured.`;

// --- Dynamic model discovery with caching ---
let cachedModels = null;
let cachedModelsTime = 0;
const MODEL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const MODEL_PRIORITY = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-2.5-flash-preview-04-17',
  'gemini-2.5-pro-preview-05-06',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
];

async function getAvailableModels() {
  // Return cache if fresh
  if (cachedModels && Date.now() - cachedModelsTime < MODEL_CACHE_TTL) {
    return cachedModels;
  }

  try {
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${getActiveKey()}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.models) return null;

    const chatModels = data.models
      .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => m.name.replace('models/', ''));

    cachedModels = chatModels;
    cachedModelsTime = Date.now();
    console.log(`Discovered ${chatModels.length} models: ${chatModels.slice(0, 5).join(', ')}...`);
    return chatModels;
  } catch (e) {
    console.warn('Could not fetch model list:', e.message);
    return null;
  }
}

// --- Security ---
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      mediaSrc: ["'self'", "blob:", "data:"],
      connectSrc: ["'self'", "https://generativelanguage.googleapis.com", "https://api.openai.com"],
    },
  },
  permissionsPolicy: {
    features: {
      camera: ["'self'"],
      microphone: ["'self'"],
    },
  },
}));
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Rate limiter
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});

// --- Static Files ---
app.use(express.static(join(__dirname, '.')));

// --- API Status: tells frontend if server has a key ---
app.get('/api/status', (req, res) => {
  res.json({
    hasServerKey: HAS_SERVER_KEY,
    provider: HAS_SERVER_KEY ? 'gemini' : null,
    keyCount: GEMINI_API_KEYS.length,
    // Debug: show first 8 chars of each key (safe to expose prefix)
    keyPreviews: GEMINI_API_KEYS.map(k => k.slice(0, 8) + '...'),
    envVars: {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY ? 'set' : 'not set',
      GEMINI_API_KEYS: process.env.GEMINI_API_KEYS ? 'set' : 'not set',
    },
  });
});

// --- Chat API: proxies to Gemini ---
app.post('/api/chat', apiLimiter, async (req, res) => {
  try {
    const { messages, model } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Messages array is required.' });
    }

    // If no server key, return demo response
    if (!HAS_SERVER_KEY) {
      const lastMsg = messages[messages.length - 1]?.content || '';
      await new Promise(r => setTimeout(r, 300 + Math.random() * 500));
      return res.json({
        reply: getSimulatedResponse(lastMsg),
        model: 'nexus-demo-v1',
      });
    }

    // Build Gemini-format messages
    const geminiModel = model || 'gemini-2.0-flash';
    const geminiMessages = messages.slice(-20).map(m => {
      const parts = [];
      if (m.content) parts.push({ text: m.content });

      // Handle image attachments (base64 inline_data)
      if (m.attachments && Array.isArray(m.attachments)) {
        m.attachments.forEach(att => {
          if (att.type === 'image' && att.dataUrl) {
            const base64 = att.dataUrl.split(',')[1];
            parts.push({
              inline_data: {
                mime_type: att.mimeType || 'image/jpeg',
                data: base64,
              },
            });
          } else if (att.type === 'file' && att.dataUrl) {
            try {
              const decoded = Buffer.from(att.dataUrl.split(',')[1], 'base64').toString('utf-8');
              parts.push({ text: `[File: ${att.name}]\n${decoded}` });
            } catch {
              parts.push({ text: `[Attached file: ${att.name}]` });
            }
          }
        });
      }

      if (parts.length === 0) parts.push({ text: '(empty)' });
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts,
      };
    });

    // Discover available models dynamically
    const availableModels = await getAvailableModels();
    let modelsToTry;

    if (availableModels && availableModels.length > 0) {
      // Build smart order: requested model first, then by priority, then rest
      const selected = availableModels.includes(geminiModel) ? [geminiModel] : [];
      const prioritized = MODEL_PRIORITY.filter(m => availableModels.includes(m) && m !== geminiModel);
      const rest = availableModels.filter(m => m !== geminiModel && !MODEL_PRIORITY.includes(m));
      modelsToTry = [...selected, ...prioritized, ...rest];
    } else {
      // Couldn't fetch model list — try only the requested model and safe defaults
      modelsToTry = [geminiModel, 'gemini-2.0-flash'].filter((v, i, a) => a.indexOf(v) === i);
    }

    console.log(`Trying models: ${modelsToTry.slice(0, 5).join(', ')}${modelsToTry.length > 5 ? '...' : ''} with ${GEMINI_API_KEYS.length} key(s)`);
    let lastError = '';
    let keysTriedCount = 0;
    const startKeyIdx = activeKeyIndex;

    // Outer loop: rotate through keys
    do {
      const apiKey = getActiveKey();
      keysTriedCount++;

      // Inner loop: try models with current key
      for (const tryModel of modelsToTry) {
        try {
          const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${tryModel}:generateContent?key=${apiKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
                contents: geminiMessages,
                generationConfig: { maxOutputTokens: 8192, temperature: 0.7 },
              }),
            }
          );

          if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            const errMsg = err.error?.message || `HTTP ${response.status}`;
            const isQuota = response.status === 429 || errMsg.includes('quota') || errMsg.includes('rate');
            console.log(`Key #${activeKeyIndex + 1} Model ${tryModel}: ${isQuota ? 'quota' : 'error'} — ${errMsg}`);
            lastError = errMsg;

            if (isQuota) {
              // Quota hit on this key — rotate to next key and break model loop
              if (rotateKey()) {
                console.log(`Quota hit, rotating to key #${activeKeyIndex + 1}`);
                break;
              }
            }
            continue;
          }

          const data = await response.json();
          const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Sorry, I could not generate a response.';

          return res.json({ reply, model: tryModel });

        } catch (fetchErr) {
          lastError = fetchErr.message || 'Network error';
          continue;
        }
      }
    } while (activeKeyIndex !== startKeyIdx && keysTriedCount < GEMINI_API_KEYS.length);

    // All keys and models failed
    console.error(`All ${GEMINI_API_KEYS.length} key(s) and models failed:`, lastError);
    res.status(502).json({ error: `AI service error: ${lastError}` });

  } catch (error) {
    console.error('API Error:', error.message);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// --- Health Check ---
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'nexus-ai',
    mode: HAS_SERVER_KEY ? 'live' : 'demo',
    uptime: process.uptime(),
  });
});

// --- SPA Fallback ---
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

// --- Simulated Responses (used when no API key is configured) ---
function getSimulatedResponse(userMessage) {
  const msg = userMessage.toLowerCase();

  if (msg.includes('hello') || msg.includes('hi')) {
    return `Hey! 👋 I'm **Nexus AI**, your intelligent assistant.\n\nThis is a **simulated response** from the server API. In production, wire this endpoint to your preferred LLM provider.\n\nWhat can I help you with?`;
  }
  if (msg.includes('code') || msg.includes('function')) {
    return `Here's a demo code response:\n\n\`\`\`javascript\nconst fibonacci = (n) => {\n  if (n <= 1) return n;\n  return fibonacci(n - 1) + fibonacci(n - 2);\n};\n\nconsole.log(fibonacci(10)); // 55\n\`\`\`\n\n*Server API demo — replace with real LLM integration*`;
  }

  return `Thanks for your message! 💬\n\nThis response comes from the **/api/chat** endpoint. In a production deployment, replace the simulated logic with a real AI provider (e.g., Google Gemini, OpenAI, Anthropic).\n\n**Next steps:**\n1. Add your LLM API key to the environment\n2. Update the route handler in \`server.js\`\n3. Deploy to Cloud Run or Vercel\n\n---\n*Nexus AI — Demo Mode*`;
}

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`\n  ✦ Nexus AI running at http://localhost:${PORT}`);
  console.log(`  📦 Mode: ${HAS_SERVER_KEY ? `Live (${GEMINI_API_KEYS.length} API key${GEMINI_API_KEYS.length > 1 ? 's' : ''} loaded)` : 'Demo (no API key)'}`);
  console.log(`  🚀 Ready for deployment\n`);
});
