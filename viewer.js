const viewer    = document.getElementById('viewer');
const loadingEl = document.getElementById('loading');

// Hide loading screen once GLB is loaded
viewer.addEventListener('load', () => {
  loadingEl.style.display = 'none';
});

// Show error message if model fails to load
viewer.addEventListener('error', () => {
  loadingEl.innerHTML = `
    <p style="color:#ff6b6b;text-align:center;line-height:1.6;padding:0 24px">
      Could not load model.<br>
      Place a GLB at <code>public/models/model.glb</code><br>and refresh.
    </p>`;
});
