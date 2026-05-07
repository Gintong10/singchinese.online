(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  /** Resolved each init so we pick up `SingChineseSpotify` even if scripts reorder; avoid stale undefined from load races. */
  let Sp = window.SingChineseSpotify;

  const TRACK_STORE_PREFIX = "singchinese_track_";

  const playBtn = $("playBtn");
  const seek = $("seek");
  const timeCurrent = $("timeCurrent");
  const timeTotal = $("timeTotal");
  const lyricsList = $("lyricsList");
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
  const footerRedirectHint = $("footerRedirectHint");
  const spotifySetupBanner = $("spotifySetupBanner");
  const setupBannerRedirect = $("setupBannerRedirect");

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
  /** Last Spotify track rows shown (same order as listbox). */
  let searchResultsTracks = [];
  let searchHighlightIdx = -1;

  function getSelectedSongId() {
    return catalogLessonId;
  }

  function getCatalogSpotifyTrackId() {
    return catalogDefaultTrackId;
  }

  function parseStoredTrackRaw(raw) {
    if (!raw || typeof raw !== "string") return { rawId: "", label: "" };
    const trimmed = raw.trim();
    if (!trimmed) return { rawId: "", label: "" };
    if (trimmed.charAt(0) === "{") {
      try {
        const o = JSON.parse(trimmed);
        const id = (o.id && String(o.id).trim()) || "";
        const label = (o.label && String(o.label).trim()) || "";
        return { rawId: id, label: label };
      } catch (_) {
        return { rawId: trimmed, label: "" };
      }
    }
    return { rawId: trimmed, label: "" };
  }

  function loadStoredTrackPick(songId) {
    try {
      return parseStoredTrackRaw(sessionStorage.getItem(TRACK_STORE_PREFIX + songId) || "");
    } catch (_) {
      return { rawId: "", label: "" };
    }
  }

  function saveStoredTrackPick(songId, rawId, label) {
    try {
      const key = TRACK_STORE_PREFIX + songId;
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

  function formatPickLabel(track) {
    const dur = formatTime((track.durationMs || 0) / 1000);
    return `${track.name} — ${track.artists || "Unknown"} (${dur})`;
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

  function applyTrackPick(track) {
    saveStoredTrackPick(getSelectedSongId(), track.id, formatPickLabel(track));
    if (spotifyTrackSearch) spotifyTrackSearch.value = "";
    hideTrackSearchResults();
    updateSelectedTrackRow();
    updateSpotifyUi();
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
    return Math.max(...lyricData.lines.map((l) => l.end));
  }

  function mediaDuration() {
    if (mode === "spotify" && lastSpotifyDurationSec > 0) {
      return lastSpotifyDurationSec;
    }
    return lyricsDuration();
  }

  function setMode(next) {
    mode = next;
    modeBadge.classList.remove("is-demo");
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
      const activeEl = lines[activeIndex];
      activeEl.scrollIntoView({ block: "center", behavior: "smooth" });
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

  function updateSpotifyMismatch(state) {
    if (!expectedSpotifyUri || !state.track_window || !state.track_window.current_track) {
      return;
    }
    const cur = state.track_window.current_track.uri;
    if (cur && cur !== expectedSpotifyUri) {
      modeBadge.textContent = "Different track playing — timings may drift";
      modeBadge.classList.add("is-demo");
    }
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
          updateSpotifyMismatch(state);
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

  async function startSpotifyPlayback() {
    if (!Sp) throw new Error("Spotify module not loaded");
    const raw = getEffectiveSpotifyTrackId();
    if (!raw) throw new Error("Search for a track or set spotifyTrackId in songs.json");
    const uri = Sp.uriFromTrackId(raw);
    expectedSpotifyUri = uri;
    setMode("spotify");
    await Sp.ensurePlayer();
    const state = await Sp.getPlaybackState();
    const currentUri =
      state &&
      state.track_window &&
      state.track_window.current_track &&
      state.track_window.current_track.uri;
    const sameTrack = currentUri === uri;
    const explicitlyPaused = !!(state && state.paused);
    if (sameTrack && explicitlyPaused) {
      await Sp.resumePlayback();
    } else {
      await Sp.playTrackUri(uri);
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
          spotifyHint.textContent =
            "Search Spotify for a track, or add spotifyTrackId in data/songs.json.";
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

  const spotifySearchField = document.querySelector(".spotify-search-field");
  document.addEventListener("click", (e) => {
    if (!spotifySearchResults || spotifySearchResults.hidden) return;
    const t = e.target;
    if (!(t instanceof Node)) return;
    if (spotifySearchField && spotifySearchField.contains(t)) return;
    hideTrackSearchResults();
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
    lyricsList.innerHTML = "";
    if (!lyricData) return;
    lyricData.lines.forEach((line) => {
      const li = document.createElement("li");
      li.className = "lyric-line";
      const en = document.createElement("p");
      en.className = "en";
      en.textContent = line.en;
      const py = document.createElement("p");
      py.className = "py";
      py.textContent = line.pinyin;
      const zh = document.createElement("p");
      zh.className = "zh";
      zh.textContent = line.zh;
      li.append(en, py, zh);
      lyricsList.appendChild(li);
    });
    const titleZh = lyricData.title || "SingChinese";
    const titleEn = lyricData.titleEn ? ` (${lyricData.titleEn})` : "";
    document.title = `${titleZh}${titleEn} — SingChinese`;
    previewTimeSec = 0;
    highlightLyrics(0);
  }

  async function loadLyrics(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Failed to load lyrics");
    lyricData = await res.json();
    renderLyrics();
    const dur = lyricsDuration();
    updateUiTime(0, dur);
    seek.value = "0";
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
        spotifyLoginBtn.hidden = false;
        spotifySessionRow.hidden = true;
        if (spotifyDisplayName) spotifyDisplayName.textContent = "";
        if (spotifyPremiumBadge) spotifyPremiumBadge.hidden = true;
        return;
      }
      spotifyLoginBtn.hidden = true;
      spotifySessionRow.hidden = false;
      cachedSpotifyMe = await Sp.getCurrentUser();
      if (spotifyDisplayName) {
        if (cachedSpotifyMe) {
          spotifyDisplayName.textContent =
            "Signed in as " + (cachedSpotifyMe.display_name || cachedSpotifyMe.id || "listener");
        } else {
          spotifyDisplayName.textContent = "Signed in";
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
      spotifyHint.textContent =
        "Search Spotify for a track, or set spotifyTrackId in data/songs.json.";
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

    if (footerRedirectHint && Sp) {
      footerRedirectHint.textContent = Sp.redirectUri();
    }
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
        hideTrackSearchResults();
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
    const primary = catalog.songs[0];
    catalogLessonId = primary.id || primary.lyricsUrl || "default";
    catalogDefaultTrackId =
      primary.spotifyTrackId != null ? String(primary.spotifyTrackId).trim() : "";

    if (spotifyTrackSearch) spotifyTrackSearch.value = "";
    hideTrackSearchResults();
    updateSelectedTrackRow();

    await loadLyrics(primary.lyricsUrl);
    setMode("idle");

    if (Sp) {
      try {
        await refreshSpotifyAuthUi();
      } catch (e) {
        console.warn(e);
      }
      updateSpotifyUi();
    }
  }

  init().catch((e) => {
    console.error(e);
    lyricsList.innerHTML =
      "<li class='lyric-line'><p class='en'>Could not load data. Serve this folder over HTTP (for example <code>python3 -m http.server 8080</code>).</p></li>";
  });
})();
