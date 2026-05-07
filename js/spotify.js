/**
 * Spotify PKCE auth + Web Playback SDK helper for SingChinese.
 * Requires Premium for in-browser playback. See js/spotify-config.js.
 */
(function () {
  "use strict";

  var LS = {
    ACCESS: "singchinese_spotify_access",
    REFRESH: "singchinese_spotify_refresh",
    EXPIRES: "singchinese_spotify_expires_at",
    VERIFIER: "singchinese_spotify_code_verifier",
    OAUTH_STATE: "singchinese_oauth_state",
  };

  var SCOPES = [
    "streaming",
    "user-read-email",
    "user-read-private",
    "user-modify-playback-state",
    "user-read-playback-state",
  ].join(" ");

  function getClientId() {
    var id = window.SPOTIFY_CLIENT_ID;
    return typeof id === "string" && id.trim() ? id.trim() : "";
  }

  function redirectUri() {
    var p = window.location.pathname || "/";
    var i = p.lastIndexOf("/");
    var dir = p.slice(0, i + 1);
    return window.location.origin + dir + "callback.html";
  }

  function randomString(len) {
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    var out = "";
    var arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    for (var i = 0; i < len; i++) {
      out += chars[arr[i] % chars.length];
    }
    return out;
  }

  async function sha256base64url(plain) {
    var enc = new TextEncoder().encode(plain);
    var digest = await crypto.subtle.digest("SHA-256", enc);
    var bytes = new Uint8Array(digest);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) {
      bin += String.fromCharCode(bytes[i]);
    }
    var b64 = btoa(bin);
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function getStoredAccess() {
    return localStorage.getItem(LS.ACCESS) || "";
  }

  function getStoredRefresh() {
    return localStorage.getItem(LS.REFRESH) || "";
  }

  function clearTokens() {
    localStorage.removeItem(LS.ACCESS);
    localStorage.removeItem(LS.REFRESH);
    localStorage.removeItem(LS.EXPIRES);
  }

  function isLoggedIn() {
    return !!(getStoredAccess() || getStoredRefresh());
  }

  async function refreshAccessToken() {
    var refresh = getStoredRefresh();
    var clientId = getClientId();
    if (!refresh || !clientId) return null;
    var res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refresh,
        client_id: clientId,
      }),
    });
    var body = await res.json();
    if (!res.ok) {
      clearTokens();
      return null;
    }
    localStorage.setItem(LS.ACCESS, body.access_token);
    if (body.refresh_token) {
      localStorage.setItem(LS.REFRESH, body.refresh_token);
    }
    var now = Date.now();
    localStorage.setItem(LS.EXPIRES, String(now + (body.expires_in || 3600) * 1000 - 60000));
    return body.access_token;
  }

  async function getValidAccessToken() {
    var clientId = getClientId();
    if (!clientId) return null;
    var exp = parseInt(localStorage.getItem(LS.EXPIRES) || "0", 10);
    var access = getStoredAccess();
    if (access && Date.now() < exp) return access;
    return refreshAccessToken();
  }

  async function startLogin() {
    var clientId = getClientId();
    if (!clientId) {
      throw new Error("MISSING_CLIENT_ID");
    }
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error(
        "Web Crypto API unavailable — use http://127.0.0.1 or http://localhost (not file://)."
      );
    }
    var verifier = randomString(64);
    var challenge = await sha256base64url(verifier);
    sessionStorage.setItem(LS.VERIFIER, verifier);
    var oauthState = randomString(32);
    sessionStorage.setItem(LS.OAUTH_STATE, oauthState);
    var url =
      "https://accounts.spotify.com/authorize?" +
      new URLSearchParams({
        client_id: clientId,
        response_type: "code",
        redirect_uri: redirectUri(),
        scope: SCOPES,
        code_challenge_method: "S256",
        code_challenge: challenge,
        state: oauthState,
      });
    // Full browser navigation to Spotify login + consent (accounts.spotify.com)
    window.location.href = url;
  }

  function logout() {
    clearTokens();
    sessionStorage.removeItem(LS.VERIFIER);
    sessionStorage.removeItem(LS.OAUTH_STATE);
  }

  async function api(method, path, body) {
    var token = await getValidAccessToken();
    if (!token) throw new Error("Not authenticated");
    var headers = { Authorization: "Bearer " + token };
    var opts = {
      method: method,
      headers: headers,
    };
    var sendBody =
      body !== undefined && method !== "GET" && method !== "HEAD" && body !== null;
    if (sendBody) {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    var res = await fetch("https://api.spotify.com/v1" + path, opts);
    if (res.status === 204) return null;
    var text = await res.text();
    var data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      var msg = (data && (data.error && data.error.message)) || res.statusText;
      throw new Error(msg || "Spotify API error");
    }
    return data;
  }

  var player = null;
  var deviceId = null;
  var stateListeners = [];

  function notifyState(state) {
    stateListeners.forEach(function (fn) {
      try {
        fn(state);
      } catch (e) {}
    });
  }

  function loadSdkScript() {
    return new Promise(function (resolve, reject) {
      if (window.Spotify) {
        resolve();
        return;
      }
      var existing = document.querySelector('script[data-spotify-sdk="1"]');
      if (existing) {
        if (window.Spotify) {
          resolve();
          return;
        }
        var prev = window.onSpotifyWebPlaybackSDKReady;
        window.onSpotifyWebPlaybackSDKReady = function () {
          if (typeof prev === "function") prev();
          resolve();
        };
        return;
      }
      window.onSpotifyWebPlaybackSDKReady = function () {
        resolve();
      };
      var s = document.createElement("script");
      s.src = "https://sdk.scdn.co/spotify-player.js";
      s.async = true;
      s.dataset.spotifySdk = "1";
      s.onerror = reject;
      document.body.appendChild(s);
    });
  }

  async function ensurePlayer() {
    if (player && deviceId) return { player: player, deviceId: deviceId };
    var token = await getValidAccessToken();
    if (!token) throw new Error("Sign in to Spotify first");

    await loadSdkScript();
    if (!window.Spotify) {
      throw new Error("Spotify SDK failed to load");
    }

    if (player) {
      return { player: player, deviceId: deviceId };
    }

    // eslint-disable-next-line no-undef
    player = new Spotify.Player({
      name: "absings web",
      getOAuthToken: function (cb) {
        getValidAccessToken().then(function (t) {
          return cb(t || "");
        });
      },
      volume: 0.85,
    });

    player.addListener("ready", function (_ref) {
      var id = _ref.device_id;
      deviceId = id;
      notifyState(player.__lastState || null);
    });

    player.addListener("not_ready", function () {
      deviceId = null;
    });

    player.addListener("player_state_changed", function (state) {
      player.__lastState = state;
      notifyState(state);
    });

    var connected = await player.connect();
    if (!connected) {
      throw new Error("Could not connect Spotify player");
    }

    await new Promise(function (resolve) {
      var tries = 0;
      var t = setInterval(function () {
        tries++;
        if (deviceId) {
          clearInterval(t);
          resolve();
        } else if (tries > 80) {
          clearInterval(t);
          resolve();
        }
      }, 100);
    });

    return { player: player, deviceId: deviceId };
  }

  async function transferPlaybackToThisDevice() {
    if (!deviceId) return;
    await api("PUT", "/me/player", {
      device_ids: [deviceId],
      play: false,
    });
  }

  async function playTrackUri(trackUri) {
    var _await$ensurePlayer = await ensurePlayer();
    var devId = _await$ensurePlayer.deviceId;
    if (!devId) throw new Error("Spotify player not ready");
    await transferPlaybackToThisDevice();
    var token = await getValidAccessToken();
    if (!token) throw new Error("Not authenticated");
    var res = await fetch(
      "https://api.spotify.com/v1/me/player/play?device_id=" + encodeURIComponent(devId),
      {
        method: "PUT",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ uris: [trackUri] }),
      }
    );
    if (!res.ok && res.status !== 204) {
      var errText = await res.text();
      var parsed = errText ? JSON.parse(errText) : {};
      throw new Error((parsed.error && parsed.error.message) || "Play failed");
    }
  }

  async function pausePlayback() {
    if (player) {
      await player.pause();
      return;
    }
    try {
      await api("PUT", "/me/player/pause", undefined);
    } catch (e) {}
  }

  async function resumePlayback() {
    if (player) {
      await player.resume();
      return;
    }
    await api("PUT", "/me/player/play", undefined);
  }

  async function seekMs(ms) {
    var pos = Math.max(0, Math.floor(ms));
    if (player) {
      await player.seek(pos);
      return;
    }
    var token = await getValidAccessToken();
    if (!token) throw new Error("Not authenticated");
    var res = await fetch(
      "https://api.spotify.com/v1/me/player/seek?position_ms=" + encodeURIComponent(String(pos)),
      {
        method: "PUT",
        headers: { Authorization: "Bearer " + token },
      }
    );
    if (!res.ok && res.status !== 204) {
      throw new Error("Seek failed");
    }
  }

  async function getPlaybackState() {
    if (player) {
      return player.getCurrentState();
    }
    return null;
  }

  function destroyPlayer() {
    if (player) {
      try {
        player.disconnect();
      } catch (e) {}
    }
    player = null;
    deviceId = null;
  }

  /** @returns {Promise<string>} e.g. "premium" | "free" */
  async function getBillingProduct() {
    try {
      var me = await api("GET", "/me", undefined);
      return (me && me.product) || "";
    } catch (e) {
      return "";
    }
  }

  /** @returns {Promise<Array<{ id: string, uri: string, name: string, artists: string, durationMs: number, albumArtUrl: string }>>} */
  async function searchTracks(query, limit) {
    var q = (query || "").trim();
    if (!q) return [];
    var lim = limit != null ? Number(limit) : 10;
    if (!Number.isFinite(lim)) lim = 10;
    lim = Math.max(1, Math.min(Math.floor(lim), 10));
    var params = new URLSearchParams({
      q: q,
      type: "track",
      limit: String(lim),
    });
    var data = await api("GET", "/search?" + params.toString(), undefined);
    var items = (data && data.tracks && data.tracks.items) || [];
    return items.map(function (t) {
      var artists = (t.artists || [])
        .map(function (a) {
          return a.name;
        })
        .join(", ");
      var imgs = t.album && t.album.images;
      var artUrl = "";
      if (imgs && imgs.length) {
        var preferred = imgs.filter(function (im) {
          return im.width >= 40 && im.width <= 64;
        });
        var pick = preferred.length ? preferred[0] : imgs[imgs.length - 1];
        artUrl = (pick && pick.url) || "";
      }
      return {
        id: t.id,
        uri: t.uri,
        name: t.name,
        artists: artists,
        durationMs: t.duration_ms || 0,
        albumArtUrl: artUrl,
      };
    });
  }

  /** Public profile for “signed in as …” (after login). */
  async function getCurrentUser() {
    try {
      return await api("GET", "/me", undefined);
    } catch (e) {
      return null;
    }
  }

  window.SingChineseSpotify = {
    getClientId: getClientId,
    redirectUri: redirectUri,
    isLoggedIn: isLoggedIn,
    login: startLogin,
    logout: logout,
    getValidAccessToken: getValidAccessToken,
    ensurePlayer: ensurePlayer,
    playTrackUri: playTrackUri,
    pausePlayback: pausePlayback,
    resumePlayback: resumePlayback,
    seekMs: seekMs,
    getPlaybackState: getPlaybackState,
    onPlayerState: function (fn) {
      stateListeners.push(fn);
      return function () {
        stateListeners = stateListeners.filter(function (x) {
          return x !== fn;
        });
      };
    },
    destroyPlayer: destroyPlayer,
    getBillingProduct: getBillingProduct,
    getCurrentUser: getCurrentUser,
    searchTracks: searchTracks,
    uriFromTrackId: function (id) {
      if (!id || typeof id !== "string") return "";
      var trimmed = id.trim();
      if (trimmed.indexOf("spotify:track:") === 0) return trimmed;
      var open = trimmed.match(/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?track\/([a-zA-Z0-9]+)/);
      if (open) return "spotify:track:" + open[1];
      return "spotify:track:" + trimmed;
    },
  };
})();
