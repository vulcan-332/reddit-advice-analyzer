# Reddit Advice Analyzer

A minimal Chrome Manifest V3 extension that analyzes Reddit post pages with an LLM. It answers two independent questions:

1. Is the author asking for consequential personal advice?
2. How are the visible comments distributed across positive/supportive, negative/opposed, and neutral/mixed sentiment?

The extension always performs comment sentiment analysis, even when the post is not personal advice. Percentages and the dominant sentiment are calculated locally, not by the LLM.

## Project structure

- `manifest.json` — Manifest V3 configuration, permissions, and entry points.
- `content.js` — Extracts the title, body, and first 50 visible comments; calculates percentages and the dominant sentiment; renders the floating card.
- `background.js` — Dispatches through OpenAI, Anthropic, or OpenRouter adapters and validates their common structured JSON result.
- `styles.css` — Styles the Reddit floating card.
- `popup.html`, `popup.css`, `popup.js` — Local API key and model settings.
- `privacy-policy.html`, `privacy-policy.css` — The privacy policy packaged with the extension and ready to host publicly.
- `docs/` — GitHub Pages copy of the privacy policy; publish this folder from the `main` branch.
- `icons/` — Extension and Chrome Web Store icon assets.

The content script and personal-advice classification do not gate comment analysis. Both are requested together, and the prompt explicitly tells the model to treat them independently.

## Add an API key

1. Create an API key with OpenAI, Anthropic, or OpenRouter.
2. Click the extension icon in Chrome.
3. Choose the matching provider from the **Provider** dropdown.
4. Paste that provider's API key. A key only works with the provider that issued it.
5. Keep the suggested model or enter another model ID supported by that provider. OpenRouter model IDs must include the provider prefix, such as `openai/gpt-4.1-mini`.
6. Review the data notice and turn on **Enable analysis**.
7. Click **Save settings**.

> **BYOK security warning:** Chrome's local extension storage is not an encrypted credential vault. Use a dedicated, restricted API key with a low spending limit. A future consumer version can use a backend proxy if it needs to keep a shared provider key secret.

API usage may incur charges with the selected provider. The text of the Reddit post and collected comments is sent to that provider for analysis; review its current privacy and logging policies before using sensitive content.

## Load the extension locally

1. Open Chrome and visit `chrome://extensions`.
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select the `reddit-advice-analyzer` directory (the folder containing `manifest.json`).
5. Pin **Reddit Advice Analyzer** from Chrome's extensions menu if you want quick access to settings.

After editing the files, return to `chrome://extensions` and click the extension's reload button. Reload the Reddit tab too, because content scripts already injected into an open page are not automatically replaced.

## Test on Reddit

1. Add your API key, enable analysis, and save from the extension popup.
2. Open a direct Reddit post URL containing `/comments/`, for example a relationship/advice thread.
3. Wait for the floating **Thread signal** card in the lower-right corner. It should show:
   - `Personal advice: YES` or `NO`
   - positive, negative, and neutral/mixed percentages
   - the dominant sentiment: `POSITIVE`, `NEGATIVE`, or `NEUTRAL`
   - the number of visible comments analyzed
4. The analyzer starts as a compact **Thread signal** bar. Click the bar or `+` button to reveal the cached result; click `−` to minimize it without running another API request.
5. Click `×` to dismiss the bar until the Reddit page is fully refreshed.
6. Test a non-personal question (such as a programming or product question) and confirm the card still reports comment sentiment.
7. Returning to the same unchanged post during the browser session reuses the cached result. If more comments load, click **Refresh** in the expanded card to bypass the cache and analyze the current visible comments.
8. To inspect errors, open `chrome://extensions`, find this extension, and click the service worker inspection link. Page-side extraction errors appear in the Reddit tab's DevTools console.

### Dominant sentiment rule

The category with the most classified comments is displayed as the dominant sentiment. An exact tie is displayed as **MIXED**, and a thread with no visible comments is displayed as **NO DATA**.

Displayed percentages use largest-remainder rounding, so they always sum to 100% when comments are present.

## Known limitations

- Reddit changes its DOM frequently. The selectors cover current `shreddit-*` pages and old Reddit, but future markup changes may require selector updates.
- Only comments currently present and visible in the page DOM are collected, up to 50. Collapsed, unloaded, hidden, and deeply paginated comments are excluded.
- LLM classifications can be wrong, especially with sarcasm, jokes, ambiguous context, or multilingual threads.
- Results are cached for up to six hours during the browser session, but a changed thread or manual refresh makes a paid API request.
- Requests are limited to a 500-character title, 8,000-character post body, 2,000 characters per comment, and 30,000 total comment characters. Text beyond those limits is truncated.
- Provider requests time out after 45 seconds.
- The API key is stored locally in the Chrome profile. Use a dedicated key with a provider-side spending limit.
- Direct Anthropic browser requests can be disabled by an Anthropic organization setting; if so, that key will require a backend proxy.
- Adding another provider requires one adapter in `background.js`, provider metadata in `popup.js`, and its API origin in `manifest.json`.
- The card is hidden on Reddit pages that are not direct post URLs.

## Before an unlisted beta

The public privacy policy is hosted through GitHub Pages at <https://vulcan-332.github.io/reddit-advice-analyzer/>. Enter this URL in the Chrome Web Store Developer Dashboard's privacy-policy field.

The extension does not analyze or transmit Reddit content until the user actively enables analysis in the popup. API keys are restricted to trusted extension contexts, and raw Reddit text is not written to extension storage.
