/**
 * Resolve the Download buttons to the actual installer of the latest release,
 * for the operating system the visitor is on.
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
 * network, a release with no matching artefact — nothing happens and the page
 * keeps the link it already had. There is no failure state to design because
 * there is no failure the user can see.
 *
 * The per-OS resolution rides on the same property. A release that carries no
 * .exe yet is indistinguishable, from here, from a rate-limited API: neither
 * resolves, both leave the honest catch-all link in place. That is why the
 * markup's own copy names both platforms rather than one — the fallback has to
 * be true for whoever is reading it, on whatever they are reading it on.
 */
(function () {
  'use strict';

  var API = 'https://api.github.com/repos/craigjmidwinter/getvect/releases/latest';

  var button = document.getElementById('download-button');
  var hero = document.getElementById('hero-download');
  var meta = document.getElementById('download-meta');
  var other = document.getElementById('download-other');
  if (!button && !hero) return;

  // Windows or macOS, and the tie goes to macOS. `userAgentData.platform` is
  // the only one of these that is not deprecated or lied about, so it is asked
  // first; `platform` and the UA string are the fallback for every browser that
  // does not have it, which today is most of them outside Chromium.
  //
  // Defaulting to macOS rather than guessing from a Linux or unknown UA is a
  // decision, not laziness: a Linux visitor has no published build to be sent
  // to, and the dmg link at least resolves to a real file on a real release
  // page they can navigate out of. The "other platforms" link below is the
  // honest exit for everyone this heuristic gets wrong.
  function detectOS() {
    var data = navigator.userAgentData;
    var platform = (data && data.platform) || navigator.platform || '';
    var ua = navigator.userAgent || '';
    if (/win/i.test(platform) || /windows/i.test(ua)) return 'windows';
    return 'mac';
  }

  var OS = {
    mac: {
      pattern: /\.dmg$/i,
      label: 'macOS',
      note: 'Apple Silicon',
      otherLabel: 'Also for Windows'
    },
    windows: {
      pattern: /\.exe$/i,
      label: 'Windows',
      note: 'Windows x64',
      otherLabel: 'Also for macOS'
    }
  };

  var target = OS[detectOS()];

  fetch(API, { headers: { Accept: 'application/vnd.github+json' } })
    .then(function (response) {
      if (!response.ok) throw new Error('releases API said ' + response.status);
      return response.json();
    })
    .then(function (release) {
      var assets = release.assets || [];
      var asset = null;
      for (var i = 0; i < assets.length; i++) {
        if (target.pattern.test(assets[i].name)) {
          asset = assets[i];
          break;
        }
      }
      if (!asset || !asset.browser_download_url) return;

      var version = String(release.tag_name || '').replace(/^v/, '');
      [button, hero].forEach(function (el) {
        if (!el) return;
        el.href = asset.browser_download_url;
        if (version) el.textContent = 'Download GetVect ' + version + ' for ' + target.label;
        // No `download` attribute: it is ignored cross-origin, and GitHub
        // already serves release assets as an attachment.
      });

      if (meta) {
        var mb = Math.round((asset.size || 0) / 1048576);
        meta.textContent =
          asset.name + (mb ? ' · ' + mb + ' MB' : '') + ' · ' + target.note + ' · unsigned';
      }

      // Only named once the primary button is genuinely one-platform. Until
      // then it stays the catch-all the markup shipped with, because "Also for
      // macOS" beside a button that is already the releases page is a link to
      // the same place wearing a more specific promise.
      if (other) other.textContent = target.otherLabel;
    })
    .catch(function () {
      /* The `releases/latest` link in the markup is already the right answer. */
    });
})();
