(() => {
  const BUTTON_ID = "plex-play-in-iina-button";
  const PLAY_BUTTON_XPATH =
    "/html/body/div[1]/div[3]/div/div[2]/div[2]/div/div[1]/div/div[2]/div[2]/button[1]";

  const INSTALL_DEBOUNCE_MS = 250;
  const MENU_WAIT_MS = 3500;
  const MENU_POLL_MS = 150;

  let installTimer = null;
  let observerStarted = false;

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  function xpathNode(path) {
    try {
      const result = document.evaluate(
        path,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null,
      );
      return result.singleNodeValue || null;
    } catch {
      return null;
    }
  }

  function getButtonText(el) {
    return (el?.textContent || "").trim().replace(/\s+/g, " ");
  }

  function getVisibleButtons() {
    return Array.from(document.querySelectorAll("button")).filter(isVisible);
  }

  function scoreAnchor(a) {
    const href = a.href || "";
    const text = getButtonText(a).toLowerCase();
    const target = (a.target || "").toLowerCase();

    let score = 0;
    if (!href) return -1;
    if (/download/i.test(href)) score += 50;
    if (/download/i.test(text)) score += 30;
    if (/downloadfileframe/i.test(target)) score += 20;
    if (/x-plex-token=/i.test(href)) score += 15;
    if (/\/library\/parts\//i.test(href)) score += 15;
    if (/\/transcode\//i.test(href)) score += 10;
    if (
      /\.mkv(\?|$)|\.mp4(\?|$)|\.avi(\?|$)|\.mov(\?|$)|\.m3u8(\?|$)/i.test(href)
    ) {
      score += 10;
    }
    if (/plex/i.test(href)) score += 5;
    return score;
  }

  function getInterestingAnchors(root = document) {
    return Array.from(root.querySelectorAll("a[href]"))
      .map((a) => ({
        el: a,
        href: a.href,
        text: getButtonText(a),
        target: a.target || "",
        score: scoreAnchor(a),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  function findPlayButton() {
    const xpathMatch = xpathNode(PLAY_BUTTON_XPATH);
    if (
      xpathMatch &&
      xpathMatch.tagName === "BUTTON" &&
      isVisible(xpathMatch)
    ) {
      return xpathMatch;
    }

    const selectors = [
      'button[data-qa-id="preplay-play"]',
      'button[data-testid="preplay-play"]',
      'button[aria-label="Play"]',
      'button[title="Play"]',
    ];

    for (const selector of selectors) {
      const match = Array.from(document.querySelectorAll(selector)).find(
        isVisible,
      );
      if (match) return match;
    }

    return (
      getVisibleButtons().find((btn) => {
        const text = getButtonText(btn).toLowerCase();
        const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
        const title = (btn.getAttribute("title") || "").toLowerCase();
        return text === "play" || aria === "play" || title === "play";
      }) || null
    );
  }

  function findMoreButton(playButton) {
    const directSelectors = [
      'button[data-qa-id="preplay-more"]',
      'button[data-testid="preplay-more"]',
      'button[aria-label="More"]',
      'button[title="More"]',
    ];

    for (const selector of directSelectors) {
      const match = Array.from(document.querySelectorAll(selector)).find(
        isVisible,
      );
      if (match) return match;
    }

    if (playButton?.parentElement) {
      const siblingButtons = Array.from(
        playButton.parentElement.querySelectorAll("button"),
      ).filter((b) => b !== playButton && isVisible(b));

      const moreish = siblingButtons.find((btn) => {
        const text = getButtonText(btn).toLowerCase();
        const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
        const title = (btn.getAttribute("title") || "").toLowerCase();
        return (
          text.includes("more") ||
          aria.includes("more") ||
          title.includes("more")
        );
      });

      if (moreish) return moreish;
      if (siblingButtons.length)
        return siblingButtons[siblingButtons.length - 1];
    }

    return null;
  }

  function clickElement(el) {
    if (!el) return;
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    el.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
    el.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, cancelable: true }),
    );
    el.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  }

  function waitFor(fn, timeoutMs = MENU_WAIT_MS, intervalMs = MENU_POLL_MS) {
    return new Promise((resolve, reject) => {
      const start = Date.now();

      function tick() {
        let result = null;
        try {
          result = fn();
        } catch (e) {
          reject(e);
          return;
        }

        if (result) {
          resolve(result);
          return;
        }

        if (Date.now() - start >= timeoutMs) {
          reject(new Error("Timed out"));
          return;
        }

        setTimeout(tick, intervalMs);
      }

      tick();
    });
  }

  function getHashRouteUrl() {
    try {
      const rawHash = location.hash || "";
      const route = rawHash.startsWith("#!")
        ? rawHash.slice(2)
        : rawHash.replace(/^#/, "");
      if (!route) return null;
      return new URL(route, location.origin);
    } catch {
      return null;
    }
  }

  function getMetadataKeyFromLocation() {
    const routeUrl = getHashRouteUrl();
    if (!routeUrl) return null;

    const key = routeUrl.searchParams.get("key");
    if (!key) return null;

    try {
      return decodeURIComponent(key);
    } catch {
      return key;
    }
  }

  function addTokenCandidate(list, rawToken) {
    const token = (rawToken || "").trim();
    if (!token) return;
    if (token.length < 8) return;
    if (list.some((x) => x.token === token)) return;
    list.push({ token });
  }

  function scanValueForTokens(value, source, out) {
    if (typeof value !== "string") return;

    const q = value.match(/X-Plex-Token=([^&"'\\\s]+)/i);
    if (q?.[1]) addTokenCandidate(out, decodeURIComponent(q[1]));

    if (/token|auth|access/i.test(source)) {
      addTokenCandidate(out, value);
    }

    try {
      const parsed = JSON.parse(value);
      scanObjectForTokens(parsed, `${source} json`, out);
    } catch {}
  }

  function scanObjectForTokens(obj, source, out) {
    if (!obj) return;

    if (typeof obj === "string") {
      scanValueForTokens(obj, source, out);
      return;
    }

    if (Array.isArray(obj)) {
      obj.forEach((item, i) =>
        scanObjectForTokens(item, `${source}[${i}]`, out),
      );
      return;
    }

    if (typeof obj === "object") {
      for (const [key, value] of Object.entries(obj)) {
        const childSource = `${source}.${key}`;
        if (typeof value === "string" && /token|auth|access/i.test(key)) {
          addTokenCandidate(out, value);
        }
        scanObjectForTokens(value, childSource, out);
      }
    }
  }

  function getStorageEntries(storage) {
    const items = [];
    try {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        const value = storage.getItem(key);
        items.push({ key, value });
      }
    } catch {}
    return items;
  }

  function findTokenCandidates() {
    const candidates = [];
    const storageEntries = [
      ...getStorageEntries(localStorage),
      ...getStorageEntries(sessionStorage),
    ];

    for (const entry of storageEntries) {
      scanValueForTokens(entry.value, entry.key, candidates);
    }

    for (const a of Array.from(document.querySelectorAll("a[href]")).slice(
      0,
      200,
    )) {
      scanValueForTokens(a.href, "anchor.href", candidates);
    }

    return candidates;
  }

  function parseJsonPartKey(jsonText) {
    try {
      const obj = JSON.parse(jsonText);
      const metadata =
        obj?.MediaContainer?.Metadata?.[0] ||
        obj?.MediaContainer?.Metadata ||
        obj?.Metadata?.[0] ||
        obj?.Metadata ||
        null;

      const media = metadata?.Media?.[0] || metadata?.Media || null;
      const part = media?.Part?.[0] || media?.Part || null;

      return part?.key || null;
    } catch {
      return null;
    }
  }

  function parseXmlPartKey(xmlText) {
    try {
      const doc = new DOMParser().parseFromString(xmlText, "application/xml");
      if (doc.querySelector("parsererror")) return null;
      const part = doc.querySelector("Part[key]");
      return part?.getAttribute("key") || null;
    } catch {
      return null;
    }
  }

  async function fetchMetadataText(metadataKey, token) {
    const url = new URL(metadataKey, location.origin);
    if (token) {
      url.searchParams.set("X-Plex-Token", token);
    }

    const headers = {
      Accept: "application/json, application/xml, text/xml, */*",
    };

    if (token) {
      headers["X-Plex-Token"] = token;
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      credentials: "include",
      headers,
    });

    const text = await response.text();
    return { response, text, token };
  }

  function buildPartUrl(partKey, token) {
    const url = new URL(partKey, location.origin);
    url.searchParams.set("download", "1");
    if (token) {
      url.searchParams.set("X-Plex-Token", token);
    }
    return url.toString();
  }

  async function resolveViaMetadata() {
    const metadataKey = getMetadataKeyFromLocation();
    if (!metadataKey) {
      throw new Error("No metadata key found in current Plex URL");
    }

    const tokenCandidates = findTokenCandidates();
    const tokensToTry = [null, ...tokenCandidates.map((x) => x.token)];

    for (const token of tokensToTry) {
      try {
        const { response, text } = await fetchMetadataText(metadataKey, token);
        if (!response.ok) continue;

        const jsonPartKey = parseJsonPartKey(text);
        if (jsonPartKey) {
          return buildPartUrl(jsonPartKey, token);
        }

        const xmlPartKey = parseXmlPartKey(text);
        if (xmlPartKey) {
          return buildPartUrl(xmlPartKey, token);
        }
      } catch {}
    }

    throw new Error("Could not resolve direct Plex media URL from metadata");
  }

  async function resolveViaMoreMenu(playButton) {
    const moreButton = findMoreButton(playButton);
    if (!moreButton) {
      throw new Error("Could not find More button");
    }

    clickElement(moreButton);

    try {
      return await waitFor(() => {
        const anchors = getInterestingAnchors();
        const best = anchors[0];
        if (best && best.score >= 40) {
          return best.href;
        }
        return null;
      });
    } finally {
      setTimeout(() => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
        document.dispatchEvent(
          new KeyboardEvent("keyup", { key: "Escape", bubbles: true }),
        );
      }, 50);
    }
  }

  async function openInIINA(mediaUrl) {
    const response = await chrome.runtime.sendMessage({
      type: "OPEN_IN_IINA",
      mediaUrl,
      options: {},
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Background open failed");
    }
  }

  function makeButton() {
    const btn = document.createElement("button");
    btn.id = BUTTON_ID;
    btn.type = "button";
    btn.textContent = "Play in IINA";
    btn.style.marginLeft = "16px";
    btn.style.marginTop = "auto";
    btn.style.marginBottom = "auto";
    btn.style.padding = "0 14px";
    btn.style.height = "36px";
    btn.style.border = "0";
    btn.style.borderRadius = "8px";
    btn.style.background = "#1f6feb";
    btn.style.color = "#fff";
    btn.style.fontWeight = "600";
    btn.style.cursor = "pointer";
    btn.style.zIndex = "9999";
    btn.style.position = "relative";
    btn.style.boxShadow = "0 1px 3px rgba(0,0,0,0.25)";
    return btn;
  }

  function setButtonState(btn, text, disabled = false) {
    if (!btn) return;
    btn.textContent = text;
    btn.disabled = disabled;
    btn.style.opacity = disabled ? "0.7" : "1";
    btn.style.cursor = disabled ? "default" : "pointer";
  }

  async function onButtonClick(btn, playButton) {
    try {
      setButtonState(btn, "Working…", true);

      let mediaUrl = null;

      try {
        mediaUrl = await resolveViaMoreMenu(playButton);
      } catch {}

      if (!mediaUrl) {
        mediaUrl = await resolveViaMetadata();
      }

      await openInIINA(mediaUrl);
      setButtonState(btn, "Opened");

      setTimeout(() => {
        if (document.contains(btn)) setButtonState(btn, "Play in IINA");
      }, 1500);
    } catch {
      setButtonState(btn, "Failed");

      setTimeout(() => {
        if (document.contains(btn)) setButtonState(btn, "Play in IINA");
      }, 1800);
    } finally {
      btn.disabled = false;
      btn.style.opacity = "1";
      btn.style.cursor = "pointer";
    }
  }

  function installButton() {
    const existing = document.getElementById(BUTTON_ID);
    if (existing) return;

    const playButton = findPlayButton();
    if (!playButton) return;

    const btn = makeButton();
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onButtonClick(btn, playButton);
    });

    if (playButton.parentElement) {
      playButton.insertAdjacentElement("afterend", btn);
    } else {
      document.body.appendChild(btn);
    }
  }

  function scheduleInstall() {
    clearTimeout(installTimer);
    installTimer = setTimeout(() => {
      installButton();
    }, INSTALL_DEBOUNCE_MS);
  }

  function patchHistory() {
    if (window.__plexIinaHistoryPatched) return;
    window.__plexIinaHistoryPatched = true;

    const wrap = (name) => {
      const original = history[name];
      history[name] = function (...args) {
        const result = original.apply(this, args);
        window.dispatchEvent(new Event("plex-iina-locationchange"));
        return result;
      };
    };

    wrap("pushState");
    wrap("replaceState");

    window.addEventListener("popstate", () => {
      window.dispatchEvent(new Event("plex-iina-locationchange"));
    });

    window.addEventListener("hashchange", () => {
      window.dispatchEvent(new Event("plex-iina-locationchange"));
    });

    window.addEventListener("plex-iina-locationchange", () => {
      scheduleInstall();
    });
  }

  function startObserver() {
    if (observerStarted) return;
    observerStarted = true;

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.addedNodes?.length || m.removedNodes?.length) {
          scheduleInstall();
          break;
        }
      }
    });

    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
    });
  }

  function boot() {
    patchHistory();
    startObserver();
    scheduleInstall();

    window.addEventListener("load", () => {
      scheduleInstall();
    });

    document.addEventListener("readystatechange", () => {
      scheduleInstall();
    });
  }

  boot();
})();
