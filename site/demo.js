/* The before/after stage: a range input drives the reveal, three buttons drive the
   zoom. Both write CSS custom properties on the stage; the CSS does the rest, so
   with JS off the page still shows a static 50/50 comparison at 1x. */
(function () {
  var stage = document.getElementById('stage');
  if (!stage) return;

  var reveal = document.getElementById('reveal');
  if (reveal) {
    var setPos = function () { stage.style.setProperty('--pos', reveal.value); };
    reveal.addEventListener('input', setPos);
    setPos();
  }

  var zoom = document.getElementById('zoom');
  if (zoom) {
    zoom.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-z]');
      if (!button) return;
      stage.style.setProperty('--z', button.dataset.z);
      var buttons = zoom.querySelectorAll('button');
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].setAttribute('aria-pressed', String(buttons[i] === button));
      }
    });
  }
})();
