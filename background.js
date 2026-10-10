const PROVIDERS = {
  openai: {
    name: "OpenAI",
    defaultModel: "gpt-4.1-mini",
    url: "https://api.openai.com/v1/responses"
  },
  anthropic: {
    name: "Anthropic",
    defaultModel: "claude-sonnet-5",
    url: "https://api.anthropic.com/v1/messages"
  },
  openrouter: {
    name: "OpenRouter",
    defaultModel: "openai/gpt-4.1-mini",
    url: "https://openrouter.ai/api/v1/chat/completions"
  }
};

const VALID_SENTIMENTS = new Set(["positive", "negative", "neutral"]);
const MAX_COMMENTS = 50;
const MAX_TITLE_CHARS = 500;
const MAX_BODY_CHARS = 8000;
const MAX_COMMENT_CHARS = 2000;
const MAX_TOTAL_COMMENT_CHARS = 30000;
const REQUEST_TIMEOUT_MS = 45000;
const CACHE_STORAGE_KEY = "analysisCacheV1";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 30;

// API keys should only be readable by trusted extension pages and the service
// worker, never by the Reddit content script.
lockLocalStorage();
chrome.runtime.onInstalled.addListener(lockLocalStorage);
chrome.runtime.onStartup.addListener(lockLocalStorage);

function lockLocalStorage() {
  chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_EXTENSION_STATE") {
    chrome.storage.local.get("dataConsentAccepted")
      .then(({ dataConsentAccepted }) => sendResponse({ dataConsentAccepted: dataConsentAccepted === true }))
      .catch(() => sendResponse({ dataConsentAccepted: false }));
    return true;
  }

  if (message?.type !== "ANALYZE_REDDIT_POST") return false;

  analyzeWithLLM(message.payload, { forceRefresh: message.forceRefresh === true })
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: friendlyError(error) }));

  return true;
});

/**
 * Provider boundary. Each adapter returns the same JSON shape, so future
 * providers do not require changes to Reddit extraction or the panel UI.
 */
async function analyzeWithLLM({ url, title, body, comments }, { forceRefresh = false } = {}) {
  const config = await getProviderConfig();
  const normalizedTitle = truncate(String(title || ""), MAX_TITLE_CHARS);
  const normalizedBody = truncate(String(body || ""), MAX_BODY_CHARS);
  const normalizedComments = limitComments(comments);
  const cacheKey = await createCacheKey({
    provider: config.provider,
    model: config.model,
    url: String(url || ""),
    title: normalizedTitle,
    body: normalizedBody,
    comments: normalizedComments
  });

  if (!forceRefresh) {
    const cachedAnalysis = await getCachedAnalysis(cacheKey, normalizedComments.length);
    if (cachedAnalysis) return { analysis: cachedAnalysis, cached: true };
  }

  const request = {
    instructions: buildInstructions(normalizedComments.length),
    input: JSON.stringify({
      post_title: normalizedTitle,
      post_body: normalizedBody,
      comments: normalizedComments.map((text, index) => ({ index, text }))
    }),
    schema: buildResponseSchema(normalizedComments.length)
  };

  let outputText;
  if (config.provider === "openai") {
    outputText = await analyzeWithOpenAI(config, request);
  } else if (config.provider === "anthropic") {
    outputText = await analyzeWithAnthropic(config, request);
  } else {
    outputText = await analyzeWithOpenRouter(config, request);
  }

  const parsed = parseJSONOutput(outputText, config);
  try {
    validateAnalysis(parsed, normalizedComments.length);
  } catch (error) {
    throw new Error(`${PROVIDERS[config.provider].name} (${config.model}): ${error.message}`);
  }
  await saveCachedAnalysis(cacheKey, parsed);
  return { analysis: parsed, cached: false };
}

async function getProviderConfig() {
  const stored = await chrome.storage.local.get([
    "provider",
    "providerSettings",
    "openRouterApiKey",
    "model",
    "dataConsentAccepted"
  ]);

  if (stored.dataConsentAccepted !== true) throw new Error("MISSING_CONSENT");

  const provider = Object.hasOwn(PROVIDERS, stored.provider)
    ? stored.provider
    : "openrouter";
  const saved = stored.providerSettings?.[provider] || {};
  // Read the OpenRouter-only fields used by versions 0.2–0.3.
  const apiKey = saved.apiKey || (provider === "openrouter" ? stored.openRouterApiKey : "");
  const model = saved.model ||
    (provider === "openrouter" ? stored.model : "") ||
    PROVIDERS[provider].defaultModel;

  if (!apiKey) throw new Error(`MISSING_API_KEY:${provider}`);
  return { provider, apiKey, model };
}

async function analyzeWithOpenAI(config, request) {
  const data = await postJSON(PROVIDERS.openai.url, {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`
  }, {
    model: config.model,
    store: false,
    instructions: request.instructions,
    input: request.input,
    text: {
      format: {
        type: "json_schema",
        name: "reddit_post_analysis",
        strict: true,
        schema: request.schema
      }
    }
  }, providerContext("openai", config.model));

  if (typeof data.output_text === "string") return data.output_text;
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
    }
  }
  return "";
}

async function analyzeWithAnthropic(config, request) {
  const data = await postJSON(PROVIDERS.anthropic.url, {
    "Content-Type": "application/json",
    "x-api-key": config.apiKey,
    "anthropic-version": "2023-06-01",
    // Signals that direct use from this browser extension is intentional.
    "anthropic-dangerous-direct-browser-access": "true"
  }, {
    model: config.model,
    max_tokens: 2048,
    system: request.instructions,
    messages: [{ role: "user", content: request.input }],
    output_config: {
      format: {
        type: "json_schema",
        schema: request.schema
      }
    }
  }, providerContext("anthropic", config.model));

  return (data.content || [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

async function analyzeWithOpenRouter(config, request) {
  const data = await postJSON(PROVIDERS.openrouter.url, {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
    "X-OpenRouter-Title": "Reddit Advice Analyzer",
    // Adds routing details to many failed responses, making errors actionable.
    "X-OpenRouter-Metadata": "enabled"
  }, {
    model: config.model,
    messages: [
      { role: "system", content: request.instructions },
      { role: "user", content: request.input }
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "reddit_post_analysis",
        strict: true,
        schema: request.schema
      }
    },
    provider: { require_parameters: true }
  }, providerContext("openrouter", config.model));

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("");
  }
  return "";
}

function providerContext(provider, model) {
  return { provider, providerName: PROVIDERS[provider].name, model };
}

async function postJSON(url, headers, body, context) {
  let response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${context.providerName} (${context.model}) did not respond within 45 seconds. Try again.`);
    }
    const extra = context.provider === "anthropic"
      ? " Anthropic may also be blocking direct browser requests for this organization."
      : "";
    throw new Error(`${context.providerName} (${context.model}) could not be reached. Check your connection and provider status.${extra}`);
  } finally {
    clearTimeout(timeout);
  }

  const responseText = await response.text();
  let data = {};
  try {
    data = responseText ? JSON.parse(responseText) : {};
  } catch {
    data = {};
  }

  if (!response.ok) {
    throw new Error(buildDetailedAPIError(data, response.status, response.headers, context));
  }
  return data;
}

function buildDetailedAPIError(data, status, headers, context) {
  const outerMessage = cleanMessage(data?.error?.message || data?.message);
  const upstream = parseMaybeJSON(data?.error?.metadata?.raw);
  const upstreamMessage = cleanMessage(
    upstream?.error?.message ||
    upstream?.message ||
    data?.error?.metadata?.provider_error?.message
  );
  const providerName = cleanMessage(
    data?.error?.metadata?.provider_name ||
    data?.openrouter_metadata?.attempts?.at(-1)?.provider
  );
  const requestId = cleanMessage(
    data?.request_id ||
    headers.get("request-id") ||
    headers.get("x-request-id") ||
    headers.get("x-generation-id")
  );

  const genericOuter = /^provider returned (an )?error$/i.test(outerMessage);
  const detail = upstreamMessage || (!genericOuter && outerMessage) || statusHint(status, context.provider);
  const route = providerName && providerName !== context.providerName
    ? ` via ${providerName}`
    : "";
  const id = requestId ? ` Request ID: ${requestId}.` : "";

  return `${context.providerName}${route} · ${context.model} · HTTP ${status}: ${detail}${id}`;
}

function parseMaybeJSON(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return {};
  try {
    return JSON.parse(value);
  } catch {
    return { message: value };
  }
}

function cleanMessage(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function truncate(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…` : value;
}

function limitComments(comments) {
  if (!Array.isArray(comments)) return [];
  const limited = [];
  let remainingChars = MAX_TOTAL_COMMENT_CHARS;

  for (const value of comments.slice(0, MAX_COMMENTS)) {
    if (remainingChars <= 0) break;
    const text = truncate(String(value || ""), Math.min(MAX_COMMENT_CHARS, remainingChars));
    if (!text) continue;
    limited.push(text);
    remainingChars -= text.length;
  }
  return limited;
}

async function createCacheKey(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function getCachedAnalysis(cacheKey, expectedCommentCount) {
  const stored = await chrome.storage.session.get(CACHE_STORAGE_KEY);
  const entry = stored[CACHE_STORAGE_KEY]?.[cacheKey];
  if (!entry || Date.now() - entry.createdAt > CACHE_TTL_MS) return null;
  try {
    validateAnalysis(entry.analysis, expectedCommentCount);
    return entry.analysis;
  } catch {
    return null;
  }
}

async function saveCachedAnalysis(cacheKey, analysis) {
  const stored = await chrome.storage.session.get(CACHE_STORAGE_KEY);
  const cache = stored[CACHE_STORAGE_KEY] || {};
  cache[cacheKey] = { createdAt: Date.now(), analysis };

  const trimmed = Object.fromEntries(
    Object.entries(cache)
      .filter(([, entry]) => Date.now() - entry.createdAt <= CACHE_TTL_MS)
      .sort(([, a], [, b]) => b.createdAt - a.createdAt)
      .slice(0, MAX_CACHE_ENTRIES)
  );
  await chrome.storage.session.set({ [CACHE_STORAGE_KEY]: trimmed });
}

function statusHint(status, provider) {
  const hints = {
    400: "The request was rejected. Check that the model ID is correct and supports structured JSON output.",
    401: "The API key is invalid, expired, revoked, or belongs to a different provider.",
    402: "The account has insufficient credits or a billing problem.",
    403: provider === "anthropic"
      ? "The key lacks permission, or this Anthropic organization blocks direct browser requests."
      : "The key or account does not have permission to use this model.",
    404: "The model or API resource was not found. Check the model ID in extension settings.",
    408: "The provider timed out before completing the analysis. Try again.",
    413: "The Reddit post and comments are too large for this provider request.",
    422: "The provider could not process the request. Check the selected model.",
    429: "The account hit a rate limit or spending limit. Wait and check the provider dashboard.",
    500: "The provider had an internal error. Try again shortly.",
    502: "The upstream model provider failed. Try again or select another model.",
    503: "The provider is temporarily unavailable. Try again shortly.",
    504: "The upstream model timed out. Try again shortly.",
    529: "The model provider is overloaded. Try again shortly."
  };
  return hints[status] || "The provider rejected the request. Check the API key, model, and provider dashboard.";
}

function parseJSONOutput(outputText, config) {
  const label = `${PROVIDERS[config.provider].name} (${config.model})`;
  if (!outputText) throw new Error(`${label} returned no JSON output. The selected model may not support structured output.`);
  try {
    return JSON.parse(outputText);
  } catch {
    throw new Error(`${label} returned invalid JSON. Try a model that supports structured output.`);
  }
}

function buildInstructions(commentCount) {
  return [
    "You analyze a Reddit post in two independent ways.",
    "First, set personal_advice to true only when the author is asking for consequential personal guidance about their own life, relationships, career, finances, health, relocation, education, or similarly meaningful decisions.",
    "Ordinary product, restaurant, programming, factual, or how-to questions are not consequential personal advice.",
    "Second, classify every supplied comment by its stance and tone toward the post: positive means supportive/encouraging/approving; negative means opposed/critical/discouraging; neutral means mixed, informational, unclear, or neither.",
    "The comment classification must not depend on personal_advice. Always classify the comments.",
    `Return exactly ${commentCount} comment result(s), in the same order as the input.`,
    "Return only data matching the supplied JSON schema."
  ].join(" ");
}

function buildResponseSchema(commentCount) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["personal_advice", "comments"],
    properties: {
      personal_advice: { type: "boolean" },
      comments: {
        type: "array",
        minItems: commentCount,
        maxItems: commentCount,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["sentiment"],
          properties: {
            sentiment: { type: "string", enum: ["positive", "negative", "neutral"] }
          }
        }
      }
    }
  };
}

function validateAnalysis(analysis, expectedCommentCount) {
  if (typeof analysis?.personal_advice !== "boolean") {
    throw new Error("The model response is missing personal_advice.");
  }
  if (!Array.isArray(analysis.comments) || analysis.comments.length !== expectedCommentCount) {
    throw new Error("The model returned the wrong number of comment classifications.");
  }
  if (analysis.comments.some((item) => !VALID_SENTIMENTS.has(item?.sentiment))) {
    throw new Error("The model returned an unknown sentiment label.");
  }
}

function friendlyError(error) {
  if (error?.message === "MISSING_CONSENT") {
    return "Enable analysis in the extension popup before sending Reddit content to an AI provider.";
  }
  if (error?.message?.startsWith("MISSING_API_KEY:")) {
    const provider = error.message.split(":")[1];
    return `Add a ${PROVIDERS[provider].name} API key in the extension popup, then refresh the analysis.`;
  }
  return error?.message || "Analysis failed. Please try again.";
}
