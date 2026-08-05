/* The before/after stage. Four numbers live as CSS custom properties on the stage —
   the reveal position (--pos), the zoom (--z) and the pan offset (--tx/--ty) — and the
   CSS does the rest, so with JS off the page still shows a static 50/50 comparison at
   1x. Both panes read the same four, so they cannot drift out of registration.

   Two gestures share the surface. Within CORRIDOR px of the divider you are moving the
   reveal; anywhere else, once zoomed, you are dragging the view. The range input is
   still the accessible control (and still takes arrow keys), but it no longer swallows
   pointer events across the whole stage — the stage decides and forwards. */
(function () {
  var stage = document.getElementById('stage');
  if (!stage) return;

  var reveal = document.getElementById('reveal');
  var zoom = document.getElementById('zoom');

  /* Zoom anchors on the face — the eyes, the nose and the mouth arcs, the crop where a
     traced line either holds together or doesn't, and the same framing the README's
     before/after composite uses. Frankie is a loaf facing left, so his face sits ~38%
     across the stage box rather than centred; vertically the image is full-bleed, so
     44% is exact. The zoom buttons always re-anchor here; drag from there to go
     looking elsewhere. */
  var ANCHOR_X = 0.38, ANCHOR_Y = 0.44;
  var ASPECT = 1195 / 896;   // the artwork both panes share
  var CORRIDOR = 24;         // px either side of the divider that still drags the divider
  var STEP = 48;             // px per arrow-key press when panning

  var z = 1, tx = 0, ty = 0, drag = null;

  /* The letterboxed picture inside the stage at 1x, in stage pixels. object-fit:
     contain leaves bars on one axis, and clamping against the element box would let you
     drag out into them, so the picture is what we clamp against. */
  function picture() {
    var r = stage.getBoundingClientRect();
    var p = { x: 0, y: 0, w: r.width, h: r.height, vw: r.width, vh: r.height };
    if (r.width / r.height > ASPECT) { p.w = r.height * ASPECT; p.x = (r.width - p.w) / 2; }
    else { p.h = r.width / ASPECT; p.y = (r.height - p.h) / 2; }
    return p;
  }

  /* One axis: keep the zoomed picture covering the viewport, or centred if it is
     smaller than the viewport (which is what 1x always is). */
  function fit(t, off, size, view) {
    if (size * z <= view) return (view - size * z) / 2 - off * z;
    return Math.min(-off * z, Math.max(view - (off + size) * z, t));
  }

  function apply() {
    var p = picture();
    tx = fit(tx, p.x, p.w, p.vw);
    ty = fit(ty, p.y, p.h, p.vh);
    stage.style.setProperty('--tx', tx);
    stage.style.setProperty('--ty', ty);
  }

  function setZoom(next) {
    var r = stage.getBoundingClientRect();
    z = next;
    tx = -ANCHOR_X * r.width * (z - 1);
    ty = -ANCHOR_Y * r.height * (z - 1);
    stage.style.setProperty('--z', z);
    /* A two-axis drag needs the browser's own gestures out of the way; at 1x there is
       nothing to pan, so the page scrolls through the stage as before. */
    stage.style.touchAction = z > 1 ? 'none' : 'pan-y';
    if (z > 1) {
      stage.setAttribute('tabindex', '0');
      stage.setAttribute('role', 'group');
      stage.setAttribute('aria-label', 'Zoomed comparison — arrow keys pan the view');
    } else {
      stage.removeAttribute('tabindex');
      stage.removeAttribute('role');
      stage.removeAttribute('aria-label');
    }
    apply();
  }

  function setPos(v) {
    v = Math.max(0, Math.min(100, v));
    if (reveal) reveal.value = v;
    stage.style.setProperty('--pos', v);
  }

  function onDivider(clientX) {
    var r = stage.getBoundingClientRect();
    var pos = reveal ? +reveal.value : 50;
    return Math.abs(clientX - r.left - r.width * pos / 100) <= CORRIDOR;
  }

  function dragDivider(clientX) {
    var r = stage.getBoundingClientRect();
    setPos(Math.round((clientX - r.left) / r.width * 200) / 2);  // the input's 0.5 step
  }

  function cursor(clientX) {
    stage.dataset.cursor = drag ? (drag.pan ? 'panning' : 'divider')
      : onDivider(clientX) ? 'divider' : z > 1 ? 'pan' : '';
  }

  stage.addEventListener('pointerdown', function (e) {
    var divider = onDivider(e.clientX);
    if (!divider && z === 1) return;
    drag = { pan: !divider, x: e.clientX, y: e.clientY };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('is-dragging');
    if (divider) { if (reveal) reveal.focus(); dragDivider(e.clientX); }
    else stage.focus();
    cursor(e.clientX);
    e.preventDefault();
  });

  stage.addEventListener('pointermove', function (e) {
    if (drag && drag.pan) {
      tx += e.clientX - drag.x;
      ty += e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      apply();
    } else if (drag) {
      dragDivider(e.clientX);
    }
    cursor(e.clientX);
  });

  function release(e) {
    if (!drag) return;
    drag = null;
    stage.classList.remove('is-dragging');
    cursor(e.clientX);
  }
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);
  stage.addEventListener('pointerleave', function () { if (!drag) stage.dataset.cursor = ''; });

  /* Arrows on the stage pan; arrows on the range input still move the divider, so a
     key that came from the input is left alone. */
  stage.addEventListener('keydown', function (e) {
    if (e.target !== stage || z === 1) return;
    var d = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
    if (!d) return;
    tx += d[0] * STEP;
    ty += d[1] * STEP;
    apply();
    e.preventDefault();
  });

  if (reveal) reveal.addEventListener('input', function () { setPos(+reveal.value); });

  if (zoom) {
    zoom.addEventListener('click', function (e) {
      var button = e.target.closest('button[data-z]');
      if (!button) return;
      setZoom(+button.dataset.z);
      var buttons = zoom.querySelectorAll('button');
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].setAttribute('aria-pressed', String(buttons[i] === button));
      }
    });
  }

  window.addEventListener('resize', apply);
  setPos(reveal ? +reveal.value : 50);
  setZoom(1);
})();
