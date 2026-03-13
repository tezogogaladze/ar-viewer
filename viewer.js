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
const canvas     = document.getElementById('canvas');
const loadingEl  = document.getElementById('loading');
const overlay    = document.getElementById('overlay');
const arBtn      = document.getElementById('ar-button');
const iosBtn     = document.getElementById('ios-button');
const resetBtn   = document.getElementById('reset-button');
const arCtrls    = document.getElementById('ar-controls');
const hintEl     = document.getElementById('hint');

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
  alpha: true,          // transparent background (camera feed shows through)
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
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
let xrSession       = null;
let hitTestSource   = null;
let modelPlaced     = false;

// ─── Gesture state ───────────────────────────────────────────────────────────
let gestureRotY   = 0;
let gestureScale  = 1;
let lastTouchX    = 0;
let lastPinchDist = 0;

// ─── Start AR ─────────────────────────────────────────────────────────────────
async function startAR() {
  try {
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay', 'light-estimation'],
      domOverlay: { root: overlay },
    });

    await renderer.xr.setSession(session);
    xrSession = session;

    // Viewer space is the origin for hit-testing (ray from camera center)
    const viewerSpace  = await session.requestReferenceSpace('viewer');
    hitTestSource      = await session.requestHitTestSource({ space: viewerSpace });

    session.addEventListener('select', onTap);
    session.addEventListener('end', onSessionEnd);

    arBtn.style.display   = 'none';
    hintEl.style.display  = 'block';
    arCtrls.style.display = 'flex';

    renderer.setAnimationLoop(renderFrame);
  } catch (err) {
    console.error('[AR Viewer] Session start failed:', err);
  }
}

// ─── Tap → place ─────────────────────────────────────────────────────────────
function onTap() {
  if (!reticle.visible || !modelReady) return;

  // Extract position from the reticle's world matrix
  const pos = new THREE.Vector3();
  pos.setFromMatrixPosition(reticle.matrix);

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
}

// ─── Reset ────────────────────────────────────────────────────────────────────
resetBtn.addEventListener('click', () => {
  modelPlaced   = false;
  gestureRotY   = 0;
  gestureScale  = 1;

  modelRoot.visible  = false;
  modelRoot.rotation.set(0, 0, 0);
  modelRoot.scale.setScalar(1);

  shadowPlane.visible = false;
  reticle.visible     = false; // will re-appear on next hit-test result
  dot.visible         = false;
  hintEl.style.display = 'block';
});

// ─── Session end ─────────────────────────────────────────────────────────────
function onSessionEnd() {
  xrSession      = null;
  hitTestSource  = null;
  modelPlaced    = false;
  gestureRotY    = 0;
  gestureScale   = 1;

  modelRoot.visible   = false;
  shadowPlane.visible = false;
  reticle.visible     = false;
  dot.visible         = false;

  arBtn.style.display    = '';
  hintEl.style.display   = 'none';
  arCtrls.style.display  = 'none';

  renderer.setAnimationLoop(null);
}

// ─── Touch gestures (fired on #canvas while in AR) ────────────────────────────
canvas.addEventListener('touchstart', (e) => {
  if (!modelPlaced) return;
  e.preventDefault();
  if (e.touches.length === 1) {
    lastTouchX = e.touches[0].clientX;
  } else if (e.touches.length === 2) {
    lastPinchDist = pinchDist(e.touches);
  }
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  if (!modelPlaced) return;
  e.preventDefault();

  if (e.touches.length === 1) {
    // Single finger → rotate around Y axis
    const dx = e.touches[0].clientX - lastTouchX;
    gestureRotY += dx * 0.012;
    modelRoot.rotation.y = gestureRotY;
    lastTouchX = e.touches[0].clientX;

  } else if (e.touches.length === 2) {
    // Two fingers → pinch to scale
    const dist  = pinchDist(e.touches);
    const ratio = dist / lastPinchDist;
    gestureScale = Math.min(5.0, Math.max(0.05, gestureScale * ratio));
    modelRoot.scale.setScalar(gestureScale);
    lastPinchDist = dist;
  }
}, { passive: false });

function pinchDist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
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
