(() => {
  const BUTTON_ID = "plex-play-in-iina-button";
  const PLAY_BUTTON_XPATH =
    "/html/body/div[1]/div[3]/div/div[2]/div[2]/div/div[1]/div/div[2]/div[2]/button[1]";

  const INSTALL_DEBOUNCE_MS = 250;

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

  function isFilmDetailView() {
    const routeUrl = getHashRouteUrl();
    if (!routeUrl || !getMetadataKeyFromLocation()) return false;

    const path = routeUrl.pathname.toLowerCase();
    return /\/(details|preplay)(?:\/|$)/.test(path);
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

  async function findTokenCandidates() {
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

    try {
      const response = await chrome.runtime.sendMessage({
        type: "GET_PLEX_TOKEN",
      });
      addTokenCandidate(candidates, response?.token);
    } catch {}

    return candidates;
  }

  function isSelectedPlexStream(stream) {
    return stream?.selected === true || String(stream?.selected) === "1";
  }

  function selectedFirst(subtitles) {
    return [...subtitles].sort(
      (a, b) => Number(b.selected) - Number(a.selected),
    );
  }

  function parseJsonMediaInfo(jsonText) {
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
      const streams = Array.isArray(part?.Stream)
        ? part.Stream
        : part?.Stream
          ? [part.Stream]
          : [];
      const subtitleStreams = streams.filter(
        (stream) => Number(stream?.streamType) === 3 && stream?.key,
      ).map((stream) => ({
        key: stream.key,
        selected: isSelectedPlexStream(stream),
      }));

      return {
        partKey: part?.key || null,
        subtitles: selectedFirst(subtitleStreams),
      };
    } catch {
      return { partKey: null, subtitles: [] };
    }
  }

  function parseXmlMediaInfo(xmlText) {
    try {
      const doc = new DOMParser().parseFromString(xmlText, "application/xml");
      if (doc.querySelector("parsererror")) {
        return { partKey: null, subtitles: [] };
      }

      const part = doc.querySelector("Part[key]");
      const subtitleStreams = Array.from(
        part?.querySelectorAll('Stream[streamType="3"][key]') || [],
      ).map((stream) => ({
        key: stream.getAttribute("key"),
        selected: stream.getAttribute("selected") === "1",
      })).filter((stream) => stream.key);

      return {
        partKey: part?.getAttribute("key") || null,
        subtitles: selectedFirst(subtitleStreams),
      };
    } catch {
      return { partKey: null, subtitles: [] };
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

  function buildSubtitleUrl(subtitleKey, token) {
    const url = new URL(subtitleKey, location.origin);
    url.searchParams.set("download", "1");
    if (token) {
      url.searchParams.set("X-Plex-Token", token);
    }
    return url.toString();
  }

  function buildPlaybackUrl(partKey, subtitles, token) {
    const url = new URL(buildPartUrl(partKey, token));
    const selectedSubtitle = subtitles.find((subtitle) => subtitle.selected);

    for (const subtitle of subtitles) {
      url.searchParams.append(
        "iinaplex-subtitle",
        buildSubtitleUrl(subtitle.key, token),
      );
    }

    if (selectedSubtitle) {
      url.searchParams.set(
        "iinaplex-selected-subtitle",
        buildSubtitleUrl(selectedSubtitle.key, token),
      );
    }

    return url.toString();
  }

  async function resolveViaMetadata() {
    const metadataKey = getMetadataKeyFromLocation();
    if (!metadataKey) {
      throw new Error("No metadata key found in current Plex URL");
    }

    const tokenCandidates = await findTokenCandidates();
    const tokensToTry = [null, ...tokenCandidates.map((x) => x.token)];

    for (const token of tokensToTry) {
      try {
        const { response, text } = await fetchMetadataText(metadataKey, token);
        if (!response.ok) continue;

        const jsonInfo = parseJsonMediaInfo(text);
        if (jsonInfo.partKey) {
          return {
            mediaUrl: buildPlaybackUrl(
              jsonInfo.partKey,
              jsonInfo.subtitles,
              token,
            ),
          };
        }

        const xmlInfo = parseXmlMediaInfo(text);
        if (xmlInfo.partKey) {
          return {
            mediaUrl: buildPlaybackUrl(
              xmlInfo.partKey,
              xmlInfo.subtitles,
              token,
            ),
          };
        }
      } catch {}
    }

    throw new Error("Could not resolve direct Plex media URL from metadata");
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

  async function onButtonClick(btn) {
    try {
      setButtonState(btn, "Working…", true);

      const { mediaUrl } = await resolveViaMetadata();
      await openInIINA(mediaUrl);
      setButtonState(btn, "Opened");

      setTimeout(() => {
        if (document.contains(btn)) setButtonState(btn, "Play in IINA");
      }, 1500);
    } catch (error) {
      console.error("[IINAplex] Could not open Plex media in IINA.", error);
      setButtonState(btn, "Failed");

      setTimeout(() => {
        if (document.contains(btn)) {
          setButtonState(btn, "Play in IINA");
        }
      }, 1800);
    } finally {
      btn.disabled = false;
      btn.style.opacity = "1";
      btn.style.cursor = "pointer";
    }
  }

  function installButton() {
    const currentRoute = location.hash || "";
    const existing = document.getElementById(BUTTON_ID);
    if (!isFilmDetailView()) {
      existing?.remove();
      return;
    }

    if (existing) {
      if (existing.dataset.plexIinaRoute === currentRoute) return;
      existing.remove();
    }

    const playButton = findPlayButton();
    if (!playButton) return;

    const btn = makeButton();
    btn.dataset.plexIinaRoute = currentRoute;
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onButtonClick(btn);
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
