/**
 * Create a Spotify app at https://developer.spotify.com/dashboard
 * - Add redirect URIs (Settings → Redirect URIs → Add → Save):
 *     https://singchinese.online/callback.html
 *     http://127.0.0.1:8080/callback.html
 * - Paste the Client ID below (no secret needed for browser PKCE).
 */
window.SPOTIFY_CLIENT_ID = "84320bdb68c1430e9ffaebad88b02e58";

/** Must match Spotify Dashboard redirect URIs exactly. */
window.singchineseSpotifyRedirectUri = function () {
  var host = window.location.hostname;
  if (host === "singchinese.online" || host === "www.singchinese.online") {
    return "https://singchinese.online/callback.html";
  }
  var origin = window.location.origin;
  if (host === "localhost") {
    origin = origin.replace("localhost", "127.0.0.1");
  }
  return origin + "/callback.html";
};
