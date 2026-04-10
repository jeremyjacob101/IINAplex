const LOG = "[Plex IINA bg]";

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

  console.log(LOG, "Opening:", {
    mediaUrl,
    iinaUrl,
    tabId,
  });

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
  if (message?.type !== "OPEN_IN_IINA") {
    return;
  }

  const tabId = sender.tab?.id;
  if (typeof tabId !== "number") {
    sendResponse({ ok: false, error: "No sender tab id" });
    return;
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
