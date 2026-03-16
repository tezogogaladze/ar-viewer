const viewer    = document.getElementById('viewer');
const loadingEl = document.getElementById('loading');

// ?model=chair  →  /models/chair/model.glb  +  /models/chair/model.usdz
// (no param)    →  /models/model.glb         +  /models/model.usdz
const param = new URLSearchParams(window.location.search).get('model');
const base  = param ? `/models/${param}` : '/models';

viewer.setAttribute('src',     `${base}/model.glb`);
viewer.setAttribute('ios-src', `${base}/model.usdz`);

viewer.addEventListener('load', () => {
  loadingEl.style.display = 'none';
});

viewer.addEventListener('error', () => {
  loadingEl.innerHTML = `
    <p style="color:#ff6b6b;text-align:center;line-height:1.6;padding:0 24px">
      Could not load model.<br>
      Check that <code>${base}/model.glb</code> exists.
    </p>`;
});
