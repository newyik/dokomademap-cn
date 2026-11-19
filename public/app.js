(() => {
  "use strict";

  const DEFAULTS = {
    whPerKm: 160,
    fullRangeKm: 600,
    departPct: 80,
    arrivePct: 10,
    roundTrip: false,
    winter: false,
    ferry: true,
    ferryCharge: true,
    showCamp: true,
    fontScale: 1,
    theme: "auto", // auto | dark | light
  };

  // Model 3 Long Range Dual Motor (LRW3F7EK9TC939131) usable reference: 75 kWh @ 600 km
  const BASE_USABLE_WH = 75000.0;
  const BASE_FULL_KM = 600.0;
  const CLIMB_WH_PER_M = 6.0;
  const DESCENT_REGEN_WH_PER_M = 3.3;
  const FERRY_CHARGE_WATTS = 3000.0;
  const WINTER_MULT = 1.28;

  const STYLE_URLS = {
    dark: "https://tiles.openfreemap.org/styles/dark",
    light: "https://tiles.openfreemap.org/styles/positron",
  };

  const state = loadState();
  let map = null;
  let graph = null;
  let grid = null;
  let superchargers = [];
  let ferries = [];
  let campSpots = [];
  let selectedScIdx = -1;
  let selectedCampIdx = -1;
  let campTempC = 8;
  let campHours = 8;
  let campExtra = false;
  let currentMode = "map"; // map | camp
  let cvFilter = "all";
  let cvSearchQuery = "";
  let cvRefCoord = { lat: 35.6812, lon: 139.7671, label: "东京周边" };
  let cvOutTemp = 6;
  let cvCabinTemp = 21;
  let cvArrSoc = 60;
  let cvSentry = false;
  let cvFridge = false;
  let currentTheme = resolveTheme(state.theme);

  // Offscreen canvas for Mercator land-masked reachability overlay
  let reachCanvas = null;
  let reachCtx = null;
  let reachImgData = null;
  let reachPixels32 = null;

  // Reusable Dijkstra scratch buffers
  let bestTime = null;
  let minUsed = null;
  let ferryHops = null;
  let parentNode = null;
  let parentEdge = null;
  let goUsed = null;
  let goParentNode = null;
  let goParentEdge = null;
  let backUsed = null;
  let selectedDest = null; // { name, lat, lon }
  let dataReadyPromise = null;
  let heapNode = new Uint32Array(262144);
  let heapTime = new Float64Array(262144);
  let heapUsed = new Float64Array(262144);
  let heapSize = 0;

  function loadState() {
    try {
      const raw = localStorage.getItem("dokomademap_cn_m3lr_v1");
      if (raw) {
        return { ...DEFAULTS, ...JSON.parse(raw) };
      }
    } catch (_) {}
    return { ...DEFAULTS };
  }

  function saveState() {
    try {
      localStorage.setItem("dokomademap_cn_m3lr_v1", JSON.stringify(state));
    } catch (_) {}
  }

  function resolveTheme(mode) {
    if (mode === "dark" || mode === "light") return mode;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  }

  function applyThemeAndFont() {
    document.documentElement.style.setProperty("--font-scale", String(state.fontScale));
    const nextTheme = resolveTheme(state.theme);
    document.body.classList.toggle("theme-light", nextTheme === "light");

    document.getElementById("btn-theme-auto").classList.toggle("active", state.theme === "auto");
    document.getElementById("btn-theme-dark").classList.toggle("active", state.theme === "dark");
    document.getElementById("btn-theme-light").classList.toggle("active", state.theme === "light");

    if (map && nextTheme !== currentTheme) {
      currentTheme = nextTheme;
      map.setStyle(STYLE_URLS[currentTheme]);
    } else {
      currentTheme = nextTheme;
    }
  }

  // Safe aligned typed-array reader
  function readTyped(buf, byteOffset, Ctor, count) {
    const byteLen = count * Ctor.BYTES_PER_ELEMENT;
    if (byteOffset % Ctor.BYTES_PER_ELEMENT === 0) {
      return new Ctor(buf, byteOffset, count);
    }
    return new Ctor(buf.slice(byteOffset, byteOffset + byteLen));
  }

  function parseGraph(buf) {
    const dv = new DataView(buf);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== "DMAP") throw new Error("graph.bin 格式无效");
    const nNodes = dv.getUint32(4, true);
    const nEdges = dv.getUint32(8, true);

    let off = 12;
    const nodeLat = readTyped(buf, off, Float32Array, nNodes); off += nNodes * 4;
    const nodeLon = readTyped(buf, off, Float32Array, nNodes); off += nNodes * 4;
    const nodeElev = readTyped(buf, off, Int16Array, nNodes); off += nNodes * 2;

    const fwdHead = readTyped(buf, off, Uint32Array, nNodes + 1); off += (nNodes + 1) * 4;
    const fwdTo = readTyped(buf, off, Uint32Array, nEdges); off += nEdges * 4;
    const fwdDist = readTyped(buf, off, Uint32Array, nEdges); off += nEdges * 4;
    const fwdTime = readTyped(buf, off, Uint32Array, nEdges); off += nEdges * 4;
    const fwdClimb = readTyped(buf, off, Uint16Array, nEdges); off += nEdges * 2;
    const fwdDescent = readTyped(buf, off, Uint16Array, nEdges); off += nEdges * 2;
    const fwdFlags = readTyped(buf, off, Uint8Array, nEdges); off += nEdges;

    const revHead = readTyped(buf, off, Uint32Array, nNodes + 1); off += (nNodes + 1) * 4;
    const revFrom = readTyped(buf, off, Uint32Array, nEdges); off += nEdges * 4;
    const revEidx = readTyped(buf, off, Uint32Array, nEdges);

    bestTime = new Float64Array(nNodes);
    minUsed = new Float64Array(nNodes);
    ferryHops = new Uint8Array(nNodes);
    parentNode = new Int32Array(nNodes);
    parentEdge = new Int32Array(nNodes);
    goUsed = new Float64Array(nNodes);
    goParentNode = new Int32Array(nNodes);
    goParentEdge = new Int32Array(nNodes);
    backUsed = new Float64Array(nNodes);

    return {
      nNodes,
      nEdges,
      nodeLat,
      nodeLon,
      nodeElev,
      fwdHead,
      fwdTo,
      fwdDist,
      fwdTime,
      fwdClimb,
      fwdDescent,
      fwdFlags,
      revHead,
      revFrom,
      revEidx,
    };
  }

  function parseLandGrid(buf) {
    const dv = new DataView(buf);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== "LGRD") throw new Error("landgrid.bin 格式无效");
    const w = dv.getUint32(4, true);
    const h = dv.getUint32(8, true);
    const nPix = dv.getUint32(12, true);
    const latMin = dv.getFloat32(16, true);
    const latMax = dv.getFloat32(20, true);
    const lonMin = dv.getFloat32(24, true);
    const lonMax = dv.getFloat32(28, true);

    let off = 32;
    const pixIdx = readTyped(buf, off, Uint32Array, nPix); off += nPix * 4;
    const pixNode = readTyped(buf, off, Uint32Array, nPix); off += nPix * 4;
    const pixDist = readTyped(buf, off, Uint16Array, nPix);

    reachCanvas = document.createElement("canvas");
    reachCanvas.width = w;
    reachCanvas.height = h;
    reachCtx = reachCanvas.getContext("2d");
    reachImgData = reachCtx.createImageData(w, h);
    reachPixels32 = new Uint32Array(reachImgData.data.buffer);

    return { w, h, nPix, latMin, latMax, lonMin, lonMax, pixIdx, pixNode, pixDist };
  }

  // Min-Heap helpers (ordered by time, tie-broken by used energy)
  function heapEnsure(cap) {
    if (cap <= heapNode.length) return;
    const next = heapNode.length * 2;
    const nNode = new Uint32Array(next);
    const nTime = new Float64Array(next);
    const nUsed = new Float64Array(next);
    nNode.set(heapNode);
    nTime.set(heapTime);
    nUsed.set(heapUsed);
    heapNode = nNode;
    heapTime = nTime;
    heapUsed = nUsed;
  }

  function heapPush(node, time, used) {
    heapEnsure(heapSize + 1);
    let i = heapSize++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapTime[p] <= time) break;
      heapNode[i] = heapNode[p];
      heapTime[i] = heapTime[p];
      heapUsed[i] = heapUsed[p];
      i = p;
    }
    heapNode[i] = node;
    heapTime[i] = time;
    heapUsed[i] = used;
  }

  let popTime = 0, popUsed = 0;
  function heapPop() {
    const node = heapNode[0];
    const time = heapTime[0];
    const used = heapUsed[0];
    const last = --heapSize;
    if (last > 0) {
      const tNode = heapNode[last];
      const tTime = heapTime[last];
      const tUsed = heapUsed[last];
      let i = 0;
      const half = last >> 1;
      while (i < half) {
        let c = (i << 1) + 1;
        const r = c + 1;
        if (r < last && heapTime[r] < heapTime[c]) c = r;
        if (tTime <= heapTime[c]) break;
        heapNode[i] = heapNode[c];
        heapTime[i] = heapTime[c];
        heapUsed[i] = heapUsed[c];
        i = c;
      }
      heapNode[i] = tNode;
      heapTime[i] = tTime;
      heapUsed[i] = tUsed;
    }
    popTime = time;
    popUsed = used;
    return node;
  }

  function computeEnergyParams() {
    const usableFullWh = BASE_USABLE_WH * (state.fullRangeKm / BASE_FULL_KM);
    const usablePct = Math.max(0, state.departPct - state.arrivePct);
    const budgetWh = usableFullWh * (usablePct / 100.0);
    // Battery cannot exceed 100% SoC on downhill/ferry charging
    const minUsedAllowed = -usableFullWh * ((100.0 - state.departPct) / 100.0);
    const winterMult = state.winter ? WINTER_MULT : 1.0;
    return { usableFullWh, budgetWh, minUsedAllowed, winterMult };
  }

  function runDijkstra(startNode, isReverse, params, outMinUsed, outParentNode = null, outParentEdge = null) {
    const { nNodes, fwdHead, fwdTo, fwdDist, fwdTime, fwdClimb, fwdDescent, fwdFlags, revHead, revFrom, revEidx } = graph;
    const { budgetWh, minUsedAllowed, winterMult } = params;
    const whPerM = (state.whPerKm / 1000.0) * winterMult;
    const climbWh = CLIMB_WH_PER_M * winterMult;
    const useFerry = state.ferry;
    const useFerryCharge = state.ferry && state.ferryCharge;

    bestTime.fill(Infinity);
    minUsed.fill(Infinity);
    ferryHops.fill(255);
    parentNode.fill(-1);
    parentEdge.fill(-1);
    heapSize = 0;

    bestTime[startNode] = 0;
    minUsed[startNode] = 0;
    ferryHops[startNode] = 0;
    heapPush(startNode, 0, 0);

    let pops = 0;
    const maxPops = 1500000;

    while (heapSize > 0 && pops < maxPops) {
      const u = heapPop();
      const curTime = popTime, curUsed = popUsed;
      pops++;

      // Skip stale heap entries unless this entry represents our lowest-energy path
      if (curTime > bestTime[u] && curUsed > minUsed[u] + 1) continue;

      const uHops = ferryHops[u];
      const startE = isReverse ? revHead[u] : fwdHead[u];
      const endE = isReverse ? revHead[u + 1] : fwdHead[u + 1];

      for (let k = startE; k < endE; k++) {
        const v = isReverse ? revFrom[k] : fwdTo[k];
        const eIdx = isReverse ? revEidx[k] : k;
        const flg = fwdFlags[eIdx];

        if (flg > 0 && !useFerry) continue;

        const nextHops = flg > 0 ? uHops + 1 : uHops;
        if (nextHops > 1) continue;

        const dt = fwdTime[eIdx];
        let newUsed;
        if (flg === 0) {
          const dWh = fwdDist[eIdx] * whPerM + fwdClimb[eIdx] * climbWh - fwdDescent[eIdx] * DESCENT_REGEN_WH_PER_M;
          newUsed = curUsed + dWh;
          if (newUsed < minUsedAllowed) newUsed = minUsedAllowed;
        } else if (flg === 2 && useFerryCharge) {
          const chargeWh = FERRY_CHARGE_WATTS * (dt / 3600.0);
          newUsed = curUsed - chargeWh;
          if (newUsed < minUsedAllowed) newUsed = minUsedAllowed;
        } else {
          newUsed = curUsed;
        }

        if (newUsed > budgetWh) continue;

        const newTime = curTime + dt;
        const faster = newTime < bestTime[v];
        // Allow energy-saving ferry wave to propagate past road-settled ports without road-loop blowup
        const canRevisitCheaper =
          (flg > 0 && (minUsed[v] === Infinity || uHops === 0)) ||
          (flg === 0 && nextHops > ferryHops[v]);
        const muchCheaper = canRevisitCheaper && newUsed < minUsed[v] - 400.0;

        if (faster || muchCheaper) {
          if (faster) bestTime[v] = newTime;
          if (newUsed < minUsed[v]) minUsed[v] = newUsed;
          if (ferryHops[v] === 255 || muchCheaper || nextHops < ferryHops[v]) {
            ferryHops[v] = nextHops;
          }
          parentNode[v] = u;
          parentEdge[v] = eIdx;
          heapPush(v, newTime, newUsed);
        }
      }
    }

    outMinUsed.set(minUsed);
    if (outParentNode) outParentNode.set(parentNode);
    if (outParentEdge) outParentEdge.set(parentEdge);
  }

  // Green -> Lime -> Yellow -> Orange -> Red (little-endian ABGR for Uint32Array)
  function ratioToABGR(ratio) {
    const t = Math.max(0, Math.min(1, ratio));
    let r, g, b;
    if (t >= 0.6) {
      // 1.0 -> 0.6: #16a34a (22,163,74) -> #84cc16 (132,204,22)
      const k = (1.0 - t) / 0.4;
      r = Math.round(22 + k * (132 - 22));
      g = Math.round(180 + k * (212 - 180));
      b = Math.round(74 + k * (22 - 74));
    } else if (t >= 0.3) {
      // 0.6 -> 0.3: #84cc16 -> #facc15 (250,204,21)
      const k = (0.6 - t) / 0.3;
      r = Math.round(132 + k * (250 - 132));
      g = Math.round(212 + k * (204 - 212));
      b = Math.round(22 + k * (21 - 22));
    } else {
      // 0.3 -> 0.0: #facc15 -> #ef4444 (239,68,68)
      const k = (0.3 - t) / 0.3;
      r = Math.round(250 + k * (239 - 250));
      g = Math.round(204 + k * (68 - 204));
      b = Math.round(21 + k * (68 - 21));
    }
    const alpha = Math.round(135 + 35 * (1.0 - t * 0.3));
    return (alpha << 24) | (b << 16) | (g << 8) | r;
  }

  let revealAnimId = 0;

  function paintReachPixels(budgetWh, offroadWhPerM, revealFrac) {
    const { nPix, pixIdx, pixNode, pixDist } = grid;
    reachPixels32.fill(0);
    if (budgetWh <= 0 || revealFrac <= 0) {
      reachCtx.putImageData(reachImgData, 0, 0);
      return;
    }

    const invBudget = 1.0 / budgetWh;
    const maxAllowedUsed = budgetWh * revealFrac;
    for (let i = 0; i < nPix; i++) {
      const nodeUsed = goUsed[pixNode[i]];
      if (nodeUsed > maxAllowedUsed) continue;
      const totalUsed = nodeUsed + pixDist[i] * offroadWhPerM;
      if (totalUsed <= maxAllowedUsed) {
        const rem = budgetWh - totalUsed;
        if (rem > 0) {
          reachPixels32[pixIdx[i]] = ratioToABGR(rem * invBudget);
        }
      }
    }
    reachCtx.putImageData(reachImgData, 0, 0);
  }

  function refreshCanvasOverlayOnce() {
    if (!map) return;
    const src = map.getSource("reach-overlay");
    if (!src) return;
    src.play();
    requestAnimationFrame(() => {
      if (!revealAnimId && map.getSource("reach-overlay")) {
        map.getSource("reach-overlay").pause();
      }
    });
  }

  function updateReachability(opts = {}) {
    if (!graph || !grid || !map) return;
    const { animate = false, pan = false } = opts;

    if (revealAnimId) {
      cancelAnimationFrame(revealAnimId);
      revealAnimId = 0;
    }

    const emptyEl = document.getElementById("status-empty");
    const activeEl = document.getElementById("status-active");
    const ferryLegendEl = document.getElementById("ferry-legend");

    if (selectedScIdx < 0) {
      if (selectedCampIdx < 0) emptyEl.classList.remove("hidden");
      else emptyEl.classList.add("hidden");
      activeEl.classList.add("hidden");
      if (map.getLayer("reach-overlay-layer")) {
        map.setLayoutProperty("reach-overlay-layer", "visibility", "none");
      }
      const src = map.getSource("reach-overlay");
      if (src) src.pause();
      updateFerryLayer(null, Infinity);
      updateSuperchargerLayer(null, Infinity);
      updateDestRouteLayer(null, null);
      if (selectedCampIdx >= 0) updateCampCalc();
      return;
    }

    emptyEl.classList.add("hidden");
    activeEl.classList.remove("hidden");
    if (ferryLegendEl) {
      ferryLegendEl.classList.toggle("hidden", !state.ferry);
    }
    if (map.getLayer("reach-overlay-layer")) {
      map.setLayoutProperty("reach-overlay-layer", "visibility", "visible");
    }

    const sc = superchargers[selectedScIdx];
    const params = computeEnergyParams();
    const { budgetWh, winterMult } = params;

    // 1. Run Dijkstra from selected Supercharger
    runDijkstra(sc.node, false, params, goUsed, goParentNode, goParentEdge);
    if (state.roundTrip) {
      runDijkstra(sc.node, true, params, backUsed);
      for (let i = 0; i < graph.nNodes; i++) {
        if (goUsed[i] <= budgetWh && backUsed[i] <= budgetWh) {
          goUsed[i] = goUsed[i] + backUsed[i];
        } else {
          goUsed[i] = Infinity;
        }
      }
    }

    // 2. Smoothly center camera and animate outward energy wave when clicking a Supercharger
    const offroadWhPerM = (state.whPerKm / 1000.0) * 1.12 * winterMult * (state.roundTrip ? 2.0 : 1.0);
    if (pan) {
      map.easeTo({
        center: [sc.lon, sc.lat],
        duration: 500,
        easing: (t) => 1 - Math.pow(1 - t, 3),
      });
    }

    const src = map.getSource("reach-overlay");
    if (animate && budgetWh > 0 && src) {
      const startMs = performance.now();
      const durationMs = 420;
      src.play();
      const step = (now) => {
        const rawT = Math.min(1.0, (now - startMs) / durationMs);
        const eased = 1.0 - Math.pow(1.0 - rawT, 3);
        paintReachPixels(budgetWh, offroadWhPerM, 0.06 + 0.94 * eased);
        if (map.getLayer("sc-selected-halo")) {
          map.setPaintProperty("sc-selected-halo", "circle-radius", 24 - 10 * eased);
        }
        if (rawT < 1.0) {
          revealAnimId = requestAnimationFrame(step);
        } else {
          revealAnimId = 0;
          src.pause();
        }
      };
      revealAnimId = requestAnimationFrame(step);
    } else {
      paintReachPixels(budgetWh, offroadWhPerM, 1.0);
      refreshCanvasOverlayOnce();
    }

    // 3. Update Ferry & Supercharger layers and status metrics
    updateFerryLayer(goUsed, budgetWh);
    const reachableScCount = updateSuperchargerLayer(goUsed, budgetWh);

    document.getElementById("sc-name").textContent = sc.name;
    const locParts = [sc.state, sc.city].filter(Boolean).join(" · ");
    document.getElementById("sc-meta").textContent =
      `${locParts ? locParts + " · " : ""}${sc.stalls || "?"} 桩 · ${sc.kw || "?"} kW`;
    document.getElementById("metric-kwh").textContent = `${(budgetWh / 1000.0).toFixed(1)} kWh`;
    const flatKm = budgetWh > 0 ? (budgetWh / (state.whPerKm * winterMult)) / (state.roundTrip ? 2.0 : 1.0) : 0;
    document.getElementById("metric-range").textContent = `${Math.round(flatKm)} km`;
    document.getElementById("metric-sc-count").textContent = `${reachableScCount} 座`;
    const gauge = document.getElementById("soc-gauge");
    if (gauge) {
      gauge.style.setProperty("--soc-from", state.arrivePct + "%");
      gauge.style.setProperty("--soc-to", state.departPct + "%");
      document.getElementById("soc-label").textContent = `${state.departPct}% → ${state.arrivePct}%`;
    }
    if (selectedDest) {
      evaluateDestination(selectedDest);
    } else {
      updateDestRouteLayer(null, null);
    }
    if (selectedCampIdx >= 0) {
      updateCampCalc();
    }
  }

  function updateFerryLayer(usedArr, budgetWh) {
    if (!map) return;
    const src = map.getSource("ferry-routes");
    if (!src) return;

    // Only display reachable domestic ferry routes once an origin Supercharger is selected
    if (!state.ferry || !usedArr) {
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    const features = [];
    for (let i = 0; i < ferries.length; i++) {
      const f = ferries[i];
      if (usedArr[f.u] > budgetWh && usedArr[f.v] > budgetWh) continue;
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: f.coords },
        properties: {
          idx: i,
          name: f.name,
          operator: f.operator,
          duration_min: f.duration_min,
          distance_km: f.distance_km,
          ev_charge: f.ev_charge ? 1 : 0,
        },
      });
    }
    src.setData({ type: "FeatureCollection", features });
  }

  function updateSuperchargerLayer(usedArr, budgetWh) {
    if (!map) return 0;
    const src = map.getSource("superchargers");
    if (!src) return 0;

    let reachableCount = 0;
    const { usableFullWh } = computeEnergyParams();
    const features = superchargers.map((sc, idx) => {
      let status = 0; // 0 = normal, 1 = reachable, 2 = selected
      let arrivalPct = null;
      if (idx === selectedScIdx) {
        status = 2;
      } else if (usedArr && usedArr[sc.node] <= budgetWh) {
        status = 1;
        reachableCount++;
        if (usableFullWh > 0) {
          const remTotalWh = usableFullWh * (state.departPct / 100.0) - usedArr[sc.node];
          arrivalPct = Math.max(0, Math.min(100, Math.round((remTotalWh / usableFullWh) * 100)));
        }
      }
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [sc.lon, sc.lat] },
        properties: {
          idx,
          name: sc.name,
          stalls: sc.stalls,
          kw: sc.kw,
          status,
          arrivalPct: arrivalPct === null ? -1 : arrivalPct,
        },
      };
    });

    src.setData({ type: "FeatureCollection", features });
    return reachableCount;
  }

  function findFirstSymbolLayerId() {
    const layers = map.getStyle().layers || [];
    for (const l of layers) {
      if (l.type === "symbol") return l.id;
    }
    return undefined;
  }

  let pendingRaf = 0;
  function scheduleReachabilityUpdate() {
    if (pendingRaf) cancelAnimationFrame(pendingRaf);
    pendingRaf = requestAnimationFrame(() => {
      pendingRaf = 0;
      updateReachability();
    });
  }

  function ensureReachOverlaySource() {
    if (!map || !grid || !map.isStyleLoaded()) return;
    if (map.getSource("reach-overlay")) return;
    const beforeId = findFirstSymbolLayerId();
    map.addSource("reach-overlay", {
      type: "canvas",
      canvas: reachCanvas,
      animate: false,
      coordinates: [
        [grid.lonMin, grid.latMax],
        [grid.lonMax, grid.latMax],
        [grid.lonMax, grid.latMin],
        [grid.lonMin, grid.latMin],
      ],
    });
    map.addLayer(
      {
        id: "reach-overlay-layer",
        type: "raster",
        source: "reach-overlay",
        layout: { visibility: selectedScIdx >= 0 ? "visible" : "none" },
        paint: {
          "raster-opacity": 0.9,
          "raster-resampling": "linear",
        },
      },
      beforeId
    );
  }

  function setupMapLayers() {
    const beforeId = findFirstSymbolLayerId();

    ensureReachOverlaySource();

    map.addSource("ferry-routes", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer(
      {
        id: "ferry-routes-std",
        type: "line",
        source: "ferry-routes",
        filter: ["==", ["get", "ev_charge"], 0],
        paint: {
          "line-color": "#94a3b8",
          "line-width": 1.6,
          "line-opacity": 0.6,
          "line-dasharray": [4, 3],
        },
      },
      beforeId
    );
    map.addLayer(
      {
        id: "ferry-routes-ev",
        type: "line",
        source: "ferry-routes",
        filter: ["==", ["get", "ev_charge"], 1],
        paint: {
          "line-color": "#22c55e",
          "line-width": 2.6,
          "line-opacity": 0.9,
        },
      },
      beforeId
    );

    map.addSource("dest-route", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer(
      {
        id: "dest-route-line",
        type: "line",
        source: "dest-route",
        paint: {
          "line-color": "#38bdf8",
          "line-width": 4,
          "line-opacity": 0.92,
        },
      },
      beforeId
    );

    map.addSource("dest-pin", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({
      id: "dest-pin-circle",
      type: "circle",
      source: "dest-pin",
      paint: {
        "circle-radius": 8,
        "circle-color": "#38bdf8",
        "circle-stroke-width": 2.5,
        "circle-stroke-color": "#ffffff",
      },
    });

    map.addSource("superchargers", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });

    // Selected SC outer halo
    map.addLayer({
      id: "sc-selected-halo",
      type: "circle",
      source: "superchargers",
      filter: ["==", ["get", "status"], 2],
      paint: {
        "circle-radius": 14,
        "circle-color": "rgba(232, 33, 39, 0.28)",
        "circle-stroke-width": 2,
        "circle-stroke-color": "#ffffff",
      },
    });

    map.addLayer({
      id: "sc-circles",
      type: "circle",
      source: "superchargers",
      paint: {
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          4, ["case", ["==", ["get", "status"], 2], 8, 5.2],
          8, ["case", ["==", ["get", "status"], 2], 10, 7],
          12, ["case", ["==", ["get", "status"], 2], 12, 9],
        ],
        "circle-color": [
          "case",
          ["==", ["get", "status"], 2], "#ffffff",
          ["==", ["get", "status"], 1], "#ef4444",
          "#dc2626",
        ],
        "circle-stroke-width": ["case", ["==", ["get", "status"], 2], 3, 1.5],
        "circle-stroke-color": [
          "case",
          ["==", ["get", "status"], 2], "#e82127",
          ["==", ["get", "status"], 1], "#ffffff",
          "rgba(255,255,255,0.75)",
        ],
      },
    });

    // Generous invisible hit-target so markers are easy to click at overview zoom
    map.addLayer({
      id: "sc-hit",
      type: "circle",
      source: "superchargers",
      paint: {
        "circle-radius": 14,
        "circle-opacity": 0,
      },
    });

    // Car-camping spots (道の駅 / RV 营地 / SA)
    map.addSource("camp-spots", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer(
      {
        id: "camp-circles",
        type: "circle",
        source: "camp-spots",
        minzoom: 5.8,
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            6, 2.8,
            9, 4.5,
            12, 6.5,
          ],
          "circle-color": [
            "match",
            ["get", "kind"],
            "rv", "#14b8a6",
            "sa", "#60a5fa",
            "#f59e0b",
          ],
          "circle-opacity": [
            "interpolate",
            ["linear"],
            ["zoom"],
            5.8, 0.5,
            7.5, 0.9,
          ],
          "circle-stroke-width": 1,
          "circle-stroke-color": "rgba(255,255,255,0.7)",
        },
      },
      "sc-selected-halo"
    );
    map.addLayer(
      {
        id: "camp-hit",
        type: "circle",
        source: "camp-spots",
        minzoom: 5.8,
        paint: {
          "circle-radius": 11,
          "circle-opacity": 0,
        },
      },
      "sc-selected-halo"
    );

    updateCampLayer();
    updateSuperchargerLayer(null, Infinity);
    if (graph && grid) updateReachability();
  }

  function bindMapInteractions() {
    const hoverPopup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 12,
    });

    map.on("mouseenter", "sc-hit", (e) => {
      map.getCanvas().style.cursor = "pointer";
      const f = e.features[0];
      const p = f.properties;
      let html = `<strong>${p.name}</strong><br/>${p.stalls || "?"} 桩 · ${p.kw || "?"} kW`;
      if (p.status === 2) {
        html += `<br/><span style="color:#4ade80">当前出发起点</span>`;
      } else if (p.status === 1 && p.arrivalPct >= 0) {
        html += `<br/><span style="color:#4ade80">预计到达剩余约 ${p.arrivalPct}%</span>`;
      }
      hoverPopup.setLngLat(f.geometry.coordinates).setHTML(html).addTo(map);
    });

    map.on("mouseleave", "sc-hit", () => {
      map.getCanvas().style.cursor = "";
      hoverPopup.remove();
    });

    map.on("click", "sc-hit", async (e) => {
      const f = e.features[0];
      selectedScIdx = f.properties.idx;
      if (dataReadyPromise) await dataReadyPromise;
      updateReachability({ animate: true, pan: true });
    });

    const onFerryEnter = () => { map.getCanvas().style.cursor = "pointer"; };
    const onFerryLeave = () => { map.getCanvas().style.cursor = ""; };
    const onFerryClick = (e) => {
      if (map.queryRenderedFeatures(e.point, { layers: ["sc-hit"] }).length > 0) return;
      const f = e.features[0];
      const p = f.properties;
      const hrs = Math.floor(p.duration_min / 60);
      const mins = p.duration_min % 60;
      const durText = hrs > 0 ? `${hrs} 小时 ${mins} 分钟` : `${mins} 分钟`;
      const chargeText = p.ev_charge
        ? `<span style="color:#22c55e;font-weight:600">支持船上 EV 充电（约 3 kW）</span>`
        : `<span>无船上充电（保持登船电量）</span>`;
      new maplibregl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(
          `<strong>${p.name}</strong>` +
          (p.operator ? `<br/>运营方：${p.operator}` : "") +
          `<br/>航程：约 ${p.distance_km} km · 预计耗时：${durText}<br/>${chargeText}`
        )
        .addTo(map);
    };

    map.on("mouseenter", "ferry-routes-std", onFerryEnter);
    map.on("mouseleave", "ferry-routes-std", onFerryLeave);
    map.on("click", "ferry-routes-std", onFerryClick);
    map.on("mouseenter", "ferry-routes-ev", onFerryEnter);
    map.on("mouseleave", "ferry-routes-ev", onFerryLeave);
    map.on("click", "ferry-routes-ev", onFerryClick);

    map.on("mouseenter", "camp-hit", (e) => {
      if (map.queryRenderedFeatures(e.point, { layers: ["sc-hit"] }).length > 0) return;
      map.getCanvas().style.cursor = "pointer";
      const p = e.features[0].properties;
      const kLabel = p.kind === "rv" ? "RV 营地" : p.kind === "sa" ? "高速 SA" : "道の駅";
      hoverPopup
        .setLngLat(e.features[0].geometry.coordinates)
        .setHTML(`<strong>${p.name}</strong><br/>${kLabel} · 海拔 ${p.elev} m · 距最近超充 ${p.sc_km} km`)
        .addTo(map);
    });
    map.on("mouseleave", "camp-hit", () => {
      map.getCanvas().style.cursor = "";
      hoverPopup.remove();
    });
    map.on("click", "camp-hit", (e) => {
      if (map.queryRenderedFeatures(e.point, { layers: ["sc-hit"] }).length > 0) return;
      selectCampSpot(e.features[0].properties.idx, false);
    });
  }

  // ---------- Curated Japan Cities & Landmarks (Instant Offline Search) ----------
  const JP_PLACES = [
    { name: "东京 (Tokyo)", keys: "东京 東京 tokyo", lat: 35.6812, lon: 139.7671 },
    { name: "新宿 (Shinjuku)", keys: "新宿 shinjuku", lat: 35.6896, lon: 139.7006 },
    { name: "涩谷 (Shibuya)", keys: "涩谷 渋谷 shibuya", lat: 35.6580, lon: 139.7016 },
    { name: "羽田机场 (Haneda)", keys: "羽田机场 羽田空港 haneda", lat: 35.5494, lon: 139.7798 },
    { name: "成田机场 (Narita)", keys: "成田机场 成田空港 narita", lat: 35.7720, lon: 140.3929 },
    { name: "横滨 (Yokohama)", keys: "横滨 横浜 yokohama", lat: 35.4437, lon: 139.6380 },
    { name: "镰仓 (Kamakura)", keys: "镰仓 鎌倉 kamakura", lat: 35.3192, lon: 139.5467 },
    { name: "箱根 (Hakone)", keys: "箱根 hakone", lat: 35.2324, lon: 139.1069 },
    { name: "富士山 / 河口湖", keys: "富士山 河口湖 fuji kawaguchiko", lat: 35.4982, lon: 138.7686 },
    { name: "热海 (Atami)", keys: "热海 熱海 atami 伊豆", lat: 35.0962, lon: 139.0717 },
    { name: "轻井泽 (Karuizawa)", keys: "轻井泽 軽井沢 karuizawa", lat: 36.3483, lon: 138.5970 },
    { name: "日光 (Nikko)", keys: "日光 nikko", lat: 36.7199, lon: 139.6982 },
    { name: "草津温泉 (Kusatsu)", keys: "草津温泉 草津 kusatsu", lat: 36.6207, lon: 138.5961 },
    { name: "千叶 (Chiba)", keys: "千叶 千葉 chiba", lat: 35.6074, lon: 140.1065 },
    { name: "埼玉 / 大宫", keys: "埼玉 大宫 大宮 saitama omiya", lat: 35.9063, lon: 139.6240 },
    { name: "宇都宫 (Utsunomiya)", keys: "宇都宫 宇都宮 utsunomiya", lat: 36.5551, lon: 139.8828 },
    { name: "水户 (Mito)", keys: "水户 水戸 mito", lat: 36.3659, lon: 140.4712 },
    { name: "高崎 (Takasaki)", keys: "高崎 takasaki", lat: 36.3219, lon: 139.0033 },
    { name: "甲府 (Kofu)", keys: "甲府 kofu", lat: 35.6621, lon: 138.5683 },
    { name: "静冈 (Shizuoka)", keys: "静冈 静岡 shizuoka", lat: 34.9756, lon: 138.3828 },
    { name: "滨松 (Hamamatsu)", keys: "滨松 浜松 hamamatsu", lat: 34.7108, lon: 137.7261 },
    { name: "名古屋 (Nagoya)", keys: "名古屋 nagoya", lat: 35.1815, lon: 136.9066 },
    { name: "岐阜 (Gifu)", keys: "岐阜 gifu", lat: 35.4233, lon: 136.7607 },
    { name: "高山 (Takayama)", keys: "高山 飞驒 飛騨 takayama", lat: 36.1461, lon: 137.2522 },
    { name: "白川乡 (Shirakawa-go)", keys: "白川乡 白川郷 shirakawa", lat: 36.2578, lon: 136.9062 },
    { name: "金泽 (Kanazawa)", keys: "金泽 金沢 kanazawa", lat: 36.5613, lon: 136.6562 },
    { name: "富山 (Toyama)", keys: "富山 toyama", lat: 36.6959, lon: 137.2137 },
    { name: "长野 (Nagano)", keys: "长野 長野 nagano", lat: 36.6486, lon: 138.1942 },
    { name: "松本 (Matsumoto)", keys: "松本 matsumoto", lat: 36.2380, lon: 137.9720 },
    { name: "白马 (Hakuba)", keys: "白马 白馬 hakuba", lat: 36.6982, lon: 137.8619 },
    { name: "新潟 (Niigata)", keys: "新潟 新泻 niigata", lat: 37.9162, lon: 139.0364 },
    { name: "京都 (Kyoto)", keys: "京都 kyoto", lat: 35.0116, lon: 135.7681 },
    { name: "大阪 (Osaka)", keys: "大阪 osaka", lat: 34.6937, lon: 135.5023 },
    { name: "关西机场 (KIX)", keys: "关西机场 関西空港 kansai kix", lat: 34.4320, lon: 135.2304 },
    { name: "神户 (Kobe)", keys: "神户 神戸 kobe", lat: 34.6901, lon: 135.1955 },
    { name: "奈良 (Nara)", keys: "奈良 nara", lat: 34.6851, lon: 135.8048 },
    { name: "和歌山 (Wakayama)", keys: "和歌山 wakayama", lat: 34.2305, lon: 135.1708 },
    { name: "白滨 (Shirahama)", keys: "白滨 白浜 shirahama", lat: 33.6795, lon: 135.3446 },
    { name: "三重 / 伊势", keys: "伊势 伊勢 三重 ise mie", lat: 34.4875, lon: 136.7094 },
    { name: "广岛 (Hiroshima)", keys: "广岛 広島 hiroshima", lat: 34.3853, lon: 132.4553 },
    { name: "冈山 (Okayama)", keys: "冈山 岡山 okayama", lat: 34.6551, lon: 133.9195 },
    { name: "鸟取 (Tottori)", keys: "鸟取 鳥取 tottori", lat: 35.5011, lon: 134.2351 },
    { name: "高松 (Takamatsu)", keys: "高松 香川 takamatsu", lat: 34.3428, lon: 134.0466 },
    { name: "松山 (Matsuyama)", keys: "松山 爱媛 matsuyama", lat: 33.8392, lon: 132.7657 },
    { name: "仙台 (Sendai)", keys: "仙台 sendai", lat: 38.2682, lon: 140.8694 },
    { name: "郡山 (Koriyama)", keys: "郡山 koriyama", lat: 37.4005, lon: 140.3597 },
    { name: "福岛 (Fukushima)", keys: "福岛 福島 fukushima", lat: 37.7608, lon: 140.4747 },
    { name: "盛冈 (Morioka)", keys: "盛冈 盛岡 morioka", lat: 39.7020, lon: 141.1545 },
    { name: "青森 (Aomori)", keys: "青森 aomori", lat: 40.8221, lon: 140.7474 },
    { name: "函馆 (Hakodate)", keys: "函馆 函館 hakodate", lat: 41.7687, lon: 140.7288 },
    { name: "札幌 (Sapporo)", keys: "札幌 sapporo", lat: 43.0618, lon: 141.3545 },
    { name: "小樽 (Otaru)", keys: "小樽 otaru", lat: 43.1907, lon: 140.9947 },
    { name: "富良野 (Furano)", keys: "富良野 furano", lat: 43.3421, lon: 142.3832 },
    { name: "旭川 (Asahikawa)", keys: "旭川 asahikawa", lat: 43.7706, lon: 142.3650 },
    { name: "福冈 (Fukuoka)", keys: "福冈 福岡 博多 fukuoka hakata", lat: 33.5902, lon: 130.4017 },
    { name: "长崎 (Nagasaki)", keys: "长崎 長崎 nagasaki", lat: 32.7503, lon: 129.8777 },
    { name: "熊本 (Kumamoto)", keys: "熊本 kumamoto", lat: 32.8031, lon: 130.7079 },
    { name: "别府 (Beppu)", keys: "别府 別府 大分 beppu oita", lat: 33.2846, lon: 131.4910 },
    { name: "宫崎 (Miyazaki)", keys: "宫崎 宮崎 miyazaki", lat: 31.9077, lon: 131.4202 },
    { name: "鹿儿岛 (Kagoshima)", keys: "鹿儿岛 鹿児島 kagoshima", lat: 31.5966, lon: 130.5571 },
    { name: "那霸 (Naha)", keys: "那霸 那覇 冲绳 沖縄 naha okinawa", lat: 26.2124, lon: 127.6809 },
  ];

  function haversineKm(lat1, lon1, lat2, lon2) {
    const r = 6371.0;
    const p1 = (lat1 * Math.PI) / 180;
    const p2 = (lat2 * Math.PI) / 180;
    const dp = p2 - p1;
    const dl = ((lon2 - lon1) * Math.PI) / 180;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function findNearestNode(lat, lon, requireReachableBudget = Infinity) {
    if (!graph) return { node: -1, distKm: Infinity };
    const { nNodes, nodeLat, nodeLon } = graph;
    let bestIdx = -1;
    let bestD = Infinity;
    for (let i = 0; i < nNodes; i++) {
      if (requireReachableBudget < Infinity && goUsed[i] > requireReachableBudget) continue;
      // Fast equirectangular filter before haversine
      const dLat = Math.abs(nodeLat[i] - lat);
      if (dLat > 0.45) continue;
      const dLon = Math.abs(nodeLon[i] - lon);
      if (dLon > 0.55) continue;
      const d = haversineKm(lat, lon, nodeLat[i], nodeLon[i]);
      if (d < bestD) {
        bestD = d;
        bestIdx = i;
      }
    }
    return { node: bestIdx, distKm: bestD };
  }

  function findUnboundedRoute(startNode, targetNode) {
    const { nNodes, fwdHead, fwdTo, fwdDist, fwdTime, fwdClimb, fwdDescent, fwdFlags } = graph;
    const params = computeEnergyParams();
    const whPerM = (state.whPerKm / 1000.0) * params.winterMult;
    const climbWh = CLIMB_WH_PER_M * params.winterMult;
    const useFerry = state.ferry;
    const useFerryCharge = state.ferry && state.ferryCharge;

    bestTime.fill(Infinity);
    parentNode.fill(-1);
    parentEdge.fill(-1);
    heapSize = 0;
    bestTime[startNode] = 0;
    heapPush(startNode, 0, 0);

    let pops = 0;
    while (heapSize > 0 && pops < 500000) {
      const u = heapPop();
      const curTime = popTime;
      pops++;
      if (u === targetNode) break;
      if (curTime > bestTime[u]) continue;
      for (let k = fwdHead[u]; k < fwdHead[u + 1]; k++) {
        const flg = fwdFlags[k];
        if (flg > 0 && !useFerry) continue;
        const v = fwdTo[k];
        const nt = curTime + fwdTime[k];
        if (nt < bestTime[v]) {
          bestTime[v] = nt;
          parentNode[v] = u;
          parentEdge[v] = k;
          heapPush(v, nt, 0);
        }
      }
    }

    if (bestTime[targetNode] === Infinity) return null;
    let distM = 0, timeS = 0, climbM = 0, totalWh = 0, usedFerry = false;
    let cur = targetNode;
    const coords = [];
    while (cur !== -1) {
      coords.push([graph.nodeLon[cur], graph.nodeLat[cur]]);
      if (cur === startNode) break;
      const e = parentEdge[cur];
      const p = parentNode[cur];
      if (e < 0 || p < 0) break;
      const flg = fwdFlags[e];
      distM += fwdDist[e];
      timeS += fwdTime[e];
      climbM += fwdClimb[e];
      if (flg === 0) {
        totalWh += fwdDist[e] * whPerM + fwdClimb[e] * climbWh - fwdDescent[e] * DESCENT_REGEN_WH_PER_M;
      } else {
        usedFerry = true;
        if (flg === 2 && useFerryCharge) totalWh -= FERRY_CHARGE_WATTS * (fwdTime[e] / 3600.0);
      }
      cur = p;
    }
    coords.reverse();
    return { distKm: distM / 1000.0, timeS, climbM, totalWh, usedFerry, coords };
  }

  function updateDestRouteLayer(routeCoords, dest) {
    if (!map) return;
    const rSrc = map.getSource("dest-route");
    const pSrc = map.getSource("dest-pin");
    if (rSrc) {
      rSrc.setData(
        routeCoords && routeCoords.length >= 2
          ? { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "LineString", coordinates: routeCoords } }] }
          : { type: "FeatureCollection", features: [] }
      );
    }
    if (pSrc) {
      pSrc.setData(
        dest
          ? { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [dest.lon, dest.lat] } }] }
          : { type: "FeatureCollection", features: [] }
      );
    }
  }

  function evaluateDestination(dest) {
    const resEl = document.getElementById("dest-result");
    const clearBtn = document.getElementById("btn-dest-clear");
    if (!dest || selectedScIdx < 0 || !graph) {
      resEl.classList.add("hidden");
      clearBtn.classList.add("hidden");
      updateDestRouteLayer(null, null);
      return;
    }
    clearBtn.classList.remove("hidden");

    const sc = superchargers[selectedScIdx];
    const params = computeEnergyParams();
    const { budgetWh, usableFullWh, winterMult } = params;
    const offroadWhPerKm = state.whPerKm * 1.12 * winterMult * (state.roundTrip ? 2.0 : 1.0);

    // Check nearest reachable node first, else overall nearest node
    let snap = findNearestNode(dest.lat, dest.lon, budgetWh);
    let reachable = snap.node >= 0 && (goUsed[snap.node] + snap.distKm * offroadWhPerKm) <= budgetWh;
    if (!reachable) {
      snap = findNearestNode(dest.lat, dest.lon, Infinity);
    }

    if (snap.node < 0 || snap.distKm > 45) {
      resEl.className = "dest-result fail";
      resEl.innerHTML = `<div class="dest-badge fail">✕ 暂无附近干线道路</div><div class="dest-details">${dest.name} 距离日本高速/国道网过远。</div>`;
      updateDestRouteLayer(null, dest);
      return;
    }

    const totalUsedWh = reachable ? (goUsed[snap.node] + snap.distKm * offroadWhPerKm) : Infinity;

    if (reachable) {
      // Reconstruct path from goParentNode / goParentEdge (or unbounded if roundTrip modified goUsed)
      let distM = 0, timeS = 0, climbM = 0, usedFerry = false;
      const coords = [[dest.lon, dest.lat]];
      let cur = snap.node;
      let steps = 0;
      while (cur !== -1 && steps < 50000) {
        coords.push([graph.nodeLon[cur], graph.nodeLat[cur]]);
        if (cur === sc.node) break;
        const e = goParentEdge[cur];
        const p = goParentNode[cur];
        if (e < 0 || p < 0) break;
        distM += graph.fwdDist[e];
        timeS += graph.fwdTime[e];
        climbM += graph.fwdClimb[e];
        if (graph.fwdFlags[e] > 0) usedFerry = true;
        cur = p;
        steps++;
      }
      coords.reverse();
      if (coords.length < 2) coords.unshift([sc.lon, sc.lat]);

      const remWh = Math.max(0, usableFullWh * (state.departPct / 100.0) - totalUsedWh);
      const remPct = Math.max(0, Math.min(100, Math.round((remWh / usableFullWh) * 100)));
      const totalKm = Math.round(distM / 1000.0 + snap.distKm);
      const hrs = Math.floor(timeS / 3600);
      const mins = Math.round((timeS % 3600) / 60);
      const durStr = hrs > 0 ? `${hrs} 小时 ${mins} 分` : `${mins} 分钟`;

      resEl.className = "dest-result ok";
      resEl.innerHTML =
        `<div class="dest-badge ok">✓ 可直达 ${dest.name}</div>` +
        `<div class="dest-details">` +
        `${state.roundTrip ? "往返返回起点预计剩余" : "预计到达剩余"} <b>${remPct}%</b> · 路程约 <b>${totalKm} km</b> · 驾车约 <b>${durStr}</b>` +
        (climbM > 50 ? ` · 累计爬升 ${climbM} m` : "") +
        (usedFerry ? ` · 含轮渡` : "") +
        `</div>`;
      updateDestRouteLayer(coords, dest);
    } else {
      // Unreachable in one charge -> compute exact shortfall & recommend relay Superchargers
      const info = findUnboundedRoute(sc.node, snap.node);
      let detailHtml = "";
      if (info) {
        const neededWh = (info.totalWh + snap.distKm * offroadWhPerKm) * (state.roundTrip ? 2.0 : 1.0);
        const shortWh = Math.max(0, neededWh - budgetWh);
        const shortKm = Math.round(shortWh / (state.whPerKm * winterMult));
        detailHtml = `单程路网约 <b>${Math.round(info.distKm + snap.distKm)} km</b>，当前电量还差约 <b>${(shortWh / 1000).toFixed(1)} kWh</b>（约 ${shortKm} km）。`;
        updateDestRouteLayer(info.coords.concat([[dest.lon, dest.lat]]), dest);
      } else {
        detailHtml = "单次电量无法直达该地点（可能需要跨海轮渡或中转补电）。";
        updateDestRouteLayer(null, dest);
      }

      // Recommend top 2 reachable Superchargers closest to destination
      const curDist = haversineKm(sc.lat, sc.lon, dest.lat, dest.lon);
      const relays = superchargers
        .map((s, idx) => ({
          idx,
          s,
          dToDest: haversineKm(s.lat, s.lon, dest.lat, dest.lon),
        }))
        .filter((x) => x.idx !== selectedScIdx && goUsed[x.s.node] <= budgetWh && x.dToDest < curDist * 0.95)
        .sort((a, b) => a.dToDest - b.dToDest)
        .slice(0, 2);

      let relayHtml = "";
      if (relays.length > 0) {
        relayHtml = `<div class="dest-relay-list">` +
          relays.map((r) =>
            `<button class="dest-relay-btn" type="button" data-sc-idx="${r.idx}">经 ${r.s.name} 中转（距终点 ${Math.round(r.dToDest)} km）</button>`
          ).join("") +
          `</div>`;
      }

      resEl.className = "dest-result fail";
      resEl.innerHTML =
        `<div class="dest-badge fail">✕ 单次无法直达 ${dest.name}</div>` +
        `<div class="dest-details">${detailHtml}</div>` +
        relayHtml;

      resEl.querySelectorAll(".dest-relay-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          selectedScIdx = Number(btn.dataset.scIdx);
          updateReachability({ animate: true, pan: true });
        });
      });
    }

    // Recommend up to 3 nearby car-camping spots (道の駅 / RV / SA) near destination
    if (campSpots.length > 0) {
      const nearCamps = campSpots
        .map((c, idx) => ({
          idx,
          c,
          d: haversineKm(c.lat, c.lon, dest.lat, dest.lon),
        }))
        .filter((x) => x.d <= 35.0)
        .sort((a, b) => {
          const prio = (k) => (k === "rv" ? 0 : k === "michi" ? 1 : 2);
          return (a.d + prio(a.c.kind) * 2.5) - (b.d + prio(b.c.kind) * 2.5);
        })
        .slice(0, 3);

      if (nearCamps.length > 0) {
        const listDiv = document.createElement("div");
        listDiv.className = "dest-camp-list";
        listDiv.innerHTML =
          `<div class="dest-camp-title">终点附近车中泊推荐（点击测算过夜耗电）：</div>` +
          nearCamps
            .map((x) => {
              const badge = x.c.kind === "rv" ? "RV" : x.c.kind === "sa" ? "SA" : "道の駅";
              const extra = [x.c.p ? "电源" : "", x.c.o ? "温泉" : ""].filter(Boolean).join("/");
              return `<button class="dest-camp-btn" type="button" data-camp-idx="${x.idx}"><span>[${badge}] ${x.c.name}${extra ? " · " + extra : ""}</span><small>${x.d.toFixed(1)} km</small></button>`;
            })
            .join("");
        resEl.appendChild(listDiv);
        listDiv.querySelectorAll(".dest-camp-btn").forEach((btn) => {
          btn.addEventListener("click", () => {
            selectCampSpot(Number(btn.dataset.campIdx), true);
          });
        });
      }
    }

    resEl.classList.remove("hidden");
  }

  async function searchDestinationQuery(query) {
    const q = query.trim().toLowerCase();
    if (!q) return null;

    // 1. Check local curated places (prefer prefix/token match over substring)
    const tokenMatch = (p) => p.keys.toLowerCase().split(/\s+/).some((t) => t === q || t.startsWith(q));
    for (const p of JP_PLACES) {
      if (tokenMatch(p)) return { name: p.name, lat: p.lat, lon: p.lon };
    }
    for (const p of JP_PLACES) {
      if (p.keys.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)) {
        return { name: p.name, lat: p.lat, lon: p.lon };
      }
    }
    // 2. Check Superchargers
    for (const s of superchargers) {
      if (s.name.toLowerCase().includes(q) || s.city.toLowerCase().includes(q)) {
        return { name: s.name, lat: s.lat, lon: s.lon };
      }
    }
    // 3. Fallback to OpenStreetMap Nominatim Japan search
    const url = `https://nominatim.openstreetmap.org/search?format=json&countrycodes=jp&limit=1&accept-language=zh-CN,ja,en&q=${encodeURIComponent(query.trim())}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const arr = await resp.json();
    if (!arr || !arr.length) return null;
    return {
      name: arr[0].display_name.split(",")[0],
      lat: parseFloat(arr[0].lat),
      lon: parseFloat(arr[0].lon),
    };
  }

  // ---------- IndexedDB Cache & Progressive Binary Loader ----------
  const IDB_NAME = "dokomademap_cn_cache";
  const IDB_STORE = "files";

  function openIDB() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error("no idb"));
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) {
          req.result.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(key) {
    try {
      const db = await openIDB();
      return await new Promise((resolve) => {
        const tx = db.transaction(IDB_STORE, "readonly");
        const r = tx.objectStore(IDB_STORE).get(key);
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => resolve(null);
      });
    } catch (_) {
      return null;
    }
  }

  async function idbSet(key, value) {
    try {
      const db = await openIDB();
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(value, key);
    } catch (_) {}
  }

  async function fetchBinaryCached(url, cacheKey, expectedBytes, onBytes) {
    const cached = await idbGet(cacheKey);
    if (cached && cached.byteLength > 100000) {
      onBytes(expectedBytes);
      return cached;
    }
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`无法加载 ${url}`);
    if (!resp.body || !resp.body.getReader) {
      const buf = await resp.arrayBuffer();
      onBytes(buf.byteLength);
      idbSet(cacheKey, buf);
      return buf;
    }
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      onBytes(received);
    }
    const out = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    idbSet(cacheKey, out.buffer);
    return out.buffer;
  }

  function updateCampLayer() {
    if (!map) return;
    const src = map.getSource("camp-spots");
    if (!src) return;
    if (!state.showCamp || !campSpots.length) {
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    const features = campSpots.map((c, idx) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [c.lon, c.lat] },
      properties: {
        idx,
        name: c.name,
        kind: c.kind,
        elev: c.elev,
        sc_km: c.sc_km,
      },
    }));
    src.setData({ type: "FeatureCollection", features });
  }

  function estimateCampKw(tempC, extra) {
    let kw = 0.28; // Model 3 Heat Pump standby + cabin fan
    if (tempC < 18) {
      kw += 0.065 * (18 - tempC);
    } else if (tempC > 24) {
      kw += 0.08 * (tempC - 24);
    }
    if (extra) kw += 0.22;
    return kw;
  }

  function updateCampCalc() {
    if (selectedCampIdx < 0 || !campSpots[selectedCampIdx]) return;
    const spot = campSpots[selectedCampIdx];
    const params = computeEnergyParams();
    const { usableFullWh, budgetWh, winterMult } = params;

    const kw = estimateCampKw(campTempC, campExtra);
    const totalKwh = kw * campHours;
    const campPct = Math.round((totalKwh / (usableFullWh / 1000.0)) * 100);

    document.getElementById("val-camp-temp").textContent = `${campTempC}°C`;
    document.getElementById("val-camp-hours").textContent = `${campHours} 小时`;
    document.getElementById("camp-kwh-total").textContent = `${totalKwh.toFixed(1)} kWh (-${campPct}%)`;

    const summaryEl = document.getElementById("camp-trip-summary");
    const nearestSc = superchargers[spot.sc_idx];
    const nearestScName = nearestSc ? nearestSc.name : "附近超充";

    if (selectedScIdx >= 0 && graph && goUsed) {
      const usedToSpot = goUsed[spot.node];
      if (usedToSpot <= budgetWh) {
        const arrWh = usableFullWh * (state.departPct / 100.0) - usedToSpot;
        const arrPct = Math.max(0, Math.min(100, Math.round((arrWh / usableFullWh) * 100)));
        const morningWh = arrWh - totalKwh * 1000.0;
        const morningPct = Math.round((morningWh / usableFullWh) * 100);
        const toScWh = spot.sc_km * state.whPerKm * winterMult * 1.15;
        const afterScPct = Math.round(((morningWh - toScWh) / usableFullWh) * 100);

        if (morningPct <= 0) {
          summaryEl.innerHTML =
            `开到该营地约剩 <b>${arrPct}%</b>；过夜露营消耗 <b>-${campPct}%</b> 后电量将耗尽，请先补电再过夜。`;
        } else if (afterScPct >= 5) {
          summaryEl.innerHTML =
            `开到这里约剩 <b>${arrPct}%</b> → 过夜后清晨剩 <b style="color:#4ade80">${morningPct}%</b><br/>` +
            `✓ 足够次日开往 <b>${nearestScName}</b>（约 ${spot.sc_km} km，到达约剩 ${afterScPct}%）`;
        } else {
          summaryEl.innerHTML =
            `开到这里约剩 <b>${arrPct}%</b> → 过夜后清晨仅剩 <b style="color:#fbbf24">${morningPct}%</b><br/>` +
            `⚠️ 次日前往 <b>${nearestScName}</b>（${spot.sc_km} km）余量偏紧，建议出发前多充一些。`;
        }
      } else {
        summaryEl.innerHTML =
          `从当前超充出发单次无法直达该营地；建议先开到 <b>${nearestScName}</b>（距此 ${spot.sc_km} km）补电后再前往过夜。`;
      }
    } else {
      summaryEl.innerHTML =
        `约每小时耗电 <b>${kw.toFixed(2)} kW</b>；最近超充为 <b>${nearestScName}</b>（距此 ${spot.sc_km} km）。点选任意超充站可联动测算往返余量。`;
    }
  }

  async function selectCampSpot(idx, panToSpot = true) {
    if (idx < 0 || !campSpots[idx]) return;
    selectedCampIdx = idx;
    const spot = campSpots[idx];

    if (selectedScIdx < 0) {
      document.getElementById("status-empty").classList.add("hidden");
    }
    const panel = document.getElementById("camp-panel");
    panel.classList.remove("hidden");

    const badgeEl = document.getElementById("camp-kind-badge");
    badgeEl.className = `camp-badge ${spot.kind === "rv" ? "rv" : spot.kind === "sa" ? "sa" : ""}`;
    badgeEl.textContent = spot.kind === "rv" ? "RV 营地" : spot.kind === "sa" ? "高速 SA" : "道の駅";

    document.getElementById("camp-name").textContent = spot.name;
    document.getElementById("camp-meta").textContent = `海拔 ${spot.elev} m · 距最近超充 ${spot.sc_km} km`;

    const tags = [];
    if (spot.t) tags.push("🚻 24h厕所");
    if (spot.p) tags.push("🔌 外部电源");
    if (spot.o) tags.push("♨️ 附近温泉");
    if (spot.s) tags.push("🚿 淋浴");
    if (!tags.length) tags.push("🅿️ 夜间停靠休息");
    document.getElementById("camp-tags").innerHTML = tags.map((t) => `<span class="camp-tag">${t}</span>`).join("");

    // Fallback temperature estimate by elevation before live weather returns
    campTempC = Math.max(-12, Math.min(28, Math.round(10 - spot.elev * 0.006)));
    document.getElementById("slider-camp-temp").value = campTempC;
    document.getElementById("camp-temp-src").textContent = "(获取实时预报中…)";
    updateCampCalc();

    if (panToSpot && map) {
      map.easeTo({ center: [spot.lon, spot.lat], zoom: Math.max(map.getZoom(), 9.2), duration: 550 });
    }

    // Fetch live tonight's minimum temperature from Open-Meteo (JMA Japan data)
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${spot.lat}&longitude=${spot.lon}&daily=temperature_2m_min&timezone=Asia%2FTokyo&forecast_days=2`;
      const resp = await fetch(url);
      if (resp.ok && selectedCampIdx === idx) {
        const w = await resp.json();
        const tMin = w?.daily?.temperature_2m_min?.[0];
        if (typeof tMin === "number") {
          campTempC = Math.max(-15, Math.min(35, Math.round(tMin)));
          document.getElementById("slider-camp-temp").value = campTempC;
          document.getElementById("camp-temp-src").textContent = "(今夜 JMA 最低温)";
          updateCampCalc();
          return;
        }
      }
    } catch (_) {}
    if (selectedCampIdx === idx) {
      document.getElementById("camp-temp-src").textContent = "(按海拔估算)";
    }
  }

  // ---------- Dedicated Car-Camping View (#camp-view) Controller ----------
  function switchMode(mode) {
    currentMode = mode;
    const isCamp = mode === "camp";
    document.getElementById("tab-map").classList.toggle("active", !isCamp);
    document.getElementById("tab-camp").classList.toggle("active", isCamp);
    document.getElementById("tab-map").setAttribute("aria-selected", String(!isCamp));
    document.getElementById("tab-camp").setAttribute("aria-selected", String(isCamp));
    document.getElementById("camp-view").classList.toggle("hidden", !isCamp);
    document.getElementById("status-card").classList.toggle("hidden", isCamp);
    document.getElementById("drawer").classList.toggle("hidden", isCamp);
    document.getElementById("btn-toggle-drawer").classList.toggle("hidden", isCamp);

    if (isCamp) {
      if (selectedScIdx >= 0 && superchargers[selectedScIdx]) {
        const sc = superchargers[selectedScIdx];
        cvRefCoord = { lat: sc.lat, lon: sc.lon, label: sc.name };
      } else if (map) {
        const c = map.getCenter();
        cvRefCoord = { lat: c.lat, lon: c.lng, label: "当前地图中心周边" };
      }
      renderCampViewList();
      if (selectedCampIdx >= 0) selectCampViewSpot(selectedCampIdx);
    }
  }

  function getSleepHours() {
    const s = document.getElementById("cv-sleep-start").value || "22:30";
    const e = document.getElementById("cv-sleep-end").value || "07:00";
    const [sh, sm] = s.split(":").map(Number);
    const [eh, em] = e.split(":").map(Number);
    let mins = (eh * 60 + em) - (sh * 60 + sm);
    if (mins <= 0) mins += 24 * 60;
    return Math.max(0.5, mins / 60.0);
  }

  function updateCampViewCalc() {
    if (selectedCampIdx < 0 || !campSpots[selectedCampIdx]) return;
    const spot = campSpots[selectedCampIdx];
    const hours = getSleepHours();
    const params = computeEnergyParams();
    const { usableFullWh, winterMult } = params;

    // Heat pump power scaled to target cabin temperature vs outside temperature
    let kw = 0.28;
    const heatThreshold = cvCabinTemp - 3;
    const coolThreshold = cvCabinTemp + 3;
    if (cvOutTemp < heatThreshold) kw += 0.065 * (heatThreshold - cvOutTemp);
    else if (cvOutTemp > coolThreshold) kw += 0.08 * (cvOutTemp - coolThreshold);
    if (cvSentry) kw += 0.25;
    if (cvFridge) kw += 0.12;

    const totalKwh = kw * hours;
    const campPct = Math.round((totalKwh / (usableFullWh / 1000.0)) * 100);

    document.getElementById("cv-val-temp").textContent = `${cvOutTemp}°C`;
    document.getElementById("cv-val-soc").textContent = `${cvArrSoc}%`;
    document.getElementById("cv-kwh-big").textContent = `${totalKwh.toFixed(1)} kWh (-${campPct}%)`;
    document.getElementById("cv-avg-kw").textContent = `${kw.toFixed(2)} kW`;
    document.getElementById("cv-dur-text").textContent = `${hours.toFixed(1)} 小时`;

    const morningPct = cvArrSoc - campPct;
    const morningWh = (morningPct / 100.0) * usableFullWh;
    const toScWh = spot.sc_km * state.whPerKm * winterMult * 1.15;
    const afterScPct = Math.round(((morningWh - toScWh) / usableFullWh) * 100);
    const nearestSc = superchargers[spot.sc_idx];
    const scName = nearestSc ? nearestSc.name : "最近超充";

    const box = document.getElementById("cv-morning-box");
    if (morningPct <= 0) {
      box.innerHTML = `<b style="color:#f87171">⚠️ 电量不足以支撑整夜露营</b>：按到达 <b>${cvArrSoc}%</b> 计算，整夜消耗约 <b>${campPct}%</b>，建议先在 <b>${scName}</b> 补电后再前往。`;
    } else if (afterScPct >= 5) {
      box.innerHTML =
        `到达营地 <b>${cvArrSoc}%</b> → 过夜消耗 <b>-${campPct}%</b> → 清晨剩余 <b style="color:#4ade80">${morningPct}%</b><br/>` +
        `✓ 次日可直接开往 <b>${scName}</b>（距此 ${spot.sc_km} km，预计到达还剩 <b>${afterScPct}%</b>）`;
    } else {
      box.innerHTML =
        `到达营地 <b>${cvArrSoc}%</b> → 过夜消耗 <b>-${campPct}%</b> → 清晨剩余 <b style="color:#fbbf24">${morningPct}%</b><br/>` +
        `⚠️ 次日开往 <b>${scName}</b>（${spot.sc_km} km）余量偏紧，建议到达营地前多充 10–15% 电量。`;
    }
  }

  async function selectCampViewSpot(idx) {
    if (idx < 0 || !campSpots[idx]) return;
    selectedCampIdx = idx;
    const spot = campSpots[idx];

    document.getElementById("cv-detail-empty").classList.add("hidden");
    document.getElementById("cv-detail-active").classList.remove("hidden");

    const badge = document.getElementById("cv-badge");
    badge.className = `camp-badge ${spot.kind === "rv" ? "rv" : spot.kind === "sa" ? "sa" : ""}`;
    badge.textContent = spot.kind === "rv" ? "RV 公园" : spot.kind === "sa" ? "高速 SA" : "道の駅";

    document.getElementById("cv-spot-name").textContent = spot.name;
    document.getElementById("cv-spot-meta").textContent = `海拔 ${spot.elev} m · 距最近超充 ${spot.sc_km} km`;

    const tags = [];
    if (spot.t) tags.push("🚻 24h厕所");
    if (spot.p) tags.push("🔌 外部电源");
    if (spot.o) tags.push("♨️ 附近温泉");
    if (spot.s) tags.push("🚿 淋浴");
    if (!tags.length) tags.push("🅿️ 夜间停靠休息");
    document.getElementById("cv-spot-tags").innerHTML = tags.map((t) => `<span class="camp-tag">${t}</span>`).join("");

    // Sync arrival SoC if reachable from currently selected SC
    if (selectedScIdx >= 0 && graph && goUsed) {
      const params = computeEnergyParams();
      if (goUsed[spot.node] <= params.budgetWh) {
        const arrWh = params.usableFullWh * (state.departPct / 100.0) - goUsed[spot.node];
        cvArrSoc = Math.max(15, Math.min(100, Math.round((arrWh / params.usableFullWh) * 100 / 5) * 5));
        document.getElementById("cv-arr-soc").value = cvArrSoc;
      }
    }

    cvOutTemp = Math.max(-12, Math.min(28, Math.round(10 - spot.elev * 0.006)));
    const tempEl = document.getElementById("cv-out-temp");
    tempEl.value = cvOutTemp;
    tempEl.style.setProperty("--fill", ((cvOutTemp - (-15)) / 50) * 100 + "%");
    const socEl = document.getElementById("cv-arr-soc");
    socEl.style.setProperty("--fill", ((cvArrSoc - 15) / 85) * 100 + "%");
    document.getElementById("cv-temp-src").textContent = "(获取预报中…)";
    updateCampViewCalc();

    document.querySelectorAll(".cv-spot-item").forEach((el) => {
      el.classList.toggle("active", Number(el.dataset.idx) === idx);
    });

    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${spot.lat}&longitude=${spot.lon}&daily=temperature_2m_min&timezone=Asia%2FTokyo&forecast_days=2`;
      const resp = await fetch(url);
      if (resp.ok && selectedCampIdx === idx) {
        const w = await resp.json();
        const tMin = w?.daily?.temperature_2m_min?.[0];
        if (typeof tMin === "number") {
          cvOutTemp = Math.max(-15, Math.min(35, Math.round(tMin)));
          tempEl.value = cvOutTemp;
          tempEl.style.setProperty("--fill", ((cvOutTemp - (-15)) / 50) * 100 + "%");
          document.getElementById("cv-temp-src").textContent = "(今夜 JMA 最低温)";
          updateCampViewCalc();
          return;
        }
      }
    } catch (_) {}
    if (selectedCampIdx === idx) {
      document.getElementById("cv-temp-src").textContent = "(按海拔估算)";
    }
  }

  function renderCampViewList() {
    const listEl = document.getElementById("cv-spot-list");
    const metaEl = document.getElementById("cv-list-meta");
    if (!campSpots.length) {
      metaEl.textContent = "车中泊数据加载中，请稍候…";
      listEl.innerHTML = "";
      return;
    }

    const q = cvSearchQuery.trim().toLowerCase();
    const filtered = [];
    for (let i = 0; i < campSpots.length; i++) {
      const c = campSpots[i];
      if (cvFilter === "michi" && c.kind !== "michi") continue;
      if (cvFilter === "rv" && c.kind !== "rv") continue;
      if (cvFilter === "sa" && c.kind !== "sa") continue;
      if (cvFilter === "onsen" && !c.o) continue;
      if (cvFilter === "power" && !c.p) continue;
      const d = haversineKm(cvRefCoord.lat, cvRefCoord.lon, c.lat, c.lon);
      if (q && !c.name.toLowerCase().includes(q)) {
        // Also keep spots within 60km of searched city center
        if (d > 60) continue;
      }
      filtered.push({ idx: i, c, d });
    }
    filtered.sort((a, b) => a.d - b.d);
    const shown = filtered.slice(0, 50);

    metaEl.textContent = `${cvRefCoord.label} · 匹配 ${filtered.length} 处（显示最近 ${shown.length} 处）`;
    listEl.innerHTML = shown
      .map(({ idx, c, d }) => {
        const badge = c.kind === "rv" ? "RV" : c.kind === "sa" ? "SA" : "道の駅";
        const bCls = c.kind === "rv" ? "rv" : c.kind === "sa" ? "sa" : "";
        const feats = [c.o ? "♨️温泉" : "", c.p ? "🔌电源" : "", c.t ? "🚻厕所" : ""].filter(Boolean).join(" ");
        return `<button class="cv-spot-item ${idx === selectedCampIdx ? "active" : ""}" type="button" data-idx="${idx}">
          <div class="cv-spot-row1"><span>${c.name}</span><span class="camp-badge ${bCls}">${badge}</span></div>
          <div class="cv-spot-row2"><span>${feats || "夜间停靠"} · 海拔 ${c.elev}m</span><span>距参考点 ${d.toFixed(1)} km</span></div>
        </button>`;
      })
      .join("");

    listEl.querySelectorAll(".cv-spot-item").forEach((btn) => {
      btn.addEventListener("click", () => selectCampViewSpot(Number(btn.dataset.idx)));
    });
  }

  function bindUI() {
    const sWh = document.getElementById("slider-wh");
    const sFull = document.getElementById("slider-full");
    const sDep = document.getElementById("slider-depart");
    const sArr = document.getElementById("slider-arrive");

    const vWh = document.getElementById("val-wh");
    const vFull = document.getElementById("val-full");
    const vDep = document.getElementById("val-depart");
    const vArr = document.getElementById("val-arrive");

    const chkRt = document.getElementById("chk-roundtrip");
    const chkWin = document.getElementById("chk-winter");
    const chkFer = document.getElementById("chk-ferry");
    const chkFerChg = document.getElementById("chk-ferry-charge");
    const chkCamp = document.getElementById("chk-camp");
    const ferChgRow = document.getElementById("ferry-charge-row");

    const paintFill = (el) => {
      const pct = ((el.value - el.min) / (el.max - el.min)) * 100;
      el.style.setProperty("--fill", pct + "%");
    };
    const presetBtns = document.querySelectorAll(".preset-pill");
    const syncPresetPills = () => {
      presetBtns.forEach((b) => {
        b.classList.toggle(
          "active",
          Number(b.dataset.dep) === state.departPct && Number(b.dataset.arr) === state.arrivePct
        );
      });
    };

    [sWh, sFull, sDep, sArr].forEach((el) => {
      el.addEventListener("input", () => {
        paintFill(el);
        syncPresetPills();
      });
    });

    function syncControlsFromState() {
      sWh.value = state.whPerKm;
      sFull.value = state.fullRangeKm;
      sDep.value = state.departPct;
      sArr.value = state.arrivePct;
      vWh.textContent = `${state.whPerKm} Wh/km`;
      vFull.textContent = `${state.fullRangeKm} km`;
      vDep.textContent = `${state.departPct}%`;
      vArr.textContent = `${state.arrivePct}%`;
      chkRt.checked = state.roundTrip;
      chkWin.checked = state.winter;
      chkFer.checked = state.ferry;
      chkFerChg.checked = state.ferryCharge;
      chkCamp.checked = state.showCamp;
      ferChgRow.classList.toggle("disabled", !state.ferry);
      [sWh, sFull, sDep, sArr].forEach(paintFill);
      syncPresetPills();
    }

    syncControlsFromState();

    presetBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        state.departPct = Number(btn.dataset.dep);
        state.arrivePct = Number(btn.dataset.arr);
        syncControlsFromState();
        saveState();
        updateReachability();
      });
    });

    sWh.addEventListener("input", () => {
      state.whPerKm = Number(sWh.value);
      vWh.textContent = `${state.whPerKm} Wh/km`;
      saveState();
      scheduleReachabilityUpdate();
    });

    sFull.addEventListener("input", () => {
      state.fullRangeKm = Number(sFull.value);
      vFull.textContent = `${state.fullRangeKm} km`;
      saveState();
      scheduleReachabilityUpdate();
    });

    sDep.addEventListener("input", () => {
      state.departPct = Number(sDep.value);
      if (state.departPct < state.arrivePct) {
        state.arrivePct = state.departPct;
        sArr.value = state.arrivePct;
        vArr.textContent = `${state.arrivePct}%`;
      }
      vDep.textContent = `${state.departPct}%`;
      saveState();
      scheduleReachabilityUpdate();
    });

    sArr.addEventListener("input", () => {
      state.arrivePct = Number(sArr.value);
      if (state.arrivePct > state.departPct) {
        state.departPct = state.arrivePct;
        sDep.value = state.departPct;
        vDep.textContent = `${state.departPct}%`;
      }
      vArr.textContent = `${state.arrivePct}%`;
      saveState();
      scheduleReachabilityUpdate();
    });

    chkRt.addEventListener("change", () => {
      state.roundTrip = chkRt.checked;
      saveState();
      updateReachability();
    });

    chkWin.addEventListener("change", () => {
      state.winter = chkWin.checked;
      saveState();
      updateReachability();
    });

    chkFer.addEventListener("change", () => {
      state.ferry = chkFer.checked;
      ferChgRow.classList.toggle("disabled", !state.ferry);
      saveState();
      updateReachability();
    });

    chkFerChg.addEventListener("change", () => {
      state.ferryCharge = chkFerChg.checked;
      saveState();
      updateReachability();
    });

    chkCamp.addEventListener("change", () => {
      state.showCamp = chkCamp.checked;
      saveState();
      updateCampLayer();
    });

    document.getElementById("btn-close-camp").addEventListener("click", () => {
      selectedCampIdx = -1;
      document.getElementById("camp-panel").classList.add("hidden");
      if (selectedScIdx < 0) document.getElementById("status-empty").classList.remove("hidden");
    });
    document.getElementById("slider-camp-temp").addEventListener("input", (e) => {
      campTempC = Number(e.target.value);
      document.getElementById("camp-temp-src").textContent = "(手动设定)";
      updateCampCalc();
    });
    document.getElementById("slider-camp-hours").addEventListener("input", (e) => {
      campHours = Number(e.target.value);
      updateCampCalc();
    });
    document.getElementById("chk-camp-extra").addEventListener("change", (e) => {
      campExtra = e.target.checked;
      updateCampCalc();
    });

    // Mode tabs (⚡ 超充地图 <-> ⛺ 车中泊)
    document.getElementById("tab-map").addEventListener("click", () => switchMode("map"));
    document.getElementById("tab-camp").addEventListener("click", () => switchMode("camp"));

    // Dedicated Camp View bindings
    document.querySelectorAll("#cv-filters .cv-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        cvFilter = chip.dataset.filter;
        document.querySelectorAll("#cv-filters .cv-chip").forEach((c) => c.classList.toggle("active", c === chip));
        renderCampViewList();
      });
    });

    document.getElementById("cv-search-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const raw = document.getElementById("cv-search-input").value.trim();
      cvSearchQuery = raw;
      if (raw) {
        const found = await searchDestinationQuery(raw).catch(() => null);
        if (found) {
          cvRefCoord = { lat: found.lat, lon: found.lon, label: `${found.name}周边` };
        }
      }
      renderCampViewList();
    });

    document.getElementById("btn-cv-gps").addEventListener("click", () => {
      if (!navigator.geolocation) return;
      navigator.geolocation.getCurrentPosition((pos) => {
        cvSearchQuery = "";
        document.getElementById("cv-search-input").value = "";
        cvRefCoord = { lat: pos.coords.latitude, lon: pos.coords.longitude, label: "当前定位周边" };
        renderCampViewList();
      });
    });

    document.getElementById("btn-cv-show-map").addEventListener("click", () => {
      const idx = selectedCampIdx;
      switchMode("map");
      if (idx >= 0) selectCampSpot(idx, true);
    });

    const syncSliderFill = (el) => el.style.setProperty("--fill", ((el.value - el.min) / (el.max - el.min)) * 100 + "%");
    document.getElementById("cv-sleep-start").addEventListener("change", updateCampViewCalc);
    document.getElementById("cv-sleep-end").addEventListener("change", updateCampViewCalc);
    document.getElementById("cv-cabin-temp").addEventListener("change", (e) => {
      cvCabinTemp = Number(e.target.value);
      updateCampViewCalc();
    });
    document.getElementById("cv-out-temp").addEventListener("input", (e) => {
      cvOutTemp = Number(e.target.value);
      syncSliderFill(e.target);
      document.getElementById("cv-temp-src").textContent = "(手动设定)";
      updateCampViewCalc();
    });
    document.getElementById("cv-arr-soc").addEventListener("input", (e) => {
      cvArrSoc = Number(e.target.value);
      syncSliderFill(e.target);
      updateCampViewCalc();
    });
    document.getElementById("cv-chk-sentry").addEventListener("change", (e) => {
      cvSentry = e.target.checked;
      updateCampViewCalc();
    });
    document.getElementById("cv-chk-fridge").addEventListener("change", (e) => {
      cvFridge = e.target.checked;
      updateCampViewCalc();
    });

    document.getElementById("btn-reset-defaults").addEventListener("click", () => {
      Object.assign(state, DEFAULTS);
      syncControlsFromState();
      applyThemeAndFont();
      saveState();
      updateReachability();
    });

    document.getElementById("btn-clear-sc").addEventListener("click", () => {
      selectedScIdx = -1;
      updateReachability();
    });

    // Destination search box
    const destInput = document.getElementById("dest-input");
    const destSug = document.getElementById("dest-suggestions");
    const destClear = document.getElementById("btn-dest-clear");

    destInput.addEventListener("input", () => {
      const q = destInput.value.trim().toLowerCase();
      if (!q) {
        destSug.classList.add("hidden");
        return;
      }
      const matches = [];
      for (const p of JP_PLACES) {
        if (p.keys.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)) {
          matches.push({ name: p.name, sub: "热门城市/地标", lat: p.lat, lon: p.lon });
        }
        if (matches.length >= 5) break;
      }
      for (const s of superchargers) {
        if (matches.length >= 7) break;
        if (s.name.toLowerCase().includes(q) || s.city.toLowerCase().includes(q)) {
          matches.push({ name: s.name, sub: "超级充电站", lat: s.lat, lon: s.lon });
        }
      }
      if (!matches.length) {
        destSug.classList.add("hidden");
        return;
      }
      destSug.innerHTML = matches
        .map((m, i) => `<button class="dest-sug-item" type="button" data-i="${i}"><span>${m.name}</span><small>${m.sub}</small></button>`)
        .join("");
      destSug.classList.remove("hidden");
      destSug.querySelectorAll(".dest-sug-item").forEach((btn) => {
        btn.addEventListener("click", () => {
          const item = matches[Number(btn.dataset.i)];
          destInput.value = item.name;
          destSug.classList.add("hidden");
          selectedDest = { name: item.name, lat: item.lat, lon: item.lon };
          evaluateDestination(selectedDest);
        });
      });
    });

    document.getElementById("dest-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      destSug.classList.add("hidden");
      const raw = destInput.value.trim();
      if (!raw) return;
      const resEl = document.getElementById("dest-result");
      resEl.className = "dest-result";
      resEl.textContent = "正在检索地名并测算路线…";
      resEl.classList.remove("hidden");
      try {
        const found = await searchDestinationQuery(raw);
        if (!found) {
          resEl.className = "dest-result fail";
          resEl.textContent = `未找到“${raw}”，请尝试输入日本城市名或日文地名。`;
          return;
        }
        selectedDest = found;
        evaluateDestination(selectedDest);
      } catch (_) {
        resEl.className = "dest-result fail";
        resEl.textContent = "地名检索超时，请直接输入热门城市中文名或日文名重试。";
      }
    });

    destClear.addEventListener("click", () => {
      destInput.value = "";
      selectedDest = null;
      destSug.classList.add("hidden");
      evaluateDestination(null);
    });

    // GPS locate nearest Supercharger
    document.getElementById("btn-locate").addEventListener("click", () => {
      if (!navigator.geolocation || !superchargers.length) return;
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const { latitude, longitude } = pos.coords;
          let bestIdx = 0;
          let bestD = Infinity;
          for (let i = 0; i < superchargers.length; i++) {
            const d = haversineKm(latitude, longitude, superchargers[i].lat, superchargers[i].lon);
            if (d < bestD) { bestD = d; bestIdx = i; }
          }
          if (map) map.easeTo({ center: [longitude, latitude], zoom: Math.max(map.getZoom(), 8.5), duration: 600 });
          selectedScIdx = bestIdx;
          if (dataReadyPromise) await dataReadyPromise;
          updateReachability({ animate: true, pan: false });
        },
        () => {},
        { enableHighAccuracy: false, timeout: 6000 }
      );
    });

    const drawer = document.getElementById("drawer");
    const btnDrawer = document.getElementById("btn-toggle-drawer");
    if (window.innerWidth <= 720) {
      drawer.classList.add("collapsed");
      btnDrawer.setAttribute("aria-expanded", "false");
    }
    btnDrawer.addEventListener("click", () => {
      const collapsed = drawer.classList.toggle("collapsed");
      btnDrawer.setAttribute("aria-expanded", String(!collapsed));
    });

    const modal = document.getElementById("info-modal");
    document.getElementById("btn-info").addEventListener("click", () => modal.classList.remove("hidden"));
    document.getElementById("btn-close-modal").addEventListener("click", () => modal.classList.add("hidden"));
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.classList.add("hidden");
    });

    document.getElementById("btn-font-dec").addEventListener("click", () => {
      state.fontScale = Math.max(0.85, Number((state.fontScale - 0.08).toFixed(2)));
      applyThemeAndFont();
      saveState();
    });
    document.getElementById("btn-font-inc").addEventListener("click", () => {
      state.fontScale = Math.min(1.3, Number((state.fontScale + 0.08).toFixed(2)));
      applyThemeAndFont();
      saveState();
    });

    document.getElementById("btn-theme-auto").addEventListener("click", () => {
      state.theme = "auto";
      applyThemeAndFont();
      saveState();
    });
    document.getElementById("btn-theme-dark").addEventListener("click", () => {
      state.theme = "dark";
      applyThemeAndFont();
      saveState();
    });
    document.getElementById("btn-theme-light").addEventListener("click", () => {
      state.theme = "light";
      applyThemeAndFont();
      saveState();
    });

    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
        if (state.theme === "auto") applyThemeAndFont();
      });
    }
  }

  async function init() {
    applyThemeAndFont();
    bindUI();

    const loadingText = document.getElementById("loading-text");
    const loadingOverlay = document.getElementById("loading-overlay");
    const progressPill = document.getElementById("data-progress-pill");
    const progressText = document.getElementById("data-progress-text");

    try {
      // 1. Load lightweight superchargers list (37 KB) & show map immediately
      const scData = await fetch("data/superchargers.json").then((r) => r.json());
      superchargers = scData.map((x) => ({
        ...x,
        name: x.name.replace(/,\s*Japan\s*-?\s*/, " · ").replace(/\s·\s$/, ""),
      }));

      // 2. Start loading heavy graph + landgrid in background (with IndexedDB cache)
      const totalExpected = 22656497 + 1321542;
      let bytesG = 0, bytesL = 0;
      const updateProg = () => {
        const pct = Math.min(99, Math.round(((bytesG + bytesL) / totalExpected) * 100));
        progressText.textContent = `路网准备中 ${pct}%`;
      };
      progressPill.classList.remove("hidden");

      dataReadyPromise = Promise.all([
        fetchBinaryCached("data/graph.bin", "graph_v2", 22656497, (b) => { bytesG = b; updateProg(); }),
        fetchBinaryCached("data/landgrid.bin", "landgrid_v2", 1321542, (b) => { bytesL = b; updateProg(); }),
        fetch("data/ferries.json").then((r) => r.json()),
        fetch("data/camp_spots.json").then((r) => r.json()).catch(() => []),
      ]).then(([gBuf, lBuf, ferryData, campData]) => {
        graph = parseGraph(gBuf);
        grid = parseLandGrid(lBuf);
        ferries = ferryData;
        campSpots = campData;
        progressPill.classList.add("hidden");
        ensureReachOverlaySource();
        updateCampLayer();
        if (currentMode === "camp") renderCampViewList();
        if (selectedScIdx >= 0) updateReachability({ animate: true, pan: false });
      }).catch((err) => {
        progressText.textContent = "路网加载失败";
        console.error(err);
      });

      map = new maplibregl.Map({
        container: "map",
        style: STYLE_URLS[currentTheme],
        center: [137.8, 36.2],
        zoom: 5.2,
        minZoom: 4,
        maxZoom: 15,
        attributionControl: false,
      });

      map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "bottom-left");
      map.addControl(
        new maplibregl.AttributionControl({
          compact: true,
          customAttribution: "高程数据: 国土地理院 | 路网: OpenStreetMap | 超充: supercharge.info | 底图: OpenFreeMap",
        }),
        "bottom-left"
      );

      map.on("style.load", () => {
        setupMapLayers();
      });

      map.on("load", () => {
        bindMapInteractions();
        loadingOverlay.classList.add("hidden");
      });
    } catch (err) {
      console.error(err);
      loadingText.textContent = `加载失败：${err.message}`;
    }
  }

  init();
})();
