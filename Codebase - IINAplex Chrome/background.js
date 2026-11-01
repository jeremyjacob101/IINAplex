const LOG = "[Plex IINA bg]";
const PLEX_REQUEST_PATTERNS = [
  "http://127.0.0.1:32400/*",
  "http://localhost:32400/*",
  "http://10.100.102.13:32400/*",
  "http://*.plex.direct/*",
  "https://*.plex.direct/*",
  "http://app.plex.tv/*",
  "https://app.plex.tv/*",
];

function tokenStorageKey(tabId) {
  return `plex-token:${tabId}`;
}

function connectionStorageKey(tabId) {
  return `plex-connection:${tabId}`;
}

function extractPlexToken(requestUrl) {
  try {
    const token = new URL(requestUrl).searchParams.get("X-Plex-Token");
    return token?.trim() || null;
  } catch {
    return null;
  }
}

function rememberPlexConnection(details) {
  if (details.tabId < 0) return;

  const token = extractPlexToken(details.url);
  if (!token) return;

  let origin;
  try {
    origin = new URL(details.url).origin;
  } catch {
    return;
  }

  chrome.storage.session
    .set({
      [tokenStorageKey(details.tabId)]: token,
      [connectionStorageKey(details.tabId)]: { token, origin },
    })
    .catch((error) =>
      console.warn(LOG, "Could not save Plex connection:", error),
    );
}

async function getPlexToken(tabId) {
  const key = tokenStorageKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return stored[key] || null;
}

async function getPlexConnection(tabId) {
  const key = connectionStorageKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return stored[key] || null;
}

chrome.webRequest.onBeforeRequest.addListener(rememberPlexConnection, {
  urls: PLEX_REQUEST_PATTERNS,
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    message?.type !== "GET_PLEX_TOKEN" &&
    message?.type !== "GET_PLEX_CONNECTION"
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

  if (message?.type === "GET_PLEX_CONNECTION") {
    getPlexConnection(tabId)
      .then((connection) => sendResponse({ ok: true, connection }))
      .catch((error) =>
        sendResponse({ ok: false, error: error?.message || String(error) }),
      );
    return true;
  }

});
