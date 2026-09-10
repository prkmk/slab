(() => {
  const profileCanvas = document.getElementById("profileCanvas");
  const viewCanvas = document.getElementById("viewCanvas");
  const latticeCanvas = document.getElementById("latticeCanvas");
  const profilePane = document.getElementById("profilePane");
  const heightInput = document.getElementById("heightInput");
  const segmentsInput = document.getElementById("segments");
  const smoothInput = document.getElementById("smoothInput");
  const smoothValue = document.getElementById("smoothValue");
  const snapInput = document.getElementById("snapInput");
  const snapToggle = document.getElementById("snapToggle");
  const printBase = document.getElementById("printBase");
  const printSide = document.getElementById("printSide");
  const printCap = document.getElementById("printCap");
  const printAllSides = document.getElementById("printAllSides");
  const paperOrientation = document.getElementById("paperOrientation");
  const a4GuideToggle = document.getElementById("a4GuideToggle");
  const printButton = document.getElementById("printButton");
  const traceButton = document.getElementById("traceButton");
  const traceClose = document.getElementById("traceClose");
  const screenScaleInput = document.getElementById("screenScaleInput");
  const calibrateButton = document.getElementById("calibrateButton");
  const status = document.getElementById("profileStatus");

  const latticePan = {
    x: 0, y: 0, dragging: false, lastX: 0, lastY: 0,
    pointers: new Map(), pinchStartDistance: 0, pinchStartZoom: 1
  };
  let traceZoom = 1;

  const pctx = profileCanvas.getContext("2d");
  const vctx = viewCanvas.getContext("2d");
  const lctx = latticeCanvas.getContext("2d");

  // Profile coordinates use:
  // x = radius from the vertical axis
  // y = height above the base
  let profile = [
    { x: 120, y: 0 },
    { x: 120, y: 180 }
  ];

  // Projected 3D faces used for touch hit-testing. A touch that starts on
  // the object rotates it; a touch that starts elsewhere is left to the
  // browser so the page can scroll normally.
  let viewHitPolygons = [];

  // The design is small enough to live directly in the URL hash. We store
  // only the geometry: segment count, smoothing, and profile point x/y.
  // Height is therefore implicit in the final point's y coordinate.
  function saveStateToURL() {
    const n = Math.max(3, Math.min(128, Math.round(Number(segmentsInput.value) || 12)));
    const smooth = Math.max(0, Math.min(100, Math.round(Number(smoothInput.value) || 0)));
    const points = profile.map(p =>
      (Math.round(p.x * 100) / 100) + ',' + (Math.round(p.y * 100) / 100)
    ).join('|');
    const hash = '#v1;n=' + n + '&s=' + smooth + '&p=' + encodeURIComponent(points);
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }

  function loadStateFromURL() {
    if (!location.hash || !location.hash.startsWith('#v1;')) return false;
    try {
      const params = new URLSearchParams(location.hash.slice(4));
      const n = Number(params.get('n'));
      const smooth = Number(params.get('s'));
      const points = String(params.get('p') || '').split('|').map(pair => {
        const [x, y] = pair.split(',').map(Number);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Invalid point');
        return { x: Math.max(5, x), y: Math.max(0, y) };
      });

      if (!Number.isFinite(n) || n < 3 || n > 128 ||
          !Number.isFinite(smooth) || smooth < 0 || smooth > 100 ||
          points.length < 2) return false;

      points[0].y = 0;
      for (let i = 1; i < points.length; i++) {
        points[i].y = Math.max(points[i].y, points[i - 1].y + 1);
      }

      profile = points;
      segmentsInput.value = Math.round(n);
      smoothInput.value = Math.round(smooth);
      smoothValue.textContent = smoothInput.value;
      heightInput.value = Math.round(points[points.length - 1].y);
      return true;
    } catch (_) {
      return false;
    }
  }

  let dragIndex = -1;
  let dragOffset = { x: 0, y: 0 };

  const view = {
    yaw: -0.55,
    pitch: 0.28,
    zoom: 1,
    dragging: false,
    lastX: 0,
    lastY: 0
  };

  function resizeCanvas(canvas, ctx) {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function resize() {
    resizeCanvas(profileCanvas, pctx);
    resizeCanvas(viewCanvas, vctx);
    resizeCanvas(latticeCanvas, lctx);
    redrawAll();
  }

  window.addEventListener("resize", resize);

  function dimensions() {
    return {
      width: profileCanvas.clientWidth,
      height: profileCanvas.clientHeight
    };
  }

  // Profile drawing area.
  function profileTransform() {
    const { width, height } = dimensions();
    const maxRadius = Math.max(180, ...profile.map(p => p.x));
    const maxY = Math.max(180, ...profile.map(p => p.y));

    const left = 60;
    const right = width - 35;
    const top = 28;
    const bottom = height - 45;

    // Use the actual profile bounds rather than adding large vertical and
    // horizontal safety factors. This lets the profile fill the editor
    // height by default while retaining a small UI margin.
    const scale = Math.min(
      (right - left) / Math.max(maxRadius, 1),
      (bottom - top) / Math.max(maxY, 1)
    );

    return {
      ox: left,
      oy: bottom,
      scale
    };
  }

  function worldToScreen(p) {
    const t = profileTransform();
    return {
      x: t.ox + p.x * t.scale,
      y: t.oy - p.y * t.scale
    };
  }

  function screenToWorld(x, y) {
    const t = profileTransform();
    return {
      x: (x - t.ox) / t.scale,
      y: (t.oy - y) / t.scale
    };
  }

  // The control points are interpolation points: the rendered curve
  // passes through every one of them. Smoothing changes only the tangent
  // at each point; it never moves a control point.
  function curvePoint(segment, t, amount) {
    const a = profile[segment];
    const b = profile[segment + 1];

    if (amount <= 0 || profile.length < 3) {
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t
      };
    }

    const last = profile.length - 1;

    /*
      Tangents are deliberately constructed from the neighbouring
      SEGMENTS, rather than treating the endpoints as extra control
      points.

      At an endpoint, the tangent simply follows the segment connecting
      that endpoint to its neighbour. Therefore an endpoint cannot make
      the curve bend toward some imaginary point beyond the shape.

      At an interior point, the tangent is the direction halfway between
      the incoming and outgoing directions. Its magnitude is limited by
      the shorter adjacent segment, which prevents the large overshoot /
      looping behaviour of ordinary Catmull-Rom interpolation.
    */
    const tangent = i => {
      if (i === 0) {
        return {
          x: profile[1].x - profile[0].x,
          y: profile[1].y - profile[0].y
        };
      }

      if (i === last) {
        return {
          x: profile[last].x - profile[last - 1].x,
          y: profile[last].y - profile[last - 1].y
        };
      }

      const prev = profile[i - 1];
      const curr = profile[i];
      const next = profile[i + 1];

      const inX = curr.x - prev.x;
      const inY = curr.y - prev.y;
      const outX = next.x - curr.x;
      const outY = next.y - curr.y;

      const inLen = Math.hypot(inX, inY);
      const outLen = Math.hypot(outX, outY);

      if (inLen < 1e-6) return { x: outX, y: outY };
      if (outLen < 1e-6) return { x: inX, y: inY };

      // Average the two unit directions. This gives a tangent that
      // bisects the corner rather than pulling toward either endpoint.
      let dirX = inX / inLen + outX / outLen;
      let dirY = inY / inLen + outY / outLen;
      const dirLen = Math.hypot(dirX, dirY);

      // 180° reversal: there is no useful bisector, so keep the
      // tangent along the outgoing segment.
      if (dirLen < 1e-6) {
        dirX = outX / outLen;
        dirY = outY / outLen;
      } else {
        dirX /= dirLen;
        dirY /= dirLen;
      }

      const handleLength = Math.min(inLen, outLen);
      return {
        x: dirX * handleLength,
        y: dirY * handleLength
      };
    };

    const ta = tangent(segment);
    const tb = tangent(segment + 1);
    const k = amount / 100;

    // Cubic Hermite interpolation. At k=0 this is the original straight
    // segment; at k=1 it is a smooth curve passing through both points.
    const h00 =  2*t*t*t - 3*t*t + 1;
    const h10 =    t*t*t - 2*t*t + t;
    const h01 = -2*t*t*t + 3*t*t;
    const h11 =    t*t*t - t*t;

    return {
      x: h00*a.x + h10*ta.x*k + h01*b.x + h11*tb.x*k,
      y: h00*a.y + h10*ta.y*k + h01*b.y + h11*tb.y*k
    };
  }

  function renderedProfile() {
    const amount = Number(smoothInput.value);
    if (amount <= 0 || profile.length < 2) return profile.map(p => ({...p}));

    const result = [];
    const samples = 20;
    for (let i = 0; i < profile.length - 1; i++) {
      for (let j = 0; j < samples; j++) {
        result.push(curvePoint(i, j / samples, amount));
      }
    }
    result.push({...profile[profile.length - 1]});
    return result;
  }

  function drawProfilePath(ctx, closeToAxis = false) {
    const amount = Number(smoothInput.value);
    const points = profile.map(worldToScreen);
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);

    if (amount <= 0 || profile.length < 3) {
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    } else {
      // Draw the exact same sampled curve used by the 3D mesh.
      const samples = renderedProfile();
      for (let i = 1; i < samples.length; i++) {
        const q = worldToScreen(samples[i]);
        ctx.lineTo(q.x, q.y);
      }
    }

    if (closeToAxis) {
      const last = worldToScreen(profile[profile.length - 1]);
      const bottom = worldToScreen(profile[0]);
      ctx.lineTo(last.x, last.y);
      ctx.lineTo(worldToScreen({x: 0, y: profile[profile.length - 1].y}).x, last.y);
      ctx.lineTo(worldToScreen({x: 0, y: profile[0].y}).x, bottom.y);
      ctx.closePath();
    }
  }

  function drawProfile() {
    const { width, height } = dimensions();
    pctx.clearRect(0, 0, width, height);

    pctx.fillStyle = "#faf9f6";
    pctx.fillRect(0, 0, width, height);

    const t = profileTransform();
    const maxY = Math.max(180, ...profile.map(p => p.y));
    const maxX = Math.max(180, ...profile.map(p => p.x));

    // Grid.
    pctx.lineWidth = 1;
    pctx.strokeStyle = "#e1dfd9";
    pctx.fillStyle = "#898781";
    pctx.font = "11px system-ui";

    const step = 20;
    for (let y = 0; y <= maxY + step; y += step) {
      const sy = t.oy - y * t.scale;
      pctx.beginPath();
      pctx.moveTo(t.ox, sy);
      pctx.lineTo(width - 35, sy);
      pctx.stroke();

      if (y % 40 === 0) {
        pctx.fillText(String(y), 12, sy + 4);
      }
    }

    for (let x = 0; x <= maxX + 40; x += step) {
      const sx = t.ox + x * t.scale;
      pctx.beginPath();
      pctx.moveTo(sx, 35);
      pctx.lineTo(sx, t.oy);
      pctx.stroke();

      if (x % 40 === 0) {
        pctx.fillText(String(x), sx - 8, height - 28);
      }
    }

    // Axis.
    pctx.strokeStyle = "#222";
    pctx.lineWidth = 2;
    pctx.beginPath();
    pctx.moveTo(t.ox, 35);
    pctx.lineTo(t.ox, t.oy + 8);
    pctx.stroke();

    // Axis label.
    pctx.save();
    pctx.translate(25, height / 2);
    pctx.rotate(-Math.PI / 2);
    pctx.fillStyle = "#666";
    pctx.font = "12px system-ui";
    pctx.fillText("height", 0, 0);
    pctx.restore();

    pctx.fillStyle = "#666";
    pctx.font = "12px system-ui";
    pctx.fillText("radius", width / 2, height - 10);

    // Filled silhouette and visible profile use exactly the same curve.
    drawProfilePath(pctx, true);
    pctx.fillStyle = "#e5e3dd";
    pctx.fill();

    drawProfilePath(pctx, false);
    pctx.strokeStyle = "#222";
    pctx.lineWidth = 3;
    pctx.lineJoin = "round";
    pctx.stroke();

    // Base line.
    pctx.strokeStyle = "#777";
    pctx.lineWidth = 1;
    pctx.beginPath();
    pctx.moveTo(t.ox, t.oy);
    pctx.lineTo(worldToScreen(profile[0]).x, t.oy);
    pctx.stroke();

    // Points.
    profile.forEach((p, i) => {
      const s = worldToScreen(p);
      const endpoint = i === 0 || i === profile.length - 1;

      pctx.beginPath();
      pctx.arc(s.x, s.y, endpoint ? 7 : 6, 0, Math.PI * 2);
      pctx.fillStyle = endpoint ? "#315f8a" : "#faf9f6";
      pctx.fill();
      pctx.strokeStyle = "#222";
      pctx.lineWidth = 2;
      pctx.stroke();
    });

    const baseWidth = profile[0].x * 2;
    status.textContent = `${profile.length - 1} profile segments · ${Math.round(Math.max(...profile.map(p => p.y)))} high`;
  }

  function snapValue(value) {
    if (!snapToggle.checked) return value;
    let step = Number(snapInput.value);
    if (!Number.isFinite(step) || step <= 0) step = 1;
    return Math.round(value / step) * step;
  }

  function snapPoint(point, includeY = true) {
    return {
      x: snapValue(point.x),
      y: includeY ? snapValue(point.y) : point.y
    };
  }

  function pointerPosition(canvas, event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };
  }

  function nearestPoint(x, y, threshold = 12) {
    let best = -1;
    let distance = threshold;

    profile.forEach((p, i) => {
      const s = worldToScreen(p);
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < distance) {
        distance = d;
        best = i;
      }
    });

    return best;
  }

  function nearestEdge(x, y, threshold = 10) {
    let best = -1;
    let bestDistance = threshold;

    for (let i = 0; i < profile.length - 1; i++) {
      const a = worldToScreen(profile[i]);
      const b = worldToScreen(profile[i + 1]);

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      if (!len2) continue;

      let u = ((x - a.x) * dx + (y - a.y) * dy) / len2;
      u = Math.max(0, Math.min(1, u));

      const px = a.x + u * dx;
      const py = a.y + u * dy;
      const d = Math.hypot(x - px, y - py);

      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    }

    return best;
  }

  profileCanvas.addEventListener("contextmenu", e => e.preventDefault());

  profileCanvas.addEventListener("mousedown", e => {
    const pos = pointerPosition(profileCanvas, e);
    const point = nearestPoint(pos.x, pos.y);

    if (e.button === 2) {
      // Never remove either endpoint.
      if (point > 0 && point < profile.length - 1) {
        profile.splice(point, 1);
        redrawAll();
      }
      return;
    }

    if (e.button !== 0) return;

    if (point >= 0) {
      dragIndex = point;
      const w = screenToWorld(pos.x, pos.y);
      dragOffset.x = profile[point].x - w.x;
      dragOffset.y = profile[point].y - w.y;
      profileCanvas.style.cursor = "grabbing";
      return;
    }

    // Left click on an existing profile edge inserts a point.
    const edge = nearestEdge(pos.x, pos.y);
    if (edge >= 0) {
      e.preventDefault();
      profileCanvas.setPointerCapture?.(e.pointerId);
      const w = screenToWorld(pos.x, pos.y);

      // Clamp to sensible dimensions.
      const snapped = snapPoint(w);
      w.x = Math.max(5, snapped.x);
      w.y = Math.max(0, snapped.y);

      // Keep the new point inside its neighbouring points.
      w.y = Math.max(profile[edge].y + 1,
                     Math.min(profile[edge + 1].y - 1, w.y));

      profile.splice(edge + 1, 0, w);
      redrawAll();

      dragIndex = edge + 1;
      dragOffset.x = 0;
      dragOffset.y = 0;
      profileCanvas.style.cursor = "grabbing";
    }
  });

  window.addEventListener("mousemove", e => {
    if (dragIndex < 0) return;

    const pos = pointerPosition(profileCanvas, e);
    const w = screenToWorld(pos.x, pos.y);
    const p = profile[dragIndex];

    const rawX = w.x + dragOffset.x;
    const rawY = w.y + dragOffset.y;

    p.x = Math.max(5, snapValue(rawX));

    // Endpoints are horizontally constrained.
    if (dragIndex !== 0 && dragIndex !== profile.length - 1) {
      p.y = Math.max(0, snapValue(rawY));

      // Keep profile ordered vertically.
      const previous = profile[dragIndex - 1];
      const next = profile[dragIndex + 1];
      p.y = Math.max(previous.y + 1, Math.min(next.y - 1, p.y));
    } else {
      if (dragIndex === 0) {
        p.y = 0;
      } else {
        p.y = Math.max(profile[profile.length - 2].y + 1, p.y);
      }
    }

    redrawAll();
  });

  window.addEventListener("mouseup", () => {
    if (dragIndex >= 0) {
      dragIndex = -1;
      profileCanvas.style.cursor = "default";
    }
  });

  segmentsInput.addEventListener("input", () => {
    let n = Math.round(Number(segmentsInput.value));
    n = Math.max(3, Math.min(128, n));
    segmentsInput.value = n;
    redrawAll();
  });

  heightInput.addEventListener("input", () => {
    let height = Number(heightInput.value);
    if (!Number.isFinite(height) || height < 1) height = 1;
    heightInput.value = height;

    const oldHeight = Math.max(...profile.map(p => p.y), 1);
    const scale = height / oldHeight;
    profile.forEach(p => p.y *= scale);
    profile[0].y = 0;
    profile[profile.length - 1].y = height;

    redrawAll();
  });

  smoothInput.addEventListener("input", () => {
    redrawAll();
  });

  smoothInput.addEventListener("input", () => { smoothValue.textContent = smoothInput.value; });
  paperOrientation.addEventListener("change", redrawAll);
  a4GuideToggle.addEventListener("change", redrawAll);
  printButton.addEventListener("click", printA4);
  traceButton.addEventListener("click", () => {
    if(document.body.classList.contains("trace-mode")) exitTraceMode(); else enterTraceMode();
  });
  traceClose.addEventListener("click", exitTraceMode);
  screenScaleInput.addEventListener("input", redrawAll);
  calibrateButton.addEventListener("click", () => {
    const measured = Number(prompt("Measure the 50 mm line on your phone screen with a ruler, then enter the measured length in millimetres:", "50"));
    if(!Number.isFinite(measured) || measured <= 0) return;
    const current = Number(screenScaleInput.value) || 100;
    const corrected = Math.max(25, Math.min(300, current * 50 / measured));
    screenScaleInput.value = corrected.toFixed(1);
    redrawAll();
  });
  document.addEventListener("keydown", e => { if(e.key === "Escape" && document.body.classList.contains("trace-mode")) exitTraceMode(); });

  // -------------------------
  // Simple 3D wireframe renderer
  // -------------------------

  function makeMesh() {
    const n = Math.max(3, Math.min(128, Math.round(Number(segmentsInput.value))));
    const rings = renderedProfile();
    const vertices = [];

    for (const p of rings) {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        vertices.push({
          x: Math.max(0, p.x) * Math.cos(a),
          y: p.y,
          z: Math.max(0, p.x) * Math.sin(a)
        });
      }
    }

    const faces = [];
    for (let j = 0; j < rings.length - 1; j++) {
      for (let i = 0; i < n; i++) {
        const a = j*n + i;
        const b = j*n + ((i+1)%n);
        const c = (j+1)*n + ((i+1)%n);
        const d = (j+1)*n + i;
        faces.push([a,b,c,d]);
      }
    }

    const bottomCenter = vertices.length;
    vertices.push({x:0, y:rings[0].y, z:0});
    const topCenter = vertices.length;
    vertices.push({x:0, y:rings[rings.length-1].y, z:0});

    for (let i=0; i<n; i++) {
      faces.push([bottomCenter, (i+1)%n, i]);
      const base=(rings.length-1)*n;
      faces.push([topCenter, base+i, base+((i+1)%n)]);
    }

    return {vertices, faces, n, ringCount:rings.length};
  }

  function rotate(v) {
    const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw);
    const x1 = v.x * cy - v.z * sy;
    const z1 = v.x * sy + v.z * cy;

    const cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
    return {
      x: x1,
      y: v.y * cp - z1 * sp,
      z: v.y * sp + z1 * cp
    };
  }

  function project(v, centerX, centerY, scale) {
    // Conventional perspective projection. The camera is in front of
    // the object (negative z); positive z is closer to the viewer.
    const cameraDistance = 900;
    const focalLength = 760;
    const depth = cameraDistance - v.z;
    const perspective = focalLength / depth;

    return {
      x: centerX + v.x * scale * perspective,
      y: centerY - v.y * scale * perspective,
      depth
    };
  }

  function pointInPolygon(x, y, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].x, yi = polygon[i].y;
      const xj = polygon[j].x, yj = polygon[j].y;
      const intersects = ((yi > y) !== (yj > y)) &&
        (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi);
      if (intersects) inside = !inside;
    }
    return inside;
  }

  function touchHits3DObject(clientX, clientY) {
    const rect = viewCanvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return viewHitPolygons.some(poly => pointInPolygon(x, y, poly));
  }

  function draw3D() {
    const width = viewCanvas.clientWidth;
    const height = viewCanvas.clientHeight;

    vctx.clearRect(0, 0, width, height);
    vctx.fillStyle = "#faf9f6";
    vctx.fillRect(0, 0, width, height);

    const mesh = makeMesh();

    const maxRadius = Math.max(...profile.map(p => p.x));
    const maxHeight = Math.max(...profile.map(p => p.y));
    const objectSize = Math.max(maxHeight, maxRadius * 2);

    const scale = Math.min(width, height) * 0.31 / objectSize * view.zoom;
    const cx = width / 2;
    const cy = height / 2 + maxHeight * scale * 0.04;

    const transformed = mesh.vertices.map(rotate);
    const projected = transformed.map(v => project(v, cx, cy, scale));

    // Keep the projected face polygons for mobile touch hit-testing.
    viewHitPolygons = mesh.faces
      .filter(face => face.length >= 3)
      .map(face => face.map(index => projected[index]));

    // Faces sorted back-to-front.
    const renderedFaces = mesh.faces.map(face => {
      const avgZ = face.reduce((sum, i) => sum + transformed[i].z, 0) / face.length;
      return { face, avgZ };
    }).sort((a, b) => a.avgZ - b.avgZ);

    // Very restrained surface shading based on face orientation.
    renderedFaces.forEach(({ face, avgZ }) => {
      if (face.length < 3) return;

      const a = transformed[face[0]];
      const b = transformed[face[1]];
      const c = transformed[face[2]];

      const ux = b.x - a.x;
      const uy = b.y - a.y;
      const uz = b.z - a.z;

      const vx = c.x - a.x;
      const vy = c.y - a.y;
      const vz = c.z - a.z;

      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;

      const light = Math.max(0, Math.min(1, (nx * -0.3 + ny * 0.5 + nz * 0.7) /
        Math.max(1, Math.hypot(nx, ny, nz))));

      const gray = Math.round(225 - light * 55);

      vctx.beginPath();
      face.forEach((index, i) => {
        const p = projected[index];
        if (i === 0) vctx.moveTo(p.x, p.y);
        else vctx.lineTo(p.x, p.y);
      });
      vctx.closePath();

      // Simple shaded faces, with the face boundaries retained.
      vctx.fillStyle = `rgb(${gray},${gray},${gray - 2})`;
      vctx.fill();
      vctx.strokeStyle = "#555";
      vctx.lineWidth = 0.8;
      vctx.stroke();
    });

    vctx.fillStyle = "#777";
    vctx.font = "12px system-ui";
    vctx.fillText(`${mesh.n} radial segments`, 16, 24);
  }

  // -------------------------
  // -------------------------
  // 2D lattice / unfolded net
  // -------------------------

  // Lattice geometry is expressed in millimetres. Profile x/y values are
  // treated as millimetres, so this is the single source of truth for both
  // the on-screen preview and 1:1 printing.
  function latticeGeometry() {
    const n = Math.max(3, Math.min(128, Math.round(Number(segmentsInput.value))));
    const rings = renderedProfile();
    const bottomRadius = Math.max(0, rings[0].x);
    const topRadius = Math.max(0, rings[rings.length - 1].x);
    const slant = [0];
    for (let i = 1; i < rings.length; i++) {
      slant.push(slant[i - 1] + Math.hypot(rings[i].x-rings[i-1].x, rings[i].y-rings[i-1].y));
    }
    const edgeHalf = r => r * Math.sin(Math.PI / n);
    const apothem = r => r * Math.cos(Math.PI / n);
    const latticeRotation = -Math.PI / n;
    const bottomApothem = apothem(bottomRadius);

    const point = (x,y) => ({x,y});
    const polar = (r,a) => point(r*Math.cos(a), r*Math.sin(a));
    const add = (a,b) => point(a.x+b.x,a.y+b.y);
    const mul = (a,k) => point(a.x*k,a.y*k);

    const bottomVertices=[];
    const bottomAngle=-Math.PI/2+latticeRotation;
    for(let i=0;i<n;i++) bottomVertices.push(polar(bottomRadius,bottomAngle+i*2*Math.PI/n));

    const panels=[];
    for(let face=0;face<n;face++){
      const midAngle=-Math.PI/2+latticeRotation+(face+0.5)*2*Math.PI/n;
      const normal=polar(1,midAngle);
      const tangent=polar(1,midAngle+Math.PI/2);
      const left=[],right=[];
      for(let i=0;i<rings.length;i++){
        const center=mul(normal,bottomApothem+slant[i]);
        const hw=edgeHalf(Math.max(0,rings[i].x));
        left.push(add(center,mul(tangent,-hw)));
        right.push(add(center,mul(tangent,hw)));
      }
      panels.push({left,right});
    }

    const topPanel=panels[0];
    const A=topPanel.left[topPanel.left.length-1];
    const B=topPanel.right[topPanel.right.length-1];
    const edgeMid=mul(add(A,B),0.5);
    const topMidAngle=-Math.PI/2+latticeRotation+0.5*2*Math.PI/n;
    const outward=polar(1,topMidAngle);
    const capCenter=add(edgeMid,mul(outward,apothem(topRadius)));
    const startAngle=Math.atan2(A.y-capCenter.y,A.x-capCenter.x);
    const topVertices=[];
    for(let i=0;i<n;i++) topVertices.push(add(capCenter,polar(topRadius,startAngle+i*2*Math.PI/n)));

    const all=[];
    bottomVertices.forEach(v=>all.push(v));
    panels.forEach(panel=>panel.left.concat(panel.right).forEach(v=>all.push(v)));
    topVertices.forEach(v=>all.push(v));
    const minX=Math.min(...all.map(v=>v.x)), maxX=Math.max(...all.map(v=>v.x));
    const minY=Math.min(...all.map(v=>v.y)), maxY=Math.max(...all.map(v=>v.y));

    return {n,rings,bottomVertices,panels,topVertices,bottomCenter:point(0,0),topCenter:capCenter,
      minX,maxX,minY,maxY,width:maxX-minX,height:maxY-minY};
  }

  function drawLattice() {
    const width=latticeCanvas.clientWidth, height=latticeCanvas.clientHeight;
    lctx.clearRect(0,0,width,height);
    lctx.fillStyle="#faf9f6"; lctx.fillRect(0,0,width,height);
    const g=latticeGeometry();
    const sel=printSelection();
    const visiblePanels = sel.allSides ? g.panels : (sel.side ? [g.panels[0]] : []);
    const visiblePoints=[];
    if (sel.base) g.bottomVertices.forEach(v=>visiblePoints.push(v));
    if (sel.cap) g.topVertices.forEach(v=>visiblePoints.push(v));
    visiblePanels.forEach(panel=>panel.left.concat(panel.right).forEach(v=>visiblePoints.push(v)));
    if (!visiblePoints.length) visiblePoints.push({x:0,y:0});
    const vb={
      minX:Math.min(...visiblePoints.map(v=>v.x)), maxX:Math.max(...visiblePoints.map(v=>v.x)),
      minY:Math.min(...visiblePoints.map(v=>v.y)), maxY:Math.max(...visiblePoints.map(v=>v.y))
    };
    const visibleWidth=Math.max(1,vb.maxX-vb.minX);
    const visibleHeight=Math.max(1,vb.maxY-vb.minY);

    const orientation=paperOrientation.value;
    const pageW=orientation==="portrait"?210:297;
    const pageH=orientation==="portrait"?297:210;
    const margin=8;
    const pageScale=Math.min((width-30)/pageW,(height-55)/pageH);
    const contentScale=Math.min((width-50)/(visibleWidth+30),(height-65)/(visibleHeight+30));
    const screenScale = document.body.classList.contains("trace-mode") ? Math.max(0.25, Math.min(3, Number(screenScaleInput.value)/100)) : 1;
    const scale=Math.min(pageScale,contentScale) * screenScale * (document.body.classList.contains("trace-mode") ? traceZoom : 1);
    const isTraceMode = document.body.classList.contains("trace-mode");
    // In the editor the lattice is anchored to the top-left of the pane.
    // Only trace mode uses the pan state and centers the drawing.
    const cx = isTraceMode
      ? width/2-(vb.minX+vb.maxX)/2*scale + latticePan.x
      : 16 - vb.minX*scale;
    const cy = isTraceMode
      ? height/2-(vb.minY+vb.maxY)/2*scale + latticePan.y
      : 32 - vb.minY*scale;

    const S=v=>({x:cx+v.x*scale,y:cy+v.y*scale});

    // A4 guide. This is deliberately a physical-size reference in the
    // coordinate system of the lattice; it is not a promise that the
    // browser display itself has physical dimensions.
    if(a4GuideToggle.checked){
      const pxW=pageW*scale, pxH=pageH*scale;
      lctx.save();
      lctx.strokeStyle="#b8b6b0"; lctx.lineWidth=1; lctx.setLineDash([5,4]);
      lctx.strokeRect(cx+vb.minX*scale-margin*scale, cy+vb.minY*scale-margin*scale, pageW*scale, pageH*scale);
      lctx.restore();
      lctx.fillStyle="#999"; lctx.font="11px system-ui";
      lctx.fillText(`A4 ${orientation} · 1:1 guide`, cx+vb.minX*scale-margin*scale+5, cy+vb.minY*scale-margin*scale-6);
    }

    const pathLine=(pts,close=false)=>{
      lctx.beginPath();
      pts.forEach((v,i)=>{const q=S(v); if(i===0)lctx.moveTo(q.x,q.y);else lctx.lineTo(q.x,q.y);});
      if(close)lctx.closePath(); lctx.stroke();
    };

    lctx.strokeStyle="#222"; lctx.lineWidth=1.35; lctx.lineJoin="round"; lctx.lineCap="round";
    for(const panel of visiblePanels) pathLine(panel.left.concat([...panel.right].reverse()),true);
    if (sel.base) pathLine(g.bottomVertices,true);
    if (sel.cap) pathLine(g.topVertices,true);

    // Dashed sector folds only for visible caps.
    lctx.save(); lctx.setLineDash([5,5]); lctx.strokeStyle="#999"; lctx.lineWidth=1;
    if (sel.base) for(const v of g.bottomVertices) pathLine([g.bottomCenter,v]);
    if (sel.cap) for(const v of g.topVertices) pathLine([g.topCenter,v]);
    lctx.restore();

    // 50 mm scale ruler anchored to the top-left corner of the A4 sheet.
    // It follows the sheet when panning/zooming, so it is useful for
    // checking the physical scale in trace mode.
    const sheetX=cx+vb.minX*scale-margin*scale;
    const sheetY=cy+vb.minY*scale-margin*scale;
    const rulerX=sheetX+5*scale, rulerY=sheetY+14*scale, rulerLen=50*scale;
    lctx.save();
    lctx.strokeStyle="#444"; lctx.fillStyle="#444"; lctx.lineWidth=Math.max(1,scale*0.35);
    lctx.beginPath(); lctx.moveTo(rulerX,rulerY); lctx.lineTo(rulerX+rulerLen,rulerY); lctx.stroke();
    for(let i=0;i<=5;i++){
      const x=rulerX+rulerLen*i/5;
      const tick=i%5===0 ? 5*scale : 3*scale;
      lctx.beginPath(); lctx.moveTo(x,rulerY-tick); lctx.lineTo(x,rulerY+tick); lctx.stroke();
    }
    lctx.font=`${Math.max(9,10*scale)}px system-ui`;
    lctx.fillText("5 cm",rulerX,rulerY-7*scale);
    lctx.restore();

    lctx.fillStyle="#777"; lctx.font="11px system-ui";
    const pieceCount=(sel.allSides?g.panels.length:visiblePanels.length)+(sel.base?1:0)+(sel.cap?1:0);
    const visibleFits=visibleWidth<=pageW-2*margin && visibleHeight<=pageH-2*margin;
    lctx.fillText(`${pieceCount} piece${pieceCount===1?"":"s"} · ${Math.round(visibleWidth)} × ${Math.round(visibleHeight)} mm · ${visibleFits?"fits on one A4":"use 2-page print"}`,16,24);
  }

  function svgLine(points, dash=false){
    const pts=points.map(v=>`${v.x.toFixed(3)},${v.y.toFixed(3)}`).join(" ");
    return `<polyline points="${pts}" fill="none" ${dash?'stroke-dasharray="2.5,2.5"':''}/>`;
  }

  function printSelection() {
    return {
      base: printBase.checked,
      side: printSide.checked,
      cap: printCap.checked,
      allSides: printAllSides.checked
    };
  }

  function updatePrintSelection() {
    if (printAllSides.checked) {
      printSide.checked = false;
      printSide.disabled = true;
    } else {
      printSide.disabled = false;
    }
  }

  [printBase, printSide, printCap, printAllSides].forEach(el =>
    el.addEventListener("change", () => { updatePrintSelection(); redrawAll(); })
  );
  updatePrintSelection();

  function buildPrintPages(){
    const g=latticeGeometry();
    const sel=printSelection();
    const margin=8, A4={w:210,h:297};

    // A printable layout is composed only from the requested pieces.
    // "One side" means panel 0 only: the panel whose bottom edge and
    // corresponding top edge form the complete side template.
    const selectedPanels = sel.allSides ? g.panels : (sel.side ? [g.panels[0]] : []);
    const items=[];

    if (sel.base) items.push({type:"base"});
    selectedPanels.forEach((panel,i)=>items.push({type:"panel",panel,index:i}));
    if (sel.cap) items.push({type:"cap"});

    if (!items.length) {
      return `<div class="empty-print">No pieces selected. Close this window and select at least one piece.</div>`;
    }

    // Pack pieces onto a simple millimetre canvas. Panels are placed
    // vertically; the base/cap polygons are placed alongside when possible.
    const placed=[];
    let x=margin, y=margin, rowH=0;
    const gap=12;

    function bounds(points){
      return {
        minX:Math.min(...points.map(p=>p.x)), maxX:Math.max(...points.map(p=>p.x)),
        minY:Math.min(...points.map(p=>p.y)), maxY:Math.max(...points.map(p=>p.y))
      };
    }

    function panelPoints(panel){
      return panel.left.concat([...panel.right].reverse());
    }

    for(const item of items){
      let pts;
      if(item.type==="base") pts=g.bottomVertices;
      else if(item.type==="cap") pts=g.topVertices;
      else pts=panelPoints(item.panel);
      const b=bounds(pts);
      const w=b.maxX-b.minX, h=b.maxY-b.minY;
      if(x+w+margin>A4.w && x>margin){ x=margin; y+=rowH+gap; rowH=0; }
      placed.push({item,b,x:x-b.minX,y:y-b.minY,w,h});
      x+=w+gap;
      rowH=Math.max(rowH,h);
    }

    const totalW=Math.max(...placed.map(p=>p.x+p.w))+margin;
    const totalH=Math.max(...placed.map(p=>p.y+p.h))+margin;
    const cols=Math.max(1,Math.ceil(totalW/(A4.w-2*margin)));
    const rows=Math.max(1,Math.ceil(totalH/(A4.h-2*margin)));

    // For the usual case this packs onto one or two sheets. Never scale the
    // geometry to make it fit: all coordinates remain millimetres.
    const sheetW=A4.w, sheetH=A4.h;
    const pages=[];

    function line(points,dash=false){
      const pts=points.map(p=>`${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(" ");
      return `<polyline points="${pts}" fill="none"${dash?' stroke-dasharray="2.5,2.5"':''}/>`;
    }
    function circleLines(center,vertices){
      return vertices.map(v=>line([center,v],true)).join("");
    }

    function itemSvg(item, ox, oy){
      const T=p=>({x:p.x+ox,y:p.y+oy});
      let out="";
      if(item.type==="base"){
        out+=line(g.bottomVertices.map(T).concat([T(g.bottomVertices[0])]));
        out+=circleLines(T(g.bottomCenter),g.bottomVertices.map(T));
      } else if(item.type==="cap"){
        out+=line(g.topVertices.map(T).concat([T(g.topVertices[0])]));
        out+=circleLines(T(g.topCenter),g.topVertices.map(T));
      } else {
        const panel=item.panel;
        out+=line(panel.left.concat([...panel.right].reverse()).map(T).concat([T(panel.left[0])]));
        // The horizontal/radial section boundaries of a side are fold lines.
        // Draw them dashed, while keeping the outer outline solid.
        for(let i=1;i<panel.left.length-1;i++){
          out+=line([T(panel.left[i]),T(panel.right[i])],true);
        }
      }
      return out;
    }

    for(let row=0;row<rows;row++) for(let col=0;col<cols;col++){
      const x0=col*sheetW, y0=row*sheetH;
      let content="";
      for(const p of placed){
        if(p.x+p.w < x0+margin || p.x > x0+sheetW-margin || p.y+p.h < y0+margin || p.y > y0+sheetH-margin) continue;
        content+=itemSvg(p.item,p.x,p.y);
      }
      // A 50 mm ruler is printed on every page so the physical scale can
      // always be checked after printing.
      content+=`<line x1="13" y1="14" x2="63" y2="14"/><line x1="13" y1="9" x2="13" y2="19"/><line x1="23" y1="11" x2="23" y2="17"/><line x1="33" y1="9" x2="33" y2="19"/><line x1="43" y1="11" x2="43" y2="17"/><line x1="53" y1="11" x2="53" y2="17"/><line x1="63" y1="9" x2="63" y2="19"/><text x="13" y="7">5 cm</text>`;
      pages.push(`<div class="page"><svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 210 297"><g fill="none" stroke="#111" stroke-width="0.35" stroke-linejoin="round" stroke-linecap="round">${content}</g></svg><div class="page-label">Page ${row*cols+col+1} / ${cols*rows}</div></div>`);
    }
    return pages.join("");
  }

  function printA4(){
    const pages = buildPrintPages();
    const w = window.open('', '_blank');
    if (!w) {
      alert('Please allow pop-ups for the print preview.');
      return;
    }

    // Build this as ordinary strings rather than one huge template literal.
    // This avoids the browser HTML parser confusing embedded script markup
    // with the main script when the standalone file is served locally.
    const printHtml = [
      '<!doctype html><html><head><title>Segmented Cylinder — 1:1 lattice</title>',
      '<style>',
      '@page{size:A4 portrait;margin:0}',
      '*{box-sizing:border-box}',
      'html,body{margin:0;padding:0}',
      '.page{width:210mm;height:297mm;position:relative;page-break-after:always;break-after:page}',
      '.page:last-child{page-break-after:auto}',
      '.page svg{display:block;width:210mm;height:297mm}',
      '.page-label{position:absolute;right:5mm;bottom:3mm;font:8pt system-ui;color:#777}',
      '@media print{.page-label{display:none}}',
      '@media screen{body{background:#ddd}.page{margin:10px auto;background:#fff;box-shadow:0 1px 8px #aaa}}',
      '</style></head><body>',
      pages,
      '</body></html>'
    ].join('');

    w.document.open();
    w.document.write(printHtml);
    w.document.close();

    // Print from the parent context instead of embedding executable markup
    // inside the generated document.
    setTimeout(() => {
      try { w.focus(); w.print(); } catch (_) {}
    }, 300);
  }

  let traceWakeLock = null;
  let traceReturnScrollX = 0;
  let traceReturnScrollY = 0;

  async function enterTraceMode(){
    // Remember exactly where the editor page was. Trace mode is a temporary
    // full-screen view and should return the user to the same place.
    traceReturnScrollX = window.scrollX;
    traceReturnScrollY = window.scrollY;

    latticePan.x = 0; latticePan.y = 0; latticePan.dragging = false; latticePan.pointers.clear(); traceZoom = 1;
    document.body.classList.add("trace-mode");
    // The canvas changes size when trace mode takes over the viewport.
    // Resize its backing store as well, otherwise the browser can stretch
    // the old bitmap and distort the lattice.
    resizeCanvas(latticeCanvas, lctx);
    redrawAll();
    if("wakeLock" in navigator){ try { traceWakeLock = await navigator.wakeLock.request("screen"); } catch(e) {} }
  }
  async function exitTraceMode(){
    document.body.classList.remove("trace-mode");
    if(traceWakeLock){ try { await traceWakeLock.release(); } catch(e) {} traceWakeLock=null; }

    // Restore the normal canvas backing size after leaving the full-screen
    // trace layout, before redrawing the editor view.
    resizeCanvas(latticeCanvas, lctx);
    redrawAll();

    // Wait for the normal document layout to return before restoring scroll.
    requestAnimationFrame(() => {
      window.scrollTo(traceReturnScrollX, traceReturnScrollY);
    });
  }

  // In phone trace mode, one finger/mouse drag pans the lattice; two fingers
  // pinch-zoom it. The pinch keeps the point beneath the fingers stationary.
  function traceBaseScale() {
    const orientation=paperOrientation.value;
    const pageW=orientation==="portrait"?210:297;
    const pageH=orientation==="portrait"?297:210;
    const gg=latticeGeometry();
    const sel=printSelection();
    const panels=sel.allSides?gg.panels:(sel.side?[gg.panels[0]]:[]);
    const pts=[];
    if(sel.base) gg.bottomVertices.forEach(v=>pts.push(v));
    if(sel.cap) gg.topVertices.forEach(v=>pts.push(v));
    panels.forEach(panel=>panel.left.concat(panel.right).forEach(v=>pts.push(v)));
    if(!pts.length) pts.push({x:0,y:0});
    const minX=Math.min(...pts.map(v=>v.x)), maxX=Math.max(...pts.map(v=>v.x));
    const minY=Math.min(...pts.map(v=>v.y)), maxY=Math.max(...pts.map(v=>v.y));
    const visibleWidth=Math.max(1,maxX-minX), visibleHeight=Math.max(1,maxY-minY);
    const pageScale=Math.min((latticeCanvas.clientWidth-30)/pageW,(latticeCanvas.clientHeight-55)/pageH);
    const contentScale=Math.min((latticeCanvas.clientWidth-50)/(visibleWidth+30),(latticeCanvas.clientHeight-65)/(visibleHeight+30));
    return Math.min(pageScale,contentScale) * Math.max(0.25,Math.min(3,Number(screenScaleInput.value)/100));
  }

  function traceLatticeBaseCenter(scale) {
    const g=latticeGeometry();
    const sel=printSelection();
    const visiblePanels = sel.allSides ? g.panels : (sel.side ? [g.panels[0]] : []);
    const visiblePoints=[];
    if (sel.base) g.bottomVertices.forEach(v=>visiblePoints.push(v));
    if (sel.cap) g.topVertices.forEach(v=>visiblePoints.push(v));
    visiblePanels.forEach(panel=>panel.left.concat(panel.right).forEach(v=>visiblePoints.push(v)));
    if (!visiblePoints.length) visiblePoints.push({x:0,y:0});
    const minX=Math.min(...visiblePoints.map(v=>v.x)), maxX=Math.max(...visiblePoints.map(v=>v.x));
    const minY=Math.min(...visiblePoints.map(v=>v.y)), maxY=Math.max(...visiblePoints.map(v=>v.y));
    return {
      x:latticeCanvas.clientWidth/2-(minX+maxX)/2*scale,
      y:latticeCanvas.clientHeight/2-(minY+maxY)/2*scale
    };
  }

  function tracePinchDistance() {
    const pts=[...latticePan.pointers.values()];
    if(pts.length<2) return 0;
    return Math.hypot(pts[0].x-pts[1].x, pts[0].y-pts[1].y);
  }

  function tracePinchMidpoint() {
    const pts=[...latticePan.pointers.values()];
    return {x:(pts[0].x+pts[1].x)/2, y:(pts[0].y+pts[1].y)/2};
  }

  latticeCanvas.addEventListener("pointerdown", e => {
    if (!document.body.classList.contains("trace-mode")) {
      // The normal lattice is intentionally static. Do not capture the
      // pointer or preventDefault(), so touch can continue scrolling the page.
      return;
    }

    // Trace mode owns the pointer, because panning and pinch-zooming are
    // the only gestures enabled for the lattice.
    latticeCanvas.setPointerCapture?.(e.pointerId);
    latticePan.pointers.set(e.pointerId, {x:e.clientX, y:e.clientY});
    if (latticePan.pointers.size === 1) {
      latticePan.dragging = true;
      latticePan.lastX = e.clientX;
      latticePan.lastY = e.clientY;
    } else if (latticePan.pointers.size === 2) {
      latticePan.dragging = false;
      latticePan.pinchStartDistance = tracePinchDistance();
      latticePan.pinchStartZoom = traceZoom;
    }
    e.preventDefault();
  });

  latticeCanvas.addEventListener("pointermove", e => {
    if (!document.body.classList.contains("trace-mode")) {
      // No panning outside trace mode.
      return;
    }
    if (!latticePan.pointers.has(e.pointerId)) return;
    latticePan.pointers.set(e.pointerId, {x:e.clientX, y:e.clientY});

    if (latticePan.pointers.size >= 2) {
      const d=tracePinchDistance();
      if (!latticePan.pinchStartDistance) latticePan.pinchStartDistance=d;
      const oldZoom=traceZoom;
      const newZoom=Math.max(0.5, Math.min(4, latticePan.pinchStartZoom * d / latticePan.pinchStartDistance));
      if (newZoom !== oldZoom) {
        const oldScale=traceBaseScale() * oldZoom;
        const newScale=traceBaseScale() * newZoom;
        const mid=tracePinchMidpoint();
        const oldCenter=traceLatticeBaseCenter(oldScale);
        const newCenter=traceLatticeBaseCenter(newScale);
        const worldX=(mid.x-oldCenter.x-latticePan.x)/oldScale;
        const worldY=(mid.y-oldCenter.y-latticePan.y)/oldScale;
        traceZoom=newZoom;
        latticePan.x=mid.x-newCenter.x-worldX*newScale;
        latticePan.y=mid.y-newCenter.y-worldY*newScale;
        drawLattice();
      }
      e.preventDefault();
      return;
    }

    if (latticePan.dragging) {
      latticePan.x += e.clientX - latticePan.lastX;
      latticePan.y += e.clientY - latticePan.lastY;
      latticePan.lastX = e.clientX;
      latticePan.lastY = e.clientY;
      drawLattice();
      e.preventDefault();
    }
  });

  function stopLatticePan(e) {
    if (!document.body.classList.contains("trace-mode")) {
      latticePan.dragging = false;
      if (e?.pointerId != null) latticeCanvas.releasePointerCapture?.(e.pointerId);
      return;
    }
    latticePan.pointers.delete(e.pointerId);
    if (latticePan.pointers.size === 0) {
      latticePan.dragging = false;
    } else if (latticePan.pointers.size === 1) {
      const p=[...latticePan.pointers.values()][0];
      latticePan.dragging = true;
      latticePan.lastX=p.x; latticePan.lastY=p.y;
    }
    if (e?.pointerId != null) latticeCanvas.releasePointerCapture?.(e.pointerId);
  }

  latticeCanvas.addEventListener("pointerup", stopLatticePan);
  latticeCanvas.addEventListener("pointercancel", stopLatticePan);

  // Mouse wheel / trackpad zoom in trace mode. The zoom is centred on the
  // cursor so the area being inspected stays under the pointer.
  latticeCanvas.addEventListener("wheel", e => {
    if (!document.body.classList.contains("trace-mode")) return;
    e.preventDefault();
    const oldZoom=traceZoom;
    const factor=Math.exp(-e.deltaY*0.0015);
    const newZoom=Math.max(0.5, Math.min(4, oldZoom*factor));
    if (newZoom===oldZoom) return;

    const oldScale=traceBaseScale()*oldZoom;
    const newScale=traceBaseScale()*newZoom;
    const centerOld=traceLatticeBaseCenter(oldScale);
    const centerNew=traceLatticeBaseCenter(newScale);
    const worldX=(e.clientX-centerOld.x-latticePan.x)/oldScale;
    const worldY=(e.clientY-centerOld.y-latticePan.y)/oldScale;
    traceZoom=newZoom;
    latticePan.x=e.clientX-centerNew.x-worldX*newScale;
    latticePan.y=e.clientY-centerNew.y-worldY*newScale;
    drawLattice();
  }, {passive:false});

  // Touch controls for the profile editor. On phones, a tap on a profile
  // line adds a point; dragging a point moves it. Double-tapping an interior
  // point removes it, providing the mobile equivalent of right-click.
  let profileTouch = {
    active: false, moved: false, index: -1, lastTap: 0, lastTapIndex: -1,
    scrollStartY: 0, scrollStartScrollY: 0, pointerId: null
  };

  profileCanvas.addEventListener("pointerdown", e => {
    if (e.pointerType !== "touch") return;
    const pos = pointerPosition(profileCanvas, e);
    const point = nearestPoint(pos.x, pos.y);
    profileTouch.active = true;
    profileTouch.moved = false;
    profileTouch.index = point;
    profileTouch.pointerId = e.pointerId;
    profileTouch.scrollStartY = e.clientY;
    profileTouch.scrollStartScrollY = window.scrollY;

    if (point >= 0) {
      e.preventDefault();
      profileCanvas.setPointerCapture?.(e.pointerId);
      const now = performance.now();
      if (point > 0 && point < profile.length - 1 &&
          point === profileTouch.lastTapIndex && now - profileTouch.lastTap < 350) {
        profile.splice(point, 1);
        profileTouch.active = false;
        profileTouch.index = -1;
        profileTouch.lastTapIndex = -1;
        redrawAll();
        return;
      }
      profileTouch.lastTap = now;
      profileTouch.lastTapIndex = point;

      dragIndex = point;
      const w = screenToWorld(pos.x, pos.y);
      dragOffset.x = profile[point].x - w.x;
      dragOffset.y = profile[point].y - w.y;
      profileCanvas.style.cursor = "grabbing";
      return;
    }

    const edge = nearestEdge(pos.x, pos.y);
    if (edge >= 0) {
      e.preventDefault();
      const w = screenToWorld(pos.x, pos.y);
      const snapped = snapPoint(w);
      w.x = Math.max(5, snapped.x);
      w.y = Math.max(0, snapped.y);
      w.y = Math.max(profile[edge].y + 1,
                     Math.min(profile[edge + 1].y - 1, w.y));
      profile.splice(edge + 1, 0, w);
      dragIndex = edge + 1;
      dragOffset.x = 0;
      dragOffset.y = 0;
      profileTouch.index = dragIndex;
      profileCanvas.style.cursor = "grabbing";
      redrawAll();
    }
    // Background: deliberately do not capture the pointer. Instead, emulate
    // the page's normal vertical scrolling while the finger moves.
    // This lets node drags stay locked to the editor without sacrificing
    // scrollability of the page.
  }, { passive: false });

  profileCanvas.addEventListener("pointermove", e => {
    if (e.pointerType !== "touch") return;
    if (profileTouch.index < 0 && dragIndex < 0 && profileTouch.active) {
      e.preventDefault();
      const dy = e.clientY - profileTouch.scrollStartY;
      window.scrollTo(window.scrollX, profileTouch.scrollStartScrollY - dy);
      return;
    }
    if (e.pointerType !== "touch" || dragIndex < 0) return;
    e.preventDefault();
    const pos = pointerPosition(profileCanvas, e);
    const dx = pos.x - worldToScreen(profile[dragIndex]).x;
    const dy = pos.y - worldToScreen(profile[dragIndex]).y;
    if (Math.hypot(dx, dy) > 3) profileTouch.moved = true;

    const w = screenToWorld(pos.x, pos.y);
    const p = profile[dragIndex];
    p.x = Math.max(5, snapValue(w.x + dragOffset.x));
    if (dragIndex !== 0 && dragIndex !== profile.length - 1) {
      p.y = Math.max(0, snapValue(w.y + dragOffset.y));
      const previous = profile[dragIndex - 1];
      const next = profile[dragIndex + 1];
      p.y = Math.max(previous.y + 1, Math.min(next.y - 1, p.y));
    } else {
      if (dragIndex === 0) p.y = 0;
      else p.y = Math.max(profile[profile.length - 2].y + 1, p.y);
    }
    if (dragIndex === profile.length - 1) heightInput.value = Math.round(p.y);
    redrawAll();
  }, { passive: false });

  profileCanvas.addEventListener("pointerup", e => {
    if (e.pointerType !== "touch") return;
    e.preventDefault();
    dragIndex = -1;
    profileTouch.active = false;
    profileTouch.index = -1;
    profileTouch.pointerId = null;
    profileCanvas.style.cursor = "default";
    try { profileCanvas.releasePointerCapture?.(e.pointerId); } catch (_) {}
  }, { passive: false });

  profileCanvas.addEventListener("pointercancel", e => {
    if (e.pointerType !== "touch") return;
    dragIndex = -1;
    profileTouch.active = false;
    profileCanvas.style.cursor = "default";
  });

  // Mobile 3D interaction: only a touch that starts on the actual object
  // rotates it. Touches starting on empty canvas are deliberately ignored so
  // the browser can scroll the page normally.
  let viewTouch = { active: false, pointerId: null, lastX: 0, lastY: 0 };
  viewCanvas.addEventListener("pointerdown", e => {
    if (e.pointerType !== "touch") return;
    if (!touchHits3DObject(e.clientX, e.clientY)) return;

    e.preventDefault();
    viewTouch.active = true;
    viewTouch.pointerId = e.pointerId;
    viewTouch.lastX = e.clientX;
    viewTouch.lastY = e.clientY;
    viewCanvas.setPointerCapture?.(e.pointerId);
  }, { passive: false });

  viewCanvas.addEventListener("pointermove", e => {
    if (e.pointerType !== "touch" || !viewTouch.active || e.pointerId !== viewTouch.pointerId) return;
    e.preventDefault();
    const dx = e.clientX - viewTouch.lastX;
    const dy = e.clientY - viewTouch.lastY;
    view.yaw -= dx * 0.01;
    view.pitch += dy * 0.008;
    view.pitch = Math.max(-1.2, Math.min(1.2, view.pitch));
    viewTouch.lastX = e.clientX;
    viewTouch.lastY = e.clientY;
    draw3D();
  }, { passive: false });

  function stopViewTouch(e) {
    if (e.pointerType !== "touch" || e.pointerId !== viewTouch.pointerId) return;
    viewTouch.active = false;
    viewTouch.pointerId = null;
    try { viewCanvas.releasePointerCapture?.(e.pointerId); } catch (_) {}
  }

  viewCanvas.addEventListener("pointerup", stopViewTouch);
  viewCanvas.addEventListener("pointercancel", stopViewTouch);

  // Mouse controls for the 3D view.
  viewCanvas.addEventListener("mousedown", e => {
    if (e.button !== 0) return;
    view.dragging = true;
    view.lastX = e.clientX;
    view.lastY = e.clientY;
  });

  window.addEventListener("mousemove", e => {
    if (!view.dragging) return;

    const dx = e.clientX - view.lastX;
    const dy = e.clientY - view.lastY;

    view.yaw -= dx * 0.01;
    view.pitch += dy * 0.008;
    view.pitch = Math.max(-1.2, Math.min(1.2, view.pitch));

    view.lastX = e.clientX;
    view.lastY = e.clientY;

    draw3D();
  });

  window.addEventListener("mouseup", () => {
    view.dragging = false;
  });

  viewCanvas.addEventListener("wheel", e => {
    e.preventDefault();
    view.zoom *= Math.exp(-e.deltaY * 0.001);
    view.zoom = Math.max(0.35, Math.min(3, view.zoom));
    draw3D();
  }, { passive: false });

  // Keep height input synchronized when the top point is dragged.
  window.addEventListener("mousemove", () => {
    if (dragIndex === profile.length - 1) {
      heightInput.value = Math.round(profile[profile.length - 1].y);
    }
  });


  function redrawAll() {
    drawProfile();
    draw3D();
    drawLattice();
    saveStateToURL();
  }

  smoothValue.textContent = smoothInput.value;
  loadStateFromURL();
  resize();
})();
