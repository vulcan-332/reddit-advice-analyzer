const PROVIDERS = {
  openai: {
    name: "OpenAI",
    defaultModel: "gpt-4.1-mini",
    placeholder: "sk-…",
    hint: "Uses OpenAI's Responses API."
  },
  anthropic: {
    name: "Anthropic",
    defaultModel: "claude-sonnet-5",
    placeholder: "sk-ant-…",
    hint: "Uses Anthropic's Messages API."
  },
  openrouter: {
    name: "OpenRouter",
    defaultModel: "openai/gpt-4.1-mini",
    placeholder: "sk-or-v1-…",
    hint: "Use an OpenRouter model slug, including its provider prefix."
  }
};

const form = document.getElementById("settings-form");
const providerSelect = document.getElementById("provider");
const apiKeyLabel = document.getElementById("api-key-label");
const apiKeyInput = document.getElementById("api-key");
const modelInput = document.getElementById("model");
const providerHint = document.getElementById("provider-hint");
const consentInput = document.getElementById("data-consent");
const consentProvider = document.getElementById("consent-provider");
const status = document.getElementById("status");
const toggleKeyButton = document.getElementById("toggle-key");

let providerSettings = {};
let activeProvider = "openrouter";

loadSettings();

async function loadSettings() {
  const stored = await chrome.storage.local.get([
    "provider",
    "providerSettings",
    "openRouterApiKey",
    "model",
    "dataConsentAccepted"
  ]);

  providerSettings = stored.providerSettings || {};
  // Migrate the OpenRouter-only settings used by versions 0.2–0.3.
  if (!providerSettings.openrouter && (stored.openRouterApiKey || stored.model)) {
    providerSettings.openrouter = {
      apiKey: stored.openRouterApiKey || "",
      model: stored.model || PROVIDERS.openrouter.defaultModel
    };
  }

  activeProvider = Object.hasOwn(PROVIDERS, stored.provider)
    ? stored.provider
    : "openrouter";
  providerSelect.value = activeProvider;
  consentInput.checked = stored.dataConsentAccepted === true;
  renderProvider();
}

providerSelect.addEventListener("change", () => {
  rememberCurrentFields();
  activeProvider = providerSelect.value;
  renderProvider();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  rememberCurrentFields();

  // LOCAL/BYOK PROTOTYPE ONLY: chrome.storage.local is convenient, not a
  // secure vault. A production shared-key service should use a backend proxy.
  await chrome.storage.local.set({
    provider: activeProvider,
    providerSettings,
    dataConsentAccepted: consentInput.checked,
    consentVersion: consentInput.checked ? 1 : 0
  });
  showStatus(consentInput.checked
    ? `${PROVIDERS[activeProvider].name} saved. Refresh Reddit.`
    : "Settings saved. Analysis is disabled.");
});

document.getElementById("clear").addEventListener("click", async () => {
  providerSettings[activeProvider] = {
    ...providerSettings[activeProvider],
    apiKey: ""
  };
  apiKeyInput.value = "";
  await chrome.storage.local.set({ providerSettings });
  showStatus(`${PROVIDERS[activeProvider].name} key cleared.`);
});

toggleKeyButton.addEventListener("click", () => {
  const shouldShow = apiKeyInput.type === "password";
  apiKeyInput.type = shouldShow ? "text" : "password";
  toggleKeyButton.textContent = shouldShow ? "Hide" : "Show";
  toggleKeyButton.setAttribute("aria-label", `${shouldShow ? "Hide" : "Show"} API key`);
});

function rememberCurrentFields() {
  providerSettings[activeProvider] = {
    apiKey: apiKeyInput.value.trim(),
    model: modelInput.value.trim() || PROVIDERS[activeProvider].defaultModel
  };
}

function renderProvider() {
  const metadata = PROVIDERS[activeProvider];
  const saved = providerSettings[activeProvider] || {};
  apiKeyLabel.textContent = `${metadata.name} API key`;
  apiKeyInput.value = saved.apiKey || "";
  apiKeyInput.placeholder = metadata.placeholder;
  modelInput.value = saved.model || metadata.defaultModel;
  providerHint.textContent = metadata.hint;
  consentProvider.textContent = metadata.name;
}

function showStatus(message) {
  status.textContent = message;
  clearTimeout(showStatus.timer);
  showStatus.timer = setTimeout(() => { status.textContent = ""; }, 3000);
}
