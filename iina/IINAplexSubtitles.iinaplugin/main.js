const { console, core, event } = iina;

const SUBTITLE_PARAM = "iinaplex-subtitle";
const SELECTED_SUBTITLE_PARAM = "iinaplex-selected-subtitle";

let lastPayload = "";

function decodeQueryValue(value) {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function queryValues(url, name) {
  const queryStart = url.indexOf("?");
  if (queryStart === -1) return [];

  const hashStart = url.indexOf("#", queryStart);
  const query = url.slice(queryStart + 1, hashStart === -1 ? undefined : hashStart);
  const encodedName = encodeURIComponent(name);

  return query.split("&").flatMap((entry) => {
    const separator = entry.indexOf("=");
    const key = separator === -1 ? entry : entry.slice(0, separator);
    if (key !== name && key !== encodedName) return [];

    return [decodeQueryValue(separator === -1 ? "" : entry.slice(separator + 1))];
  });
}

function unique(values) {
  return values.filter((value, index) => value && values.indexOf(value) === index);
}

function loadPlexSubtitles() {
  const mediaUrl = core.status.url;
  const subtitles = unique(queryValues(mediaUrl, SUBTITLE_PARAM));
  if (!subtitles.length) return;

  const selected = queryValues(mediaUrl, SELECTED_SUBTITLE_PARAM)[0];
  const ordered = unique([selected, ...subtitles]);
  const payload = ordered.join("\n");
  if (payload === lastPayload) return;
  lastPayload = payload;

  for (const subtitleUrl of ordered) {
    core.subtitle.loadTrack(subtitleUrl);
  }

  console.log(`[IINAplex Subtitles] Loaded ${ordered.length} Plex subtitle track(s).`);
}

event.on("iina.file-loaded", () => {
  setTimeout(loadPlexSubtitles, 0);
});
