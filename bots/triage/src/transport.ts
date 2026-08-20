import type { SelectedBotProvider } from './classify.js';

/**
 * The bot's ONLY network egress besides the GitHub API.
 *
 * One request, one short JSON answer, a hard timeout, no retries. There is deliberately no
 * streaming, no tool use, no conversation state, and no second call: the bot is stateless
 * between issues by construction, so there is nothing for a compromised model response to
 * accumulate in. See ops/BOT-SCOPE.md for the blast radius this bounds.
 */

const TIMEOUT_MS = 20_000;
const MAX_OUTPUT_TOKENS = 200;

export async function callBotProvider(cfg: SelectedBotProvider, userBlock: string): Promise<string> {
  const { SYSTEM_PROMPT } = await import('./prompt.js');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    if (cfg.provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: ac.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: cfg.model, max_tokens: MAX_OUTPUT_TOKENS, system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userBlock }],
        }),
      });
      if (!res.ok) throw new Error(`anthropic HTTP ${res.status}`);
      const j = await res.json() as { content?: { type: string; text?: string }[] };
      return (j.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    }
    if (cfg.provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', signal: ac.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model, max_completion_tokens: MAX_OUTPUT_TOKENS,
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userBlock }],
        }),
      });
      if (!res.ok) throw new Error(`openai HTTP ${res.status}`);
      const j = await res.json() as { choices?: { message?: { content?: string } }[] };
      return j.choices?.[0]?.message?.content ?? '';
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`;
    const res = await fetch(url, {
      method: 'POST', signal: ac.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userBlock }] }],
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, responseMimeType: 'application/json' },
      }),
    });
    if (!res.ok) throw new Error(`gemini HTTP ${res.status}`);
    const j = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  } finally {
    clearTimeout(timer);
  }
}
