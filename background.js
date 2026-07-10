const LOG = "[Plex IINA bg]";
const PLEX_REQUEST_PATTERNS = [
  "http://127.0.0.1:32400/*",
  "http://localhost:32400/*",
  "http://10.100.102.13:32400/*",
  "http://app.plex.tv/*",
  "https://app.plex.tv/*",
];

function tokenStorageKey(tabId) {
  return `plex-token:${tabId}`;
}

function extractPlexToken(requestUrl) {
  try {
    const token = new URL(requestUrl).searchParams.get("X-Plex-Token");
    return token?.trim() || null;
  } catch {
    return null;
  }
}

function rememberPlexToken(details) {
  if (details.tabId < 0) return;

  const token = extractPlexToken(details.url);
  if (!token) return;

  chrome.storage.session
    .set({ [tokenStorageKey(details.tabId)]: token })
    .catch((error) => console.warn(LOG, "Could not save Plex token:", error));
}

async function getPlexToken(tabId) {
  const key = tokenStorageKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return stored[key] || null;
}

chrome.webRequest.onBeforeRequest.addListener(rememberPlexToken, {
  urls: PLEX_REQUEST_PATTERNS,
});

function buildIinaUrl(mediaUrl, options = {}) {
  const params = [`url=${encodeURIComponent(mediaUrl).replace(/'/g, "%27")}`];

  switch (options.mode) {
    case "fullScreen":
      params.push("full_screen=1");
      break;
    case "pip":
      params.push("pip=1");
      break;
    case "enqueue":
      params.push("enqueue=1");
      break;
  }

  if (options.newWindow) {
    params.push("new_window=1");
  }

  return `iina://open?${params.join("&")}`;
}

async function openInIina(tabId, mediaUrl, options = {}) {
  const iinaUrl = buildIinaUrl(mediaUrl, options);

  console.log(LOG, "Opening media in IINA:", { tabId });

  await chrome.scripting.executeScript({
    target: { tabId },
    args: [iinaUrl],
    func: (urlToOpen) => {
      const link = document.createElement("a");
      link.href = urlToOpen;
      link.style.display = "none";
      document.documentElement.appendChild(link);
      link.click();
      link.remove();
    },
  });

  return { ok: true, iinaUrl };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    message?.type !== "GET_PLEX_TOKEN" &&
    message?.type !== "OPEN_IN_IINA"
  ) {
    return;
  }

  const tabId = sender.tab?.id;
  if (typeof tabId !== "number") {
    sendResponse({ ok: false, error: "No sender tab id" });
    return;
  }

  if (message?.type === "GET_PLEX_TOKEN") {
    getPlexToken(tabId)
      .then((token) => sendResponse({ ok: true, token }))
      .catch((error) =>
        sendResponse({ ok: false, error: error?.message || String(error) }),
      );
    return true;
  }

  openInIina(tabId, message.mediaUrl, message.options || {})
    .then((result) => sendResponse(result))
    .catch((error) => {
      console.error(LOG, "Failed:", error);
      sendResponse({
        ok: false,
        error: error?.message || String(error),
      });
    });

  return true;
});
