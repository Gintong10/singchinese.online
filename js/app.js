(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  /** Resolved each init so we pick up `SingChineseSpotify` even if scripts reorder; avoid stale undefined from load races. */
  let Sp = window.SingChineseSpotify;

  const TRACK_STORE_PREFIX = "singchinese_track_";
  const SKIP_SEC = 5;

  const playBtn = $("playBtn");
  const skipBackBtn = $("skipBackBtn");
  const skipForwardBtn = $("skipForwardBtn");
  const seek = $("seek");
  const timeCurrent = $("timeCurrent");
  const timeTotal = $("timeTotal");
  const lyricsList = $("lyricsList");
  const wordPopover = $("wordPopover");
  const wordPopoverClose = $("wordPopoverClose");
  const wordPopoverZh = $("wordPopoverZh");
  const wordPopoverPy = $("wordPopoverPy");
  const wordPopoverEn = $("wordPopoverEn");
  const modeBadge = $("modeBadge");
  const spotifyLoginBtn = $("spotifyLoginBtn");
  const spotifySessionRow = $("spotifySessionRow");
  const spotifyDisplayName = $("spotifyDisplayName");
  const spotifyLogoutBtn = $("spotifyLogoutBtn");
  const spotifyHint = $("spotifyHint");
  const spotifyTrackSearch = $("spotifyTrackSearch");
  const spotifySearchResults = $("spotifySearchResults");
  const spotifySelectedRow = $("spotifySelectedRow");
  const spotifySelectedLabel = $("spotifySelectedLabel");
  const spotifyClearTrackBtn = $("spotifyClearTrackBtn");
  const spotifyPremiumBadge = $("spotifyPremiumBadge");
  const spotifySetupBanner = $("spotifySetupBanner");
  const setupBannerRedirect = $("setupBannerRedirect");
  const lyricsLessonSearch = $("lyricsLessonSearch");
  const lyricsLessonSearchResults = $("lyricsLessonSearchResults");
  const lyricsSelectedRow = $("lyricsSelectedRow");
  const lyricsSelectedLabel = $("lyricsSelectedLabel");
  const scriptSimplifiedBtn = $("scriptSimplifiedBtn");
  const scriptTraditionalBtn = $("scriptTraditionalBtn");

  /** First lesson in catalog (Lyrics & timing picker removed). */
  let catalogLessonId = "default";
  let catalogDefaultTrackId = "";

  /** @type {{ lines: Array<{start:number,end:number,zh:string,pinyin:string,en:string}>, title?: string, titleEn?: string, artist?: string } | null} */
  let lyricData = null;

  /** @type {"idle" | "spotify"} */
  let mode = "idle";

  let lastActiveLine = -1;
  let spotifyRafId = 0;
  let lastSpotifyTimeSec = 0;
  let lastSpotifyDurationSec = 0;
  let seekSpotifyTimer = 0;
  let expectedSpotifyUri = "";
  /** Preview time when idle (scrubbing before play) */
  let previewTimeSec = 0;

  let cachedSpotifyMe = null;
  let trackSearchTimer = 0;
  let trackSearchSeq = 0;
  let lrclibSeq = 0;
  /** Last Spotify track rows shown (same order as listbox). */
  let searchResultsTracks = [];
  let searchHighlightIdx = -1;

  /** Local lyric catalog from data/songs.json (same order as file). */
  let catalogSongs = [];
  let lyricsSearchTimer = 0;
  let lyricsSearchSeq = 0;
  /** Same order as lyrics lesson listbox. */
  let lyricsSearchList = [];
  let lyricsSearchHighlightIdx = -1;

  const SCRIPT_PREF_KEY = "singchinese_script_pref";
  const LRCLIB_BASE_URL = "https://lrclib.net";
  const lineProcessCache = new Map();
  const openccConverters = {};

  let scriptPreference = loadScriptPreference();
  let lyricSource = null;
  /** Reused across lines until script preference changes. */
  let browserTranslator = null;
  let browserTranslatorSourceLang = "";
  let activeWordBtn = null;
  const wordMeaningCache = new Map();
  let pinyinSegmentDictReady = false;
  let pinyinSegmentDictPromise = null;

  function ensurePinyinSegmentDict() {
    if (pinyinSegmentDictReady) return Promise.resolve();
    const pp = window.pinyinPro;
    if (!pp || typeof pp.addDict !== "function") {
      pinyinSegmentDictReady = true;
      return Promise.resolve();
    }
    if (pinyinSegmentDictPromise) return pinyinSegmentDictPromise;
    pinyinSegmentDictPromise = import(
      "https://cdn.jsdelivr.net/npm/@pinyin-pro/data@1.3.1/dist/modern.mjs"
    )
      .then((mod) => {
        const dict = mod.default || mod;
        if (window.pinyinPro?.addDict) window.pinyinPro.addDict(dict);
      })
      .catch((e) => {
        console.warn("Pinyin phrase dictionary failed to load", e);
      })
      .finally(() => {
        pinyinSegmentDictReady = true;
      });
    return pinyinSegmentDictPromise;
  }

  function getSelectedSongId() {
    return catalogLessonId;
  }

  function getCatalogSpotifyTrackId() {
    return catalogDefaultTrackId;
  }

  function loadScriptPreference() {
    try {
      const saved = localStorage.getItem(SCRIPT_PREF_KEY);
      return saved === "traditional" ? "traditional" : "simplified";
    } catch (_) {
      return "simplified";
    }
  }

  function saveScriptPreference(next) {
    scriptPreference = next === "traditional" ? "traditional" : "simplified";
    try {
      localStorage.setItem(SCRIPT_PREF_KEY, scriptPreference);
    } catch (_) {}
    browserTranslator = null;
    browserTranslatorSourceLang = "";
    updateScriptToggleUi();
  }

  function updateScriptToggleUi() {
    const isTraditional = scriptPreference === "traditional";
    if (scriptSimplifiedBtn) {
      scriptSimplifiedBtn.classList.toggle("is-active", !isTraditional);
      scriptSimplifiedBtn.setAttribute("aria-pressed", !isTraditional ? "true" : "false");
    }
    if (scriptTraditionalBtn) {
      scriptTraditionalBtn.classList.toggle("is-active", isTraditional);
      scriptTraditionalBtn.setAttribute("aria-pressed", isTraditional ? "true" : "false");
    }
  }

  function parseStoredTrackRaw(raw) {
    const empty = { rawId: "", label: "", name: "", artists: "", albumName: "", durationMs: 0 };
    if (!raw || typeof raw !== "string") return empty;
    const trimmed = raw.trim();
    if (!trimmed) return empty;
    if (trimmed.charAt(0) === "{") {
      try {
        const o = JSON.parse(trimmed);
        const id = (o.id && String(o.id).trim()) || "";
        const label = (o.label && String(o.label).trim()) || "";
        return {
          rawId: id,
          label: label,
          name: (o.name && String(o.name)) || "",
          artists: (o.artists && String(o.artists)) || "",
          albumName: (o.albumName && String(o.albumName)) || "",
          durationMs: Number(o.durationMs) || 0,
        };
      } catch (_) {
        return { rawId: trimmed, label: "", name: "", artists: "", albumName: "", durationMs: 0 };
      }
    }
    return { rawId: trimmed, label: "", name: "", artists: "", albumName: "", durationMs: 0 };
  }

  function loadStoredTrackPick(songId) {
    try {
      return parseStoredTrackRaw(sessionStorage.getItem(TRACK_STORE_PREFIX + songId) || "");
    } catch (_) {
      return { rawId: "", label: "" };
    }
  }

  function saveStoredTrackPick(songId, rawIdOrTrack, label) {
    try {
      const key = TRACK_STORE_PREFIX + songId;
      if (rawIdOrTrack && typeof rawIdOrTrack === "object") {
        const track = rawIdOrTrack;
        const id = track.id && String(track.id).trim();
        if (!id) {
          sessionStorage.removeItem(key);
          return;
        }
        sessionStorage.setItem(
          key,
          JSON.stringify({
            id: id,
            label: formatPickLabel(track),
            name: track.name || "",
            artists: track.artists || "",
            albumName: track.albumName || "",
            durationMs: track.durationMs || 0,
          })
        );
        return;
      }
      const rawId = rawIdOrTrack;
      if (!rawId || !String(rawId).trim()) {
        sessionStorage.removeItem(key);
        return;
      }
      const id = String(rawId).trim();
      const lb = label && String(label).trim();
      if (lb) {
        sessionStorage.setItem(key, JSON.stringify({ id: id, label: lb }));
      } else {
        sessionStorage.setItem(key, id);
      }
    } catch (_) {}
  }

  function getEffectiveSpotifyTrackId() {
    const pick = loadStoredTrackPick(getSelectedSongId());
    if (pick.rawId) return pick.rawId;
    return getCatalogSpotifyTrackId();
  }

  function syncTrackSearchUiAuth() {
    const hasClient = !!(Sp && Sp.getClientId());
    const loggedIn = !!(Sp && Sp.isLoggedIn());
    const canSearch = hasClient && loggedIn;
    if (spotifyTrackSearch) {
      spotifyTrackSearch.disabled = !canSearch;
      spotifyTrackSearch.placeholder = !hasClient
        ? "Configure Spotify Client ID to search…"
        : !loggedIn
          ? "Sign in (header) to search Spotify…"
          : "What do you want to play?";
    }
  }

  function hideTrackSearchResults() {
    if (!spotifySearchResults || !spotifyTrackSearch) return;
    spotifySearchResults.hidden = true;
    spotifySearchResults.innerHTML = "";
    spotifyTrackSearch.setAttribute("aria-expanded", "false");
    searchResultsTracks = [];
    searchHighlightIdx = -1;
  }

  function hideLyricsSearchResults() {
    if (!lyricsLessonSearchResults || !lyricsLessonSearch) return;
    lyricsLessonSearchResults.hidden = true;
    lyricsLessonSearchResults.innerHTML = "";
    lyricsLessonSearch.setAttribute("aria-expanded", "false");
    lyricsSearchList = [];
    lyricsSearchHighlightIdx = -1;
  }

  function setLyricsSearchHighlight(idx) {
    if (!lyricsLessonSearchResults) return;
    const btns = lyricsLessonSearchResults.querySelectorAll(".lyrics-lesson-result-btn");
    lyricsSearchHighlightIdx = idx;
    btns.forEach((b, i) => {
      b.classList.toggle("is-highlighted", i === idx);
      b.setAttribute("aria-selected", i === idx ? "true" : "false");
    });
    if (idx >= 0 && btns[idx]) {
      btns[idx].scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  function renderLyricsCatalogEmpty(message) {
    if (!lyricsLessonSearchResults || !lyricsLessonSearch) return;
    lyricsLessonSearchResults.innerHTML = "";
    const div = document.createElement("div");
    div.className = "spotify-search-empty";
    div.textContent = message || "No matching lyrics found.";
    lyricsLessonSearchResults.appendChild(div);
    lyricsLessonSearchResults.hidden = false;
    lyricsLessonSearch.setAttribute("aria-expanded", "true");
    lyricsSearchList = [];
    lyricsSearchHighlightIdx = -1;
  }

  function appendLyricsSearchLoadingRow(container) {
    const row = document.createElement("div");
    row.className = "spotify-search-loading";
    row.setAttribute("role", "status");
    row.textContent = "Searching LRCLIB…";
    container.appendChild(row);
  }

  function renderLyricsSearchResults(catalogMatches, lrclibRecords, options) {
    if (!lyricsLessonSearchResults || !lyricsLessonSearch) return;
    const loading = !!(options && options.loading);
    const catalog = catalogMatches || [];
    const lrclib = lrclibRecords || [];
    lyricsLessonSearchResults.innerHTML = "";
    lyricsSearchList = [];
    lyricsSearchHighlightIdx = -1;

    if (!catalog.length && !lrclib.length && !loading) {
      renderLyricsCatalogEmpty();
      return;
    }

    let idx = 0;
    catalog.forEach((song) => {
      const item = { kind: "catalog", entry: song };
      lyricsSearchList.push(item);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "spotify-search-result-btn lyrics-lesson-result-btn";
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", "false");
      const ph = document.createElement("span");
      ph.className = "spotify-search-thumb spotify-search-thumb--placeholder";
      ph.setAttribute("aria-hidden", "true");
      btn.appendChild(ph);
      const textWrap = document.createElement("div");
      textWrap.className = "spotify-search-result-text";
      const titleEl = document.createElement("div");
      titleEl.className = "spotify-search-result-title";
      titleEl.textContent = song.title || song.id || "Untitled";
      const meta = document.createElement("div");
      meta.className = "spotify-search-result-meta";
      meta.textContent = [song.artist || "", "Lesson"].filter(Boolean).join(" · ");
      textWrap.append(titleEl, meta);
      btn.appendChild(textWrap);
      const pickIdx = idx++;
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("mouseenter", () => setLyricsSearchHighlight(pickIdx));
      btn.addEventListener("click", () => applyLyricsSearchPick(item));
      lyricsLessonSearchResults.appendChild(btn);
    });

    lrclib.forEach((record) => {
      const item = { kind: "lrclib", record: record };
      lyricsSearchList.push(item);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "spotify-search-result-btn lyrics-lesson-result-btn";
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", "false");
      const ph = document.createElement("span");
      ph.className = "spotify-search-thumb spotify-search-thumb--placeholder";
      ph.setAttribute("aria-hidden", "true");
      btn.appendChild(ph);
      const textWrap = document.createElement("div");
      textWrap.className = "spotify-search-result-text";
      const titleEl = document.createElement("div");
      titleEl.className = "spotify-search-result-title";
      titleEl.textContent = record.trackName || "Unknown track";
      const meta = document.createElement("div");
      meta.className = "spotify-search-result-meta";
      const dur = Number(record.duration) > 0 ? formatTime(record.duration) : "";
      meta.textContent = [record.artistName || "", record.albumName || "", dur ? "(" + dur + ")" : ""]
        .filter(Boolean)
        .join(" · ");
      textWrap.append(titleEl, meta);
      btn.appendChild(textWrap);
      const pickIdx = idx++;
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("mouseenter", () => setLyricsSearchHighlight(pickIdx));
      btn.addEventListener("click", () => applyLyricsSearchPick(item));
      lyricsLessonSearchResults.appendChild(btn);
    });

    if (loading) appendLyricsSearchLoadingRow(lyricsLessonSearchResults);
    lyricsLessonSearchResults.hidden = false;
    lyricsLessonSearch.setAttribute("aria-expanded", "true");
  }

  function applyLyricsSearchPick(item) {
    if (!item) return;
    if (item.kind === "catalog") applyLyricsLessonPick(item.entry);
    else if (item.kind === "lrclib") applyLrclibSearchPick(item.record);
  }

  function filterLyricsCatalog(needle) {
    const q = needle.trim().toLowerCase();
    if (!q) return [];
    return catalogSongs.filter((s) => {
      const title = (s.title || "").toLowerCase();
      const artist = (s.artist || "").toLowerCase();
      const id = (s.id || "").toLowerCase();
      return title.includes(q) || artist.includes(q) || id.includes(q);
    });
  }

  async function searchLrclib(query) {
    const q = (query || "").trim();
    if (!q) return [];
    const params = new URLSearchParams({ q: q });
    const res = await fetch(LRCLIB_BASE_URL + "/api/search?" + params.toString());
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    if (!Array.isArray(data)) return [];
    return data.slice(0, 12);
  }

  async function runLyricsCatalogQuery(q) {
    const needle = q.trim();
    if (needle.length < 1) {
      hideLyricsSearchResults();
      return;
    }
    const seq = ++lyricsSearchSeq;
    const catalogMatches = filterLyricsCatalog(needle);
    renderLyricsSearchResults(catalogMatches, [], { loading: true });

    let lrclibMatches = [];
    try {
      lrclibMatches = await searchLrclib(needle);
    } catch (e) {
      console.warn(e);
    }
    if (seq !== lyricsSearchSeq) return;
    renderLyricsSearchResults(catalogMatches, lrclibMatches, { loading: false });
  }

  function scheduleLyricsCatalogSearch(q) {
    window.clearTimeout(lyricsSearchTimer);
    lyricsSearchTimer = window.setTimeout(() => {
      runLyricsCatalogQuery(q);
    }, 200);
  }

  function renderLyricsStatus(message, kind) {
    if (!lyricsList) return;
    const li = document.createElement("li");
    li.className = "lyrics-status" + (kind ? " is-" + kind : "");
    li.textContent = message;
    lyricsList.appendChild(li);
  }

  function setLyricsStatus(message, kind) {
    if (!lyricsList) return;
    lyricsList.innerHTML = "";
    renderLyricsStatus(message, kind);
  }

  function getOpenccConverter(script) {
    if (!window.OpenCC || !window.OpenCC.Converter) return null;
    if (!openccConverters[script]) {
      openccConverters[script] =
        script === "traditional"
          ? window.OpenCC.Converter({ from: "cn", to: "tw" })
          : window.OpenCC.Converter({ from: "tw", to: "cn" });
    }
    return openccConverters[script];
  }

  function convertChineseScript(text, script) {
    const raw = text || "";
    const converter = getOpenccConverter(script);
    return converter ? converter(raw) : raw;
  }

  function makePinyin(text, fallback) {
    if (window.pinyinPro && typeof window.pinyinPro.pinyin === "function") {
      try {
        return window.pinyinPro.pinyin(text || "", {
          toneType: "symbol",
          traditional: scriptPreference === "traditional",
        });
      } catch (e) {
        console.warn(e);
      }
    }
    return fallback || "";
  }

  function isHanText(text) {
    return /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(text || "");
  }

  function segmentLyricWords(zhText) {
    const text = zhText || "";
    const pp = window.pinyinPro;
    if (pp && typeof pp.segment === "function" && pp.OutputFormat) {
      try {
        const segments = pp.segment(text, {
          toneType: "symbol",
          traditional: scriptPreference === "traditional",
          format: pp.OutputFormat.AllSegment,
        });
        if (Array.isArray(segments) && segments.length) {
          const words = segments
            .filter((item) => item && item.origin)
            .map((item) => {
              const clickable = isHanText(item.origin);
              return {
                zh: item.origin,
                pinyin: clickable
                  ? makePinyin(item.origin, item.result || "")
                  : "",
                clickable,
              };
            });
          if (words.length) return words;
        }
      } catch (e) {
        console.warn(e);
      }
    }
    return [...text]
      .filter((ch) => isHanText(ch))
      .map((ch) => ({ zh: ch, pinyin: makePinyin(ch), clickable: true }));
  }

  function hideWordPopover() {
    if (!wordPopover) return;
    wordPopover.hidden = true;
    if (activeWordBtn) {
      activeWordBtn.classList.remove("is-active-word");
      activeWordBtn = null;
    }
  }

  function positionWordPopover(anchorEl) {
    if (!wordPopover || !anchorEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const margin = 8;
    wordPopover.hidden = false;
    const popRect = wordPopover.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - popRect.width / 2;
    let top = rect.bottom + margin;
    if (left + popRect.width > window.innerWidth - margin) {
      left = window.innerWidth - popRect.width - margin;
    }
    if (left < margin) left = margin;
    if (top + popRect.height > window.innerHeight - margin) {
      top = rect.top - popRect.height - margin;
    }
    if (top < margin) top = margin;
    wordPopover.style.left = Math.round(left) + "px";
    wordPopover.style.top = Math.round(top) + "px";
  }

  async function lookupWordMeaning(zhText) {
    const text = (zhText || "").trim();
    if (!text) return "";
    const cacheKey = scriptPreference + "|" + text;
    if (wordMeaningCache.has(cacheKey)) return wordMeaningCache.get(cacheKey);

    let meaning = "";
    const sourceLang = getTranslationSourceLanguage();
    if (browserTranslatorSupported() && (await canUseBrowserTranslator(sourceLang))) {
      try {
        const translator = await getBrowserTranslator(sourceLang);
        meaning = ((await translator.translate(text)) || "").trim();
      } catch (e) {
        console.warn(e);
      }
    }
    wordMeaningCache.set(cacheKey, meaning);
    return meaning;
  }

  async function showWordPopover(word, anchorEl) {
    if (!wordPopover || !wordPopoverZh || !wordPopoverPy || !wordPopoverEn || !anchorEl) return;
    if (activeWordBtn) activeWordBtn.classList.remove("is-active-word");
    activeWordBtn = anchorEl;
    anchorEl.classList.add("is-active-word");

    wordPopoverZh.textContent = word.zh;
    wordPopoverPy.textContent = word.pinyin || makePinyin(word.zh);
    wordPopoverEn.textContent = "Translating…";
    positionWordPopover(anchorEl);

    const meaning = await lookupWordMeaning(word.zh);
    if (activeWordBtn !== anchorEl) return;
    wordPopoverEn.textContent = meaning || "Translation unavailable in this browser.";
  }

  function getCharPinyinPairs(zhText, phrasePinyin) {
    const chars = [...(zhText || "")].filter((ch) => isHanText(ch));
    if (!chars.length) return [];
    let syllables = (phrasePinyin || "").trim().split(/\s+/).filter(Boolean);
    if (syllables.length !== chars.length && window.pinyinPro?.pinyin) {
      try {
        syllables = window.pinyinPro.pinyin(zhText, {
          toneType: "symbol",
          traditional: scriptPreference === "traditional",
          type: "array",
        });
      } catch (e) {
        console.warn(e);
      }
    }
    if (!Array.isArray(syllables) || syllables.length !== chars.length) {
      syllables = chars.map((ch) => makePinyin(ch));
    }
    return chars.map((zh, i) => ({ zh, py: syllables[i] || makePinyin(zh) }));
  }

  function buildChineseLineElement(line) {
    const zh = document.createElement("p");
    zh.className = "zh";
    const words = segmentLyricWords(line.zh || "");
    if (!words.length) {
      zh.textContent = line.zh || "";
      return zh;
    }
    words.forEach((word) => {
      if (word.clickable === false) {
        zh.appendChild(document.createTextNode(word.zh));
        return;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "zh-word";
      btn.dataset.zh = word.zh;
      btn.dataset.pinyin = word.pinyin || makePinyin(word.zh);
      btn.setAttribute(
        "aria-label",
        (word.zh.length > 1 ? "Look up phrase " : "Look up ") + word.zh
      );

      const inner = document.createElement("span");
      inner.className = "zh-word-inner";
      getCharPinyinPairs(word.zh, word.pinyin).forEach(({ zh: ch, py }) => {
        const unit = document.createElement("span");
        unit.className = "zh-char";
        const pyEl = document.createElement("span");
        pyEl.className = "zh-char-py";
        pyEl.textContent = py;
        const chEl = document.createElement("span");
        chEl.className = "zh-char-zh";
        chEl.textContent = ch;
        unit.appendChild(pyEl);
        unit.appendChild(chEl);
        inner.appendChild(unit);
      });
      btn.appendChild(inner);

      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        showWordPopover(
          { zh: word.zh, pinyin: btn.dataset.pinyin || makePinyin(word.zh) },
          btn
        );
      });
      zh.appendChild(btn);
    });
    return zh;
  }

  function getTranslationSourceLanguage() {
    return scriptPreference === "traditional" ? "zh-Hant" : "zh";
  }

  function browserTranslatorSupported() {
    return "Translator" in self;
  }

  async function getBrowserTranslatorAvailability(sourceLang) {
    if (!browserTranslatorSupported()) return "unavailable";
    try {
      return await Translator.availability({
        sourceLanguage: sourceLang,
        targetLanguage: "en",
      });
    } catch (e) {
      console.warn(e);
      return "unavailable";
    }
  }

  async function canUseBrowserTranslator(sourceLang) {
    const availability = await getBrowserTranslatorAvailability(sourceLang);
    return (
      availability === "available" ||
      availability === "downloadable" ||
      availability === "downloading"
    );
  }

  async function getBrowserTranslator(sourceLang, onProgress) {
    if (browserTranslator && browserTranslatorSourceLang === sourceLang) {
      return browserTranslator;
    }
    browserTranslator = null;
    browserTranslatorSourceLang = "";
    const translator = await Translator.create({
      sourceLanguage: sourceLang,
      targetLanguage: "en",
      monitor(m) {
        if (!onProgress) return;
        m.addEventListener("downloadprogress", (e) => {
          onProgress({ phase: "download", loaded: e.loaded });
        });
      },
    });
    browserTranslator = translator;
    browserTranslatorSourceLang = sourceLang;
    return translator;
  }

  async function translateLinesWithBrowser(lines, onProgress) {
    if (!lines.length) return null;
    const sourceLang = getTranslationSourceLanguage();
    if (!(await canUseBrowserTranslator(sourceLang))) return null;

    let translator;
    try {
      translator = await getBrowserTranslator(sourceLang, onProgress);
    } catch (e) {
      console.warn(e);
      browserTranslator = null;
      browserTranslatorSourceLang = "";
      return null;
    }

    const translated = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || !String(line).trim()) {
        translated.push("");
        continue;
      }
      try {
        translated.push((await translator.translate(line)) || "");
      } catch (e) {
        console.warn(e);
        translated.push("");
      }
      if (onProgress) {
        onProgress({ phase: "lines", index: i + 1, total: lines.length });
      }
    }
    return translated;
  }

  function reportBrowserTranslationProgress(update) {
    if (update.phase === "download" && typeof update.loaded === "number") {
      setLyricsStatus(
        "Downloading Chrome translation model… " + Math.round(update.loaded * 100) + "%",
        "loading"
      );
      return;
    }
    if (update.phase === "lines" && update.total) {
      setLyricsStatus("Translating lyrics… " + update.index + "/" + update.total, "loading");
    }
  }

  function parseLrcTime(stamp) {
    const m = String(stamp || "").match(/(\d+):(\d{2})(?:[.:](\d{1,3}))?/);
    if (!m) return 0;
    const min = Number(m[1]) || 0;
    const sec = Number(m[2]) || 0;
    const fracRaw = m[3] || "0";
    const frac = Number(fracRaw.padEnd(3, "0").slice(0, 3)) / 1000;
    return min * 60 + sec + frac;
  }

  function parseSyncedLyrics(lrc, durationSec) {
    const entries = [];
    String(lrc || "")
      .split(/\r?\n/)
      .forEach((row) => {
        const stamps = [...row.matchAll(/\[(\d+:\d{2}(?:[.:]\d{1,3})?)\]/g)];
        if (!stamps.length) return;
        const text = row.replace(/\[(\d+:\d{2}(?:[.:]\d{1,3})?)\]/g, "").trim();
        stamps.forEach((stamp) => {
          entries.push({ start: parseLrcTime(stamp[1]), text: text });
        });
      });
    entries.sort((a, b) => a.start - b.start);
    const timed = entries.filter((entry) => entry.text);
    return timed.map((entry, i) => {
      const next = timed[i + 1];
      const fallbackEnd =
        Number.isFinite(durationSec) && durationSec > entry.start
          ? durationSec
          : entry.start + 4;
      return {
        start: entry.start,
        end: next ? Math.max(next.start, entry.start + 0.1) : fallbackEnd,
        text: entry.text,
      };
    });
  }

  function parsePlainLyrics(plain) {
    return String(plain || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((text) => ({ start: 0, end: 0, text: text }));
  }

  function makeSourceFromLyricJson(data, cacheKey) {
    return {
      kind: "catalog",
      cacheKey: cacheKey,
      title: data.title || "singchinese",
      titleEn: data.titleEn || "",
      artist: data.artist || "",
      synced: true,
      lines: (data.lines || []).map((line) => ({
        start: Number(line.start) || 0,
        end: Number(line.end) || 0,
        text: line.zh || "",
        pinyin: line.pinyin || "",
        en: line.en || "",
      })),
    };
  }

  async function processLyricSource(source) {
    if (!source) return null;
    const cacheKey = [source.cacheKey, scriptPreference, "browser-translator"].join("|");
    if (lineProcessCache.has(cacheKey)) return lineProcessCache.get(cacheKey);

    const displayTexts = source.lines.map((line) =>
      convertChineseScript(line.text || "", scriptPreference)
    );
    let english = source.lines.map((line) => line.en || "");
    let translationUnavailable = false;

    if (source.kind === "lrclib" && displayTexts.length) {
      if (browserTranslatorSupported()) {
        const translated = await translateLinesWithBrowser(displayTexts, reportBrowserTranslationProgress);
        if (translated && translated.some((line) => line && line.trim())) {
          english = translated;
        } else {
          translationUnavailable = true;
          english = displayTexts.map(() => "");
        }
      } else {
        translationUnavailable = true;
        english = displayTexts.map(() => "");
      }
    }

    const processed = {
      title: convertChineseScript(source.title || "singchinese", scriptPreference),
      titleEn: source.titleEn || "",
      artist: source.artist || "",
      synced: !!source.synced,
      translationUnavailable: translationUnavailable,
      lines: source.lines.map((line, i) => ({
        start: line.start,
        end: line.end,
        zh: displayTexts[i],
        pinyin: makePinyin(displayTexts[i], line.pinyin),
        en: english[i] || "",
      })),
    };
    lineProcessCache.set(cacheKey, processed);
    return processed;
  }

  async function renderLyricSource(source) {
    lyricSource = source;
    lyricData = await processLyricSource(source);
    renderLyrics();
    const dur = lyricsDuration();
    updateUiTime(0, dur);
    seek.value = "0";
  }

  async function fetchLrclibLyrics(track) {
    const duration = Math.round((track.durationMs || 0) / 1000);
    const params = new URLSearchParams({
      track_name: track.name || "",
      artist_name: track.artists || "",
      album_name: track.albumName || "",
      duration: String(duration),
    });
    const res = await fetch(LRCLIB_BASE_URL + "/api/get?" + params.toString());
    if (res.status === 404) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error((data && data.message) || "LRCLIB lookup failed");
    }
    return data;
  }

  async function fetchLrclibById(lrclibId) {
    const id = String(lrclibId || "").trim();
    if (!id) return null;
    const res = await fetch(LRCLIB_BASE_URL + "/api/get/" + encodeURIComponent(id));
    if (res.status === 404) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error((data && data.message) || "LRCLIB lookup failed");
    }
    return data;
  }

  async function loadLrclibFromCatalogEntry(entry) {
    if (!entry || entry.lrclibId == null || entry.lrclibId === "") return false;
    const seq = ++lrclibSeq;
    setLyricsStatus("Loading lyrics…", "loading");
    try {
      const record = await fetchLrclibById(entry.lrclibId);
      if (seq !== lrclibSeq) return false;
      if (!record) return false;
      await renderLrclibRecord(record, {
        name: entry.title || record.trackName,
        artists: entry.artist || record.artistName,
        durationMs: (Number(record.duration) || 0) * 1000,
      });
      return true;
    } catch (e) {
      if (seq !== lrclibSeq) return false;
      console.warn(e);
      setLyricsStatus(
        "Could not load LRCLIB lyrics: " + (e && e.message ? e.message : String(e)),
        "error"
      );
      return false;
    }
  }

  async function renderLrclibRecord(record, fallback) {
    const fb = fallback || {};
    if (!record || record.instrumental) {
      lyricData = {
        title: fb.name || record.trackName || "singchinese",
        titleEn: "",
        artist: fb.artists || record.artistName || "",
        lines: [],
        synced: false,
      };
      lyricSource = null;
      updateLyricsSelectedRow();
      setLyricsStatus(
        record && record.instrumental
          ? "LRCLIB marks this track as instrumental."
          : "No LRCLIB lyrics found for this track.",
        "error"
      );
      return;
    }
    const durationSec =
      Number(record.duration) ||
      (fb.durationMs ? Math.round(fb.durationMs / 1000) : 0);
    const hasSynced = !!(record.syncedLyrics && record.syncedLyrics.trim());
    const rawLines = hasSynced
      ? parseSyncedLyrics(record.syncedLyrics, durationSec)
      : parsePlainLyrics(record.plainLyrics);
    if (!rawLines.length) {
      lyricData = {
        title: record.trackName || fb.name || "singchinese",
        titleEn: "",
        artist: record.artistName || fb.artists || "",
        lines: [],
        synced: false,
      };
      lyricSource = null;
      updateLyricsSelectedRow();
      setLyricsStatus("LRCLIB returned lyrics, but no readable lyric lines were found.", "error");
      return;
    }
    const source = {
      kind: "lrclib",
      cacheKey: "lrclib:" + (record.id || fb.name || record.trackName),
      title: record.trackName || fb.name || "singchinese",
      titleEn: "",
      artist: record.artistName || fb.artists || "",
      synced: hasSynced,
      lines: rawLines,
    };
    setLyricsStatus(
      hasSynced ? "Preparing pinyin and translation…" : "Preparing unsynchronized lyrics…",
      "loading"
    );
    await renderLyricSource(source);
  }

  async function loadLrclibLyricsForTrack(track) {
    if (!track) return;
    const seq = ++lrclibSeq;
    setLyricsStatus("Looking up synchronized lyrics…", "loading");
    try {
      const record = await fetchLrclibLyrics(track);
      if (seq !== lrclibSeq) return;
      await renderLrclibRecord(record, {
        name: track.name,
        artists: track.artists,
        durationMs: track.durationMs,
      });
    } catch (e) {
      if (seq !== lrclibSeq) return;
      console.warn(e);
      lyricData = {
        title: track.name || "singchinese",
        titleEn: "",
        artist: track.artists || "",
        lines: [],
        synced: false,
      };
      lyricSource = null;
      updateLyricsSelectedRow();
      setLyricsStatus(
        "Could not load LRCLIB lyrics: " + (e && e.message ? e.message : String(e)),
        "error"
      );
    }
  }

  async function applyLrclibSearchPick(record) {
    if (!record) return;
    window.clearTimeout(lyricsSearchTimer);
    hideLyricsSearchResults();
    if (lyricsLessonSearch) lyricsLessonSearch.value = "";
    hideWordPopover();
    pauseAll();
    setMode("idle");
    expectedSpotifyUri = "";
    const seq = ++lrclibSeq;
    setLyricsStatus("Loading lyrics…", "loading");
    try {
      await renderLrclibRecord(record, {
        name: record.trackName,
        artists: record.artistName,
        durationMs: (Number(record.duration) || 0) * 1000,
      });
    } catch (e) {
      if (seq !== lrclibSeq) return;
      console.warn(e);
      setLyricsStatus(
        "Could not load LRCLIB lyrics: " + (e && e.message ? e.message : String(e)),
        "error"
      );
    }
  }

  async function applyLyricsLessonPick(entry) {
    if (!entry) return;
    window.clearTimeout(lyricsSearchTimer);
    hideLyricsSearchResults();
    if (lyricsLessonSearch) lyricsLessonSearch.value = "";
    pauseAll();
    setMode("idle");
    expectedSpotifyUri = "";
    catalogLessonId = entry.id || entry.lyricsUrl || "default";
    catalogDefaultTrackId =
      entry.spotifyTrackId != null ? String(entry.spotifyTrackId).trim() : "";
    if (entry.lrclibId != null && entry.lrclibId !== "") {
      hideWordPopover();
      const loaded = await loadLrclibFromCatalogEntry(entry);
      if (loaded) {
        updateSelectedTrackRow();
        updateSpotifyUi();
        return;
      }
    }
    if (!entry.lyricsUrl) return;
    try {
      await loadLyrics(entry.lyricsUrl);
    } catch (e) {
      console.error(e);
      lyricsList.innerHTML =
        "<li class='lyric-line'><p class='en'>Could not load lyrics file.</p></li>";
      return;
    }
    updateSelectedTrackRow();
    updateSpotifyUi();
  }

  function updateLyricsSelectedRow() {
    if (!lyricsSelectedRow || !lyricsSelectedLabel) return;
    const entry = catalogSongs.find((s) => s.id === catalogLessonId);
    const dynamicLabel =
      lyricData && lyricSource && lyricSource.kind === "lrclib"
        ? lyricData.title || lyricData.titleEn
        : "";
    const emptyDynamicLabel =
      lyricData && !lyricData.lines.length ? lyricData.title || lyricData.titleEn : "";
    const label =
      dynamicLabel ||
      emptyDynamicLabel ||
      (entry && entry.title) ||
      (lyricData && (lyricData.title || lyricData.titleEn)) ||
      catalogLessonId;
    if (label) {
      lyricsSelectedLabel.textContent = label;
      lyricsSelectedRow.hidden = false;
    } else {
      lyricsSelectedLabel.textContent = "";
      lyricsSelectedRow.hidden = true;
    }
  }

  function formatPickLabel(track) {
    const dur = formatTime((track.durationMs || 0) / 1000);
    return `${track.name} — ${track.artists || "Unknown"} (${dur})`;
  }

  function normalizeTrackId(raw) {
    if (!raw) return "";
    const trimmed = String(raw).trim();
    if (trimmed.indexOf("spotify:track:") === 0) {
      return trimmed.slice("spotify:track:".length);
    }
    const open = trimmed.match(/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?track\/([a-zA-Z0-9]+)/);
    if (open) return open[1];
    return trimmed;
  }

  function parsePickLabel(label) {
    if (!label) return null;
    const match = String(label).match(/^(.+) — (.+) \((\d+:\d{2})\)$/);
    if (!match) return null;
    const parts = match[3].split(":");
    const durationMs = (Number(parts[0]) * 60 + Number(parts[1])) * 1000;
    return {
      name: match[1],
      artists: match[2],
      albumName: "",
      durationMs: Number.isFinite(durationMs) ? durationMs : 0,
    };
  }

  async function resolveSongSpotTrack() {
    const trackId = getEffectiveSpotifyTrackId();
    if (!trackId) return null;
    const pick = loadStoredTrackPick(getSelectedSongId());
    const id = normalizeTrackId(pick.rawId || trackId);
    if (pick.name) {
      return {
        id: id,
        name: pick.name,
        artists: pick.artists || "",
        albumName: pick.albumName || "",
        durationMs: pick.durationMs || 0,
      };
    }
    if (Sp && Sp.isLoggedIn() && Sp.getTrack) {
      const fetched = await Sp.getTrack(id);
      if (fetched) return fetched;
    }
    const parsed = pick.label ? parsePickLabel(pick.label) : null;
    if (parsed) {
      return {
        id: id,
        name: parsed.name,
        artists: parsed.artists,
        albumName: parsed.albumName,
        durationMs: parsed.durationMs,
      };
    }
    return null;
  }

  async function syncPlaybackPositionToSongSpot() {
    if (!Sp || !Sp.isLoggedIn() || !getEffectiveSpotifyTrackId() || !Sp.getRemotePlayback) return;
    try {
      const remote = await Sp.getRemotePlayback();
      if (!remote || !remote.item) return;
      const wantId = normalizeTrackId(getEffectiveSpotifyTrackId());
      if (remote.item.id !== wantId) return;
      lastSpotifyTimeSec = (remote.progress_ms || 0) / 1000;
      lastSpotifyDurationSec = (remote.item.duration_ms || 0) / 1000;
      previewTimeSec = lastSpotifyTimeSec;
      expectedSpotifyUri = Sp.uriFromTrackId(wantId);
      updateUiTime(lastSpotifyTimeSec, lastSpotifyDurationSec);
      highlightLyrics(lastSpotifyTimeSec);
    } catch (e) {
      console.warn(e);
    }
  }

  async function syncLyricsToSongSpot(catalogPrimary) {
    const trackId = getEffectiveSpotifyTrackId();
    if (trackId) {
      const track = await resolveSongSpotTrack();
      if (track) {
        await loadLrclibLyricsForTrack(track);
        await syncPlaybackPositionToSongSpot();
        return;
      }
    }
    if (catalogPrimary && catalogPrimary.lrclibId != null && catalogPrimary.lrclibId !== "") {
      const loaded = await loadLrclibFromCatalogEntry(catalogPrimary);
      if (loaded) return;
    }
    if (catalogPrimary && catalogPrimary.lyricsUrl) {
      await loadLyrics(catalogPrimary.lyricsUrl);
    }
  }

  function updateSelectedTrackRow() {
    const pick = loadStoredTrackPick(getSelectedSongId());
    if (!spotifySelectedRow || !spotifySelectedLabel) return;
    if (pick.rawId && pick.label) {
      spotifySelectedLabel.textContent = pick.label;
      spotifySelectedRow.hidden = false;
    } else if (pick.rawId) {
      spotifySelectedLabel.textContent = pick.rawId;
      spotifySelectedRow.hidden = false;
    } else {
      spotifySelectedLabel.textContent = "";
      spotifySelectedRow.hidden = true;
    }
  }

  function setSearchHighlight(idx) {
    if (!spotifySearchResults) return;
    const btns = spotifySearchResults.querySelectorAll(".spotify-search-result-btn");
    searchHighlightIdx = idx;
    btns.forEach((b, i) => {
      b.classList.toggle("is-highlighted", i === idx);
      b.setAttribute("aria-selected", i === idx ? "true" : "false");
    });
    if (idx >= 0 && btns[idx]) {
      btns[idx].scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  async function applyTrackPick(track) {
    saveStoredTrackPick(getSelectedSongId(), track);
    if (spotifyTrackSearch) spotifyTrackSearch.value = "";
    hideTrackSearchResults();
    updateSelectedTrackRow();
    updateSpotifyUi();
    loadLrclibLyricsForTrack(track).catch((e) => {
      console.warn(e);
    });

    if (!lyricData || !canStartSpotifyPlayback()) return;

    pauseAll();
    try {
      await startSpotifyPlayback({ restartFromStart: true });
    } catch (e) {
      console.error(e);
      if (spotifyHint) {
        spotifyHint.textContent =
          (e && e.message) ||
          "Could not play (Premium required for Web Playback; pick another recording if needed).";
      }
      pauseAll();
      setMode("idle");
      updateUiTime(previewTimeSec, mediaDuration());
    }
  }

  function showTrackSearchLoading() {
    if (!spotifySearchResults || !spotifyTrackSearch) return;
    spotifySearchResults.innerHTML = "";
    const row = document.createElement("div");
    row.className = "spotify-search-loading";
    row.setAttribute("role", "status");
    row.textContent = "Searching…";
    spotifySearchResults.appendChild(row);
    spotifySearchResults.hidden = false;
    spotifyTrackSearch.setAttribute("aria-expanded", "true");
    searchResultsTracks = [];
    searchHighlightIdx = -1;
  }

  function renderTrackSearchEmpty(message) {
    if (!spotifySearchResults || !spotifyTrackSearch) return;
    spotifySearchResults.innerHTML = "";
    const div = document.createElement("div");
    div.className = "spotify-search-empty";
    div.textContent = message || "No results found.";
    spotifySearchResults.appendChild(div);
    spotifySearchResults.hidden = false;
    spotifyTrackSearch.setAttribute("aria-expanded", "true");
    searchResultsTracks = [];
    searchHighlightIdx = -1;
  }

  function renderTrackSearchResults(tracks) {
    if (!spotifySearchResults || !spotifyTrackSearch) return;
    spotifySearchResults.innerHTML = "";
    searchResultsTracks = tracks.slice();
    searchHighlightIdx = -1;
    if (!tracks.length) {
      renderTrackSearchEmpty();
      return;
    }
    tracks.forEach((track, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "spotify-search-result-btn";
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", "false");

      if (track.albumArtUrl) {
        const img = document.createElement("img");
        img.className = "spotify-search-thumb";
        img.src = track.albumArtUrl;
        img.alt = "";
        img.loading = "lazy";
        img.decoding = "async";
        btn.appendChild(img);
      } else {
        const ph = document.createElement("span");
        ph.className = "spotify-search-thumb spotify-search-thumb--placeholder";
        ph.setAttribute("aria-hidden", "true");
        btn.appendChild(ph);
      }

      const textWrap = document.createElement("div");
      textWrap.className = "spotify-search-result-text";
      const titleEl = document.createElement("div");
      titleEl.className = "spotify-search-result-title";
      titleEl.textContent = track.name;
      const meta = document.createElement("div");
      meta.className = "spotify-search-result-meta";
      meta.textContent = track.artists || "";
      textWrap.append(titleEl, meta);

      const dur = document.createElement("span");
      dur.className = "spotify-search-duration";
      dur.textContent = formatTime((track.durationMs || 0) / 1000);

      btn.append(textWrap, dur);

      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
      });
      btn.addEventListener("mouseenter", () => setSearchHighlight(i));
      btn.addEventListener("click", () => applyTrackPick(track));
      spotifySearchResults.appendChild(btn);
    });
    spotifySearchResults.hidden = false;
    spotifyTrackSearch.setAttribute("aria-expanded", "true");
  }

  async function runTrackSearchQuery(q) {
    const needle = q.trim();
    if (needle.length < 1) {
      hideTrackSearchResults();
      return;
    }
    if (!Sp || !Sp.isLoggedIn()) return;
    const seq = ++trackSearchSeq;
    showTrackSearchLoading();
    try {
      const tracks = await Sp.searchTracks(needle, 10);
      if (seq !== trackSearchSeq) return;
      renderTrackSearchResults(tracks);
    } catch (e) {
      if (seq !== trackSearchSeq) return;
      console.warn(e);
      hideTrackSearchResults();
      if (spotifyHint) {
        spotifyHint.textContent =
          "Search failed: " + (e && e.message ? e.message : String(e));
      }
    }
  }

  function scheduleTrackSearch(q) {
    window.clearTimeout(trackSearchTimer);
    trackSearchTimer = window.setTimeout(() => {
      runTrackSearchQuery(q);
    }, 200);
  }

  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ":" + String(s).padStart(2, "0");
  }

  function canStartSpotifyPlayback() {
    return !!(Sp && Sp.isLoggedIn() && getEffectiveSpotifyTrackId());
  }

  function lyricsDuration() {
    if (!lyricData || !lyricData.lines.length) return 0;
    if (lyricData.synced === false) return 0;
    return Math.max(...lyricData.lines.map((l) => l.end));
  }

  function mediaDuration() {
    if (mode === "spotify" && lastSpotifyDurationSec > 0) {
      return lastSpotifyDurationSec;
    }
    return lyricsDuration();
  }

  function skipBy(deltaSec) {
    if (!lyricData) return;
    const dur = mediaDuration();
    let next;
    if (mode === "spotify" && Sp) {
      next = lastSpotifyTimeSec + deltaSec;
      if (dur > 0) next = Math.min(next, dur);
      next = Math.max(0, next);
      clearTimeout(seekSpotifyTimer);
      Sp.seekMs(next * 1000).catch(() => {});
      lastSpotifyTimeSec = next;
      updateUiTime(next, dur > 0 ? dur : Math.max(next, 0.001));
      highlightLyrics(next);
      return;
    }
    next = previewTimeSec + deltaSec;
    if (dur > 0) next = Math.min(next, dur);
    next = Math.max(0, next);
    previewTimeSec = next;
    updateUiTime(next, dur > 0 ? dur : Math.max(next, 0.001));
    highlightLyrics(next);
  }

  function setMode(next) {
    mode = next;
    if (next === "spotify") {
      modeBadge.textContent = "Spotify";
    } else {
      modeBadge.textContent = "Ready";
    }
  }

  function stopSpotifyLoop() {
    if (spotifyRafId) {
      cancelAnimationFrame(spotifyRafId);
      spotifyRafId = 0;
    }
  }

  function pauseAll() {
    stopSpotifyLoop();
    if (mode === "spotify" && Sp) {
      Sp.pausePlayback().catch(() => {});
    }
    playBtn.classList.remove("is-playing");
    playBtn.setAttribute("aria-pressed", "false");
  }

  function highlightLyrics(t) {
    if (!lyricData) return;
    const lines = lyricsList.querySelectorAll(".lyric-line");
    if (lyricData.synced === false) {
      lines.forEach((el) => el.classList.remove("is-active", "is-past", "is-future"));
      lastActiveLine = -1;
      return;
    }
    let activeIndex = -1;
    lyricData.lines.forEach((line, i) => {
      const el = lines[i];
      if (!el) return;
      el.classList.remove("is-active", "is-past", "is-future");
      if (t >= line.end) {
        el.classList.add("is-past");
      } else if (t < line.start) {
        el.classList.add("is-future");
      } else {
        el.classList.add("is-active");
        activeIndex = i;
      }
    });
    if (activeIndex >= 0 && activeIndex !== lastActiveLine) {
      lastActiveLine = activeIndex;
      lines[activeIndex].scrollIntoView({ block: "center", behavior: "smooth" });
    } else if (activeIndex < 0) {
      lastActiveLine = -1;
    }
  }

  function updateUiTime(current, duration) {
    timeCurrent.textContent = formatTime(current);
    timeTotal.textContent = formatTime(duration);
    const max = Math.max(duration, 0.001);
    seek.value = String(Math.round((current / max) * 1000));
  }

  function spotifyLoop() {
    if (mode !== "spotify" || !Sp) return;
    Sp.getPlaybackState()
      .then((state) => {
        if (mode !== "spotify") return;
        if (state) {
          lastSpotifyTimeSec = state.position / 1000;
          lastSpotifyDurationSec = state.duration / 1000;
          updateUiTime(lastSpotifyTimeSec, lastSpotifyDurationSec);
          highlightLyrics(lastSpotifyTimeSec);
          if (!state.paused) {
            playBtn.classList.add("is-playing");
            playBtn.setAttribute("aria-pressed", "true");
          } else {
            playBtn.classList.remove("is-playing");
            playBtn.setAttribute("aria-pressed", "false");
          }
        }
        if (mode === "spotify") {
          spotifyRafId = requestAnimationFrame(spotifyLoop);
        }
      })
      .catch(() => {
        if (mode === "spotify") {
          spotifyRafId = requestAnimationFrame(spotifyLoop);
        }
      });
  }

  function startSpotifyLoop() {
    stopSpotifyLoop();
    spotifyRafId = requestAnimationFrame(spotifyLoop);
  }

  async function startSpotifyPlayback(options) {
    const restartFromStart = !!(options && options.restartFromStart);
    if (!Sp) throw new Error("Spotify module not loaded");
    const raw = getEffectiveSpotifyTrackId();
    if (!raw) throw new Error("Search for a track or set spotifyTrackId in songs.json");
    const uri = Sp.uriFromTrackId(raw);
    expectedSpotifyUri = uri;
    setMode("spotify");
    if (restartFromStart) {
      lastSpotifyTimeSec = 0;
      updateUiTime(0, mediaDuration());
    }
    await Sp.ensurePlayer();
    const state = await Sp.getPlaybackState();
    const currentUri =
      state &&
      state.track_window &&
      state.track_window.current_track &&
      state.track_window.current_track.uri;
    const sameTrack = currentUri === uri;
    const explicitlyPaused = !!(state && state.paused);
    if (!restartFromStart && sameTrack && explicitlyPaused) {
      await Sp.resumePlayback();
    } else {
      await Sp.playTrackUri(uri, restartFromStart ? 0 : undefined);
    }
    playBtn.classList.add("is-playing");
    playBtn.setAttribute("aria-pressed", "true");
    startSpotifyLoop();
  }

  playBtn.addEventListener("click", async () => {
    if (!lyricData) return;
    const isPlayingUi = playBtn.classList.contains("is-playing");
    if (isPlayingUi) {
      pauseAll();
      return;
    }

    if (!canStartSpotifyPlayback()) {
      if (spotifyHint) {
        if (!Sp || !Sp.isLoggedIn()) {
          spotifyHint.textContent = "Sign in (header button), then search for a track.";
        } else {
          spotifyHint.textContent = "";
        }
      }
      if (!Sp || !Sp.isLoggedIn()) {
        spotifyLoginBtn && spotifyLoginBtn.focus();
      } else if (spotifyTrackSearch && !spotifyTrackSearch.disabled) {
        spotifyTrackSearch.focus();
      }
      return;
    }

    // Same track still paused — resume only (avoid playTrackUri restarting from 0).
    if (mode === "spotify" && Sp) {
      const wantUri = Sp.uriFromTrackId(getEffectiveSpotifyTrackId());
      try {
        const st = await Sp.getPlaybackState();
        const curUri =
          st &&
          st.track_window &&
          st.track_window.current_track &&
          st.track_window.current_track.uri;
        if (curUri === wantUri && st && st.paused) {
          await Sp.resumePlayback();
          playBtn.classList.add("is-playing");
          playBtn.setAttribute("aria-pressed", "true");
          startSpotifyLoop();
          return;
        }
      } catch (e) {
        console.warn(e);
      }
    }

    try {
      await startSpotifyPlayback();
    } catch (e) {
      console.error(e);
      if (spotifyHint) {
        spotifyHint.textContent =
          (e && e.message) ||
          "Could not play (Premium required for Web Playback; pick another recording if needed).";
      }
      pauseAll();
      setMode("idle");
      updateUiTime(previewTimeSec, mediaDuration());
    }
  });

  seek.addEventListener("input", () => {
    const dur = mediaDuration();
    const t = (Number(seek.value) / 1000) * dur;
    if (mode === "spotify" && Sp) {
      clearTimeout(seekSpotifyTimer);
      seekSpotifyTimer = window.setTimeout(() => {
        Sp.seekMs(t * 1000).catch(() => {});
      }, 120);
      lastSpotifyTimeSec = t;
      updateUiTime(t, dur);
      highlightLyrics(t);
      return;
    }
    previewTimeSec = t;
    updateUiTime(t, dur);
    highlightLyrics(t);
  });

  if (skipBackBtn) {
    skipBackBtn.addEventListener("click", () => skipBy(-SKIP_SEC));
  }
  if (skipForwardBtn) {
    skipForwardBtn.addEventListener("click", () => skipBy(SKIP_SEC));
  }

  if (wordPopoverClose) {
    wordPopoverClose.addEventListener("click", (e) => {
      e.stopPropagation();
      hideWordPopover();
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideWordPopover();
  });

  const lyricsScroll = $("lyricsScroll");
  if (lyricsScroll) {
    lyricsScroll.addEventListener("scroll", hideWordPopover, { passive: true });
  }

  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof Node)) return;
    if (wordPopover && !wordPopover.hidden) {
      const inPopover = wordPopover.contains(t);
      const onWord = t instanceof Element && t.closest(".zh-word");
      if (!inPopover && !onWord) hideWordPopover();
    }
    if (spotifySearchResults && !spotifySearchResults.hidden) {
      const wrap =
        spotifyTrackSearch && spotifyTrackSearch.closest(".spotify-search-field");
      if (!(wrap && wrap.contains(t))) hideTrackSearchResults();
    }
    if (lyricsLessonSearchResults && !lyricsLessonSearchResults.hidden) {
      const wrap =
        lyricsLessonSearch && lyricsLessonSearch.closest(".spotify-search-field");
      if (!(wrap && wrap.contains(t))) hideLyricsSearchResults();
    }
  });

  if (spotifyTrackSearch) {
    spotifyTrackSearch.addEventListener("input", () => {
      const q = spotifyTrackSearch.value;
      if (q.trim().length < 1) {
        hideTrackSearchResults();
        return;
      }
      scheduleTrackSearch(q);
    });
    spotifyTrackSearch.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        hideTrackSearchResults();
        return;
      }
      const open = spotifySearchResults && !spotifySearchResults.hidden;
      const n = searchResultsTracks.length;
      if (!open || n === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next =
          searchHighlightIdx < 0 ? 0 : Math.min(searchHighlightIdx + 1, n - 1);
        setSearchHighlight(next);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (searchHighlightIdx <= 0) setSearchHighlight(-1);
        else setSearchHighlight(searchHighlightIdx - 1);
      } else if (e.key === "Enter" && searchHighlightIdx >= 0) {
        e.preventDefault();
        const picked = searchResultsTracks[searchHighlightIdx];
        if (picked) applyTrackPick(picked);
      }
    });
    spotifyTrackSearch.addEventListener("focus", () => {
      const q = spotifyTrackSearch.value.trim();
      if (q.length >= 1) scheduleTrackSearch(spotifyTrackSearch.value);
    });
  }

  if (lyricsLessonSearch) {
    lyricsLessonSearch.addEventListener("input", () => {
      const q = lyricsLessonSearch.value;
      if (q.trim().length < 1) {
        hideLyricsSearchResults();
        return;
      }
      scheduleLyricsCatalogSearch(q);
    });
    lyricsLessonSearch.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        hideLyricsSearchResults();
        return;
      }
      const open = lyricsLessonSearchResults && !lyricsLessonSearchResults.hidden;
      const n = lyricsSearchList.length;
      if (!open || n === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next =
          lyricsSearchHighlightIdx < 0 ? 0 : Math.min(lyricsSearchHighlightIdx + 1, n - 1);
        setLyricsSearchHighlight(next);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (lyricsSearchHighlightIdx <= 0) setLyricsSearchHighlight(-1);
        else setLyricsSearchHighlight(lyricsSearchHighlightIdx - 1);
      } else if (e.key === "Enter" && lyricsSearchHighlightIdx >= 0) {
        e.preventDefault();
        const picked = lyricsSearchList[lyricsSearchHighlightIdx];
        if (picked) applyLyricsSearchPick(picked);
      }
    });
    lyricsLessonSearch.addEventListener("focus", () => {
      const q = lyricsLessonSearch.value.trim();
      if (q.length >= 1) runLyricsCatalogQuery(lyricsLessonSearch.value);
    });
  }

  [scriptSimplifiedBtn, scriptTraditionalBtn].forEach((btn) => {
    if (!btn) return;
    btn.addEventListener("click", async () => {
      const next = btn.dataset.script === "traditional" ? "traditional" : "simplified";
      if (next === scriptPreference) return;
      saveScriptPreference(next);
      if (!lyricSource) return;
      setLyricsStatus("Updating lyric script…", "loading");
      try {
        await renderLyricSource(lyricSource);
      } catch (e) {
        console.warn(e);
        setLyricsStatus(
          "Could not update lyric script: " + (e && e.message ? e.message : String(e)),
          "error"
        );
      }
    });
  });

  if (spotifyClearTrackBtn) {
    spotifyClearTrackBtn.addEventListener("click", () => {
      saveStoredTrackPick(getSelectedSongId(), "", "");
      updateSelectedTrackRow();
      updateSpotifyUi();
      if (spotifyTrackSearch && !spotifyTrackSearch.disabled) spotifyTrackSearch.focus();
    });
  }

  function renderLyrics() {
    lastActiveLine = -1;
    hideWordPopover();
    lyricsList.innerHTML = "";
    if (!lyricData) return;
    if (lyricData.translationUnavailable) {
      renderLyricsStatus(
        "English translation needs Chrome's built-in Translator (desktop Chrome 138+). Chinese and pinyin still work.",
        "error"
      );
    }
    if (lyricData.synced === false && lyricData.lines.length) {
      renderLyricsStatus("Plain lyrics only — line timing is unavailable.", "error");
    }
    lyricData.lines.forEach((line) => {
      const li = document.createElement("li");
      li.className = "lyric-line";
      if (line.en) {
        const en = document.createElement("p");
        en.className = "en";
        en.textContent = line.en;
        li.appendChild(en);
      }
      li.appendChild(buildChineseLineElement(line));
      lyricsList.appendChild(li);
    });
    const titleZh = lyricData.title || "singchinese";
    const titleEn = lyricData.titleEn ? ` (${lyricData.titleEn})` : "";
    document.title = `${titleZh}${titleEn} — singchinese`;
    previewTimeSec = 0;
    highlightLyrics(0);
    updateLyricsSelectedRow();
  }

  async function loadLyrics(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Failed to load lyrics");
    const data = await res.json();
    await renderLyricSource(makeSourceFromLyricJson(data, "catalog:" + url));
  }

  function applySpotifyAuthChrome(loggedIn) {
    if (spotifyLoginBtn) spotifyLoginBtn.hidden = loggedIn;
    if (spotifySessionRow) spotifySessionRow.hidden = !loggedIn;
  }

  function syncSpotifySetupBanner() {
    if (!spotifySetupBanner || !Sp) return;
    const hasId = !!Sp.getClientId();
    spotifySetupBanner.hidden = hasId;
    if (setupBannerRedirect) setupBannerRedirect.textContent = Sp.redirectUri();
  }

  async function refreshSpotifyAuthUi() {
    if (!Sp || !spotifyLoginBtn || !spotifySessionRow) return;
    try {
      if (!Sp.isLoggedIn()) {
        cachedSpotifyMe = null;
        applySpotifyAuthChrome(false);
        if (spotifyDisplayName) spotifyDisplayName.textContent = "";
        if (spotifyPremiumBadge) spotifyPremiumBadge.hidden = true;
        return;
      }
      applySpotifyAuthChrome(true);
      cachedSpotifyMe = await Sp.getCurrentUser();
      if (spotifyDisplayName) {
        if (cachedSpotifyMe) {
          spotifyDisplayName.textContent =
            cachedSpotifyMe.display_name || cachedSpotifyMe.id || "listener";
        } else {
          spotifyDisplayName.textContent = "listener";
        }
      }
      applyPremiumFromMe(cachedSpotifyMe);
    } finally {
      syncSpotifySetupBanner();
    }
  }

  function applyPremiumFromMe(me) {
    if (!spotifyPremiumBadge) return;
    if (!me || !me.product) {
      spotifyPremiumBadge.hidden = true;
      return;
    }
    const product = String(me.product).toLowerCase();
    spotifyPremiumBadge.hidden = false;
    if (product === "premium") {
      spotifyPremiumBadge.textContent = "Premium";
      spotifyPremiumBadge.classList.remove("premium-badge-warn");
    } else {
      spotifyPremiumBadge.textContent =
        product === "free" ? "Free tier — Premium needed here" : "Check subscription tier";
      spotifyPremiumBadge.classList.add("premium-badge-warn");
    }
  }

  function updateSpotifyUi() {
    syncTrackSearchUiAuth();
    if (!Sp || !spotifyHint) return;

    const id = Sp.getClientId();
    if (!id) {
      spotifyHint.textContent =
        "Add Client ID in js/spotify-config.js and register redirect " +
        Sp.redirectUri() +
        " in the Spotify dashboard.";
      applyPremiumFromMe(cachedSpotifyMe);
      return;
    }
    if (!Sp.isLoggedIn()) {
      spotifyHint.textContent = "Sign in using the header button, then search for a track.";
      applyPremiumFromMe(cachedSpotifyMe);
      return;
    }

    applyPremiumFromMe(cachedSpotifyMe);

    if (!getEffectiveSpotifyTrackId()) {
      spotifyHint.textContent = "";
      return;
    }
    const pick = loadStoredTrackPick(getSelectedSongId());
    if (!pick.rawId && getCatalogSpotifyTrackId()) {
      spotifyHint.textContent =
        "Using catalog track from songs.json — search above to use another recording.";
      return;
    }
    spotifyHint.textContent = "";
  }

  async function init() {
    Sp = window.SingChineseSpotify || Sp;

    await ensurePinyinSegmentDict();

    updateScriptToggleUi();
    syncSpotifySetupBanner();

    if (spotifyLoginBtn) {
      spotifyLoginBtn.addEventListener("click", async () => {
        const SpMod = window.SingChineseSpotify;
        if (!SpMod) {
          if (spotifyHint) {
            spotifyHint.textContent =
              "Spotify code did not load (check Network tab for js/spotify.js). Serve this folder with HTTP and hard-refresh.";
          }
          console.error("SingChineseSpotify is missing — js/spotify.js may have failed to load.");
          return;
        }
        try {
          await SpMod.login();
        } catch (e) {
          if (e && e.message === "MISSING_CLIENT_ID") {
            syncSpotifySetupBanner();
            spotifySetupBanner?.scrollIntoView({ behavior: "smooth", block: "center" });
            if (spotifyHint) {
              spotifyHint.textContent =
                "Configure Client ID in js/spotify-config.js (see note above), reload, then try Sign in again.";
            }
          } else {
            console.warn(e);
            if (spotifyHint) {
              spotifyHint.textContent =
                "Could not start Spotify sign-in: " +
                (e && e.message ? e.message : String(e)) +
                " (see browser console).";
            }
          }
        }
      });
    }
    if (spotifyLogoutBtn && Sp) {
      spotifyLogoutBtn.addEventListener("click", () => {
        pauseAll();
        window.clearTimeout(trackSearchTimer);
        window.clearTimeout(lyricsSearchTimer);
        hideTrackSearchResults();
        hideLyricsSearchResults();
        if (lyricsLessonSearch) lyricsLessonSearch.value = "";
        Sp.destroyPlayer();
        Sp.logout();
        expectedSpotifyUri = "";
        lastSpotifyTimeSec = 0;
        lastSpotifyDurationSec = 0;
        setMode("idle");
        updateSpotifyUi();
        refreshSpotifyAuthUi();
      });
    }

    const res = await fetch("data/songs.json");
    const catalog = await res.json();
    if (!catalog.songs || !catalog.songs.length) {
      throw new Error("No songs in data/songs.json");
    }
    catalogSongs = catalog.songs.slice();
    const primary = catalog.songs[0];
    catalogLessonId = primary.id || primary.lyricsUrl || "default";
    catalogDefaultTrackId =
      primary.spotifyTrackId != null ? String(primary.spotifyTrackId).trim() : "";

    if (spotifyTrackSearch) spotifyTrackSearch.value = "";
    hideTrackSearchResults();
    if (lyricsLessonSearch) lyricsLessonSearch.value = "";
    hideLyricsSearchResults();
    updateSelectedTrackRow();

    if (Sp) {
      try {
        await refreshSpotifyAuthUi();
      } catch (e) {
        console.warn(e);
      }
      updateSpotifyUi();
    }

    await syncLyricsToSongSpot(primary);
    setMode("idle");
  }

  init().catch((e) => {
    console.error(e);
    lyricsList.innerHTML =
      "<li class='lyric-line'><p class='en'>Could not load data. Serve this folder over HTTP and open <code>http://127.0.0.1:8080</code> (for example <code>python3 -m http.server 8080</code>).</p></li>";
  });
})();
