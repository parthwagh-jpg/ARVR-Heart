import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ARButton } from 'three/addons/webxr/ARButton.js';

const YOUR_API_KEY = "AIzaSyBDr7xxYKqxyUWoOXEuQn-oVmzHrWXuxJ0";
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${YOUR_API_KEY}`;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.01, 20);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.xr.enabled = true;
document.getElementById('container').appendChild(renderer.domElement);

const ambientLight = new THREE.AmbientLight(0xffffff, 1);
scene.add(ambientLight);
const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
directionalLight.position.set(1, 1, 1);
scene.add(directionalLight);

let model = null;
let lesionMarker = null;
let reticle = null;
let hitTestSource = null;
let hitTestSourceRequested = false;
const originalScale = 0.3;
let lesionVisible = false;
let controller = null;
let isARMode = false;
let modelPlaced = false;

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let isMarkingLesion = false;

const tempMatrix = new THREE.Matrix4();

camera.position.set(0, 0, 3);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.minDistance = 1;
controls.maxDistance = 10;

const reticleGeometry = new THREE.RingGeometry(0.15, 0.2, 32);
reticleGeometry.rotateX(-Math.PI / 2);
const reticleMaterial = new THREE.MeshBasicMaterial({ color: 0x00bcd4, side: THREE.DoubleSide });
reticle = new THREE.Mesh(reticleGeometry, reticleMaterial);
reticle.matrixAutoUpdate = false;
reticle.visible = false;
scene.add(reticle);

const loader = new GLTFLoader();
const loadingScreen = document.getElementById('loadingScreen');

loader.load('models/heart2.glb', (gltf) => {
  model = gltf.scene;
  // immediately after you set `model = gltf.scene;`
/* Renderer tweaks (put these once at app init as well) */
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.physicallyCorrectLights = true;

/* Traverse all meshes and fix material / texture encodings and flags */
model.traverse((node) => {
  if (!node.isMesh) return;

  // ensure the geometry can receive vertex colors if present
  if (node.geometry && node.geometry.attributes && node.geometry.attributes.color) {
    // many GLBs use vertex colors — enable them on the material
    if (Array.isArray(node.material)) {
      node.material.forEach(m => { if (m) m.vertexColors = true; });
    } else if (node.material) {
      node.material.vertexColors = true;
    }
  }

  // handle material array or single material consistently
  const mats = Array.isArray(node.material) ? node.material : [node.material];
  mats.forEach((mat) => {
    if (!mat) return;
    // if material uses a texture, make sure it's interpreted as sRGB (correct color space)
    if (mat.map) mat.map.encoding = THREE.sRGBEncoding;
    if (mat.emissiveMap) mat.emissiveMap.encoding = THREE.sRGBEncoding;
    if (mat.aoMap) mat.aoMap.encoding = THREE.sRGBEncoding;
    // ensure material reacts to the lights
    if (typeof mat.metalness === 'undefined') mat.metalness = 0.1;
    if (typeof mat.roughness === 'undefined') mat.roughness = 1.0;
    mat.needsUpdate = true;
    // if you want double sided (fixes some shading issues/incorrect normals), enable:
    // mat.side = THREE.DoubleSide;
  });

  // optionally recompute normals if shading is odd:
  if (node.geometry && !node.geometry.attributes.normal) {
    node.geometry.computeVertexNormals();
  }
});

/* Optional debug: list materials to console so you can inspect them */
console.log('GLTF materials:', (() => {
  const m = new Set();
  model.traverse(n => { if (n.isMesh) {
    if (Array.isArray(n.material)) n.material.forEach(x => m.add(x));
    else m.add(n.material);
  }});
  return [...m];
})());

  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  model.position.sub(center);
  const maxDim = Math.max(size.x, size.y, size.z);
  const scale = originalScale / maxDim;
  model.scale.multiplyScalar(scale);
  model.visible = true;
  scene.add(model);
  createLesionMarker();
  if (loadingScreen) loadingScreen.classList.add('hidden');
}, (progress) => {
  if (progress.total) {
    const percent = (progress.loaded / progress.total * 100).toFixed(0);
    const txt = document.querySelector('.loading-text');
    if (txt) txt.textContent = `Loading Heart Model... ${percent}%`;
  }
}, (error) => {
  const geometry = new THREE.BoxGeometry(0.8, 0.8, 0.8);
  const material = new THREE.MeshStandardMaterial({ color: 0xff6b6b, roughness: 0.7, metalness: 0.1 });
  model = new THREE.Mesh(geometry, material);
  model.visible = true;
  scene.add(model);
  createLesionMarker();
  setTimeout(() => { if (loadingScreen) loadingScreen.classList.add('hidden'); }, 2000);
});

function createLesionMarker() {
  const lesionGeometry = new THREE.SphereGeometry(1, 32, 32);
  const lesionMaterial = new THREE.MeshStandardMaterial({
    color: 0xff0000,
    emissive: 0xff0000,
    emissiveIntensity: 0.5,
    transparent: true,
    opacity: 0.85
  });
  lesionMarker = new THREE.Mesh(lesionGeometry, lesionMaterial);
  lesionMarker.userData.pulsePhase = 0;
  lesionMarker.visible = false;
  lesionMarker.scale.set(0.05, 0.05, 0.05);
  if (model) model.add(lesionMarker); else scene.add(lesionMarker);
}

const arButton = document.getElementById('ar-button');
let customARButton = null;

if ('xr' in navigator) {
  navigator.xr.isSessionSupported('immersive-ar').then((supported) => {
    if (supported) {
      if (arButton) arButton.style.display = 'block';
      customARButton = ARButton.createButton(renderer, { requiredFeatures: ['hit-test'], optionalFeatures: ['dom-overlay'], domOverlay: { root: document.body } });
      customARButton.style.display = 'none';
      document.body.appendChild(customARButton);
      if (arButton) {
        arButton.addEventListener('click', () => { customARButton.click(); });
      }
      renderer.xr.addEventListener('sessionstart', () => {
        isARMode = true;
        modelPlaced = false;
        if (arButton) arButton.textContent = 'Exit AR';
        const instr = document.getElementById('arInstructions');
        if (instr) instr.classList.remove('hidden');
        if (model) model.visible = false;
      });
      renderer.xr.addEventListener('sessionend', () => {
        isARMode = false;
        hitTestSourceRequested = false;
        hitTestSource = null;
        if (arButton) arButton.textContent = 'Start AR Experience';
        if (model) { model.visible = true; model.position.set(0, 0, 0); }
      });
    } else {
      if (arButton) {
        arButton.textContent = 'AR Not Supported on This Device';
        arButton.style.display = 'block';
        arButton.disabled = true;
        arButton.style.opacity = '0.5';
      }
    }
  }).catch(err => {
    if (arButton) {
      arButton.textContent = 'Error Checking AR Support';
      arButton.style.display = 'block';
      arButton.disabled = true;
    }
  });
} else {
  if (arButton) {
    arButton.textContent = 'WebXR Not Available';
    arButton.style.display = 'block';
    arButton.disabled = true;
    arButton.style.opacity = '0.5';
  }
}

controller = renderer.xr.getController(0);
controller.addEventListener('select', onSelect);
scene.add(controller);

function onSelect() {
  if (reticle.visible && model && !modelPlaced) {
    model.position.setFromMatrixPosition(reticle.matrix);
    model.quaternion.setFromRotationMatrix(reticle.matrix);
    model.visible = true;
    modelPlaced = true;
    const instr = document.getElementById('arInstructions');
    if (instr) { setTimeout(() => instr.classList.add('hidden'), 2000); }
    return;
  }
  if (modelPlaced && isMarkingLesion && model) {
    tempMatrix.identity().extractRotation(controller.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);
    const intersects = raycaster.intersectObject(model, true);
    if (intersects.length > 0) handleLesionMarking(intersects[0].point);
  }
}

const scaleSlider = document.getElementById('scaleSlider');
const toggleLesionBtn = document.getElementById('toggleLesionBtn');
const resetViewBtn = document.getElementById('resetViewBtn');
const markLesionBtn = document.getElementById('markLesionBtn');

if (scaleSlider) {
  scaleSlider.addEventListener('input', (e) => {
    const scaleValue = parseFloat(e.target.value);
    const scaleDisplay = document.getElementById('scaleValue');
    if (scaleDisplay) scaleDisplay.textContent = scaleValue.toFixed(1) + 'x';
    if (model) {
      const baseScale = originalScale * scaleValue;
      model.scale.setScalar(baseScale);
    }
  });
}

if (toggleLesionBtn) {
  toggleLesionBtn.addEventListener('click', () => {
    lesionVisible = !lesionVisible;
    if (lesionMarker) lesionMarker.visible = lesionVisible;
    toggleLesionBtn.textContent = lesionVisible ? 'Hide Abnormality' : 'Show Abnormality';
  });
}

if (resetViewBtn) {
  resetViewBtn.addEventListener('click', () => {
    if (lesionMarker) {
      lesionMarker.visible = false;
      lesionVisible = false;
      if (toggleLesionBtn) toggleLesionBtn.textContent = 'Show Abnormality';
    }
    const pX = document.getElementById('posX');
    const pY = document.getElementById('posY');
    const pZ = document.getElementById('posZ');
    const res = document.getElementById('lesionAnalysisResult');
    if (pX) pX.textContent = '---';
    if (pY) pY.textContent = '---';
    if (pZ) pZ.textContent = '---';
    if (res) res.textContent = 'No abnormality marked.';
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    if (isARMode && model) {
      modelPlaced = false;
      model.visible = false;
    } else {
      camera.position.set(0, 0, 3);
      controls.target.set(0, 0, 0);
      controls.update();
      if (model) {
        model.rotation.set(0, 0, 0);
        model.position.set(0, 0, 0);
      }
    }
  });
}

if (markLesionBtn) {
  markLesionBtn.addEventListener('click', () => {
    isMarkingLesion = !isMarkingLesion;
    if (isMarkingLesion) {
      markLesionBtn.textContent = 'Marking... (Click on Heart)';
      markLesionBtn.classList.add('active');
      controls.enabled = false;
    } else {
      markLesionBtn.textContent = 'Mark Abnormality';
      markLesionBtn.classList.remove('active');
      controls.enabled = true;
    }
  });
}

function onModelClick(event) {
  if (!isMarkingLesion || !model || isARMode) return;
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObject(model, true);
  if (intersects.length > 0) handleLesionMarking(intersects[0].point);
}

window.addEventListener('click', onModelClick);

function handleLesionMarking(worldPoint) {
  if (!model || !lesionMarker) return;
  const localPoint = model.worldToLocal(worldPoint.clone());
  if (lesionMarker.parent !== model) {
    const worldPos = new THREE.Vector3();
    lesionMarker.getWorldPosition(worldPos);
    model.add(lesionMarker);
    lesionMarker.position.copy(model.worldToLocal(worldPos));
  }
  lesionMarker.position.copy(localPoint);
  lesionMarker.visible = true;
  lesionVisible = true;
  if (toggleLesionBtn) toggleLesionBtn.textContent = 'Hide Abnormality';
  lesionMarker.scale.set(0.05, 0.05, 0.05);
  const pX = document.getElementById('posX');
  const pY = document.getElementById('posY');
  const pZ = document.getElementById('posZ');
  if (pX) pX.textContent = localPoint.x.toFixed(3);
  if (pY) pY.textContent = localPoint.y.toFixed(3);
  if (pZ) pZ.textContent = localPoint.z.toFixed(3);
  callGeminiAPI(localPoint);
  isMarkingLesion = false;
  if (markLesionBtn) {
    markLesionBtn.textContent = 'Mark Abnormality';
    markLesionBtn.classList.remove('active');
  }
  controls.enabled = true;
}

function speakText(text) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US';
  utterance.rate = 0.9;
  utterance.pitch = 1.0;
  const voices = window.speechSynthesis.getVoices();
  let selectedVoice = voices.find(v => v.name.includes('Google') && v.lang === 'en-US');
  if (!selectedVoice) selectedVoice = voices.find(v => v.name.includes('Microsoft') && v.lang === 'en-US');
  if (!selectedVoice) selectedVoice = voices.find(v => v.lang === 'en-US' && v.default);
  utterance.voice = selectedVoice || voices[0];
  window.speechSynthesis.speak(utterance);
}

if ('speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = () => { window.speechSynthesis.getVoices(); };
}

async function callGeminiAPI(position) {
  const resultEl = document.getElementById('lesionAnalysisResult');
  if (resultEl) resultEl.textContent = 'Analyzing...';
  if (!YOUR_API_KEY) {
    if (resultEl) resultEl.textContent = 'Error: API Key not set in script.js';
    return;
  }
  const prompt = `
A potential cardiac abnormality has been identified at:
X: ${position.x.toFixed(4)}
Y: ${position.y.toFixed(4)}
Z: ${position.z.toFixed(4)}
Explain in plain non-technical language:
- Which part of the heart this location most likely corresponds to (one sentence).
- What kinds of problems could happen there (e.g., a blocked artery, weakened heart muscle, or a valve issue), listed simply.
- What tests a doctor would usually order to check (one short list: e.g., ultrasound, CT scan, angiogram).
- A clear one-sentence reassurance/disclaimer: this is an automated suggestion and only a doctor reviewing clinical tests can diagnose.
Keep the answer short (simple sentences).`;
  const requestBody = { contents: [{ parts: [{ text: prompt }] }], safetySettings: [] };
  try {
    const response = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    let aiText = null;
    if (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0]) {
      aiText = data.candidates[0].content.parts[0].text;
    }
    if (aiText) {
      if (resultEl) resultEl.textContent = aiText.trim();
      callMedicalAnalysisAPI(position, aiText.trim());
    } else {
      if (resultEl) resultEl.textContent = 'No response from API.';
    }
  } catch (err) {
    if (resultEl) resultEl.textContent = 'Error: Could not get analysis.';
  }
}

async function callMedicalAnalysisAPI(position, regionName) {
  if (!YOUR_API_KEY) {
    speakText("API Key not configured.");
    return;
  }
  const prompt = `
You are a senior cardiothoracic consultant.
An abnormality has been marked in ${regionName}.
Coordinates: X: ${position.x.toFixed(4)}, Y: ${position.y.toFixed(4)}, Z: ${position.z.toFixed(4)}.
Provide a short calm verbal briefing appropriate for a clinician (one paragraph).`;
  const requestBody = { contents: [{ parts: [{ text: prompt }] }], safetySettings: [] };
  try {
    const response = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    let analysisText = null;
    if (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0]) {
      analysisText = data.candidates[0].content.parts[0].text;
    }
    if (analysisText) speakText(analysisText.trim()); else speakText("Medical analysis data is unavailable.");
  } catch (err) {
    speakText("Error retrieving medical analysis.");
  }
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function animate() { renderer.setAnimationLoop(render); }

function render(timestamp, frame) {
  if (lesionMarker && lesionMarker.visible) {
    lesionMarker.userData.pulsePhase += 0.05;
    const pulse = Math.sin(lesionMarker.userData.pulsePhase) * 0.2 + 1;
    lesionMarker.material.emissiveIntensity = 0.3 + pulse * 0.2;
  }
  if (frame && isARMode) {
    const referenceSpace = renderer.xr.getReferenceSpace();
    const session = renderer.xr.getSession();
    if (hitTestSourceRequested === false && session) {
      session.requestReferenceSpace('viewer').then((viewerSpace) => {
        session.requestHitTestSource({ space: viewerSpace }).then((source) => { hitTestSource = source; });
      });
      hitTestSourceRequested = true;
    }
    if (hitTestSource) {
      const hitTestResults = frame.getHitTestResults(hitTestSource);
      if (hitTestResults.length > 0 && !modelPlaced) {
        const hit = hitTestResults[0];
        const pose = hit.getPose(referenceSpace);
        if (pose) {
          reticle.visible = true;
          reticle.matrix.fromArray(pose.transform.matrix);
        }
      } else reticle.visible = false;
    }
  } else controls.update();
  renderer.render(scene, camera);
}

animate();
