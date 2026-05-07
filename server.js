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
app.use(express.json({ limit: '1mb' }));

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

// --- Placeholder Chat API ---
app.post('/api/chat', apiLimiter, async (req, res) => {
  try {
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Messages array is required.' });
    }

    const lastMsg = messages[messages.length - 1]?.content || '';

    // Simulated response with realistic delay
    await new Promise(r => setTimeout(r, 300 + Math.random() * 500));

    res.json({
      reply: getSimulatedResponse(lastMsg),
      model: 'nexus-demo-v1',
    });
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
    mode: 'demo',
    uptime: process.uptime(),
  });
});

// --- SPA Fallback ---
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

// --- Simulated Responses ---
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
  console.log(`  📦 Mode: Demo (placeholder API)`);
  console.log(`  🚀 Ready for deployment\n`);
});
