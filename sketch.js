// iPhone camera start UI
// =====================
let startBtn;
let camStarted = false;

let cam;
let cvReady = false;

let modelStatus = "not started";
let modelError = "";
let loadedCount = 0;
let totalCount = 0;

// ✅ freeze cache：用于 lock 后保持“按下那一刻的画面数据”
let freeze = {
  roi: null,          // p5.Image（小缩略图）
  roiFeats: null,     // {warmth, brightness, straightness, texture, smoothness, lineCount}
  resultROI: null,    // classifyOrganism 的结果
  edgePixels: 0,      // UI 用
};

let currentMatType = "none";
let currentMatInfo = "";

// ===== UI fold (debug panel) =====
let uiState = {
  collapsed: true,   // 默认折叠
  showN: 5           // 折叠时显示前 N 行
};
let uiToggleBtn;


// ===== Drag rotate controls (mouse + touch) =====
let dragCtrl = {
  enabled: true,
  dragging: false,
  lastX: 0,
  lastY: 0,
  yaw: 0,    // 左右
  pitch: 0,  // 上下
  sensitivity: 0.006, // 旋转灵敏度
  pitchMin: -Math.PI / 2 + 0.15,
  pitchMax:  Math.PI / 2 - 0.15,
};

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function attachDragRotate(domEl) {
  if (!domEl) return;

  const onDown = (e) => {
    if (!dragCtrl.enabled) return;

    // 避免拖拽按钮
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : "";
    if (tag === "button") return;

    dragCtrl.dragging = true;
    const p = getPointerXY(e);
    dragCtrl.lastX = p.x;
    dragCtrl.lastY = p.y;

    // 捕获指针（防止移出画布就断）
    if (domEl.setPointerCapture && e.pointerId != null) {
      try { domEl.setPointerCapture(e.pointerId); } catch (_) {}
    }
  };

  const onMove = (e) => {
    if (!dragCtrl.enabled || !dragCtrl.dragging) return;

    const p = getPointerXY(e);
    const dx = p.x - dragCtrl.lastX;
    const dy = p.y - dragCtrl.lastY;
    dragCtrl.lastX = p.x;
    dragCtrl.lastY = p.y;

    dragCtrl.yaw   += dx * dragCtrl.sensitivity;
    dragCtrl.pitch += dy * dragCtrl.sensitivity;
    dragCtrl.pitch = clamp(dragCtrl.pitch, dragCtrl.pitchMin, dragCtrl.pitchMax);

    // ✅ 把旋转应用到模型（instF）
    if (three && three.instF) {
      // Y 轴左右旋转 + X 轴上下旋转（更像 3D 查看器）
      three.instF.rotation.set(-dragCtrl.pitch, dragCtrl.yaw + Math.PI, 0);
    }
  };

  const onUp = (e) => {
    dragCtrl.dragging = false;
  };

  // Pointer events（同时支持鼠标+触摸）
  domEl.addEventListener("pointerdown", onDown, { passive: true });
  domEl.addEventListener("pointermove", onMove, { passive: true });
  domEl.addEventListener("pointerup", onUp, { passive: true });
  domEl.addEventListener("pointercancel", onUp, { passive: true });
  domEl.addEventListener("pointerleave", onUp, { passive: true });
}

function getPointerXY(e) {
  // pointer event
  if (e.clientX != null) return { x: e.clientX, y: e.clientY };
  // touch event fallback（一般不需要）
  const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
  return t ? { x: t.clientX, y: t.clientY } : { x: 0, y: 0 };
}


// Tracking (A/B stable boxes)
// =====================
let trackA = null;
let trackB = null;

let spawn3D = new THREE.Vector3(0, 0, 0);
const SPAWN_SMOOTH = 0.5; // 越小越稳

const SMOOTH = 0.25;
const TEXTURE_MAX = 1200;

// =====================
// Debug: spawn marker
// =====================
let DEBUG_SPAWN = true;

// 2D: 屏幕上的生成点（p5 画）
let spawn2D = { x: 0, y: 0, ok: false };

// 3D: Three.js 里的生成点（小球）
let spawnMarker3D = null;

// 在 global 变量区添加
let rawOrientation = { alpha: 0, beta: 0, gamma: 0 };

const STABLE_FRAMES = 12;     // 连续 12 帧一致才算稳定（你可以 8~20 之间试）
const LOST_FRAMES = 18;       // 连续丢失多少帧才认为目标消失

let lockMode = false;         // ✅ 锁定模式：锁定后不再更新识别/造型
let lockedA = null;           // { organism, feats }
let lockedB = null;

let stableA = { name: null, count: 0, lost: 0, feats: null };
let stableB = { name: null, count: 0, lost: 0, feats: null };

let lockBtn;

let lockedRectA = null;
let lockedRectB = null;

// ✅ 在全局变量区添加，用于锁定 3D 模型的位置
let lockedHit = null;

// ===== Marker AR params =====
const MARKER_SIZE_M = 0.06; // marker 实际边长（米）: 6cm，按你打印的真实尺寸改
let markerPose = null;      // { rvec, tvec, R } 缓存
let markerVisible = false;  // 是否检测到


function updateStable(st, obj) {
  if (!obj) {
    st.lost++;
    if (st.lost > LOST_FRAMES) {
      st.name = null; st.count = 0; st.feats = null;
    }
    return st;
  }

  st.lost = 0;

  if (st.name === obj.organism) {
    st.count++;
    // feats 做一个轻微 EMA，避免材质参数抖
    if (st.feats) {
      const a = 0.25;
      st.feats = {
        warmth: st.feats.warmth + (obj.feats.warmth - st.feats.warmth) * a,
        brightness: st.feats.brightness + (obj.feats.brightness - st.feats.brightness) * a,
        straightness: st.feats.straightness + (obj.feats.straightness - st.feats.straightness) * a,
        smoothness: st.feats.smoothness + (obj.feats.smoothness - st.feats.smoothness) * a,
      };
    } else {
      st.feats = { ...obj.feats };
    }
  } else {
    st.name = obj.organism;
    st.count = 1;
    st.feats = { ...obj.feats };
  }
  return st;
}

function toggleLock() {
  lockMode = !lockMode;

  if (lockMode) {
    // 1) 锁定 A/B（来自 stable）
    lockedA = (stableA.name && stableA.count >= STABLE_FRAMES)
      ? { organism: stableA.name, feats: stableA.feats }
      : null;

    lockedB = (stableB.name && stableB.count >= STABLE_FRAMES)
      ? { organism: stableB.name, feats: stableB.feats }
      : null;

    // 2) 锁定框（来自 track）
    lockedRectA = trackA ? { ...trackA } : null;
    lockedRectB = trackB ? { ...trackB } : null;

    // 3) 锁定 spawn 点（来自当前 spawn2D）
    const boxSize = Math.floor(Math.min(width, height) * 0.85);
    const bx = Math.floor((width - boxSize) / 2);
    const by = Math.floor((height - boxSize) / 2);

    const sx = (spawn2D && spawn2D.ok) ? spawn2D.x : (bx + boxSize / 2);
    const sy = (spawn2D && spawn2D.ok) ? spawn2D.y : (by + boxSize / 2);

    lockedHit = screenToGround(sx, sy);

    if (lockBtn) lockBtn.html("Locked ✅ (tap to unlock)");
  } else {
    lockedA = null;
    lockedB = null;
    lockedRectA = null;
    lockedRectB = null;
    lockedHit = null;

    // ✅ 解锁后，把 tracking 和 spawn 都重置
    trackA = null;
    trackB = null;
    spawn2D.ok = false;

    stableA = { name: null, count: 0, lost: 0, feats: null };
    stableB = { name: null, count: 0, lost: 0, feats: null };

    // ✅ 可选：让 3D 模型先隐藏，避免残留
    if (three.instF) three.instF.visible = false;

    if (lockBtn) lockBtn.html("Lock / Unlock");
  }
}




// =====================
// OpenCV init
// =====================
(function waitForCvAndInit() {
  const t = setInterval(() => {
    if (window.cv) {
      clearInterval(t);

      window.cv.onRuntimeInitialized = () => {
        console.log("✅ OpenCV initialized");
        cvReady = true;
      };

      if (window.cv.Mat) {
        console.log("✅ OpenCV already ready");
        cvReady = true;
      }
    }
  }, 50);
})();

// =====================
// Three.js overlay
// =====================
let three = {
  scene: null,
  camera: null,
  renderer: null,
  root: null,
  models: {},
  current: null,
  ready: false,

  instF: null,

};

function initThreeOverlay() {
  const w = windowWidth;
  const h = windowHeight;

  if (three.renderer) return;

  // 1) 先创建 scene / camera / renderer
  three.scene = new THREE.Scene();

  three.camera = new THREE.PerspectiveCamera(60, w / h, 0.01, 100);
  three.camera.position.set(0, 1.6, 0);

  three.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  three.renderer.setSize(w, h);
  three.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  three.renderer.domElement.style.position = "fixed";
  three.renderer.domElement.style.left = "0";
  three.renderer.domElement.style.top = "0";
  three.renderer.domElement.style.zIndex = "5";
  three.renderer.domElement.style.pointerEvents = "auto";
  document.body.appendChild(three.renderer.domElement);
  attachDragRotate(three.renderer.domElement);


  three.ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  // 2) lights
  three.scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(1, 2, 3);
  three.scene.add(dir);

  // ✅ 再补一个背光，让材质更立体（不依赖 HDR/RoomEnvironment）
  const back = new THREE.DirectionalLight(0xffffff, 0.6);
  back.position.set(-2, 1, -2);
  three.scene.add(back);

  three.root = new THREE.Group();
  three.scene.add(three.root);

  // 3) ✅ 可选：环境反射（不使用 RoomEnvironment，避免你没引入时报错）
  // 这一步不是必须；先保证不报错
  // 如果你确实想要环境反射，看 Step 2

  // 4) device orientation
  window.addEventListener('deviceorientation', (e) => {
    rawOrientation.alpha = e.alpha || 0;
    rawOrientation.beta  = e.beta  || 0;
    rawOrientation.gamma = e.gamma || 0;
  }, true);

  three.ready = true;
}


function loadAllModels() {
  const manager = new THREE.LoadingManager();
  manager.onStart = () => { modelStatus = "loading..."; };
  manager.onLoad  = () => { modelStatus = "all loaded ✅"; };
  manager.onError = (url) => { modelStatus = "load error ❌"; modelError = `fail: ${url}`; };

  const loader = new THREE.GLTFLoader(manager);
  // 有些 iOS 情况下加这个更稳
  loader.setCrossOrigin("anonymous");

  const files = {
  "Tendril__Tendril":           "models/Tendril__Tendril.glb",
  "Tendril__GlyphLight":        "models/Tendril__GlyphLight.glb",
  "Tendril__CrystalShell":      "models/Tendril__CrystalShell.glb",
  "Tendril__Jelly":             "models/Tendril__Jelly.glb",
  "Tendril__SporeCloud":        "models/Tendril__SporeCloud.glb",

  "GlyphLight__GlyphLight":     "models/GlyphLight__GlyphLight.glb",
  "GlyphLight__CrystalShell":   "models/GlyphLight__CrystalShell.glb",
  "GlyphLight__Jelly":          "models/GlyphLight__Jelly.glb",
  "GlyphLight__SporeCloud":     "models/GlyphLight__SporeCloud.glb",

  "SporeCloud__SporeCloud":     "models/SporeCloud__SporeCloud.glb",
  "SporeCloud__CrystalShell":   "models/SporeCloud__CrystalShell.glb",
  "SporeCloud__Jelly":          "models/SporeCloud__Jelly.glb",

  "CrystalShell__CrystalShell": "models/CrystalShell__CrystalShell.glb",
  "CrystalShell__Jelly":        "models/CrystalShell__Jelly.glb",

  "Jelly__Jelly":               "models/Jelly__Jelly.glb",
};


  const keys = Object.keys(files);
  totalCount = keys.length;
  loadedCount = 0;

  keys.forEach((key) => {
    loader.load(
      files[key],
      (gltf) => {
        const obj = gltf.scene;
        obj.visible = false;
        obj.scale.set(1.5, 1.5, 1.5);
        obj.userData._materialCloned = false;

        three.models[key] = obj;
        three.root.add(obj);

        loadedCount++;
        modelStatus = `loaded ${loadedCount}/${totalCount}`;

        if (!three.current) setActiveModel(key);
      },
      undefined,
      (err) => {
        modelStatus = "load error ❌";
        modelError = `${key}: ${err?.message || err}`;
        console.error("❌ load error", key, err);
      }
    );
  });
}


function setActiveModel(name) {
  const m = three.models[name];
  if (!m || three.current === m) return; // 避免重复设置

  if (three.current) three.current.visible = false;
  
  three.current = m;
  three.current.visible = true;
  
  // 核心：只在切换模型时初始化旋转，之后不要在 draw 里改它
  three.current.rotation.set(0, Math.PI, 0); 
}

function ensureFusionInstance(fuseName) {
  const src = three.models[fuseName];
  if (!src) return null;

  const old = three.instF;
  if (old && old.userData._fusionName === fuseName) return old;

  if (old) three.root.remove(old);

  const inst = src.clone(true);
  inst.visible = true;
  inst.userData._fusionName = fuseName;
  inst.userData._materialCloned = false;
  inst.userData._fusionSeed = hashStringToSeed(fuseName);


  inst.traverse((child) => {
    if (child.isMesh && child.material) child.material = child.material.clone();
  });

  three.root.add(inst);
  three.instF = inst;
  return inst;
}



// =====================
// p5 setup / draw
// =====================
function setup() {
  createCanvas(windowWidth, windowHeight);
  
// 让 p5 的线框/UI 永远在最上面
  const c = document.querySelector("canvas");
  c.style.position = "fixed";
  c.style.left = "0";
  c.style.top = "0";
  c.style.zIndex = "10";       // p5 在上面
  c.style.pointerEvents = "none"; // 可选：不挡触控

  // Start Camera button
  startBtn = createButton("Start Camera");
  startBtn.position(20, 20);
  startBtn.size(160, 44);
  startBtn.mousePressed(startCamera);

   lockBtn = createButton("Lock / Unlock");
   lockBtn.position(20, 70);
   lockBtn.size(160, 44);
   lockBtn.mousePressed(toggleLock);
   startBtn.style('position', 'fixed');
   
   startBtn.style('z-index', '9999');
   lockBtn.style('position', 'fixed');
   lockBtn.style('z-index', '9999');

   uiToggleBtn = createButton("UI: Collapsed ▾");
uiToggleBtn.position(20, 120);
uiToggleBtn.size(160, 36);
uiToggleBtn.mousePressed(() => {
  uiState.collapsed = !uiState.collapsed;
  uiToggleBtn.html(uiState.collapsed ? "UI: Collapsed ▾" : "UI: Expanded ▴");
});
uiToggleBtn.style('position', 'fixed');
uiToggleBtn.style('z-index', '9999');


}

function startCamera() {
  if (camStarted) return;
  camStarted = true;

  cam = createCapture({
    video: { facingMode: { ideal: "environment" } },
    audio: false
  }, () => console.log("✅ camera callback"));

  cam.size(640, 480);

cam.elt.setAttribute("playsinline", "");
cam.elt.setAttribute("webkit-playsinline", "");
cam.elt.muted = true;

// 把 video 铺满屏幕，放在最底层
cam.elt.style.position = "fixed";
cam.elt.style.left = "0";
cam.elt.style.top = "0";
cam.elt.style.width = "100vw";
cam.elt.style.height = "100vh";
cam.elt.style.objectFit = "cover";
cam.elt.style.zIndex = "0";


  startBtn.hide();
  lockBtn.show();

}

function lerp(a, b, t) { return a + (b - a) * t; }

// 把 ROI 内的 rect（像素坐标）映射到屏幕 scan box 坐标
function rectCenterToScreen(r, roiW, roiH, bx, by, boxSize) {
  const cx = r.x + r.width * 0.5;
  const cy = r.y + r.height * 0.5;
  const sx = bx + (cx / roiW) * boxSize;
  const sy = by + (cy / roiH) * boxSize;
  return { x: sx, y: sy };
}

// 由 trackA/trackB 自动算 spawn2D（并且平滑）
function updateSpawnFromTracks(bx, by, boxSize, roiW, roiH) {
  // trackA / trackB 是在 ROI 坐标系里的 rect
  const hasA = !!trackA;
  const hasB = !!trackB;

  if (!hasA && !hasB) {
    spawn2D.ok = false;
    return;
  }

  let target;

  if (hasA && hasB) {
    const a = rectCenterToScreen(trackA, roiW, roiH, bx, by, boxSize);
    const b = rectCenterToScreen(trackB, roiW, roiH, bx, by, boxSize);
    // 中点 = “关系缝隙中心”
    target = { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
  } else if (hasA) {
    target = rectCenterToScreen(trackA, roiW, roiH, bx, by, boxSize);
  } else {
    target = rectCenterToScreen(trackB, roiW, roiH, bx, by, boxSize);
  }

  // 平滑（第一次直接落点）
  if (!spawn2D.ok) {
    spawn2D.x = target.x;
    spawn2D.y = target.y;
    spawn2D.ok = true;
  } else {
    spawn2D.x = lerp(spawn2D.x, target.x, SPAWN_SMOOTH);
    spawn2D.y = lerp(spawn2D.y, target.y, SPAWN_SMOOTH);
  }
}

const ORG_ORDER = ["Tendril", "GlyphLight", "SporeCloud", "CrystalShell", "Jelly"]; 
// 这个顺序随你，但要固定且与你的 15 种表一致

function fusionKey(a, b) {
  if (!a && !b) return null;
  if (a && !b) b = a;
  if (b && !a) a = b;

  const ia = ORG_ORDER.indexOf(a);
  const ib = ORG_ORDER.indexOf(b);

  // 万一出现未知名，兜底：不排序
  if (ia < 0 || ib < 0) return `${a}__${b}`;

  return (ia <= ib) ? `${a}__${b}` : `${b}__${a}`;
}

function mergeFeats(featsA, featsB) {
  if (featsA && featsB) {
    return {
      warmth:       (featsA.warmth + featsB.warmth) / 2,
      brightness:   (featsA.brightness + featsB.brightness) / 2,
      straightness: (featsA.straightness + featsB.straightness) / 2,
      smoothness:   (featsA.smoothness + featsB.smoothness) / 2,
    };
  }
  return featsA || featsB || null;
}

function draw() {
  clear(); // ✅透明清屏，p5 只画UI，不遮挡 three

  // ✅ 延迟初始化 Three：避免一加载就报错导致黑屏
if (camStarted && !three.renderer) {
  console.log("✅ init three now");
  initThreeOverlay();
  loadAllModels();
}
fill(255);
textSize(14);
text(`three ready: ${!!three.renderer}`, 20, 50);
text(`model loaded: ${Object.keys(three.models).length}`, 20, 70);


  //background(0);

  if (!camStarted || !cam) {
    fill(255);
    textSize(16);
    text("Tap 'Start Camera' to begin", 20, 90);
    return;
  }

  //drawCameraCover(cam);

  // Scan box
const boxSize = Math.floor(Math.min(width, height) * 0.85);
const bx = Math.floor((width - boxSize) / 2);
const by = Math.floor((height - boxSize) / 2);


  noFill();
  stroke(0, 255, 0);
  rect(bx, by, boxSize, boxSize);

  fill(255);
  noStroke();
  textSize(16);
  text(`cvReady: ${cvReady}`, 20, 20);



// 先声明（让后面所有地方都能用）
let roi = null;
let roiFeats = null;
let resultROI = null;
let edgePixels = 0;

let src = null;
let gray = null;
let edges = null;

let topRects = [];   // 必须有默认值，否则 assignToTracks 会炸


if (lockMode) {
  // lock：不用重新算，直接用 freeze
  roi = freeze.roi;
  roiFeats = freeze.roiFeats;
  resultROI = freeze.resultROI;
  edgePixels = freeze.edgePixels;

  if (roi) image(roi, 20, height - 140, 120, 120);

  // ✅ lock 时也要给 topRects 一个来源：用 lockedRectA/B
  topRects = [];
  if (lockedRectA) topRects.push(lockedRectA);
  if (lockedRectB) topRects.push(lockedRectB);

} else {
  const roiSize = Math.min(320, cam.width, cam.height);
  roi = cam.get(
    Math.floor(cam.width / 2 - roiSize / 2),
    Math.floor(cam.height / 2 - roiSize / 2),
    roiSize,
    roiSize
  );

  // --- always get a live frame for marker pose (even in lockMode) ---
let poseImg = cam.get(
  Math.floor(cam.width/2 - 160),
  Math.floor(cam.height/2 - 160),
  320, 320
);

let srcPose = null;
if (cvReady && poseImg) {
  srcPose = cv.imread(poseImg.canvas);

  const quad = findMarkerQuad(srcPose);
  markerVisible = !!quad;

  if (quad) {
    const pose = estimatePoseFromQuad(quad, srcPose.cols, srcPose.rows);
    if (pose) {
      if (markerPose) { markerPose.rvec.delete(); markerPose.tvec.delete(); markerPose.R.delete(); }
      markerPose = pose;
      applyPoseToThreeCamera(markerPose);
    }
  }

  srcPose.delete();
}

  image(roi, 20, height - 140, 120, 120);

  roiFeats = extractFeaturesFromP5Image(roi);
  resultROI = classifyOrganism(
    roiFeats.warmth,
    roiFeats.brightness,
    roiFeats.straightness,
    roiFeats.smoothness
  );

  src = cv.imread(roi.canvas);
  gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  edges = new cv.Mat();
  cv.Canny(gray, edges, 50, 150);

  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel);
  kernel.delete();

  edgePixels = cv.countNonZero(edges);

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const edgesCopy = edges.clone();

  cv.findContours(edgesCopy, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  let rects = [];
  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    const r = cv.boundingRect(cnt);
    const area = r.width * r.height;
    if (area > 300) rects.push({ rect: r, area });
    cnt.delete();
  }

  rects.sort((a, b) => b.area - a.area);
  topRects = pickTopRectsNonOverlapping(rects.map(o => o.rect), 2, 0.35);
  topRects = filterDuplicateRects(topRects, 22);

  edgesCopy.delete();
contours.delete();
hierarchy.delete();


  // ✅ 写入 freeze（给 lock 用）
  freeze.roi = roi;
  freeze.roiFeats = roiFeats;
  freeze.resultROI = resultROI;
  freeze.edgePixels = edgePixels;

  // ✅ lockMode 但 freeze 还没准备好：直接跳过本帧
if (!roi) {
  fill(255, 80, 80);
  textSize(14);
  text("freeze.roi is null (wait 1-2 frames then lock)", 20, 140);
  return;
}

}



if (!lockMode) {
  const assigned = assignToTracks(topRects, trackA, trackB);
  trackA = smoothRect(trackA, assigned.A, SMOOTH);
  trackB = smoothRect(trackB, assigned.B, SMOOTH);
}


// ===== Marker pose update (每帧都做，lock 也要做) =====
markerVisible = false;

if (src) {  // ✅ 没有 src（lockMode）就跳过 marker 检测
  const quad = findMarkerQuad(src);
  if (quad) {
    markerVisible = true;
    const pose = estimatePoseFromQuad(quad, src.cols, src.rows);
    if (pose) {
      if (markerPose) {
        markerPose.rvec.delete();
        markerPose.tvec.delete();
        markerPose.R.delete();
      }
      markerPose = pose;
      applyPoseToThreeCamera(markerPose);
    }
  }
}


fill(255);
textSize(14);
text(`marker: ${markerVisible}`, 20, 110);


if (!lockMode && roi) {
  updateSpawnFromTracks(bx, by, boxSize, roi.width, roi.height);
}


  // C) stable rects -> objects
  let objects = [];
  const stableRects = [];
  if (lockMode) {
    if (lockedRectA) stableRects.push(lockedRectA);
    if (lockedRectB) stableRects.push(lockedRectB);
} else {
    if (trackA) stableRects.push(trackA);
    if (trackB) stableRects.push(trackB);
}


  for (let i = 0; i < stableRects.length; i++) {
    const r = stableRects[i];

    const rx = clampInt(r.x, 0, roi.width - 1);
    const ry = clampInt(r.y, 0, roi.height - 1);
    const rw = clampInt(r.width, 1, roi.width - rx);
    const rh = clampInt(r.height, 1, roi.height - ry);

    const sub = roi.get(rx, ry, rw, rh);
    const feats = extractFeaturesFromP5Image(sub);
    const res = classifyOrganism(feats.warmth, feats.brightness, feats.straightness, feats.smoothness);

    objects.push({
      rect: { x: rx, y: ry, width: rw, height: rh },
      organism: res.organism,
      confidence: res.confidence,
      score: res.score,
      feats
    });
  }

  // =========================
// D) UI panel (foldable)
// =========================
const uiX = 12;
const uiY = 12;
const pad = 10;
const fontSize = 12;
const lineH = 16;

textSize(fontSize);
textFont("monospace");
noStroke();

const safeFeats = roiFeats || {
  warmth: 0, brightness: 0, straightness: 0, texture: 0, smoothness: 0, lineCount: 0
};

const safeRes = resultROI || {
  organism: "NA",
  confidence: 0,
  score: { Tendril: 0, GlyphLight: 0, CrystalShell: 0, Jelly: 0, SporeCloud: 0 }
};

const uiLines = [
  `cvReady: ${cvReady}`,
  `marker: ${markerVisible}`,
  `edgePixels(ROI): ${edgePixels}`,
  `warmth (R-B): ${safeFeats.warmth.toFixed(1)}`,
  `brightness: ${safeFeats.brightness.toFixed(2)}`,
  `straightness: ${safeFeats.straightness.toFixed(2)} (lines: ${safeFeats.lineCount})`,
  `texture: ${safeFeats.texture.toFixed(2)}  smoothness: ${safeFeats.smoothness.toFixed(2)}`,
  `ROI organism: ${safeRes.organism}`,
  `ROI confidence: ${safeRes.confidence.toFixed(2)}`,
  `Tendril: ${safeRes.score.Tendril.toFixed(2)}`,
  `Glyph:   ${safeRes.score.GlyphLight.toFixed(2)}`,
  `Crystal: ${safeRes.score.CrystalShell.toFixed(2)}`,
  `Jelly:   ${safeRes.score.Jelly.toFixed(2)}`,
  `Spore:   ${safeRes.score.SporeCloud.toFixed(2)}`,
  `matType: ${currentMatType}`,
  `matInfo: ${currentMatInfo}`,
];

// ✅ fold
const drawLines = uiState.collapsed ? uiLines.slice(0, uiState.showN) : uiLines;

// 背景宽高自适应
let maxW = 0;
for (const s of drawLines) maxW = Math.max(maxW, textWidth(s));
const panelW = maxW + pad * 2;
const panelH = drawLines.length * lineH + pad * 2;

fill(0, 140);
rect(uiX, uiY, panelW, panelH, 10);

fill(255);
let ty = uiY + pad + lineH - 4;
for (const s of drawLines) {
  text(s, uiX + pad, ty);
  ty += lineH;
}

  // E) draw boxes
  const scaleX = boxSize / roi.width;
  const scaleY = boxSize / roi.height;

  for (let i = 0; i < objects.length; i++) {
    const obj = objects[i];
    const r = obj.rect;

    const sx = bx + r.x * scaleX;
    const sy = by + r.y * scaleY;
    const sw = r.width * scaleX;
    const sh = r.height * scaleY;

    noFill();
    stroke(255, 0, 255);
    strokeWeight(2);
    rect(sx, sy, sw, sh);

    noStroke();
    fill(255, 0, 255);
    textSize(14);
    const label = (i === 0) ? "A" : "B";
    text(`${label}: ${obj.organism}`, sx, sy - 8);

  }

  // ✅ 只在每帧结束时更新一次稳定结果
if (!lockMode) {
  stableA = updateStable(stableA, objects[0] || null);
  stableB = updateStable(stableB, objects[1] || null);
}

// F) Apply fused model at spawn
if (three.ready) {
  let finalHit = null;

  const currentSpawnX = (spawn2D && spawn2D.ok) ? spawn2D.x : (bx + boxSize / 2);
  const currentSpawnY = (spawn2D && spawn2D.ok) ? spawn2D.y : (by + boxSize / 2);

  finalHit = lockMode ? lockedHit : screenToGround(currentSpawnX, currentSpawnY);

  const showA = lockMode
    ? lockedA
    : ((stableA.name && stableA.count >= STABLE_FRAMES) ? { organism: stableA.name, feats: stableA.feats } : null);

  const showB = lockMode
    ? lockedB
    : ((stableB.name && stableB.count >= STABLE_FRAMES) ? { organism: stableB.name, feats: stableB.feats } : null);

  // ✅ 只有一个物体时：用“同种融合”(A__A)
 const fuseName = fusionKey(showA?.organism, showB?.organism);

if (fuseName && finalHit) {
  const instF = ensureFusionInstance(fuseName);
if (!instF) {
  // 模型还没加载成功 or fuseName 不存在
  if (three.instF) three.instF.visible = false;
  return; // 或者直接跳过这一帧
}

instF.visible = true;
instF.position.copy(finalHit);


  instF.position.copy(finalHit);
  instF.position.y += 0.02; // 可选：抬一点避免贴地面穿模

  const featsF = mergeFeats(showA?.feats, showB?.feats);
  if (featsF) {
    const baseOrgForLook = showA?.organism || showB?.organism || "Tendril";

    const matType = chooseMaterialType(featsF, edgePixels);
    currentMatType = matType;

    applyAppearanceToModel(
      instF,
      makeAppearance(featsF, baseOrgForLook),
      matType
    );

    currentMatInfo = getMaterialInfo(instF);
  }
} else {
  if (three.instF) three.instF.visible = false;
}

}

  // =====================
  // Debug draw: 2D spawn marker
  // =====================
  if (DEBUG_SPAWN && spawn2D.ok) {
    push();
    stroke(255, 0, 255);
    strokeWeight(3);
    noFill();
    // 圆圈
    circle(spawn2D.x, spawn2D.y, 18);
    // 十字
    line(spawn2D.x - 14, spawn2D.y, spawn2D.x + 14, spawn2D.y);
    line(spawn2D.x, spawn2D.y - 14, spawn2D.x, spawn2D.y + 14);

    noStroke();
    fill(255, 0, 255);
    textSize(14);
    text("spawn", spawn2D.x + 10, spawn2D.y - 10);
    pop();
  }

// --- always get a live frame for marker pose (even in lockMode) ---
let poseImg = cam.get(
  Math.floor(cam.width/2 - 160),
  Math.floor(cam.height/2 - 160),
  320, 320
);

let srcPose = null;
if (cvReady && poseImg) {
  srcPose = cv.imread(poseImg.canvas);

  const quad = findMarkerQuad(srcPose);
  markerVisible = !!quad;

  if (quad) {
    const pose = estimatePoseFromQuad(quad, srcPose.cols, srcPose.rows);
    if (pose) {
      if (markerPose) { markerPose.rvec.delete(); markerPose.tvec.delete(); markerPose.R.delete(); }
      markerPose = pose;
      applyPoseToThreeCamera(markerPose);
    }
  }

  srcPose.delete();
}


  // Render three
  if (three.ready) three.renderer.render(three.scene, three.camera);

// === 统一旋转和最终渲染 (放在 draw 结束前最后一步) ===
  if (three.ready) {
    let a = THREE.MathUtils.degToRad(rawOrientation.alpha);
    let b = THREE.MathUtils.degToRad(rawOrientation.beta);
    let g = THREE.MathUtils.degToRad(rawOrientation.gamma);

  }

  // 清理 OpenCV 内存
  if (src) src.delete();
if (gray) gray.delete();
if (edges) edges.delete();

} // 这是 draw 函数的结束括号


function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  if (three.renderer && three.camera) {
    three.renderer.setSize(windowWidth, windowHeight);
    three.camera.aspect = windowWidth / windowHeight;
    three.camera.updateProjectionMatrix();
  }
}

// =====================
// Helpers: camera cover
// =====================
function drawCameraCover(video) {
  const vw = video.width;
  const vh = video.height;
  if (!vw || !vh) return;

  const canvasRatio = width / height;
  const videoRatio = vw / vh;

  let drawW, drawH;
  if (videoRatio > canvasRatio) {
    drawH = height;
    drawW = height * videoRatio;
  } else {
    drawW = width;
    drawH = width / videoRatio;
  }

  const x = (width - drawW) / 2;
  const y = (height - drawH) / 2;
  image(video, x, y, drawW, drawH);
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}
function clampInt(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v | 0));
}

// =====================
// Rect utilities
// =====================
function rectCenter(r) {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}
function dist2(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function filterDuplicateRects(rects, thresholdPx) {
  const t2 = thresholdPx * thresholdPx;
  let out = [];
  for (const r of rects) {
    let keep = true;
    for (const rr of out) {
      if (dist2(rectCenter(r), rectCenter(rr)) < t2) {
        keep = false;
        break;
      }
    }
    if (keep) out.push(r);
  }
  return out;
}

function rectIoU(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);

  const w = Math.max(0, x2 - x1);
  const h = Math.max(0, y2 - y1);
  const inter = w * h;

  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  const union = areaA + areaB - inter;

  if (union <= 0) return 0;
  return inter / union;
}

function pickTopRectsNonOverlapping(rects, k = 2, iouTh = 0.35) {
  const picked = [];
  for (const r of rects) {
    let ok = true;
    for (const p of picked) {
      if (rectIoU(r, p) > iouTh) {
        ok = false;
        break;
      }
    }
    if (ok) picked.push(r);
    if (picked.length >= k) break;
  }
  return picked;
}

// =====================
// Step2: assign to tracks
// =====================
function assignToTracks(rects, prevA, prevB) {
  if (rects.length === 0) return { A: null, B: null };

  if (rects.length === 1) {
    const r = rects[0];

    if (!prevA && !prevB) return { A: r, B: null };
    if (prevA && !prevB) return { A: r, B: null };
    if (!prevA && prevB) return { A: null, B: r };

    const c = rectCenter(r);
    const da = dist2(c, rectCenter(prevA));
    const db = dist2(c, rectCenter(prevB));
    return (da <= db) ? { A: r, B: null } : { A: null, B: r };
  }

  const r0 = rects[0], r1 = rects[1];

  if (!prevA && !prevB) return { A: r0, B: r1 };

  const c0 = rectCenter(r0);
  const c1 = rectCenter(r1);

  const a = prevA ? rectCenter(prevA) : null;
  const b = prevB ? rectCenter(prevB) : null;

  const cost01 = (a ? dist2(c0, a) : 0) + (b ? dist2(c1, b) : 0);
  const cost10 = (a ? dist2(c1, a) : 0) + (b ? dist2(c0, b) : 0);

  return (cost01 <= cost10) ? { A: r0, B: r1 } : { A: r1, B: r0 };
}

// Step3: EMA smoothing
function smoothRect(prev, curr, alpha = 0.25) {
  if (!curr) return null;
  if (!prev) return { ...curr };

  return {
    x: prev.x + (curr.x - prev.x) * alpha,
    y: prev.y + (curr.y - prev.y) * alpha,
    width: prev.width + (curr.width - prev.width) * alpha,
    height: prev.height + (curr.height - prev.height) * alpha
  };
}

// =====================
// Feature extraction
// =====================
function extractFeaturesFromP5Image(img) {
  img.loadPixels();

  let rSum = 0, gSum = 0, bSum = 0;
  const total = img.width * img.height;

  for (let i = 0; i < img.pixels.length; i += 4) {
    rSum += img.pixels[i];
    gSum += img.pixels[i + 1];
    bSum += img.pixels[i + 2];
  }

  const rAvg = rSum / total;
  const gAvg = gSum / total;
  const bAvg = bSum / total;

  const warmth = rAvg - bAvg;
  const brightness = (0.299 * rAvg + 0.587 * gAvg + 0.114 * bAvg) / 255.0;

  const src = cv.imread(img.canvas);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  const edges = new cv.Mat();
  cv.Canny(gray, edges, 50, 150);

  const lines = new cv.Mat();
  cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 50, 20, 5);
  const lineCount = lines.rows;
  const straightness = clamp01(lineCount / 30);

  const lap = new cv.Mat();
  cv.Laplacian(gray, lap, cv.CV_64F);

  const mean = new cv.Mat();
  const stddev = new cv.Mat();
  cv.meanStdDev(lap, mean, stddev);

  const textureVar = stddev.doubleAt(0, 0) * stddev.doubleAt(0, 0);
  const texture = clamp01(textureVar / TEXTURE_MAX);
  const smoothness = 1 - texture;

  src.delete();
  gray.delete();
  edges.delete();
  lines.delete();
  lap.delete();
  mean.delete();
  stddev.delete();

  return { warmth, brightness, straightness, texture, smoothness, lineCount };
}

// =====================
// Organism classification
// =====================
function classifyOrganism(warmth, brightness, straightness, smoothness) {
  const W = clamp01((warmth + 60) / 120);
  const B = clamp01(brightness);
  const S = clamp01(straightness);
  const M = clamp01(smoothness);

  const score = {
    Tendril:      0.55 * W     + 0.25 * (1 - S) + 0.20 * (1 - M),
    GlyphLight:   0.55 * (1-W) + 0.35 * S       + 0.10 * B,
    CrystalShell: 0.45 * (1-W) + 0.35 * M       + 0.20 * B,
    Jelly:        0.45 * M     + 0.35 * (1 - S) + 0.20 * (1 - B),
    SporeCloud:   0.50 * (1-B) + 0.30 * (1 - M) + 0.20 * (1 - S),
  };

  let bestName = "Tendril";
  let bestScore = -1;
  let secondScore = -1;

  for (const [name, sc] of Object.entries(score)) {
    if (sc > bestScore) {
      secondScore = bestScore;
      bestScore = sc;
      bestName = name;
    } else if (sc > secondScore) {
      secondScore = sc;
    }
  }

  const confidence = clamp01((bestScore - secondScore) / 0.6);
  return { organism: bestName, confidence, score };
}

// =====================
// Material mapping + apply
// =====================
function normWarmth(warmthRB) {
  return clamp01((warmthRB + 60) / 120);
}

function lerpRGB(a, b, t) {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t)
  };
}

function makeAppearance(feats, organism) {
  const W = normWarmth(feats.warmth);
  const B = clamp01(feats.brightness);
  const S = clamp01(feats.straightness);
  const M = clamp01(feats.smoothness);

  // 更“冷光 + 忧郁”的两端：蓝紫 ↔ 粉琥珀（避免绿）
const cold = { r: 120, g: 160, b: 255 };   // 冷蓝
const warm = { r: 255, g: 140, b: 210 };   // 粉紫 / 珠光感

let base = lerpRGB(cold, warm, W);

// ✅ 再加一点变化：让不同“形态特征”带来不同色偏
// straightness 高 → 偏蓝紫；brightness 高 → 偏粉白
const tintA = lerpRGB({ r: 160, g: 130, b: 255 }, { r: 255, g: 220, b: 240 }, B);
base = lerpRGB(base, tintA, 0.35);

// ✅ 最终再压暗一点（保持你的 melancholy）
// ✅ Morandi：去饱和（加灰）+ 提亮（加白），不再压黑
const grey  = { r: 190, g: 195, b: 200 };   // 柔灰
const white = { r: 248, g: 248, b: 248 };   // 柔白

// 先往灰里靠（降低饱和）
let morandi = lerpRGB(base, grey, 0.45);    // 0.35~0.60 都可调

// 再轻轻提亮（避免“脏暗”）
morandi = lerpRGB(morandi, white, 0.18 + 0.22 * B);  // B 越亮越接近白

const base2 = morandi;


  let opacity = clamp01(0.35 + 0.55 * M);
  let roughness = clamp01(0.85 - 0.75 * M);
  let metalness = clamp01((1 - W) * 0.5 + S * 0.3 + M * 0.3);
  let emissiveStrength = clamp01(0.05 + 0.25 * (1 - W) + 0.15 * B);

  if (organism === "Tendril") {
    opacity = clamp01(opacity - 0.25);
    roughness = clamp01(roughness + 0.20);
    metalness = clamp01(metalness - 0.25);
    emissiveStrength = clamp01(emissiveStrength - 0.15);
  }
  if (organism === "Jelly") {
    opacity = clamp01(opacity + 0.20);
    roughness = clamp01(roughness - 0.25);
    metalness = clamp01(metalness - 0.30);
    emissiveStrength = clamp01(emissiveStrength + 0.05);
  }
  if (organism === "SporeCloud") {
    opacity = clamp01(opacity - 0.10);
    roughness = clamp01(roughness + 0.25);
    metalness = clamp01(metalness - 0.35);
    emissiveStrength = clamp01(emissiveStrength - 0.10);
  }
  if (organism === "CrystalShell") {
    opacity = clamp01(opacity + 0.10);
    roughness = clamp01(roughness - 0.35);
    metalness = clamp01(metalness + 0.35);
    emissiveStrength = clamp01(emissiveStrength + 0.25);
  }
  if (organism === "GlyphLight") {
    opacity = clamp01(opacity + 0.05);
    roughness = clamp01(roughness - 0.20);
    metalness = clamp01(metalness + 0.20);
    emissiveStrength = clamp01(emissiveStrength + 0.40);
  }

    return {
    baseColor: base2,
    opacity,
    roughness,
    metalness,

    // ✅ 不要再用 base2 当 emissive（它就是紫系来源）
    emissiveColor: { r: 220, g: 230, b: 255 },  // 冷白偏蓝
    emissiveStrength: clamp01(emissiveStrength * 0.18) // 大幅降低
  };

}

function applyAppearanceToModel(model, app, presetType = null) {
  if (!model) return;

  const preset = presetType ? getMaterialPreset(presetType) : null;

// ✅ 第一次：把 mesh 材质换成 MeshPhysicalMaterial + 写入顶点渐变（只做一次）
if (!model.userData._materialCloned) {
  const seed = (model.userData._fusionSeed ?? 12345);

  model.traverse((child) => {
    if (!child.isMesh) return;

    // 1) 取旧材质（可能是数组）
    const oldMats = Array.isArray(child.material) ? child.material : [child.material];

    // 2) 为每个旧材质创建新的 Physical 材质（保留贴图）
    const newMats = oldMats.map((old) => {
      const m = new THREE.MeshPhysicalMaterial({
        map: old?.map || null,
        normalMap: old?.normalMap || null,
        roughnessMap: old?.roughnessMap || null,
        metalnessMap: old?.metalnessMap || null,
        emissiveMap: old?.emissiveMap || null,
        aoMap: old?.aoMap || null,

        color: new THREE.Color(1, 1, 1),   // ✅ 不用单色盖掉顶点渐变
        vertexColors: true,                // ✅ 启用顶点颜色
        transparent: false
      });

      // 有些模型带 emissive / roughness 等初值，也可以继承
      if (old && "roughness" in old) m.roughness = old.roughness;
      if (old && "metalness" in old) m.metalness = old.metalness;

      return m;
    });

    // 3) 写回材质（保持数组结构）
    child.material = Array.isArray(child.material) ? newMats : newMats[0];

    // 4) 写入顶点渐变（对 geometry）
    applyVertexGradient(child, seed + (child.id % 9999));

    // 5) 更新
    child.material.needsUpdate = true;
  });

  model.userData._materialCloned = true;
}



    model.traverse((child) => {
    if (!child.isMesh || !child.material) return;

    const mats = Array.isArray(child.material) ? child.material : [child.material];

    for (const mat of mats) {
      if (!mat) continue;

      // ✅ 顶点色必须开 + baseColor 不要盖掉渐变
      mat.vertexColors = true;
      if (mat.color) mat.color.setRGB(1, 1, 1);

      // 默认用 app
      mat.transparent = false;
      mat.opacity = 1.0;
      mat.roughness = app.roughness;
      mat.metalness = app.metalness;

      // 叠加 preset（玻璃/金属/珍珠/陶土/雾）
      if (preset) {
        const isTrans = (presetType === "glass" || presetType === "foggy");
        mat.transparent = isTrans;
        mat.opacity = 1.0;

        mat.roughness = preset.roughness;
        mat.metalness = preset.metalness;

        mat.transmission = isTrans ? (preset.transmission ?? 0.0) : 0.0;
        mat.thickness    = isTrans ? (preset.thickness ?? 0.0) : 0.0;
        mat.ior          = isTrans ? (preset.ior ?? 1.0) : 1.0;

        mat.clearcoat = preset.clearcoat ?? 0.0;
        mat.clearcoatRoughness = preset.clearcoatRoughness ?? 0.0;

        if ("iridescence" in mat && preset.iridescence != null) {
          mat.iridescence = preset.iridescence;
          mat.iridescenceIOR = preset.iridescenceIOR ?? 1.3;
          if ("iridescenceThicknessRange" in mat && preset.iridescenceThicknessRange) {
            mat.iridescenceThicknessRange = preset.iridescenceThicknessRange;
          }
        }
      } else {
        mat.transmission = 0.0;
        mat.thickness = 0.0;
        mat.clearcoat = 0.0;

        //  Morandi clamp：统一变浅 + 低饱和 + 不发黑
        mat.roughness = Math.max(mat.roughness, 0.55); 
        mat.metalness = Math.min(mat.metalness, 0.25); 
        mat.envMapIntensity = 0.6;                     

      }

      // emissive 用“冷白弱光”，别用紫系染色
      if (mat.emissive) {
        mat.emissive.setRGB(app.emissiveColor.r / 255, app.emissiveColor.g / 255, app.emissiveColor.b / 255);
        mat.emissiveIntensity = app.emissiveStrength + (preset?.emissiveBoost || 0);
      }

      mat.needsUpdate = true;
    }
  });
}


function screenToGround(sx, sy) {
  const mouse = new THREE.Vector2();
  mouse.x = (sx / window.innerWidth) * 2 - 1;
  mouse.y = -(sy / window.innerHeight) * 2 + 1;

  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, three.camera);

  const targetPoint = new THREE.Vector3();
  // 关键：在 3D 空间中寻找射线与 Y=0 平面（地面）的交点
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const ok = raycaster.ray.intersectPlane(groundPlane, targetPoint);
  
  if (ok) {
    return targetPoint;
  } else {
    // 如果没射到地面，就放在相机前方 3 米远的世界坐标点
    const fallback = new THREE.Vector3();
    raycaster.ray.at(3, fallback); 
    return fallback;
  }
}

function orderCorners(pts) {
  // pts: [{x,y} * 4]
  // 按 TL, TR, BR, BL 排序
  const sum = pts.map(p => p.x + p.y);
  const diff = pts.map(p => p.x - p.y);

  const tl = pts[sum.indexOf(Math.min(...sum))];
  const br = pts[sum.indexOf(Math.max(...sum))];
  const tr = pts[diff.indexOf(Math.max(...diff))];
  const bl = pts[diff.indexOf(Math.min(...diff))];

  return [tl, tr, br, bl];
}

function findMarkerQuad(srcRGBA) {
  // srcRGBA: cv.Mat RGBA
  const gray = new cv.Mat();
  cv.cvtColor(srcRGBA, gray, cv.COLOR_RGBA2GRAY);

  const blur = new cv.Mat();
  cv.GaussianBlur(gray, blur, new cv.Size(5,5), 0);

  const edges = new cv.Mat();
  cv.Canny(blur, edges, 60, 160);

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  let best = null;
  let bestArea = 0;

  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    const area = cv.contourArea(cnt);
    if (area < 1500) { cnt.delete(); continue; }

    const peri = cv.arcLength(cnt, true);
    const approx = new cv.Mat();
    cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

    if (approx.rows === 4 && cv.isContourConvex(approx)) {
      // 取四个点
      const pts = [];
      for (let k = 0; k < 4; k++) {
        const x = approx.intAt(k, 0);
        const y = approx.intAt(k, 1);
        pts.push({ x, y });
      }

      // 粗略筛选：接近正方形（宽高比）
      const rect = cv.boundingRect(approx);
      const ratio = rect.width / rect.height;
      if (ratio > 0.7 && ratio < 1.3) {
        if (area > bestArea) {
          bestArea = area;
          best = pts;
        }
      }
    }

    approx.delete();
    cnt.delete();
  }

   // ✅ 清理 OpenCV 内存（findMarkerQuad 内部自己创建的才 delete）
  gray.delete();
  blur.delete();
  edges.delete();
  contours.delete();
  hierarchy.delete();


  if (!best) return null;
  return orderCorners(best); // TL TR BR BL
}

function buildCameraMatrix(w, h, fovDeg = 60) {
  // 用 three 的 FOV 近似相机内参
  const fov = (fovDeg * Math.PI) / 180;
  const fy = (h / 2) / Math.tan(fov / 2);
  const fx = fy;
  const cx = w / 2;
  const cy = h / 2;

  const K = cv.matFromArray(3, 3, cv.CV_64F, [
    fx, 0,  cx,
    0,  fy, cy,
    0,  0,  1
  ]);
  return K;
}

function estimatePoseFromQuad(quad, imgW, imgH) {
  // quad: TL TR BR BL, in image pixel coords
  const half = MARKER_SIZE_M / 2;

  // marker 在自身坐标系的 4 个角（单位：米）
  const objPts = cv.matFromArray(4, 3, cv.CV_64F, [
    -half,  half, 0,   // TL
     half,  half, 0,   // TR
     half, -half, 0,   // BR
    -half, -half, 0    // BL
  ]);

  const imgPts = cv.matFromArray(4, 2, cv.CV_64F, [
    quad[0].x, quad[0].y,
    quad[1].x, quad[1].y,
    quad[2].x, quad[2].y,
    quad[3].x, quad[3].y
  ]);

  const K = buildCameraMatrix(imgW, imgH, 60);
  const dist = cv.Mat.zeros(4, 1, cv.CV_64F); // 先假设无畸变

  const rvec = new cv.Mat();
  const tvec = new cv.Mat();

  const ok = cv.solvePnP(objPts, imgPts, K, dist, rvec, tvec, false, cv.SOLVEPNP_ITERATIVE);

  objPts.delete(); imgPts.delete(); K.delete(); dist.delete();

  if (!ok) { rvec.delete(); tvec.delete(); return null; }

  // rvec -> R
  const R = new cv.Mat();
  cv.Rodrigues(rvec, R);

  return { rvec, tvec, R };
}

// OpenCV坐标 -> Three坐标 纠正矩阵（y翻转 + z翻转）
const CV_TO_THREE = new THREE.Matrix4().set(
  1, 0, 0, 0,
  0,-1, 0, 0,
  0, 0,-1, 0,
  0, 0, 0, 1
);

function applyPoseToThreeCamera(pose) {
  const R = pose.R;    // 3x3
  const t = pose.tvec; // 3x1

  const r00 = R.doubleAt(0,0), r01 = R.doubleAt(0,1), r02 = R.doubleAt(0,2);
  const r10 = R.doubleAt(1,0), r11 = R.doubleAt(1,1), r12 = R.doubleAt(1,2);
  const r20 = R.doubleAt(2,0), r21 = R.doubleAt(2,1), r22 = R.doubleAt(2,2);

  const tx = t.doubleAt(0,0);
  const ty = t.doubleAt(1,0);
  const tz = t.doubleAt(2,0);

  // OpenCV: X右 Y下 Z前
  const mCV = new THREE.Matrix4().set(
    r00, r01, r02, tx,
    r10, r11, r12, ty,
    r20, r21, r22, tz,
    0,   0,   0,   1
  );

  // 转到 three 坐标
  const mThree = new THREE.Matrix4().multiplyMatrices(CV_TO_THREE, mCV);

  // 这里我们让 camera 跟随 pose（camera 相对 marker）
  three.camera.matrixAutoUpdate = false;
  three.camera.matrix.copy(mThree);

  // three 需要更新 inverse
  three.camera.matrixWorld.copy(three.camera.matrix);
  three.camera.matrixWorldInverse.copy(three.camera.matrix).invert();
}

function getMaterialPreset(type) {
  switch (type) {
    case "glass": // 透明玻璃
      return {
        transmission: 1.0,
        ior: 1.45,
        thickness: 0.12,
        roughness: 0.03,
        metalness: 0.0,
        opacity: 1.0,
        clearcoat: 1.0,
        clearcoatRoughness: 0.04,
        emissiveBoost: 0.0
      };

    case "metal": // ✅ Morandi satin metal (not pure black)
    return {
    transmission: 0.0,
    ior: 1.0,
    thickness: 0.0,
    roughness: 0.65,   // ✅ 更糙=更柔和
    metalness: 0.18,   // ✅ 关键：不要 1.0（没 env 会黑）
    opacity: 1.0,
    clearcoat: 0.35,
    clearcoatRoughness: 0.55,
    emissiveBoost: 0.03
  };


    case "pearl": // 珍珠 / 珠光
      return {
        transmission: 0.0,
        ior: 1.3,
        thickness: 0.0,
        roughness: 0.25,
        metalness: 0.15,
        opacity: 1.0,
        clearcoat: 1.0,
        clearcoatRoughness: 0.08,
        iridescence: 1.0,
        iridescenceIOR: 1.3,
        iridescenceThicknessRange: [120, 420],
        emissiveBoost: 0.0
      };

    case "clay": // 哑光陶土
      return {
        transmission: 0.0,
        ior: 1.0,
        thickness: 0.0,
        roughness: 0.92,
        metalness: 0.0,
        opacity: 1.0,
        clearcoat: 0.0,
        clearcoatRoughness: 1.0,
        emissiveBoost: 0.0
      };

    case "foggy": // 半透明雾蒙蒙（磨砂乳白）
      return {
        transmission: 0.65,
        ior: 1.25,
        thickness: 0.28,
        roughness: 0.65,
        metalness: 0.0,
        opacity: 1.0,
        clearcoat: 0.15,
        clearcoatRoughness: 0.55,
        emissiveBoost: 0.05
      };
  }
  return null;
}

function chooseMaterialType(featsF, edgePixels = 0) {
  if (!featsF) return "clay";

  const B = clamp01(featsF.brightness);   // 0-1
  const S = clamp01(featsF.straightness); // 0-1
  const M = clamp01(featsF.smoothness);   // 0-1
  const W = clamp01((featsF.warmth + 60) / 120); // 0-1（你已有 normWarmth 也行）

  // 规则（你可以之后微调阈值）
  // 1) 很亮 + 很光滑 => 玻璃
  if (B > 0.68 && M > 0.70 && S < 0.55) return "glass";

  // 2) 线性/结构感强（很多直线）=> 金属
  if (S > 0.65 && B > 0.45) return "metal";

  // 3) 亮 + 中等光滑 + 不太直 => 珍珠
  if (B > 0.55 && M > 0.55 && S < 0.55) return "pearl";

  // 4) 不亮但光滑 => 雾蒙蒙半透
  if (B < 0.55 && M > 0.65) return "foggy";

  // 5) 其它：更粗糙、偏暖 => 陶土
  return "clay";
}

function getMaterialInfo(model) {
  if (!model) return "no model";

  let firstMat = null;
  model.traverse((c) => {
    if (!firstMat && c.isMesh && c.material) firstMat = c.material;
  });
  if (!firstMat) return "no material";

  const m = firstMat;

  const type = m.type || "unknown";
  const hasMap = !!m.map;

  const tr = ("transmission" in m) ? Number(m.transmission).toFixed(2) : "NA";
  const ro = ("roughness" in m) ? Number(m.roughness).toFixed(2) : "NA";
  const me = ("metalness" in m) ? Number(m.metalness).toFixed(2) : "NA";
  const op = ("opacity" in m) ? Number(m.opacity).toFixed(2) : "NA";

  const iri = ("iridescence" in m) ? Number(m.iridescence).toFixed(2) : "NA";

  return `${type} map:${hasMap} tr:${tr} ro:${ro} me:${me} op:${op} iri:${iri}`;
}

function seededRand(seed) {
  // 简单可复现随机：0~1
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}

function applyVertexGradient(mesh, seed = 1234) {
  const geo = mesh.geometry;
  if (!geo || !geo.attributes || !geo.attributes.position) return;

  geo.computeBoundingBox();
  const bbox = geo.boundingBox;
  const size = new THREE.Vector3();
  bbox.getSize(size);

  const pos = geo.attributes.position;
  const count = pos.count;

  // 确保 color attribute
  let col = geo.getAttribute("color");
  if (!col || col.count !== count) {
    col = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    geo.setAttribute("color", col);
  }

  // ✅ Pastel + pearly palette（整体偏浅、冷雾感；紫色只做点缀）
const PALETTE = [
  // blues / cyans
  new THREE.Color("#D6ECFF"), // baby blue
  new THREE.Color("#C7F0FF"), // pale cyan
  new THREE.Color("#BFE7FF"), // sky mist

  // greens
  new THREE.Color("#C9F2E3"), // mint
  new THREE.Color("#B9E6D4"), // mint green
  new THREE.Color("#C7DCCF"), // sage / grey-green
  new THREE.Color("#BFD0C2"), // grey-green deeper (still light)

  // neutrals (silver / pearl white)
  new THREE.Color("#F2F6FA"), // pearl white (cool)
  new THREE.Color("#E6EDF3"), // silver-ish cool gray
  new THREE.Color("#D7DEE7"), // silver gray

  // warm accents (soft)
  new THREE.Color("#FFE4EE"), // watery pink (very light)
  new THREE.Color("#FFD1DE"), // soft rose
  new THREE.Color("#FFF2C7"), // soft buttery yellow
  new THREE.Color("#FFE8B0"), // gentle warm yellow

  // purple accents (rare)
  new THREE.Color("#C8C1FF"), // lavender
  new THREE.Color("#7D6BFF"), // grape purple
];


  function seededRandLocal(s) {
    s = (s * 1664525 + 1013904223) >>> 0;
    return [s, s / 4294967296];
  }

  function pickPaletteColor(rand01) {
  // 对应上面 PALETTE 的权重（越大越常出现）
  const weights = [
    1.10, // baby blue
    1.05, // pale cyan
    1.00, // sky mist

    1.25, // mint
    1.20, // mint green
    1.20, // sage
    1.05, // grey-green deeper

    1.35, // pearl white
    1.20, // silver-ish cool gray
    1.05, // silver gray

    0.85, // watery pink
    0.75, // soft rose
    0.70, // buttery yellow
    0.55, // gentle warm yellow

    0.22, // lavender (rare)
    0.12, // grape purple (very rare)
  ];

  let sum = 0;
  for (const w of weights) sum += w;

  let t = rand01 * sum;
  for (let i = 0; i < weights.length; i++) {
    t -= weights[i];
    if (t <= 0) return PALETTE[i].clone();
  }
  return PALETTE[0].clone();
}


  // ✅ 生成多个“色云 blob”
  let s = seed >>> 0;
  const blobs = [];
  const blobN = 6; // 比你原来 4 个多一点，颜色会更丰富

  for (let i = 0; i < blobN; i++) {
    let r;
    [s, r] = seededRandLocal(s); const rx = r;
    [s, r] = seededRandLocal(s); const ry = r;
    [s, r] = seededRandLocal(s); const rz = r;

    const cx = bbox.min.x + rx * size.x;
    const cy = bbox.min.y + ry * size.y;
    const cz = bbox.min.z + rz * size.z;

    [s, r] = seededRandLocal(s);
    const radius = (0.18 + 0.55 * r) * Math.max(size.x, size.y, size.z); // 多尺度

    // ✅ 从 palette 抽两种颜色，再插值，得到 blob 自己的颜色
    [s, r] = seededRandLocal(s);
    const cA = pickPaletteColor(r);

    [s, r] = seededRandLocal(s);
    const cB = pickPaletteColor(r);

    [s, r] = seededRandLocal(s);
    const c = cA.lerp(cB, r);

    blobs.push({ center: new THREE.Vector3(cx, cy, cz), r: radius, color: c });
  }

  const p = new THREE.Vector3();
  const out = new THREE.Color();

  for (let i = 0; i < count; i++) {
    p.fromBufferAttribute(pos, i);

    out.setRGB(0.9, 0.96, 0.92);


    // 云团叠加
    for (const b of blobs) {
      const d = p.distanceTo(b.center);
      const w = Math.max(0, 1 - d / b.r);
      if (w > 0) out.lerp(b.color, w * 0.95);


    }

    // ✅ 加一点整体“上亮下暗”的冷白漂白（更像生物发光/雾）
    const ny = size.y > 0 ? (p.y - bbox.min.y) / size.y : 0.5;
    out.lerp(new THREE.Color(0.90, 0.88, 1.00), 0.18 * ny);

    out.lerp(new THREE.Color(1, 1, 1), 0.22);

    col.setXYZ(i, out.r, out.g, out.b);
  }

  col.needsUpdate = true;
}

function hashStringToSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
