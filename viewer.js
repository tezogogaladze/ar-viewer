import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// ─── Config ───────────────────────────────────────────────────────────────────
const MODEL_GLB  = '/models/product.glb';
const MODEL_USDZ = '/models/product.usdz';

// Target size for the placed model (meters). Adjust per product.
const TARGET_SIZE = 0.28;

// ─── iOS / iPadOS detection ───────────────────────────────────────────────────
const isIOS =
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ─── DOM ──────────────────────────────────────────────────────────────────────
const canvas        = document.getElementById('canvas');
const gestureLayer  = document.getElementById('gesture-layer');
const loadingEl     = document.getElementById('loading');
const overlay       = document.getElementById('overlay');
const arBtn         = document.getElementById('ar-button');
const iosBtn        = document.getElementById('ios-button');
const resetBtn      = document.getElementById('reset-button');
const arCtrls       = document.getElementById('ar-controls');
const hintEl        = document.getElementById('hint');

// ─── Platform routing ─────────────────────────────────────────────────────────
if (isIOS) {
  // iOS: show Quick Look anchor, hide WebXR button
  arBtn.style.display = 'none';
  iosBtn.style.display = 'inline-flex';
  iosBtn.href = MODEL_USDZ;
} else {
  // Android / desktop: check WebXR support
  initWebXRButton();
}

async function initWebXRButton() {
  if (!navigator.xr) {
    arBtn.textContent = 'AR Not Supported';
    arBtn.disabled = true;
    return;
  }
  const supported = await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
  if (!supported) {
    arBtn.textContent = 'AR Not Available';
    arBtn.disabled = true;
  } else {
    arBtn.addEventListener('click', startAR);
  }
}

// ─── Renderer ─────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({
  canvas,
  alpha: true,
  antialias: true,
  // 'high-performance' breaks WebXR on several Android GPUs — leave as default
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
// CRITICAL: default clear alpha is 1 (opaque), which blacks out the camera feed.
// Set to 0 so the XR camera feed shows through the transparent canvas.
renderer.setClearColor(0x000000, 0);
renderer.xr.enabled = true;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;

// ─── Scene & Camera ───────────────────────────────────────────────────────────
const scene  = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);

// ─── Lighting ─────────────────────────────────────────────────────────────────
// Hemisphere approximates real-world ambient bounce
const hemi = new THREE.HemisphereLight(0xffffff, 0x888844, 0.5);
scene.add(hemi);

// Key light — positioned above and to the side
const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
keyLight.position.set(1.5, 3.0, 1.5);
keyLight.castShadow = true;
keyLight.shadow.mapSize.setScalar(1024);
keyLight.shadow.camera.near = 0.01;
keyLight.shadow.camera.far  = 10;
keyLight.shadow.camera.left   = -0.8;
keyLight.shadow.camera.right  =  0.8;
keyLight.shadow.camera.top    =  0.8;
keyLight.shadow.camera.bottom = -0.8;
keyLight.shadow.bias = -0.001;
scene.add(keyLight);

// Fill light — opposite side, softer
const fillLight = new THREE.DirectionalLight(0xffffff, 0.4);
fillLight.position.set(-1.5, 1.0, -1.0);
scene.add(fillLight);

// ─── Reticle ──────────────────────────────────────────────────────────────────
// Flat ring shown on detected surfaces before placement
const reticleGeo = new THREE.RingGeometry(0.07, 0.095, 36).rotateX(-Math.PI / 2);
const reticleMat = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  opacity: 0.85,
  transparent: true,
  side: THREE.DoubleSide,
  depthWrite: false,
});
const reticle = new THREE.Mesh(reticleGeo, reticleMat);
reticle.visible = false;
reticle.matrixAutoUpdate = false;  // we'll set matrix directly from XR hit pose
scene.add(reticle);

// Inner dot for precision
const dotGeo = new THREE.CircleGeometry(0.01, 16).rotateX(-Math.PI / 2);
const dot    = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, depthWrite: false }));
dot.matrixAutoUpdate = false;
scene.add(dot);

// ─── Shadow receiver plane ────────────────────────────────────────────────────
// Invisible plane placed where the model lands; catches cast shadows only.
const shadowPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(4, 4).rotateX(-Math.PI / 2),
  new THREE.ShadowMaterial({ opacity: 0.28, transparent: true }),
);
shadowPlane.receiveShadow = true;
shadowPlane.visible = false;
scene.add(shadowPlane);

// ─── Model container ─────────────────────────────────────────────────────────
// Outer group: positioned at hit point, rotated/scaled by gestures.
// Inner group (set during load): centers and lifts the GLB so it sits on y=0.
const modelRoot = new THREE.Group();
modelRoot.visible = false;
scene.add(modelRoot);

let modelReady   = false;
let modelBaseScale = 1; // set after normalization

// ─── Draco + GLTF loader ──────────────────────────────────────────────────────
const draco = new DRACOLoader();
// Google-hosted Draco WASM decoder — no local copy needed
draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
draco.preload();

const loader = new GLTFLoader();
loader.setDRACOLoader(draco);

loader.load(
  MODEL_GLB,
  (gltf) => {
    const mesh = gltf.scene;

    // — Normalize scale ——————————————————————————————————————————————————————
    const box    = new THREE.Box3().setFromObject(mesh);
    const size   = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const norm   = TARGET_SIZE / maxDim;

    mesh.scale.setScalar(norm);

    // Center horizontally, sit bottom on y=0 of modelRoot
    mesh.position.set(
      -center.x * norm,
      -box.min.y * norm,
      -center.z * norm,
    );

    mesh.traverse((node) => {
      if (node.isMesh) {
        node.castShadow    = true;
        node.receiveShadow = true;
        // Ensure materials are correctly color-space encoded
        if (node.material.map) node.material.map.colorSpace = THREE.SRGBColorSpace;
      }
    });

    modelRoot.add(mesh);
    modelBaseScale = norm;
    modelReady = true;
    loadingEl.style.display = 'none';
  },
  undefined,
  (err) => {
    console.error('[AR Viewer] GLB load failed:', err);
    loadingEl.innerHTML = `
      <p style="color:#ff6b6b;text-align:center;line-height:1.6;padding:0 24px">
        Could not load model.<br>
        Drop a GLB into <code>models/product.glb</code><br>and refresh.
      </p>`;
  },
);

// ─── AR session state ─────────────────────────────────────────────────────────
let xrSession        = null;
let hitTestSource    = null;
let modelPlaced      = false;
let useFixedPlacement = false; // fallback when hit-test is unavailable

// ─── Gesture state ───────────────────────────────────────────────────────────
let gestureRotY    = 0;
let gestureScale   = 1;
// 1-finger move
let lastTouch1X    = 0;
let lastTouch1Y    = 0;
let moveStartX     = 0;
let moveStartY     = 0;
let moveStarted    = false;
const MOVE_THRESHOLD = 8; // px — prevents accidental nudges
// 2-finger rotate + scale — tracked by touch identifier, not array index
let pinchId0 = -1; // identifier of the first  tracked finger
let pinchId1 = -1; // identifier of the second tracked finger
let lastPinchDist  = 0;
let lastPinchAngle = 0;
let pinchFrameSkip = false; // discard first move frame after finger-count change

// ─── Start AR ─────────────────────────────────────────────────────────────────
async function startAR() {
  showError('');
  arBtn.disabled = true;
  arBtn.textContent = 'Starting…';

  try {
    // hit-test is optional — if the device doesn't support it the session
    // still starts and we fall back to fixed-distance tap-to-place.
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: [],
      optionalFeatures: ['hit-test', 'dom-overlay', 'light-estimation'],
      domOverlay: { root: overlay },
    });

    // 'local-floor' (Three.js default) is rejected on many Android AR sessions.
    // 'local' is universally supported for immersive-ar.
    renderer.xr.setReferenceSpaceType('local');
    await renderer.xr.setSession(session);
    xrSession = session;

    session.addEventListener('select', onTap);
    session.addEventListener('end', onSessionEnd);

    arBtn.style.display   = 'none';
    hintEl.style.display  = 'block';
    arCtrls.style.display = 'flex';

    // Start render loop immediately so camera feed appears right away.
    renderer.setAnimationLoop(renderFrame);

    // Set up hit testing (viewer space = ray from camera centre)
    try {
      const viewerSpace = await session.requestReferenceSpace('viewer');
      hitTestSource     = await session.requestHitTestSource({ space: viewerSpace });
    } catch (htErr) {
      // Hit-test not supported — fall back to placing at a fixed 0.6 m distance
      console.warn('[AR Viewer] Hit-test unavailable, using fixed-distance fallback:', htErr);
      hintEl.textContent = 'Tap anywhere to place';
      hitTestSource = null;
      useFixedPlacement = true;
    }

  } catch (err) {
    console.error('[AR Viewer] Session start failed:', err);
    arBtn.disabled = false;
    arBtn.textContent = 'View in AR';
    showError(`AR failed: ${err.message || err.name || err}`);
  }
}

// Shows a small error message below the AR button
function showError(msg) {
  let el = document.getElementById('ar-error');
  if (!el) {
    el = document.createElement('p');
    el.id = 'ar-error';
    el.style.cssText = 'color:#ff6b6b;font-size:13px;text-align:center;margin-top:8px;padding:0 16px;line-height:1.4';
    document.getElementById('controls').appendChild(el);
  }
  el.textContent = msg;
}

// ─── Tap → place ─────────────────────────────────────────────────────────────
function onTap() {
  if (!modelReady) return;
  if (!reticle.visible && !useFixedPlacement) return;

  // Fixed-distance fallback: place 0.6 m in front of the camera
  const pos = new THREE.Vector3();
  if (useFixedPlacement) {
    camera.getWorldPosition(pos);
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    pos.addScaledVector(dir, 0.6);
  } else {
    pos.setFromMatrixPosition(reticle.matrix);
  }

  modelRoot.position.copy(pos);
  modelRoot.rotation.y = gestureRotY;
  modelRoot.scale.setScalar(gestureScale);
  modelRoot.visible = true;

  // Shadow plane sits at the same height as the hit point
  shadowPlane.position.set(pos.x, pos.y, pos.z);
  shadowPlane.visible = true;

  // Move key light to track placed model
  keyLight.target = modelRoot;
  scene.add(keyLight.target);

  reticle.visible  = false;
  dot.visible      = false;
  hintEl.style.display = 'none';
  modelPlaced = true;

  // Hand touch events to the gesture layer so rotate/pinch work
  gestureLayer.style.pointerEvents = 'auto';
}

// ─── Reset ────────────────────────────────────────────────────────────────────
resetBtn.addEventListener('click', () => {
  modelPlaced    = false;
  gestureRotY    = 0;
  gestureScale   = 1;
  moveStarted    = false;
  pinchId0 = pinchId1 = -1;

  modelRoot.visible  = false;
  modelRoot.rotation.set(0, 0, 0);
  modelRoot.scale.setScalar(1);

  shadowPlane.visible = false;
  reticle.visible     = false;
  dot.visible         = false;

  // Return touches to XR system so tap-to-place works again
  gestureLayer.style.pointerEvents = 'none';
  hintEl.style.display = 'block';
});

// ─── Session end ─────────────────────────────────────────────────────────────
function onSessionEnd() {
  xrSession         = null;
  hitTestSource     = null;
  modelPlaced       = false;
  useFixedPlacement = false;
  gestureRotY       = 0;
  gestureScale      = 1;
  moveStarted       = false;
  pinchId0 = pinchId1 = -1;

  modelRoot.visible   = false;
  shadowPlane.visible = false;
  reticle.visible     = false;
  dot.visible         = false;
  gestureLayer.style.pointerEvents = 'none';

  arBtn.textContent   = 'View in AR';
  arBtn.disabled      = false;
  arBtn.style.display = '';
  hintEl.style.display   = 'none';
  arCtrls.style.display  = 'none';

  renderer.setAnimationLoop(null);
}

// ─── Touch gestures — matches iOS Quick Look behaviour ────────────────────────
//   1 finger drag  → move model along floor plane
//   2 finger twist → rotate   (angle between fingers)
//   2 finger pinch → scale    (distance between fingers)
//
// Touches are tracked by identifier (not array index) so reordering by the
// browser never causes a phantom rotation or scale jump.

function getTouchById(list, id) {
  for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i];
  return null;
}

gestureLayer.addEventListener('touchstart', (e) => {
  e.preventDefault();

  if (e.touches.length === 1) {
    // Reset single-finger tracking
    moveStarted = false;
    moveStartX  = lastTouch1X = e.touches[0].clientX;
    moveStartY  = lastTouch1Y = e.touches[0].clientY;
    // Clear pinch ids so a later 2nd finger gets fresh ids
    pinchId0 = pinchId1 = -1;

  } else if (e.touches.length === 2) {
    // Lock in which two identifiers we track for this pinch gesture
    pinchId0 = e.touches[0].identifier;
    pinchId1 = e.touches[1].identifier;
    lastPinchDist  = pinchDistById(e.touches, pinchId0, pinchId1);
    lastPinchAngle = pinchAngleById(e.touches, pinchId0, pinchId1);
    pinchFrameSkip = true; // discard next move frame — fingers haven't settled yet

    // Keep 1-finger tracking in sync so releasing one finger doesn't snap
    lastTouch1X = e.touches[0].clientX;
    lastTouch1Y = e.touches[0].clientY;
    moveStarted = false;
  }
}, { passive: false });

gestureLayer.addEventListener('touchmove', (e) => {
  e.preventDefault();

  if (e.touches.length === 1) {
    const dx = e.touches[0].clientX - lastTouch1X;
    const dy = e.touches[0].clientY - lastTouch1Y;

    if (!moveStarted) {
      const totalDx = e.touches[0].clientX - moveStartX;
      const totalDy = e.touches[0].clientY - moveStartY;
      if (Math.sqrt(totalDx * totalDx + totalDy * totalDy) > MOVE_THRESHOLD) {
        moveStarted = true;
      }
    }

    if (moveStarted) moveModelByDelta(dx, dy);

    lastTouch1X = e.touches[0].clientX;
    lastTouch1Y = e.touches[0].clientY;

  } else if (e.touches.length >= 2) {
    // Keep 1-finger tracking in sync → prevents snap when second finger lifts
    const t0 = getTouchById(e.touches, pinchId0);
    if (t0) { lastTouch1X = t0.clientX; lastTouch1Y = t0.clientY; }
    moveStarted = false;

    // Skip the first move frame after a finger-count change to avoid first-frame jitter
    if (pinchFrameSkip) { pinchFrameSkip = false; return; }

    // Scale
    const dist = pinchDistById(e.touches, pinchId0, pinchId1);
    if (dist > 0) {
      gestureScale = Math.min(5.0, Math.max(0.05, gestureScale * (dist / lastPinchDist)));
      modelRoot.scale.setScalar(gestureScale);
      lastPinchDist = dist;
    }

    // Rotate — negate delta so clockwise twist = clockwise model spin from user's POV
    const angle = pinchAngleById(e.touches, pinchId0, pinchId1);
    let delta = angle - lastPinchAngle;
    if (delta >  Math.PI) delta -= 2 * Math.PI; // prevent atan2 wrap-around jumps
    if (delta < -Math.PI) delta += 2 * Math.PI;
    gestureRotY -= delta; // fix #3: negative = matches user's visual expectation
    modelRoot.rotation.y = gestureRotY;
    lastPinchAngle = angle;
  }
}, { passive: false });

// Project screen-space drag onto the horizontal floor plane
function moveModelByDelta(dx, dy) {
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  fwd.y = 0;
  fwd.normalize();

  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();

  // Scale movement by distance to model so far objects don't fly away
  const dist = camera.position.distanceTo(modelRoot.position);
  const f = Math.max(0.0005, dist * 0.0015);

  modelRoot.position.addScaledVector(right, dx * f);
  modelRoot.position.addScaledVector(fwd, -dy * f);

  // Keep shadow plane in sync
  shadowPlane.position.x = modelRoot.position.x;
  shadowPlane.position.z = modelRoot.position.z;
}

function pinchDistById(list, id0, id1) {
  const a = getTouchById(list, id0);
  const b = getTouchById(list, id1);
  if (!a || !b) return 0;
  return Math.sqrt((a.clientX - b.clientX) ** 2 + (a.clientY - b.clientY) ** 2);
}

function pinchAngleById(list, id0, id1) {
  const a = getTouchById(list, id0);
  const b = getTouchById(list, id1);
  if (!a || !b) return lastPinchAngle; // return unchanged if a finger is missing
  return Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX);
}

// ─── Render loop ─────────────────────────────────────────────────────────────
function renderFrame(_timestamp, frame) {
  if (!frame) return;

  if (hitTestSource && !modelPlaced) {
    const refSpace = renderer.xr.getReferenceSpace();
    const results  = frame.getHitTestResults(hitTestSource);

    if (results.length > 0) {
      const pose = results[0].getPose(refSpace);
      if (pose) {
        const m = pose.transform.matrix;
        reticle.visible = true;
        reticle.matrix.fromArray(m);
        dot.visible = true;
        dot.matrix.fromArray(m);
      }
    } else {
      reticle.visible = false;
      dot.visible     = false;
    }
  }

  renderer.render(scene, camera);
}

// ─── Window resize ────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
