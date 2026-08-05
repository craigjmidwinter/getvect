/**
 * Resolve the Download buttons to the actual .dmg of the latest release.
 *
 * WHY THIS IS JAVASCRIPT AND NOT A LINK. electron-builder names its artefacts
 * with the version in them — `GetVect-0.1.0-arm64.dmg` — so there is no stable
 * `releases/latest/download/<name>` URL to hard-code. Dropping the version from
 * the filename would fix the URL and break the thing that matters more: a dmg
 * in the Downloads folder should say which GetVect it is.
 *
 * So the markup ships pointing at `releases/latest`, which is a real page that
 * works with JavaScript off, on a stale cache, and if this file 404s. One API
 * call upgrades it to a direct download. If the call fails — rate limit, no
 * network, a release with no dmg — nothing happens and the page keeps the link
 * it already had. There is no failure state to design because there is no
 * failure the user can see.
 */
(function () {
  'use strict';

  var API = 'https://api.github.com/repos/craigjmidwinter/getvect/releases/latest';

  var button = document.getElementById('download-button');
  var hero = document.getElementById('hero-download');
  var meta = document.getElementById('download-meta');
  if (!button && !hero) return;

  fetch(API, { headers: { Accept: 'application/vnd.github+json' } })
    .then(function (response) {
      if (!response.ok) throw new Error('releases API said ' + response.status);
      return response.json();
    })
    .then(function (release) {
      var assets = release.assets || [];
      var dmg = null;
      for (var i = 0; i < assets.length; i++) {
        if (/\.dmg$/i.test(assets[i].name)) {
          dmg = assets[i];
          break;
        }
      }
      if (!dmg || !dmg.browser_download_url) return;

      var version = String(release.tag_name || '').replace(/^v/, '');
      [button, hero].forEach(function (el) {
        if (!el) return;
        el.href = dmg.browser_download_url;
        if (version) el.textContent = 'Download GetVect ' + version;
        // No `download` attribute: it is ignored cross-origin, and GitHub
        // already serves release assets as an attachment.
      });

      if (meta) {
        var mb = Math.round((dmg.size || 0) / 1048576);
        meta.textContent =
          dmg.name + (mb ? ' · ' + mb + ' MB' : '') + ' · Apple Silicon · unsigned';
      }
    })
    .catch(function () {
      /* The `releases/latest` link in the markup is already the right answer. */
    });
})();
