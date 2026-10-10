(() => {
  const PANEL_ID = "raa-panel-host";
  const MAX_COMMENTS = 50;
  const MAX_TITLE_CHARS = 500;
  const MAX_BODY_CHARS = 8000;
  const MAX_COMMENT_CHARS = 2000;
  const MAX_TOTAL_COMMENT_CHARS = 30000;
  const MIN_COMMENT_LENGTH = 2;
  const ANALYSIS_DELAY_MS = 1800;

  let lastUrl = location.href;
  let analysisTimer;
  let requestId = 0;
  let dismissed = false;
  let consentGranted = false;
  let consentInitialized = false;

  init();

  async function init() {
    createPanel();
    await syncConsentAndSchedule();

    // Reddit is a single-page app. Watch for navigation and newly loaded post data.
    const observer = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        requestId += 1; // Ignore any response belonging to the previous post.
        showWaitingForPost();
        scheduleAnalysis();
      }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("focus", syncConsentAndSchedule);
  }

  async function syncConsentAndSchedule() {
    const previousConsent = consentGranted;
    try {
      const state = await chrome.runtime.sendMessage({ type: "GET_EXTENSION_STATE" });
      consentGranted = state?.dataConsentAccepted === true;
    } catch {
      consentGranted = false;
    }
    if (!consentInitialized || previousConsent !== consentGranted) {
      consentInitialized = true;
      scheduleAnalysis(100);
    }
  }

  function scheduleAnalysis(delay = ANALYSIS_DELAY_MS) {
    clearTimeout(analysisTimer);
    analysisTimer = setTimeout(runAnalysis, delay);
  }

  async function runAnalysis({ forceRefresh = false } = {}) {
    const currentRequest = ++requestId;
    const post = extractPost();

    if (!post.title || !isPostPage()) {
      hidePanel();
      return;
    }

    showPanel();
    if (!consentGranted) {
      renderConsentRequired();
      return;
    }
    setLoading(post.comments.length);

    try {
      const response = await chrome.runtime.sendMessage({
        type: "ANALYZE_REDDIT_POST",
        payload: post,
        forceRefresh
      });

      if (currentRequest !== requestId) return;
      if (!response?.ok) throw new Error(response?.error || "Analysis failed.");

      const summary = summarizeSentiments(response.analysis.comments);
      renderResult(response.analysis.personal_advice, summary, post.comments.length, response.cached === true);
    } catch (error) {
      if (currentRequest !== requestId) return;
      renderError(error.message || "Analysis failed. Please try again.");
    }
  }

  function isPostPage() {
    return /\/comments\//.test(location.pathname);
  }

  function extractPost() {
    const postRoot = document.querySelector("shreddit-post") || document.querySelector(".thing.link");
    const title = truncate(cleanText(
      postRoot?.getAttribute("post-title") ||
      postRoot?.querySelector("h1")?.textContent ||
      document.querySelector("main h1")?.textContent ||
      document.querySelector("a.title")?.textContent ||
      ""
    ), MAX_TITLE_CHARS);

    const body = truncate(cleanText(
      postRoot?.querySelector('[slot="text-body"]')?.textContent ||
      postRoot?.querySelector('[data-post-click-location="text-body"]')?.textContent ||
      document.querySelector(".thing.link .usertext-body .md")?.textContent ||
      ""
    ), MAX_BODY_CHARS);

    return { url: location.href.split("#")[0], title, body, comments: extractVisibleComments() };
  }

  function extractVisibleComments() {
    const modernComments = [...document.querySelectorAll("shreddit-comment")];
    const oldComments = [...document.querySelectorAll(".commentarea .comment")];
    const candidates = modernComments.length ? modernComments : oldComments;
    const comments = [];
    const seen = new Set();
    let remainingChars = MAX_TOTAL_COMMENT_CHARS;

    for (const commentRoot of candidates) {
      if (comments.length >= MAX_COMMENTS || remainingChars <= 0) break;
      if (!isVisible(commentRoot)) continue;

      const textNode = modernComments.length
        ? commentRoot.querySelector('[slot="comment"]') ||
          commentRoot.querySelector('[data-testid="comment"]') ||
          commentRoot.querySelector(".md")
        : commentRoot.querySelector(":scope > .entry .usertext-body .md");

      const text = truncate(cleanText(textNode?.textContent || ""), Math.min(MAX_COMMENT_CHARS, remainingChars));
      if (text.length < MIN_COMMENT_LENGTH || /^\[(deleted|removed)\]$/i.test(text)) continue;
      if (seen.has(text)) continue;

      seen.add(text);
      comments.push(text);
      remainingChars -= text.length;
    }

    return comments;
  }

  function isVisible(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function cleanText(value) {
    return String(value).replace(/\s+/g, " ").trim();
  }

  function truncate(value, maxLength) {
    return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…` : value;
  }

  function summarizeSentiments(comments) {
    const counts = { positive: 0, negative: 0, neutral: 0 };
    for (const comment of comments) counts[comment.sentiment] += 1;

    const total = comments.length;
    const percentages = total
      ? allocateRoundedPercentages(counts, total)
      : { positive: 0, negative: 0, neutral: 0 };

    return {
      ...percentages,
      dominant: calculateDominantSentiment(counts, total)
    };
  }

  // Largest-remainder rounding keeps the three displayed percentages at exactly 100%.
  function allocateRoundedPercentages(counts, total) {
    const labels = ["positive", "negative", "neutral"];
    const exact = labels.map((label) => ({
      label,
      value: (counts[label] / total) * 100
    }));
    const result = Object.fromEntries(exact.map(({ label, value }) => [label, Math.floor(value)]));
    let remainder = 100 - Object.values(result).reduce((sum, value) => sum + value, 0);

    exact
      .sort((a, b) => (b.value % 1) - (a.value % 1))
      .slice(0, remainder)
      .forEach(({ label }) => { result[label] += 1; });

    return result;
  }

  /** Pick the most common sentiment. Exact ties are reported as mixed. */
  function calculateDominantSentiment(counts, total) {
    if (!total) return { label: "NO DATA", kind: "none" };

    const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (ranked[0][1] === ranked[1][1]) {
      return { label: "MIXED", kind: "mixed" };
    }

    return {
      label: ranked[0][0].toUpperCase(),
      kind: ranked[0][0]
    };
  }

  function createPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const host = document.createElement("aside");
    host.id = PANEL_ID;
    host.className = "raa-collapsed";
    host.dataset.state = "waiting";
    host.setAttribute("aria-live", "polite");
    host.innerHTML = `
      <div class="raa-card">
        <div class="raa-topline">
          <button class="raa-brand" type="button" aria-expanded="false" aria-controls="raa-panel-content" aria-label="Toggle Thread Signal results">
            <span class="raa-brand-mark">R</span>
            <span class="raa-brand-label">Thread signal</span>
            <span class="raa-state-dot" aria-hidden="true"></span>
          </button>
          <div class="raa-controls">
            <button class="raa-toggle" type="button" aria-expanded="false" aria-controls="raa-panel-content" aria-label="Expand Thread Signal" title="Expand">
              <span aria-hidden="true">＋</span>
            </button>
            <button class="raa-close" type="button" aria-label="Dismiss Thread Signal until page refresh" title="Dismiss until refresh">×</button>
          </div>
        </div>
        <div class="raa-content" id="raa-panel-content"></div>
        <div class="raa-footer">
          <span class="raa-count">Waiting for post</span>
          <button class="raa-refresh" type="button" aria-label="Analyze visible comments again">Refresh</button>
        </div>
      </div>`;

    document.documentElement.appendChild(host);
    host.querySelector(".raa-brand").addEventListener("click", togglePanel);
    host.querySelector(".raa-toggle").addEventListener("click", togglePanel);
    host.querySelector(".raa-close").addEventListener("click", dismissPanel);
    host.querySelector(".raa-refresh").addEventListener("click", () => runAnalysis({ forceRefresh: true }));
  }

  function setLoading(commentCount) {
    setPanelState("loading");
    panelContent().innerHTML = `
      <div class="raa-loading">
        <span class="raa-spinner" aria-hidden="true"></span>
        <div><strong>Reading the thread</strong><small>Analyzing two independent signals…</small></div>
      </div>`;
    setCount(`${commentCount} visible comment${commentCount === 1 ? "" : "s"}`);
  }

  function renderResult(personalAdvice, summary, commentCount, cached) {
    setPanelState("ready");
    const adviceClass = personalAdvice ? "yes" : "no";
    panelContent().innerHTML = `
      <section class="raa-advice">
        <span class="raa-eyebrow">Personal advice</span>
        <strong class="raa-verdict raa-${adviceClass}">${personalAdvice ? "YES" : "NO"}</strong>
      </section>
      <section class="raa-sentiment">
        <div class="raa-section-head"><span>Comment sentiment</span><span class="raa-majority raa-majority-${summary.dominant.kind}">${summary.dominant.label}</span></div>
        <div class="raa-meter" aria-label="Sentiment distribution">
          <span class="raa-meter-positive" style="width:${summary.positive}%"></span>
          <span class="raa-meter-negative" style="width:${summary.negative}%"></span>
          <span class="raa-meter-neutral" style="width:${summary.neutral}%"></span>
        </div>
        <dl class="raa-stats">
          ${statRow("positive", "Positive", summary.positive)}
          ${statRow("negative", "Negative", summary.negative)}
          ${statRow("neutral", "Neutral / mixed", summary.neutral)}
        </dl>
      </section>`;
    setCount(`${commentCount} comment${commentCount === 1 ? "" : "s"} analyzed${cached ? " · cached" : ""}`);
  }

  function statRow(kind, label, value) {
    return `<div><dt><i class="raa-dot raa-dot-${kind}"></i>${label}</dt><dd>${value}%</dd></div>`;
  }

  function renderError(message) {
    setPanelState("error");
    panelContent().innerHTML = `
      <div class="raa-error">
        <span aria-hidden="true">!</span>
        <div><strong>Analysis unavailable</strong><p>${escapeHtml(message)}</p></div>
      </div>`;
    setCount("Check settings and retry");
  }

  function renderConsentRequired() {
    setPanelState("paused");
    panelContent().innerHTML = `
      <div class="raa-notice">
        <span aria-hidden="true">i</span>
        <div><strong>Analysis is off</strong><p>Click the extension icon, review the data notice, and enable analysis.</p></div>
      </div>`;
    setCount("Setup required");
  }

  function showWaitingForPost() {
    setPanelState("waiting");
    showPanel();
    panelContent().innerHTML = `<div class="raa-loading"><span class="raa-spinner"></span><div><strong>Opening thread</strong><small>Waiting for Reddit to finish loading…</small></div></div>`;
    setCount("Waiting for post");
  }

  function panelContent() {
    return document.querySelector(`#${PANEL_ID} .raa-content`);
  }

  function setCount(value) {
    document.querySelector(`#${PANEL_ID} .raa-count`).textContent = value;
  }

  function showPanel() {
    if (dismissed) return;
    document.getElementById(PANEL_ID)?.classList.remove("raa-hidden");
  }

  function hidePanel() {
    document.getElementById(PANEL_ID)?.classList.add("raa-hidden");
  }

  function dismissPanel() {
    dismissed = true;
    hidePanel();
  }

  function togglePanel() {
    if (dismissed) return;
    const host = document.getElementById(PANEL_ID);
    if (!host) return;
    setCollapsed(!host.classList.contains("raa-collapsed"));
  }

  function setCollapsed(collapsed) {
    const host = document.getElementById(PANEL_ID);
    if (!host) return;

    host.classList.toggle("raa-collapsed", collapsed);
    const brand = host.querySelector(".raa-brand");
    const toggle = host.querySelector(".raa-toggle");
    brand.setAttribute("aria-expanded", String(!collapsed));
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.setAttribute("aria-label", `${collapsed ? "Expand" : "Minimize"} Thread Signal`);
    toggle.title = collapsed ? "Expand" : "Minimize";
    toggle.querySelector("span").textContent = collapsed ? "＋" : "−";
  }

  function setPanelState(state) {
    const host = document.getElementById(PANEL_ID);
    if (host) host.dataset.state = state;
  }

  function escapeHtml(value) {
    const element = document.createElement("span");
    element.textContent = value;
    return element.innerHTML;
  }
})();
