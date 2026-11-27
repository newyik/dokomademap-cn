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
    showNacs: false,
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
  // 用户自己点了定位后，后台同步车辆数据时不要再把画面抢回到车上
  let userTookOver = false;
  let graph = null;
  let grid = null;
  let superchargers = [];
  let nacsChargers = [];
  let ferries = [];
  let campSpots = [];
  let selectedScIdx = -1;
  let selectedNacsIdx = -1;
  let selectedCampIdx = -1;
  let campTempC = 8;
  let campHours = 8;
  let campExtra = false;
  let currentMode = "map"; // map | camp
  let cvFilter = "all";
  let cvSearchQuery = "";
  let cvRefCoord = { lat: 35.6812, lon: 139.7671, label: "东京周边" };
  let cvOutTemp = 6;
  // 当地逐小时气温预报（Open-Meteo），用来算睡觉那几个小时的平均气温
  let cvHourly = null; // { spotIdx, startMs: 第一个小时(当地 0 点)的时间戳, temps: [...] }
  let cvTempManual = false;
  let cvCabinTemp = 21;
  let cvArrSoc = 60;
  let cvSentry = false;
  let cvFridge = false;
  let currentTheme = resolveTheme(state.theme);
  let styleReady = false;

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
  let nacsUsed = null;
  let carUsed = null;
  let carState = { active: false, lat: 0, lon: 0, node: -1, soc: 80, updatedAt: "" };
  let cardMinimized = false;
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
      // 整套重新加载底图，保证会触发 style.load，把超充站等图层重新画上
      styleReady = false;
      map.setStyle(STYLE_URLS[currentTheme], { diff: false });
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
    nacsUsed = new Float64Array(nNodes);
    carUsed = new Float64Array(nNodes);
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

  // Blue gradient for extra 3rd-party NACS coverage (little-endian ABGR)
  function ratioToBlueABGR(ratio) {
    const t = Math.max(0, Math.min(1, ratio));
    const r = Math.round(37 + t * (56 - 37));
    const g = Math.round(99 + t * (189 - 99));
    const b = Math.round(235 + t * (248 - 235));
    const alpha = Math.round(145 + 30 * (1.0 - t * 0.25));
    return (alpha << 24) | (b << 16) | (g << 8) | r;
  }

  // Purple gradient for user's own car reachability (little-endian ABGR)
  function ratioToPurpleABGR(ratio) {
    const t = Math.max(0, Math.min(1, ratio));
    const r = Math.round(107 + t * (216 - 107));
    const g = Math.round(33 + t * (180 - 33));
    const b = Math.round(168 + t * (254 - 168));
    const alpha = Math.round(150 + 30 * (1.0 - t * 0.25));
    return (alpha << 24) | (b << 16) | (g << 8) | r;
  }

  function paintReachPixels(budgetWh, offroadWhPerM, scRevealFrac, nacsRevealFrac = 1.0, carBudgetWh = 0) {
    const { nPix, pixIdx, pixNode, pixDist } = grid;
    reachPixels32.fill(0);
    if (budgetWh <= 0 && carBudgetWh <= 0) {
      reachCtx.putImageData(reachImgData, 0, 0);
      return;
    }

    const invBudget = budgetWh > 0 ? 1.0 / budgetWh : 0;
    const invCarBudget = carBudgetWh > 0 ? 1.0 / carBudgetWh : 0;
    const hasSc = selectedScIdx >= 0 && scRevealFrac > 0 && budgetWh > 0;
    const hasNacs = selectedNacsIdx >= 0 && nacsRevealFrac > 0 && nacsUsed && budgetWh > 0;
    const hasCar = carState.active && carState.node >= 0 && carUsed && carBudgetWh > 0;
    const scMax = budgetWh * scRevealFrac;
    const nacsMax = budgetWh * nacsRevealFrac;
    const carMax = carBudgetWh * scRevealFrac;

    for (let i = 0; i < nPix; i++) {
      const node = pixNode[i];
      const offWh = pixDist[i] * offroadWhPerM;

      if (hasSc) {
        const scNodeUsed = goUsed[node];
        if (scNodeUsed <= scMax) {
          const totalUsed = scNodeUsed + offWh;
          if (totalUsed <= scMax) {
            const rem = budgetWh - totalUsed;
            if (rem > 0) {
              reachPixels32[pixIdx[i]] = ratioToABGR(rem * invBudget);
              continue;
            }
          }
        }
      }

      if (hasCar) {
        const cNodeUsed = carUsed[node];
        if (cNodeUsed <= carMax) {
          const totalUsed = cNodeUsed + offWh;
          if (totalUsed <= carMax) {
            const rem = carBudgetWh - totalUsed;
            if (rem > 0) {
              reachPixels32[pixIdx[i]] = ratioToPurpleABGR(rem * invCarBudget);
              continue;
            }
          }
        }
      }

      if (hasNacs) {
        const nNodeUsed = nacsUsed[node];
        if (nNodeUsed <= nacsMax) {
          const totalUsed = nNodeUsed + offWh;
          if (totalUsed <= nacsMax) {
            const rem = budgetWh - totalUsed;
            if (rem > 0) {
              reachPixels32[pixIdx[i]] = ratioToBlueABGR(rem * invBudget);
            }
          }
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

  function getSelectedOrigin() {
    if (selectedScIdx >= 0 && superchargers[selectedScIdx]) {
      return { type: "sc", ...superchargers[selectedScIdx] };
    }
    if (selectedNacsIdx >= 0 && nacsChargers[selectedNacsIdx]) {
      const n = nacsChargers[selectedNacsIdx];
      return { type: "nacs", ...n, state: n.pref, city: "免转接 NACS" };
    }
    return null;
  }

  function updateCarPinLayer() {
    if (!map) return;
    const src = map.getSource("car-pin");
    if (!src) return;
    src.setData(
      carState.active
        ? { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [carState.lon, carState.lat] } }] }
        : { type: "FeatureCollection", features: [] }
    );
  }

  function updateReachability(opts = {}) {
    if (!graph || !grid || !map) return;
    const { animate = false, pan = false, animateNacsOnly = false } = opts;
    // 选了新的站点/车辆时，把收起的底部面板重新展开
    if (animate) document.getElementById("status-card")?.classList.remove("peek");

    if (revealAnimId) {
      cancelAnimationFrame(revealAnimId);
      revealAnimId = 0;
    }

    const emptyEl = document.getElementById("status-empty");
    const activeEl = document.getElementById("status-active");
    const ferryLegendEl = document.getElementById("ferry-legend");
    const nacsLegendEl = document.getElementById("nacs-legend");
    const purpleLegendEl = document.getElementById("purple-legend");
    const sc = selectedScIdx >= 0 ? superchargers[selectedScIdx] : null;
    const nacsOrigin = selectedNacsIdx >= 0 ? nacsChargers[selectedNacsIdx] : null;
    const hasCar = carState.active && carState.node >= 0;

    ensureReachOverlaySource();
    updateCarPinLayer();

    if (!sc && !nacsOrigin && !hasCar) {
      if (selectedCampIdx < 0) emptyEl.classList.remove("hidden");
      else emptyEl.classList.add("hidden");
      activeEl.classList.add("hidden");
      if (nacsLegendEl) nacsLegendEl.classList.add("hidden");
      if (purpleLegendEl) purpleLegendEl.classList.add("hidden");
      if (map.getLayer("reach-overlay-layer")) {
        map.setLayoutProperty("reach-overlay-layer", "visibility", "none");
      }
      const src = map.getSource("reach-overlay");
      if (src) src.pause();
      updateFerryLayer(null, Infinity);
      updateSuperchargerLayer(null, Infinity);
      updateNacsLayer();
      updateDestRouteLayer(null, null);
      if (selectedCampIdx >= 0) updateCampCalc();
      return;
    }

    if (sc || hasCar) {
      emptyEl.classList.add("hidden");
      activeEl.classList.remove("hidden");
    } else {
      emptyEl.classList.remove("hidden");
      activeEl.classList.add("hidden");
    }
    if (ferryLegendEl) {
      ferryLegendEl.classList.toggle("hidden", !state.ferry);
    }
    if (nacsLegendEl) {
      nacsLegendEl.classList.toggle("hidden", !nacsOrigin);
    }
    if (purpleLegendEl) {
      purpleLegendEl.classList.toggle("hidden", !hasCar);
    }
    if (map.getLayer("reach-overlay-layer")) {
      map.setLayoutProperty("reach-overlay-layer", "visibility", "visible");
    }

    const params = computeEnergyParams();
    const { usableFullWh, budgetWh, winterMult } = params;
    const carUsablePct = Math.max(0, carState.soc - state.arrivePct);
    const carBudgetWh = hasCar ? usableFullWh * (carUsablePct / 100.0) : 0;

    // 1. Run Dijkstra for Supercharger, Car, and/or 3rd-party NACS
    if (sc && !animateNacsOnly) {
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
    }
    if (hasCar && !animateNacsOnly) {
      const carParams = {
        ...params,
        budgetWh: carBudgetWh,
        minUsedAllowed: -usableFullWh * ((100.0 - carState.soc) / 100.0),
      };
      runDijkstra(carState.node, false, carParams, carUsed, !sc ? goParentNode : null, !sc ? goParentEdge : null);
      if (state.roundTrip) {
        runDijkstra(carState.node, true, carParams, backUsed);
        for (let i = 0; i < graph.nNodes; i++) {
          if (carUsed[i] <= carBudgetWh && backUsed[i] <= carBudgetWh) {
            carUsed[i] = carUsed[i] + backUsed[i];
          } else {
            carUsed[i] = Infinity;
          }
        }
      }
    }
    if (nacsOrigin) {
      runDijkstra(nacsOrigin.node, false, params, nacsUsed);
      if (state.roundTrip) {
        runDijkstra(nacsOrigin.node, true, params, backUsed);
        for (let i = 0; i < graph.nNodes; i++) {
          if (nacsUsed[i] <= budgetWh && backUsed[i] <= budgetWh) {
            nacsUsed[i] = nacsUsed[i] + backUsed[i];
          } else {
            nacsUsed[i] = Infinity;
          }
        }
      }
    }

    // 2. Smoothly center camera and animate outward energy wave
    const offroadWhPerM = (state.whPerKm / 1000.0) * 1.12 * winterMult * (state.roundTrip ? 2.0 : 1.0);
    if (pan && sc) {
      map.easeTo({ center: [sc.lon, sc.lat], duration: 500, easing: (t) => 1 - Math.pow(1 - t, 3) });
    } else if (pan && hasCar && !sc) {
      map.easeTo({ center: [carState.lon, carState.lat], zoom: Math.max(map.getZoom(), 7.5), duration: 500, easing: (t) => 1 - Math.pow(1 - t, 3) });
    }

    const src = map.getSource("reach-overlay");
    if (animate && (budgetWh > 0 || carBudgetWh > 0) && src) {
      const startMs = performance.now();
      const durationMs = 420;
      src.play();
      const step = (now) => {
        const rawT = Math.min(1.0, (now - startMs) / durationMs);
        const eased = 1.0 - Math.pow(1.0 - rawT, 3);
        const frac = 0.06 + 0.94 * eased;
        paintReachPixels(budgetWh, offroadWhPerM, animateNacsOnly ? 1.0 : frac, frac, carBudgetWh);
        if (!animateNacsOnly && sc && map.getLayer("sc-selected-halo")) {
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
      paintReachPixels(budgetWh, offroadWhPerM, 1.0, 1.0, carBudgetWh);
      refreshCanvasOverlayOnce();
    }

    // 3. Update Ferry, Supercharger & NACS layers and status metrics
    const primaryArr = sc ? goUsed : (hasCar ? carUsed : null);
    const primaryBudget = sc ? budgetWh : carBudgetWh;

    const btnCarRefreshEl = document.getElementById("btn-car-refresh");
    if (btnCarRefreshEl) btnCarRefreshEl.classList.toggle("hidden", !hasCar || Boolean(sc));
    const btnCarSettingsEl = document.getElementById("btn-car-settings");
    if (btnCarSettingsEl) btnCarSettingsEl.classList.toggle("hidden", !hasCar || Boolean(sc));
    const btnCarTripsEl = document.getElementById("btn-car-trips");
    if (btnCarTripsEl) btnCarTripsEl.classList.toggle("hidden", !hasCar || Boolean(sc));

    if (sc) {
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
    } else if (hasCar) {
      updateFerryLayer(carUsed, carBudgetWh);
      const reachableScCount = updateSuperchargerLayer(carUsed, carBudgetWh);
      document.getElementById("sc-name").textContent = "我的车 · 当前位置";
      document.getElementById("sc-meta").textContent = `当前电量 ${carState.soc}%${carState.updatedAt ? " · 已同步" : ""}`;
      document.getElementById("metric-kwh").textContent = `${(carBudgetWh / 1000.0).toFixed(1)} kWh`;
      const flatKm = carBudgetWh > 0 ? (carBudgetWh / (state.whPerKm * winterMult)) / (state.roundTrip ? 2.0 : 1.0) : 0;
      document.getElementById("metric-range").textContent = `${Math.round(flatKm)} km`;
      const carPill = document.getElementById("btn-car-pill");
      if (carPill) carPill.innerHTML = `<span class="car-pill-dot"></span>我的车 <b>${carState.soc}%</b> · 约 <b>${Math.round(flatKm)} km</b>`;
      document.getElementById("metric-sc-count").textContent = `${reachableScCount} 座`;
      const gauge = document.getElementById("soc-gauge");
      if (gauge) {
        gauge.style.setProperty("--soc-from", state.arrivePct + "%");
        gauge.style.setProperty("--soc-to", carState.soc + "%");
        document.getElementById("soc-label").textContent = `${carState.soc}% → ${state.arrivePct}%`;
      }
    } else {
      updateFerryLayer(null, Infinity);
      updateSuperchargerLayer(null, Infinity);
    }

    if (selectedDest && primaryArr) evaluateDestination(selectedDest);
    else updateDestRouteLayer(null, null);

    updateNacsLayer();
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

  let showNacsPins = false;
  function updateNacsLayer() {
    if (!map) return 0;
    const src = map.getSource("nacs-chargers");
    if (!src) return 0;
    if (!showNacsPins || currentMode !== "map" || !nacsChargers.length) {
      src.setData({ type: "FeatureCollection", features: [] });
      return 0;
    }
    const features = nacsChargers.map((n, idx) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [n.lon, n.lat] },
      properties: {
        idx,
        name: n.name,
        brand: n.brand,
        kw: n.kw,
        hours: n.hours || "",
        addr: n.addr || "",
        img: n.img || "",
        gmap: n.gmap || "",
        status: idx === selectedNacsIdx ? 2 : 0,
      },
    }));
    src.setData({ type: "FeatureCollection", features });
    return features.length;
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
    if (!map || !grid || !styleReady) return;
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
    styleReady = true;
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
          4, ["case", ["==", ["get", "status"], 2], 7, 3.8],
          6, ["case", ["==", ["get", "status"], 2], 8, 5],
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
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            4, 4.0,
            7, 5.4,
            10, 6.8,
            13, 8.2,
          ],
          "circle-color": [
            "match",
            ["get", "kind"],
            "rv", "#14b8a6",
            "sa", "#60a5fa",
            "#f59e0b",
          ],
          "circle-opacity": 0.9,
          "circle-stroke-width": 1,
          "circle-stroke-color": "rgba(255,255,255,0.75)",
        },
      },
      "sc-selected-halo"
    );
    map.addLayer(
      {
        id: "camp-hit",
        type: "circle",
        source: "camp-spots",
        paint: {
          "circle-radius": 11,
          "circle-opacity": 0,
        },
      },
      "sc-selected-halo"
    );

    // 3rd-party adapter-free NACS chargers (e.g. FLASH)
    map.addSource("nacs-chargers", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer(
      {
        id: "nacs-circles",
        type: "circle",
        source: "nacs-chargers",
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            4, ["case", ["==", ["get", "status"], 2], 7.5, 3.6],
            8, ["case", ["==", ["get", "status"], 2], 9.5, 5.5],
            12, ["case", ["==", ["get", "status"], 2], 11, 7.5],
          ],
          "circle-color": [
            "case",
            ["==", ["get", "status"], 2], "#ffffff",
            "#38bdf8",
          ],
          "circle-stroke-width": ["case", ["==", ["get", "status"], 2], 3, 1.3],
          "circle-stroke-color": [
            "case",
            ["==", ["get", "status"], 2], "#38bdf8",
            "rgba(255,255,255,0.8)",
          ],
        },
      },
      "sc-selected-halo"
    );
    map.addLayer(
      {
        id: "nacs-hit",
        type: "circle",
        source: "nacs-chargers",
        paint: { "circle-radius": 12, "circle-opacity": 0 },
      },
      "sc-selected-halo"
    );

    map.addSource("car-pin", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({
      id: "car-pin-halo",
      type: "circle",
      source: "car-pin",
      paint: { "circle-radius": 16, "circle-color": "rgba(168, 85, 247, 0.28)" },
    });
    map.addLayer({
      id: "car-pin-circle",
      type: "circle",
      source: "car-pin",
      paint: {
        "circle-radius": 8,
        "circle-color": "#a855f7",
        "circle-stroke-width": 2.5,
        "circle-stroke-color": "#ffffff",
      },
    });

    updateCampLayer();
    updateNacsLayer(null, Infinity);
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

    map.on("mouseenter", "nacs-hit", (e) => {
      if (map.queryRenderedFeatures(e.point, { layers: ["sc-hit"] }).length > 0) return;
      map.getCanvas().style.cursor = "pointer";
      const p = e.features[0].properties;
      let html = `<strong>${p.name}</strong><br/>${p.brand}（免转接） · ${p.kw || "?"} kW`;
      if (p.hours) html += `<br/>${p.hours}`;
      hoverPopup.setLngLat(e.features[0].geometry.coordinates).setHTML(html).addTo(map);
    });
    map.on("mouseleave", "nacs-hit", () => {
      map.getCanvas().style.cursor = "";
      hoverPopup.remove();
    });
    map.on("click", "nacs-hit", async (e) => {
      if (map.queryRenderedFeatures(e.point, { layers: ["sc-hit"] }).length > 0) return;
      const p = e.features[0].properties;
      const coords = e.features[0].geometry.coordinates.slice();
      selectedNacsIdx = (selectedNacsIdx === p.idx) ? -1 : p.idx;
      if (dataReadyPromise) await dataReadyPromise;
      updateReachability({ animate: selectedNacsIdx >= 0, pan: false, animateNacsOnly: selectedScIdx >= 0 });
      const gmapUrl = p.gmap || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name + " " + coords[1] + "," + coords[0])}`;
      new maplibregl.Popup()
        .setLngLat(coords)
        .setHTML(
          `<strong>${p.name}</strong><br/>${p.brand}（免转接） · ${p.kw || "?"} kW` +
          (p.img ? `<img class="nacs-popup-img" src="${p.img}" alt="${p.name}" loading="lazy" onerror="this.remove()" />` : "") +
          (p.hours ? `<br/>营业时间：${p.hours}` : "") +
          (p.addr ? `<br/>地址：${p.addr}` : "") +
          `<br/><a class="gmap-link" style="margin-top:6px" href="${gmapUrl}" target="_blank" rel="noopener">📍 Google 地图实景/导航</a>` +
          `<br/><span style="color:#38bdf8">${selectedNacsIdx >= 0 ? "已叠加蓝色新增辐射范围（再点一次可取消）" : "已取消该第三方桩辐射范围"}</span>`
        )
        .addTo(map);
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
      const idx = e.features[0].properties.idx;
      if (currentMode === "camp") {
        openCampWorkspace(idx);
      } else {
        selectCampSpot(idx, false);
      }
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
    const sc = getSelectedOrigin();
    if (!dest || !sc || !graph) {
      resEl.classList.add("hidden");
      clearBtn.classList.add("hidden");
      updateDestRouteLayer(null, null);
      return;
    }
    clearBtn.classList.remove("hidden");

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
    if (currentMode !== "camp" || !campSpots.length) {
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    const features = [];
    for (let idx = 0; idx < campSpots.length; idx++) {
      const c = campSpots[idx];
      if (currentMode === "camp") {
        if (cvFilter === "michi" && c.kind !== "michi") continue;
        if (cvFilter === "rv" && c.kind !== "rv") continue;
        if (cvFilter === "sa" && c.kind !== "sa") continue;
        if (cvFilter === "onsen" && !c.o) continue;
        if (cvFilter === "power" && !c.p) continue;
      }
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [c.lon, c.lat] },
        properties: {
          idx,
          name: c.name,
          kind: c.kind,
          elev: c.elev,
          sc_km: c.sc_km,
        },
      });
    }
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

    // In camp mode, show full map first with #camp-map-bar; hide #camp-view until user clicks a spot or search
    document.getElementById("camp-view").classList.add("hidden");
    document.getElementById("camp-map-bar").classList.toggle("hidden", !isCamp);
    document.getElementById("btn-toggle-nacs").classList.toggle("hidden", isCamp);
    document.getElementById("status-card").classList.toggle("hidden", isCamp);
    document.getElementById("drawer").classList.toggle("hidden", isCamp);
    document.getElementById("btn-toggle-drawer").classList.toggle("hidden", isCamp);

    if (map && map.getLayer("sc-circles")) {
      map.setPaintProperty("sc-circles", "circle-opacity", isCamp ? 0.15 : 1.0);
      map.setPaintProperty("sc-circles", "circle-stroke-opacity", isCamp ? 0.15 : 1.0);
    }
    if (map && map.getLayer("sc-selected-halo")) {
      map.setLayoutProperty("sc-selected-halo", "visibility", isCamp ? "none" : "visible");
    }
    if (map && map.getLayer("reach-overlay-layer")) {
      const hasCov = selectedScIdx >= 0 || selectedNacsIdx >= 0 || carState.active;
      map.setLayoutProperty("reach-overlay-layer", "visibility", !isCamp && hasCov ? "visible" : "none");
    }
    if (map && map.getLayer("ferry-routes-std")) {
      map.setLayoutProperty("ferry-routes-std", "visibility", isCamp ? "none" : "visible");
    }
    if (map && map.getLayer("ferry-routes-ev")) {
      map.setLayoutProperty("ferry-routes-ev", "visibility", isCamp ? "none" : "visible");
    }
    if (map && map.getLayer("nacs-circles")) {
      map.setPaintProperty("nacs-circles", "circle-opacity", isCamp ? 0.2 : 1.0);
      map.setPaintProperty("nacs-circles", "circle-stroke-opacity", isCamp ? 0.25 : 1.0);
    }
    updateCampLayer();
  }

  function openCampWorkspace(spotIdx = -1) {
    if (selectedScIdx >= 0 && superchargers[selectedScIdx]) {
      const sc = superchargers[selectedScIdx];
      cvRefCoord = { lat: sc.lat, lon: sc.lon, label: sc.name };
    } else if (map) {
      const c = map.getCenter();
      cvRefCoord = { lat: c.lat, lon: c.lng, label: "当前地图中心周边" };
    }
    document.getElementById("camp-map-bar").classList.add("hidden");
    document.getElementById("camp-view").classList.remove("hidden");
    renderCampViewList();
    if (spotIdx >= 0) {
      selectCampViewSpot(spotIdx);
    }
  }

  // 按入睡~起床这段时间，从当地逐小时预报里取平均气温和最低气温
  function applyAutoCampTemp() {
    if (cvTempManual || !cvHourly || cvHourly.spotIdx !== selectedCampIdx) return;
    const s = document.getElementById("cv-sleep-start").value || "22:30";
    const [sh, sm] = s.split(":").map(Number);
    const hours = getSleepHours();
    // 今晚：当地日期的入睡时刻。如果当地已经过了起床时间的次日早上，就看明晚
    const nowJst = Date.now() + 9 * 3600e3;
    let startMs = cvHourly.startMs + (sh * 60 + sm) * 60e3;
    if (nowJst > startMs + hours * 3600e3) startMs += 24 * 3600e3;
    const from = Math.floor((startMs - cvHourly.startMs) / 3600e3);
    const to = Math.ceil((startMs + hours * 3600e3 - cvHourly.startMs) / 3600e3);
    const slice = cvHourly.temps.slice(Math.max(0, from), Math.min(cvHourly.temps.length, to + 1)).filter((t) => typeof t === "number");
    if (!slice.length) return;
    const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
    const min = Math.min(...slice);
    cvOutTemp = Math.max(-15, Math.min(35, Math.round(avg)));
    const tempEl = document.getElementById("cv-out-temp");
    tempEl.value = cvOutTemp;
    tempEl.style.setProperty("--fill", ((cvOutTemp - (-15)) / 50) * 100 + "%");
    const isTomorrow = startMs - cvHourly.startMs >= 24 * 3600e3 + (sh * 60 + sm) * 60e3;
    document.getElementById("cv-temp-src").textContent = `(当地预报 · ${isTomorrow ? "明晚" : "今晚"}睡觉时段平均，最低 ${Math.round(min)}°C)`;
    updateCampViewCalc();
  }

  function setTempManualUi(manual) {
    document.getElementById("cv-out-temp").classList.toggle("hidden", !manual);
    document.getElementById("btn-cv-temp-manual").classList.toggle("hidden", manual);
    document.getElementById("btn-cv-temp-auto").classList.toggle("hidden", !manual || !cvHourly);
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

  const spotPhotoCache = new Map();

  async function fetchSpotPhotos(spot) {
    const cacheKey = `${spot.name}|${spot.lat}|${spot.lon}`;
    if (spotPhotoCache.has(cacheKey)) return spotPhotoCache.get(cacheKey);
    const urls = [];
    const cleanTitle = spot.name.replace(/\s+/g, "").replace(/[「」]/g, "");
    try {
      const wUrl = `https://ja.wikipedia.org/w/api.php?origin=*&action=query&titles=${encodeURIComponent(cleanTitle)}&redirects=1&prop=pageimages&pithumbsize=640&format=json`;
      const wd = await fetch(wUrl).then((r) => r.json());
      const pages = wd?.query?.pages || {};
      for (const k of Object.keys(pages)) {
        const src = pages[k]?.thumbnail?.source;
        if (src && !urls.includes(src)) urls.push(src);
      }
    } catch (_) {}

    if (urls.length < 3) {
      try {
        const cUrl = `https://commons.wikimedia.org/w/api.php?origin=*&action=query&generator=geosearch&ggsprimary=all&ggsnamespace=6&ggscoord=${spot.lat}|${spot.lon}&ggsradius=900&ggslimit=4&prop=imageinfo&iiprop=url&iiurlwidth=640&format=json`;
        const cd = await fetch(cUrl).then((r) => r.json());
        const pages = cd?.query?.pages || {};
        for (const k of Object.keys(pages)) {
          const info = pages[k]?.imageinfo?.[0];
          const src = info?.thumburl || info?.url;
          if (src && /\.(jpe?g|png|webp)(\?|$)/i.test(src) && !urls.includes(src)) {
            urls.push(src);
          }
          if (urls.length >= 4) break;
        }
      } catch (_) {}
    }
    spotPhotoCache.set(cacheKey, urls);
    return urls;
  }

  async function renderCampViewPhotos(spot, idx) {
    const box = document.getElementById("cv-photos");
    if (!box) return;
    const gmapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(spot.name + " " + spot.lat + "," + spot.lon)}`;
    box.innerHTML = `<a class="gmap-link" href="${gmapUrl}" target="_blank" rel="noopener">📍 Google 地图看实景/评价</a><span style="font-size:11px;color:var(--text-3)">正在查找实景照片…</span>`;
    const urls = await fetchSpotPhotos(spot);
    if (selectedCampIdx !== idx) return;
    box.innerHTML =
      urls.map((u) => `<a href="${u}" target="_blank" rel="noopener"><img class="cv-photo-img" src="${u}" alt="${spot.name}" loading="lazy" /></a>`).join("") +
      `<a class="gmap-link" href="${gmapUrl}" target="_blank" rel="noopener">📍 Google 地图看实景/评价</a>`;
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
    renderCampViewPhotos(spot, idx);

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
    document.getElementById("cv-temp-src").textContent = "(获取当地预报中…)";
    cvTempManual = false;
    cvHourly = null;
    setTempManualUi(false);
    updateCampViewCalc();

    document.querySelectorAll(".cv-spot-item").forEach((el) => {
      el.classList.toggle("active", Number(el.dataset.idx) === idx);
    });

    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${spot.lat}&longitude=${spot.lon}&hourly=temperature_2m&timezone=Asia%2FTokyo&forecast_days=3`;
      const resp = await fetch(url);
      if (resp.ok && selectedCampIdx === idx) {
        const w = await resp.json();
        const times = w?.hourly?.time;
        const temps = w?.hourly?.temperature_2m;
        if (Array.isArray(times) && Array.isArray(temps) && temps.length) {
          // 时间是东京当地时间字符串，按 UTC 解析只用来做相对计算
          cvHourly = { spotIdx: idx, startMs: Date.parse(times[0] + ":00Z"), temps };
          applyAutoCampTemp();
          return;
        }
      }
    } catch (_) {}
    if (selectedCampIdx === idx) {
      document.getElementById("cv-temp-src").textContent = "(没拿到预报，按海拔估算)";
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
      state.showNacs = false;
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

    const btnNacs = document.getElementById("btn-toggle-nacs");
    btnNacs.addEventListener("click", () => {
      showNacsPins = !showNacsPins;
      btnNacs.setAttribute("aria-pressed", String(showNacsPins));
      if (!showNacsPins && selectedNacsIdx >= 0) {
        selectedNacsIdx = -1;
        updateReachability();
      } else {
        updateNacsLayer();
      }
    });

    // Dedicated Camp View & Camp Map Bar bindings
    const syncFilterChips = (filterVal) => {
      cvFilter = filterVal;
      document.querySelectorAll("#cv-filters .cv-chip, #cmb-filters .cv-chip").forEach((c) => {
        c.classList.toggle("active", c.dataset.filter === cvFilter);
      });
      updateCampLayer();
      renderCampViewList();
    };
    document.querySelectorAll("#cv-filters .cv-chip, #cmb-filters .cv-chip").forEach((chip) => {
      chip.addEventListener("click", () => syncFilterChips(chip.dataset.filter));
    });
    document.getElementById("btn-open-camp-search").addEventListener("click", () => openCampWorkspace(selectedCampIdx));
    document.getElementById("btn-cv-back-map").addEventListener("click", () => {
      document.getElementById("camp-view").classList.add("hidden");
      document.getElementById("camp-map-bar").classList.remove("hidden");
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
    const onSleepTimeChange = () => { updateCampViewCalc(); applyAutoCampTemp(); };
    document.getElementById("cv-sleep-start").addEventListener("change", onSleepTimeChange);
    document.getElementById("cv-sleep-end").addEventListener("change", onSleepTimeChange);
    document.getElementById("btn-cv-temp-manual").addEventListener("click", () => {
      cvTempManual = true;
      setTempManualUi(true);
      document.getElementById("cv-temp-src").textContent = "(手动设定)";
    });
    document.getElementById("btn-cv-temp-auto").addEventListener("click", () => {
      cvTempManual = false;
      setTempManualUi(false);
      applyAutoCampTemp();
    });

    // ---------- 时间滚轮 ----------
    const wheelSheet = document.createElement("div");
    wheelSheet.className = "modal-backdrop hidden";
    wheelSheet.id = "time-wheel";
    wheelSheet.innerHTML = `
      <div class="wheel-card glass" role="dialog" aria-modal="true" aria-labelledby="wheel-title">
        <div class="wheel-head">
          <button type="button" class="text-btn wheel-cancel">取消</button>
          <b id="wheel-title">选择时间</b>
          <button type="button" class="text-btn wheel-done">完成</button>
        </div>
        <div class="wheel-body">
          <div class="wheel-band" aria-hidden="true"></div>
          <div class="wheel-col" data-kind="h" aria-label="小时"></div>
          <div class="wheel-sep">:</div>
          <div class="wheel-col" data-kind="m" aria-label="分钟"></div>
        </div>
      </div>`;
    document.body.appendChild(wheelSheet);
    const WHEEL_ROW = 44;
    const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);
    const colH = wheelSheet.querySelector('[data-kind="h"]');
    const colM = wheelSheet.querySelector('[data-kind="m"]');
    const pad2 = (n) => String(n).padStart(2, "0");
    colH.innerHTML = Array.from({ length: 24 }, (_, i) => `<div class="wheel-item">${pad2(i)}</div>`).join("");
    colM.innerHTML = MINUTES.map((m) => `<div class="wheel-item">${pad2(m)}</div>`).join("");
    const markWheel = (col) => {
      const i = Math.round(col.scrollTop / WHEEL_ROW);
      [...col.children].forEach((el, k) => el.classList.toggle("on", k === i));
    };
    [colH, colM].forEach((col) => {
      col.addEventListener("scroll", () => markWheel(col), { passive: true });
      // 点某一项直接滚到它
      col.addEventListener("click", (e) => {
        const item = e.target.closest(".wheel-item");
        if (item) col.scrollTo({ top: [...col.children].indexOf(item) * WHEEL_ROW, behavior: "smooth" });
      });
    });
    let wheelTarget = null;
    const openWheel = (btn) => {
      wheelTarget = btn;
      const input = document.getElementById(btn.dataset.target);
      const [h, m] = (input.value || "22:30").split(":").map(Number);
      const mi = Math.round(m / 5) % 12;
      wheelSheet.querySelector("#wheel-title").textContent = btn.dataset.title || "选择时间";
      wheelSheet.classList.remove("hidden");
      requestAnimationFrame(() => {
        colH.scrollTop = h * WHEEL_ROW;
        colM.scrollTop = mi * WHEEL_ROW;
        markWheel(colH);
        markWheel(colM);
      });
    };
    const closeWheel = () => { wheelSheet.classList.add("hidden"); wheelTarget = null; };
    wheelSheet.querySelector(".wheel-cancel").addEventListener("click", closeWheel);
    wheelSheet.addEventListener("click", (e) => { if (e.target === wheelSheet) closeWheel(); });
    wheelSheet.querySelector(".wheel-done").addEventListener("click", () => {
      if (!wheelTarget) return closeWheel();
      const h = Math.min(23, Math.max(0, Math.round(colH.scrollTop / WHEEL_ROW)));
      const m = MINUTES[Math.min(11, Math.max(0, Math.round(colM.scrollTop / WHEEL_ROW)))];
      const val = `${pad2(h)}:${pad2(m)}`;
      const input = document.getElementById(wheelTarget.dataset.target);
      input.value = val;
      wheelTarget.textContent = val;
      input.dispatchEvent(new Event("change"));
      closeWheel();
    });
    document.querySelectorAll(".time-btn").forEach((btn) => btn.addEventListener("click", () => openWheel(btn)));
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

    const setCarPillVisible = (show) => {
      const bar = document.getElementById("car-pill-bar");
      if (bar) bar.classList.toggle("hidden", !show);
    };
    document.getElementById("btn-clear-sc").addEventListener("click", () => {
      if (carState.active && selectedScIdx < 0) {
        // Minimize bottom card so user can view purple reachability full-screen
        cardMinimized = true;
        document.getElementById("status-card").classList.add("hidden");
        setCarPillVisible(true);
        return;
      }
      cardMinimized = false;
      selectedScIdx = -1;
      selectedNacsIdx = -1;
      carState.active = false;
      document.getElementById("btn-my-car").setAttribute("aria-pressed", "false");
      setCarPillVisible(false);
      updateReachability();
    });

    const btnCarPillEl = document.getElementById("btn-car-pill");
    if (btnCarPillEl) {
      btnCarPillEl.addEventListener("click", () => {
        cardMinimized = false;
        setCarPillVisible(false);
        document.getElementById("status-card").classList.remove("hidden");
      });
    }
    const btnCarPillClearEl = document.getElementById("btn-car-pill-clear");
    if (btnCarPillClearEl) {
      btnCarPillClearEl.addEventListener("click", () => {
        cardMinimized = false;
        carState.active = false;
        setCarPillVisible(false);
        document.getElementById("status-card").classList.remove("hidden");
        document.getElementById("btn-my-car").setAttribute("aria-pressed", "false");
        updateReachability();
      });
    }

    // Swipe down on bottom status card to minimize (same as clicking ×) when viewing My Car
    const statusCardEl = document.getElementById("status-card");
    if (statusCardEl) {
      let touchStartY = null;
      statusCardEl.addEventListener("touchstart", (e) => {
        if (e.touches && e.touches.length === 1 && !e.target.closest("input, button, select")) {
          touchStartY = e.touches[0].clientY;
        } else {
          touchStartY = null;
        }
      }, { passive: true });
      statusCardEl.addEventListener("touchend", (e) => {
        if (touchStartY !== null && e.changedTouches && e.changedTouches.length === 1) {
          const dy = e.changedTouches[0].clientY - touchStartY;
          const atTop = statusCardEl.scrollTop <= 2;
          if (dy > 45 && atTop && carState.active && selectedScIdx < 0) {
            cardMinimized = true;
            statusCardEl.classList.add("hidden");
            setCarPillVisible(true);
          } else if (dy > 45 && atTop && window.innerWidth <= 760) {
            // 下滑：收起成一条，只留站名，把地图让出来
            statusCardEl.classList.add("peek");
            statusCardEl.scrollTop = 0;
          } else if (dy < -45 && statusCardEl.classList.contains("peek")) {
            // 上滑：重新展开
            statusCardEl.classList.remove("peek");
          }
        }
        touchStartY = null;
      }, { passive: true });
      // 电脑：用鼠标在卡片上往下拖收起、往上拖展开；点顶部横条切换
      let mouseStartY = null;
      let mouseHandledAt = 0;
      statusCardEl.addEventListener("pointerdown", (e) => {
        if (e.pointerType !== "mouse" || e.target.closest("input, button, select, a")) return;
        mouseStartY = e.clientY;
      });
      window.addEventListener("pointerup", (e) => {
        if (mouseStartY === null) return;
        const dy = e.clientY - mouseStartY;
        mouseStartY = null;
        mouseHandledAt = Date.now();
        const rect = statusCardEl.getBoundingClientRect();
        const onHandle = Math.abs(dy) < 6 && e.clientY - rect.top < 20;
        if (dy > 40 || (onHandle && !statusCardEl.classList.contains("peek"))) {
          statusCardEl.classList.add("peek");
          statusCardEl.scrollTop = 0;
        } else if (dy < -40 || onHandle) {
          statusCardEl.classList.remove("peek");
        }
      });
      // 收起状态下点一下也能展开
      statusCardEl.addEventListener("click", (e) => {
        if (Date.now() - mouseHandledAt < 300) return;
        if (statusCardEl.classList.contains("peek") && !e.target.closest("button")) {
          statusCardEl.classList.remove("peek");
        }
      });
    }

    // NAS TeslaMate Car Sync Modal & Purple Reachability
    const nasModal = document.getElementById("nas-modal");
    const nasUrlEl = document.getElementById("nas-url");
    const nasTokEl = document.getElementById("nas-token");
    const nasMsgEl = document.getElementById("nas-status-msg");
    const btnMyCar = document.getElementById("btn-my-car");

    try {
      const savedNas = JSON.parse(localStorage.getItem("dokomademap_nas_v1") || "{}");
      if (savedNas.url) nasUrlEl.value = savedNas.url;
      if (savedNas.token) nasTokEl.value = savedNas.token;
    } catch (_) {}

    const activateCarPurple = async (lat, lon, soc, updatedAt = "") => {
      if (dataReadyPromise) await dataReadyPromise;
      const snap = findNearestNode(lat, lon, Infinity);
      if (snap.node < 0) {
        nasMsgEl.textContent = "该位置不在日本路网范围内。";
        nasMsgEl.classList.remove("hidden");
        return false;
      }
      carState = { active: true, lat, lon, node: snap.node, soc, updatedAt };
      cardMinimized = false;
      document.getElementById("status-card").classList.remove("hidden");
      const carPillBar = document.getElementById("car-pill-bar");
      if (carPillBar) carPillBar.classList.add("hidden");
      state.departPct = soc;
      syncControlsFromState();
      saveState();
      selectedScIdx = -1;
      selectedNacsIdx = -1;
      btnMyCar.setAttribute("aria-pressed", "true");
      nasModal.classList.add("hidden");
      updateReachability({ animate: true, pan: true });
      return true;
    };

    const saveNasCache = (url, token, lastCar = null) => {
      try {
        const prev = JSON.parse(localStorage.getItem("dokomademap_nas_v1") || "{}");
        const next = { url: url ?? prev.url ?? "", token: token ?? prev.token ?? "", lastCar: lastCar ?? prev.lastCar ?? null };
        localStorage.setItem("dokomademap_nas_v1", JSON.stringify(next));
      } catch (_) {}
    };

    const syncFromNas = async (url, token, { silent = false, pan = true } = {}) => {
      if (!url) return false;
      if (!silent) {
        nasMsgEl.textContent = "正在从 NAS 同步车辆最新状态…";
        nasMsgEl.classList.remove("hidden");
      }
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const resp = await fetch(url, { headers });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const d = await resp.json();
      if (typeof d.soc !== "number" || typeof d.lat !== "number" || typeof d.lon !== "number") {
        throw new Error("返回数据缺少 soc / lat / lon");
      }
      if (d.full_range_km) state.fullRangeKm = Math.max(450, Math.min(680, Math.round(d.full_range_km / 10) * 10));
      if (d.wh_per_km) state.whPerKm = Math.max(120, Math.min(240, Math.round(d.wh_per_km / 5) * 5));
      const soc = Math.max(5, Math.min(100, Math.round(d.soc)));
      const updatedAt = d.updated_at || "NAS";
      saveNasCache(url, token, { lat: d.lat, lon: d.lon, soc, full_range_km: d.full_range_km, wh_per_km: d.wh_per_km, updatedAt });
      if (dataReadyPromise) await dataReadyPromise;
      const snap = findNearestNode(d.lat, d.lon, Infinity);
      if (snap.node < 0) throw new Error("该位置不在日本路网范围内");
      carState = { active: true, lat: d.lat, lon: d.lon, node: snap.node, soc, updatedAt };
      cardMinimized = false;
      document.getElementById("status-card").classList.remove("hidden");
      const carPillBar2 = document.getElementById("car-pill-bar");
      if (carPillBar2) carPillBar2.classList.add("hidden");
      state.departPct = soc;
      syncControlsFromState();
      saveState();
      selectedScIdx = -1;
      selectedNacsIdx = -1;
      btnMyCar.setAttribute("aria-pressed", "true");
      nasModal.classList.add("hidden");
      updateReachability({ animate: true, pan });
      return true;
    };

    btnMyCar.addEventListener("click", async () => {
      let savedNas = {};
      try { savedNas = JSON.parse(localStorage.getItem("dokomademap_nas_v1") || "{}"); } catch (_) {}
      // 已经在显示我的车 → 再点一下就退出（保留车辆数据，下次点开秒出）
      if (carState.active && btnMyCar.getAttribute("aria-pressed") === "true") {
        cardMinimized = false;
        carState.active = false;
        setCarPillVisible(false);
        const sc = document.getElementById("status-card");
        sc.classList.remove("hidden", "peek");
        btnMyCar.setAttribute("aria-pressed", "false");
        updateReachability();
        return;
      }
      if (carState.node >= 0) {
        carState.active = true;
        cardMinimized = false;
        document.getElementById("status-card").classList.remove("hidden");
        const carPillBar3 = document.getElementById("car-pill-bar");
        if (carPillBar3) carPillBar3.classList.add("hidden");
        state.departPct = carState.soc;
        syncControlsFromState();
        selectedScIdx = -1;
        selectedNacsIdx = -1;
        btnMyCar.setAttribute("aria-pressed", "true");
        updateReachability({ animate: true, pan: true });
        if (savedNas.url) syncFromNas(savedNas.url, savedNas.token, { silent: true, pan: false }).catch(() => {});
        return;
      }
      if (savedNas.lastCar && typeof savedNas.lastCar.lat === "number") {
        const lc = savedNas.lastCar;
        if (lc.full_range_km) state.fullRangeKm = Math.max(450, Math.min(680, Math.round(lc.full_range_km / 10) * 10));
        if (lc.wh_per_km) state.whPerKm = Math.max(120, Math.min(240, Math.round(lc.wh_per_km / 5) * 5));
        await activateCarPurple(lc.lat, lc.lon, lc.soc, lc.updatedAt || "NAS");
        if (savedNas.url) syncFromNas(savedNas.url, savedNas.token, { silent: true, pan: false }).catch(() => {});
        return;
      }
      if (savedNas.url) {
        try {
          await syncFromNas(savedNas.url, savedNas.token, { silent: true, pan: true });
          return;
        } catch (_) {}
      }
      nasModal.classList.remove("hidden");
    });

    const btnCarSettings = document.getElementById("btn-car-settings");
    if (btnCarSettings) {
      btnCarSettings.addEventListener("click", () => nasModal.classList.remove("hidden"));
    }

    const btnCarRefresh = document.getElementById("btn-car-refresh");
    if (btnCarRefresh) {
      btnCarRefresh.addEventListener("click", async () => {
        let savedNas = {};
        try { savedNas = JSON.parse(localStorage.getItem("dokomademap_nas_v1") || "{}"); } catch (_) {}
        if (!savedNas.url) {
          nasModal.classList.remove("hidden");
          return;
        }
        const metaEl = document.getElementById("sc-meta");
        if (metaEl) metaEl.textContent = "正在从 NAS 刷新最新电量与位置…";
        try {
          await syncFromNas(savedNas.url, savedNas.token, { silent: true, pan: true });
        } catch (err) {
          if (metaEl) metaEl.textContent = `刷新失败：${err.message}`;
        }
      });
    }

    // ================= 最近行程、累计统计与足迹解锁 =================
    const tripsModal = document.getElementById("trips-modal");
    const tripsListEl = document.getElementById("trips-list");
    const tripsPeriodBarEl = document.getElementById("trips-period-bar");
    const tripsStatsEl = document.getElementById("trips-stats");
    const tripsSummaryEl = document.getElementById("trips-summary");
    const tripBar = document.getElementById("trip-bar");
    const footprintBar = document.getElementById("footprint-bar");
    const fpTitleEl = document.getElementById("fp-title");
    const fpMetaEl = document.getElementById("fp-meta");
    const fpPlacesEl = document.getElementById("fp-places");
    const fpPeriodBarEl = document.getElementById("fp-period-bar");
    const fpFogBtn = document.getElementById("btn-fp-fog");
    const TRIPS_PAGE_SIZE = 20;
    let trips = [];
    let tripsTotal = null;
    let tripsHasMore = false;
    let tripsLoadingMore = false;
    let tripsStats = null;
    let tripsStatsLegacy = false;
    let currentPeriod = "all";
    let availablePeriods = { years: [], months: [] };
    let selectedTripId = null;
    let footprintActive = false;
    let footprintFog = true;
    let footprintData = null;

    const getNas = () => {
      try { return JSON.parse(localStorage.getItem("dokomademap_nas_v1") || "{}"); } catch (_) { return {}; }
    };
    // 车辆接口地址是 …/status，行程接口在同一个前缀下：…/drives
    const nasBase = (url) => url.replace(/\/status\/?(\?.*)?$/, "").replace(/\/+$/, "");
    const nasFetch = async (path, opts = {}) => {
      const nas = getNas();
      if (!nas.url) throw new Error("还没有设置 NAS 接口");
      const headers = nas.token ? { Authorization: `Bearer ${nas.token}` } : {};
      const resp = await fetch(nasBase(nas.url) + path, { ...opts, headers });
      if (resp.status === 404 && path.startsWith("/drives") && !opts.method) {
        throw new Error("NAS 上的接口还是旧版，请先更新 bridge.py");
      }
      if (resp.status === 401) throw new Error("访问密钥不对");
      if (resp.status === 403) throw new Error("NAS 没设置访问密钥，不允许删除");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp.json();
    };

    const fmtDay = (iso) => {
      const d = new Date(iso);
      const today = new Date();
      const y = new Date(); y.setDate(today.getDate() - 1);
      const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
      if (d.toDateString() === today.toDateString()) return `今天 ${hm}`;
      if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
      const yr = d.getFullYear() !== today.getFullYear() ? `${d.getFullYear()}年` : "";
      return `${yr}${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
    };
    const fmtDateOnly = (iso) => {
      if (!iso) return "";
      const d = new Date(iso);
      return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
    };
    const fmtNum = (n) => Math.round(n || 0).toLocaleString("zh-CN");
    const fmtDur = (m) => (m == null ? "—" : m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分钟`);
    const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const tripTitle = (t) => `${t.from || "未知地点"} → ${t.to || "未知地点"}`;
    const tripMeta = (t) => {
      const parts = [fmtDay(t.start), `${t.distance_km ?? "—"} km`, fmtDur(t.duration_min)];
      if (t.soc_start != null && t.soc_end != null) parts.push(`电量 ${t.soc_start}→${t.soc_end}%`);
      if (t.kwh != null && t.kwh > 0) parts.push(`约 ${t.kwh} kWh`);
      return parts.join(" · ");
    };

    // 小缩略图：把轨迹画成一条线
    const sparkPath = (path) => {
      if (!path || path.length < 2) return "";
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of path) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
      const w = 56, h = 40, pad = 5;
      const span = Math.max(maxX - minX, maxY - minY) || 1e-6;
      const sx = (w - pad * 2) / span, sy = (h - pad * 2) / span;
      const ox = (w - (maxX - minX) * sx) / 2, oy = (h - (maxY - minY) * sy) / 2;
      const pts = path.map(([x, y]) => `${(ox + (x - minX) * sx).toFixed(1)},${(h - oy - (y - minY) * sy).toFixed(1)}`);
      const [sxp, syp] = pts[0].split(","), [exp, eyp] = pts[pts.length - 1].split(",");
      return `<svg class="trip-spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts.join(" ")}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${sxp}" cy="${syp}" r="2.6" fill="#22c55e"/><circle cx="${exp}" cy="${eyp}" r="2.6" fill="#a855f7"/></svg>`;
    };

    const ensureTripLayers = () => {
      if (!map) return false;
      if (!map.getStyle()) {
        // 底图还没准备好：等地图空闲了再画
        map.once("idle", redrawTrips);
        return false;
      }
      if (!map.getSource("trips-all")) {
        map.addSource("trips-all", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({
          id: "trips-all-line",
          type: "line",
          source: "trips-all",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#a855f7", "line-width": ["interpolate", ["linear"], ["zoom"], 5, 2, 12, 4], "line-opacity": 0.45 },
        });
      }
      if (!map.getSource("trip-sel")) {
        map.addSource("trip-sel", { type: "geojson", lineMetrics: true, data: { type: "FeatureCollection", features: [] } });
        map.addLayer({
          id: "trip-sel-casing",
          type: "line",
          source: "trip-sel",
          filter: ["==", ["geometry-type"], "LineString"],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 5, 5, 12, 9], "line-opacity": 0.9 },
        });
        map.addLayer({
          id: "trip-sel-line",
          type: "line",
          source: "trip-sel",
          filter: ["==", ["geometry-type"], "LineString"],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-width": ["interpolate", ["linear"], ["zoom"], 5, 3, 12, 6],
            "line-gradient": ["interpolate", ["linear"], ["line-progress"], 0, "#22c55e", 0.5, "#3e8bff", 1, "#a855f7"],
          },
        });
        map.addLayer({
          id: "trip-sel-ends",
          type: "circle",
          source: "trip-sel",
          filter: ["==", ["geometry-type"], "Point"],
          paint: {
            "circle-radius": 7,
            "circle-color": ["match", ["get", "kind"], "start", "#22c55e", "#a855f7"],
            "circle-stroke-width": 3,
            "circle-stroke-color": "#ffffff",
          },
        });
        map.on("click", "trips-all-line", (e) => {
          const id = e.features?.[0]?.properties?.id;
          if (id != null) selectTrip(Number(id), { fit: false });
        });
        map.on("mouseenter", "trips-all-line", () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", "trips-all-line", () => { map.getCanvas().style.cursor = ""; });
      }
      return true;
    };

    const redrawTrips = () => {
      if (!ensureTripLayers()) return;
      const show = selectedTripId != null;
      map.getSource("trips-all").setData({
        type: "FeatureCollection",
        features: show
          ? trips.filter((t) => t.path && t.path.length > 1 && t.id !== selectedTripId).map((t) => ({
              type: "Feature", properties: { id: t.id }, geometry: { type: "LineString", coordinates: t.path },
            }))
          : [],
      });
      const t = trips.find((x) => x.id === selectedTripId);
      const feats = [];
      if (t && t.path && t.path.length > 1) {
        feats.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: t.path } });
        feats.push({ type: "Feature", properties: { kind: "start" }, geometry: { type: "Point", coordinates: t.path[0] } });
        feats.push({ type: "Feature", properties: { kind: "end" }, geometry: { type: "Point", coordinates: t.path[t.path.length - 1] } });
      }
      map.getSource("trip-sel").setData({ type: "FeatureCollection", features: feats });
    };

    const WORLD_RING = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
    const ensureFootprintLayers = () => {
      if (!map) return false;
      if (!map.getStyle()) {
        map.once("idle", redrawFootprint);
        return false;
      }
      if (!map.getSource("fp-fog")) {
        map.addSource("fp-fog", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({
          id: "fp-fog-fill",
          type: "fill",
          source: "fp-fog",
          paint: { "fill-color": "#05070e", "fill-opacity": 0.44 },
        });
      }
      if (!map.getSource("fp-cells")) {
        map.addSource("fp-cells", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({
          id: "fp-heat",
          type: "heatmap",
          source: "fp-cells",
          paint: {
            "heatmap-weight": ["interpolate", ["linear"], ["get", "visits"], 1, 0.35, 5, 0.7, 15, 1.0],
            "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 5, 0.7, 10, 0.95, 14, 1.15],
            "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 5, 14, 9, 32, 12, 56, 15, 86],
            "heatmap-opacity": 0.78,
            "heatmap-color": [
              "interpolate", ["linear"], ["heatmap-density"],
              0, "rgba(56, 189, 248, 0)",
              0.2, "rgba(56, 189, 248, 0.2)",
              0.5, "rgba(99, 102, 241, 0.38)",
              0.8, "rgba(168, 85, 247, 0.52)",
              1, "rgba(232, 121, 249, 0.65)",
            ],
          },
        });
      }
      if (!map.getSource("fp-trails")) {
        map.addSource("fp-trails", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({
          id: "fp-trails-aura",
          type: "line",
          source: "fp-trails",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": "#38bdf8",
            "line-width": ["interpolate", ["linear"], ["zoom"], 6, 14, 10, 34, 13, 62],
            "line-blur": ["interpolate", ["linear"], ["zoom"], 6, 10, 10, 24, 13, 42],
            "line-opacity": 0.28,
          },
        });
        map.addLayer({
          id: "fp-trails-mid",
          type: "line",
          source: "fp-trails",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": "#a855f7",
            "line-width": ["interpolate", ["linear"], ["zoom"], 6, 5, 10, 12, 13, 20],
            "line-blur": ["interpolate", ["linear"], ["zoom"], 6, 4, 10, 8, 13, 14],
            "line-opacity": 0.36,
          },
        });
        map.addLayer({
          id: "fp-trails-line",
          type: "line",
          source: "fp-trails",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": "#f0abfc",
            "line-width": ["interpolate", ["linear"], ["zoom"], 6, 1.2, 10, 2.2, 13, 3.2],
            "line-opacity": 0.88,
          },
        });
      }
      return true;
    };

    const redrawFootprint = () => {
      if (!ensureFootprintLayers()) return;
      const empty = { type: "FeatureCollection", features: [] };
      if (!footprintActive || !footprintData) {
        map.getSource("fp-fog").setData(empty);
        map.getSource("fp-cells").setData(empty);
        map.getSource("fp-trails").setData(empty);
        return;
      }
      const isLight = document.body.classList.contains("theme-light");
      map.setPaintProperty("fp-fog-fill", "fill-color", isLight ? "#0f172a" : "#05070e");
      map.setPaintProperty("fp-fog-fill", "fill-opacity", isLight ? 0.3 : 0.44);
      map.getSource("fp-fog").setData(
        footprintFog
          ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [WORLD_RING] } }] }
          : empty
      );
      const [dlon, dlat] = footprintData.cell_size || [0.02, 0.018];
      const cellFeats = (footprintData.cells || []).map(([gx, gy, visits]) => ({
        type: "Feature",
        properties: { visits: visits || 1 },
        geometry: { type: "Point", coordinates: [(gx + 0.5) * dlon, (gy + 0.5) * dlat] },
      }));
      map.getSource("fp-cells").setData({ type: "FeatureCollection", features: cellFeats });
      const trailFeats = (footprintData.trails || []).map((coords) => ({
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: coords },
      }));
      map.getSource("fp-trails").setData({ type: "FeatureCollection", features: trailFeats });
    };

    window.__redrawTrips = () => setTimeout(() => { redrawTrips(); redrawFootprint(); }, 0);

    const periodLabel = (p) => {
      if (!p || p === "all") return "全部时间";
      if (/^\d{4}$/.test(p)) return `${p}年`;
      const m = p.match(/^(\d{4})-(\d{2})$/);
      return m ? `${m[1]}年${Number(m[2])}月` : p;
    };

    const renderPeriodBars = () => {
      const years = availablePeriods.years || [];
      const months = availablePeriods.months || [];
      if (!years.length && !months.length) {
        tripsPeriodBarEl.classList.add("hidden");
        fpPeriodBarEl.classList.add("hidden");
        return;
      }
      const btn = (val, text) =>
        `<button class="period-pill${currentPeriod === val ? " active" : ""}" type="button" data-period="${esc(val)}" role="tab" aria-selected="${currentPeriod === val}">${esc(text)}</button>`;
      const parts = [btn("all", "全部")];
      if (years.length) {
        parts.push(`<span class="period-sep" aria-hidden="true"></span>`);
        years.forEach((y) => parts.push(btn(y, `${y}年`)));
      }
      if (months.length) {
        parts.push(`<span class="period-sep" aria-hidden="true"></span>`);
        months.forEach((ym) => {
          const [y, mo] = ym.split("-");
          const shortLbl = years.length <= 1 ? `${Number(mo)}月` : `${y.slice(2)}年${Number(mo)}月`;
          parts.push(btn(ym, shortLbl));
        });
      }
      const html = parts.join("");
      tripsPeriodBarEl.innerHTML = html;
      tripsPeriodBarEl.classList.remove("hidden");
      fpPeriodBarEl.innerHTML = html;
      fpPeriodBarEl.classList.remove("hidden");
    };

    const fitTrip = (t) => {
      if (!map || !t.path || t.path.length < 2) return;
      const b = new maplibregl.LngLatBounds(t.path[0], t.path[0]);
      t.path.forEach((p) => b.extend(p));
      const mobile = window.innerWidth <= 760;
      map.fitBounds(b, {
        padding: mobile ? { top: 130, bottom: 150, left: 40, right: 40 } : { top: 110, bottom: 120, left: 400, right: 80 },
        maxZoom: 14,
        duration: 800,
      });
    };

    const renderTripsStats = () => {
      if (!tripsStats) {
        tripsStatsEl.classList.add("hidden");
        tripsStatsEl.innerHTML = "";
        return;
      }
      const s = tripsStats;
      const hours = Math.round((s.total_duration_min || 0) / 60);
      const sinceText = currentPeriod === "all"
        ? (s.since ? `自 ${fmtDateOnly(s.since)} 接入以来` : "自接入以来累计")
        : `${periodLabel(currentPeriod)} 统计`;
      const maxText = s.max_drive_km > 0 ? `最长单次 ${s.max_drive_km} km` : "";
      tripsStatsEl.innerHTML = `
        <div class="trips-stats-grid">
          <div class="trips-stat-cell">
            <span class="trips-stat-label">${currentPeriod === "all" ? "累计行驶" : "期间行驶"}</span>
            <span class="trips-stat-val">${fmtNum(s.total_distance_km)} km</span>
            <span class="trips-stat-sub">共 ${fmtNum(s.drive_count)} 段</span>
          </div>
          <div class="trips-stat-cell">
            <span class="trips-stat-label">${currentPeriod === "all" ? "累计充电" : "期间充电"}</span>
            <span class="trips-stat-val">${fmtNum(s.total_charge_kwh)} kWh</span>
            <span class="trips-stat-sub">共 ${fmtNum(s.charge_count)} 次</span>
          </div>
          <div class="trips-stat-cell">
            <span class="trips-stat-label">${currentPeriod === "all" ? "累计驾驶" : "期间驾驶"}</span>
            <span class="trips-stat-val">${fmtNum(hours)} 小时</span>
            <span class="trips-stat-sub">${maxText || `约 ${fmtNum(s.total_drive_kwh)} kWh`}</span>
          </div>
        </div>
        <div class="trips-stats-since">
          <span>${esc(sinceText)}</span>
          ${s.total_drive_kwh > 0 ? `<span>行驶约耗 ${fmtNum(s.total_drive_kwh)} kWh</span>` : ""}
        </div>`;
      tripsStatsEl.classList.remove("hidden");
    };

    const renderTripsList = () => {
      renderPeriodBars();
      renderTripsStats();
      if (!trips.length) {
        tripsSummaryEl.textContent = "";
        const emptyMsg = currentPeriod === "all" ? "还没有行程记录" : `${periodLabel(currentPeriod)} 还没有行程记录`;
        tripsListEl.innerHTML = `<div class="trips-empty">${esc(emptyMsg)}</div>`;
        return;
      }
      const km = trips.reduce((a, t) => a + (t.distance_km || 0), 0);
      const kwh = trips.reduce((a, t) => a + (t.kwh > 0 ? t.kwh : 0), 0);
      const countText = tripsTotal != null
        ? `已加载 <b>${trips.length}</b> / <b>${tripsTotal}</b> 段`
        : `最近 <b>${trips.length}</b> 段`;
      const legacyHint = tripsStatsLegacy ? ` · 升级 NAS 的 bridge.py 可看全部历史与总充电量` : "";
      tripsSummaryEl.innerHTML = `${countText} · 共 <b>${fmtNum(km)}</b> km${kwh > 0 ? ` · 约 <b>${fmtNum(kwh)}</b> kWh` : ""}${legacyHint}`;
      const rowsHtml = trips.map((t) => `
        <div class="trip-item${t.id === selectedTripId ? " active" : ""}" data-id="${t.id}">
          <button class="trip-open" type="button" data-id="${t.id}">
            ${sparkPath(t.path)}
            <span class="trip-text">
              <span class="trip-title">${esc(tripTitle(t))}</span>
              <span class="trip-meta">${esc(tripMeta(t))}</span>
            </span>
          </button>
          <button class="trip-del" type="button" data-id="${t.id}" title="删除这段行程" aria-label="删除这段行程">
            <svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>`).join("");
      let footHtml = "";
      if (tripsHasMore) {
        const label = tripsLoadingMore
          ? "正在加载更多行程…"
          : `加载更多（已显示 ${trips.length}${tripsTotal != null ? ` / ${tripsTotal}` : ""} 段）`;
        footHtml = `<div class="trips-more-wrap"><button class="trips-more-btn" type="button" ${tripsLoadingMore ? "disabled" : ""}>${label}</button></div>`;
      } else if (tripsTotal != null && tripsTotal > 0) {
        footHtml = `<div class="trips-end-note">已显示${currentPeriod === "all" ? "全部" : periodLabel(currentPeriod)} ${tripsTotal} 段行程</div>`;
      }
      tripsListEl.innerHTML = rowsHtml + footHtml;
    };

    const loadStats = async () => {
      try {
        tripsStats = await nasFetch(`/stats?period=${encodeURIComponent(currentPeriod)}`);
        if (tripsStats?.periods) availablePeriods = tripsStats.periods;
        tripsStatsLegacy = false;
      } catch (err) {
        tripsStats = null;
        if (String(err.message || "").includes("404")) tripsStatsLegacy = true;
      }
    };

    const loadTrips = async () => {
      tripsSummaryEl.textContent = "";
      tripsStatsEl.classList.add("hidden");
      tripsListEl.innerHTML = `<div class="trips-empty">正在从 NAS 读取行程…</div>`;
      tripsTotal = null;
      tripsHasMore = false;
      tripsLoadingMore = false;
      try {
        const [d] = await Promise.all([
          nasFetch(`/drives?limit=${TRIPS_PAGE_SIZE}&offset=0&period=${encodeURIComponent(currentPeriod)}`),
          loadStats(),
        ]);
        trips = Array.isArray(d.drives) ? d.drives : [];
        tripsTotal = typeof d.total === "number" ? d.total : null;
        tripsHasMore = typeof d.has_more === "boolean" ? d.has_more : false;
        renderTripsList();
        redrawTrips();
      } catch (err) {
        tripsListEl.innerHTML = `<div class="trips-empty error">读取失败：${esc(err.message)}</div>`;
      }
    };

    const loadMoreTrips = async () => {
      if (tripsLoadingMore || !tripsHasMore) return;
      tripsLoadingMore = true;
      renderTripsList();
      try {
        const d = await nasFetch(`/drives?limit=${TRIPS_PAGE_SIZE}&offset=${trips.length}&period=${encodeURIComponent(currentPeriod)}`);
        const incoming = Array.isArray(d.drives) ? d.drives : [];
        const seen = new Set(trips.map((x) => x.id));
        for (const item of incoming) {
          if (!seen.has(item.id)) trips.push(item);
        }
        if (typeof d.total === "number") tripsTotal = d.total;
        tripsHasMore = typeof d.has_more === "boolean" ? d.has_more : false;
        tripsLoadingMore = false;
        renderTripsList();
        redrawTrips();
      } catch (err) {
        tripsLoadingMore = false;
        renderTripsList();
        showToast(`加载更多失败：${err.message}`, 4000);
      }
    };

    const renderFootprintBar = () => {
      renderPeriodBars();
      fpFogBtn.setAttribute("aria-pressed", String(footprintFog));
      if (!footprintData) {
        fpTitleEl.textContent = `我的足迹 · ${periodLabel(currentPeriod)}`;
        fpMetaEl.textContent = "正在从 NAS 计算已解锁区域…";
        fpPlacesEl.classList.add("hidden");
        return;
      }
      const d = footprintData;
      fpTitleEl.textContent = `我的足迹 · 已探索约 ${fmtNum(d.area_km2)} km²`;
      const parts = [
        periodLabel(currentPeriod),
        `${fmtNum(d.drive_count)} 段行程`,
        `共 ${fmtNum(d.total_distance_km)} km`,
      ];
      fpMetaEl.textContent = parts.join(" · ");
      const tags = [];
      (d.prefectures || []).forEach((p) => tags.push(p));
      (d.cities || []).forEach((c) => { if (!tags.includes(c)) tags.push(c); });
      if (tags.length) {
        fpPlacesEl.innerHTML = tags.slice(0, 20).map((t) => `<span class="fp-place-tag">${esc(t)}</span>`).join("");
        fpPlacesEl.classList.remove("hidden");
      } else {
        fpPlacesEl.classList.add("hidden");
      }
    };

    const loadFootprint = async ({ fit = true } = {}) => {
      footprintData = null;
      renderFootprintBar();
      try {
        const d = await nasFetch(`/footprint?period=${encodeURIComponent(currentPeriod)}`);
        footprintData = d;
        if (d.periods) availablePeriods = d.periods;
        renderFootprintBar();
        redrawFootprint();
        if (fit && map && Array.isArray(d.bounds) && d.bounds.length === 4) {
          const mobile = window.innerWidth <= 760;
          map.fitBounds([[d.bounds[0], d.bounds[1]], [d.bounds[2], d.bounds[3]]], {
            padding: mobile ? { top: 96, bottom: 200, left: 28, right: 28 } : { top: 96, bottom: 180, left: 80, right: 80 },
            maxZoom: 12.5,
            duration: 850,
          });
        }
      } catch (err) {
        const msg = String(err.message || "").includes("404")
          ? "NAS 上的 bridge.py 还是旧版，请更新后再看足迹"
          : `读取足迹失败：${err.message}`;
        fpMetaEl.textContent = msg;
        showToast(msg, 4000);
      }
    };

    const openFootprint = () => {
      if (!getNas().url) {
        nasModal.classList.remove("hidden");
        return;
      }
      footprintActive = true;
      selectedTripId = null;
      tripsModal.classList.add("hidden");
      tripBar.classList.add("hidden");
      redrawTrips();
      document.getElementById("status-card").classList.add("hidden");
      document.getElementById("car-pill-bar")?.classList.add("hidden");
      const drawerEl = document.getElementById("drawer");
      drawerEl.classList.add("collapsed");
      document.getElementById("btn-toggle-drawer").setAttribute("aria-expanded", "false");
      if (map.getLayer("reach-overlay-layer")) map.setLayoutProperty("reach-overlay-layer", "visibility", "none");
      footprintBar.classList.remove("hidden");
      loadFootprint({ fit: true });
    };

    const closeFootprint = () => {
      footprintActive = false;
      footprintData = null;
      footprintBar.classList.add("hidden");
      redrawFootprint();
      updateReachability();
      if (cardMinimized) document.getElementById("car-pill-bar")?.classList.remove("hidden");
      else document.getElementById("status-card").classList.remove("hidden");
    };

    const selectPeriod = (nextPeriod) => {
      if (!nextPeriod || nextPeriod === currentPeriod) return;
      currentPeriod = nextPeriod;
      renderPeriodBars();
      if (footprintActive) loadFootprint({ fit: true });
      if (!tripsModal.classList.contains("hidden")) loadTrips();
    };

    const openTrips = () => {
      if (!getNas().url) {
        nasModal.classList.remove("hidden");
        return;
      }
      tripsModal.classList.remove("hidden");
      loadTrips();
    };

    const selectTrip = (id, { fit = true } = {}) => {
      const t = trips.find((x) => x.id === id);
      if (!t) return;
      if (footprintActive) {
        footprintActive = false;
        footprintData = null;
        footprintBar.classList.add("hidden");
        redrawFootprint();
      }
      selectedTripId = id;
      tripsModal.classList.add("hidden");
      // 看行程时把其他卡片收起来，地图留给轨迹
      document.getElementById("status-card").classList.add("hidden");
      document.getElementById("car-pill-bar")?.classList.add("hidden");
      const drawerEl = document.getElementById("drawer");
      drawerEl.classList.add("collapsed");
      document.getElementById("btn-toggle-drawer").setAttribute("aria-expanded", "false");
      if (map.getLayer("reach-overlay-layer")) map.setLayoutProperty("reach-overlay-layer", "visibility", "none");
      document.getElementById("trip-bar-title").textContent = tripTitle(t);
      document.getElementById("trip-bar-meta").textContent = tripMeta(t);
      tripBar.classList.remove("hidden");
      redrawTrips();
      if (fit) fitTrip(t);
      // 列表里的轨迹是简化过的；点开后再取这段的完整轨迹，弯道更贴合道路
      if (!t.fullPath) {
        nasFetch(`/drives/${id}`)
          .then((d) => {
            if (!d || !Array.isArray(d.path) || d.path.length < 2) return;
            t.path = d.path;
            t.fullPath = true;
            if (selectedTripId === id) redrawTrips();
          })
          .catch(() => {});
      }
    };

    const closeTripView = () => {
      selectedTripId = null;
      tripBar.classList.add("hidden");
      redrawTrips();
      updateReachability();
      if (cardMinimized) document.getElementById("car-pill-bar")?.classList.remove("hidden");
      else document.getElementById("status-card").classList.remove("hidden");
    };

    const deleteTrip = async (id) => {
      const t = trips.find((x) => x.id === id);
      if (!t) return;
      const ok = window.confirm(`永久删除这段行程？\n\n${tripTitle(t)}\n${tripMeta(t)}\n\n会从 NAS 的 TeslaMate 里一起删掉轨迹，删了就找不回来。`);
      if (!ok) return;
      try {
        await nasFetch(`/drives/${id}`, { method: "DELETE" });
        trips = trips.filter((x) => x.id !== id);
        if (tripsTotal != null && tripsTotal > 0) tripsTotal -= 1;
        if (selectedTripId === id) closeTripView();
        await loadStats();
        renderTripsList();
        redrawTrips();
        showToast("已删除这段行程");
      } catch (err) {
        showToast(`删除失败：${err.message}`, 4000);
      }
    };

    tripsListEl.addEventListener("click", (e) => {
      if (e.target.closest(".trips-more-btn")) { loadMoreTrips(); return; }
      const del = e.target.closest(".trip-del");
      if (del) { deleteTrip(Number(del.dataset.id)); return; }
      const open = e.target.closest(".trip-open");
      if (open) selectTrip(Number(open.dataset.id));
    });
    tripsPeriodBarEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".period-pill");
      if (btn) selectPeriod(btn.dataset.period);
    });
    fpPeriodBarEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".period-pill");
      if (btn) selectPeriod(btn.dataset.period);
    });
    document.getElementById("btn-open-footprint").addEventListener("click", openFootprint);
    fpFogBtn.addEventListener("click", () => {
      footprintFog = !footprintFog;
      fpFogBtn.setAttribute("aria-pressed", String(footprintFog));
      redrawFootprint();
    });
    document.getElementById("btn-fp-list").addEventListener("click", () => {
      tripsModal.classList.remove("hidden");
      loadTrips();
    });
    document.getElementById("btn-fp-close").addEventListener("click", closeFootprint);
    document.getElementById("btn-car-trips").addEventListener("click", openTrips);
    document.getElementById("btn-car-pill-trips").addEventListener("click", openTrips);
    document.getElementById("btn-trips-reload").addEventListener("click", loadTrips);
    document.getElementById("btn-close-trips").addEventListener("click", () => tripsModal.classList.add("hidden"));
    tripsModal.addEventListener("click", (e) => { if (e.target === tripsModal) tripsModal.classList.add("hidden"); });
    document.getElementById("btn-trip-list").addEventListener("click", () => { tripsModal.classList.remove("hidden"); renderTripsList(); });
    document.getElementById("btn-trip-delete").addEventListener("click", () => { if (selectedTripId != null) deleteTrip(selectedTripId); });
    document.getElementById("btn-trip-close").addEventListener("click", closeTripView);

    document.getElementById("btn-close-nas").addEventListener("click", () => nasModal.classList.add("hidden"));
    nasModal.addEventListener("click", (e) => {
      if (e.target === nasModal) nasModal.classList.add("hidden");
    });

    document.getElementById("btn-nas-sync").addEventListener("click", async () => {
      const url = nasUrlEl.value.trim();
      const token = nasTokEl.value.trim();
      if (!url) {
        nasMsgEl.textContent = "请先填写你的 NAS 接口地址（例如 https://tesla.你的域名/status）。";
        nasMsgEl.classList.remove("hidden");
        return;
      }
      saveNasCache(url, token);
      try {
        await syncFromNas(url, token, { silent: false, pan: true });
      } catch (err) {
        nasMsgEl.textContent = `同步失败：${err.message}（请检查 NAS 服务和隧道是否正常）`;
      }
    });

    // 账号登录（小家控的 Supabase 账号）：登录后自动取回 / 保存 NAS 接口设置
    (() => {
      const SB_URL = "https://xwzovuseugyneqsmlnry.supabase.co";
      const SB_KEY = "sb_publishable_WbDctE2IA8QZXq5av9-VQg_ZfuVM4bM"; // 公开钥匙，数据靠表的行级权限保护
      const TABLE = "dokomademap_nas_bindings";
      const outEl = document.getElementById("acct-logged-out");
      const inEl = document.getElementById("acct-logged-in");
      const msgEl = document.getElementById("acct-msg");
      const emailEl = document.getElementById("acct-email");
      const pwEl = document.getElementById("acct-password");
      const showMsg = (t) => { msgEl.textContent = t; msgEl.classList.toggle("hidden", !t); };
      if (!window.supabase || !window.supabase.createClient) {
        showMsg("登录功能暂时加载不了，可以先手动填写下面的 NAS 设置。");
        return;
      }
      const sb = window.supabase.createClient(SB_URL, SB_KEY, {
        auth: { storageKey: "dokomademap_sb_auth", persistSession: true, autoRefreshToken: true },
      });
      let user = null;

      const settingsEl = document.getElementById("nas-settings");
      const render = () => {
        outEl.classList.toggle("hidden", !!user);
        inEl.classList.toggle("hidden", !user);
        // 没登录只显示登录框；登录后才显示 NAS 设置（已绑定时默认收起）
        settingsEl.classList.toggle("hidden", !user);
        if (user) {
          const bound = !!nasUrlEl.value.trim();
          settingsEl.open = !bound;
          document.getElementById("nas-settings-summary").textContent = bound ? "已绑定特斯拉 · 修改" : "绑定我的特斯拉";
          document.getElementById("acct-hint").textContent = bound
            ? "✓ 已绑定特斯拉，以后在任何设备登录都会自动同步"
            : "还没绑定特斯拉，在下面填一次 NAS 地址和密钥就好";
        }
        if (user) document.getElementById("acct-email-label").textContent = user.email || "";
      };

      // 从账号取回 NAS 设置（自己或同一个家里的成员存的，取最新那条）；
      // 本机还没有或和账号不一样时，顺便同步一次车辆
      const pullBinding = async ({ autoSync = true } = {}) => {
        const { data: rows, error } = await sb.from(TABLE).select("nas_url, nas_token")
          .neq("nas_url", "").order("updated_at", { ascending: false }).limit(1);
        if (error) throw error;
        const data = rows && rows[0];
        if (!data || !data.nas_url) return false;
        const prev = (() => { try { return JSON.parse(localStorage.getItem("dokomademap_nas_v1") || "{}"); } catch (_) { return {}; } })();
        const changed = prev.url !== data.nas_url || prev.token !== data.nas_token;
        nasUrlEl.value = data.nas_url;
        nasTokEl.value = data.nas_token;
        saveNasCache(data.nas_url, data.nas_token);
        render();
        if (autoSync && changed) {
          syncFromNas(data.nas_url, data.nas_token, { silent: true, pan: true }).catch(() => {});
        }
        return true;
      };

      const pushBinding = async (url, token) => {
        if (!user || !url) return false;
        const { error } = await sb.from(TABLE).upsert({
          user_id: user.id, nas_url: url, nas_token: token || "", updated_at: new Date().toISOString(),
        });
        if (error) { showMsg(`没能保存绑定：${error.message}`); return false; }
        return true;
      };

      document.getElementById("btn-acct-login").addEventListener("click", async () => {
        const email = emailEl.value.trim();
        const password = pwEl.value;
        if (!email || !password) { showMsg("请填写邮箱和密码。"); return; }
        showMsg("正在登录…");
        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        if (error) { showMsg("登录失败：邮箱或密码不对。"); return; }
        user = data.user;
        pwEl.value = "";
        render();
        try {
          const found = await pullBinding();
          if (found) {
            showMsg("登录成功，已自动连接特斯拉。");
          } else if (nasUrlEl.value.trim()) {
            await pushBinding(nasUrlEl.value.trim(), nasTokEl.value.trim());
            showMsg("登录成功，已把本机的 NAS 设置存到账号。");
          } else {
            showMsg("登录成功。第一次使用，请在下面填好 NAS 设置并同步一次，以后登录就自动连接。");
          }
        } catch (err) {
          showMsg(`登录成功，但读取绑定信息失败，请稍后再试（${err.message}）`);
        }
      });

      document.getElementById("btn-acct-logout").addEventListener("click", async () => {
        await sb.auth.signOut().catch(() => {});
        user = null;
        // 退出后把本机记住的 NAS 设置也清掉，别人用这台设备看不到你的车
        nasUrlEl.value = "";
        nasTokEl.value = "";
        try { localStorage.removeItem("dokomademap_nas_v1"); } catch (_) {}
        render();
        showMsg("已退出。");
      });

      // 手动同步成功填写后，登录状态下顺便存到账号
      document.getElementById("btn-nas-sync").addEventListener("click", () => {
        const url = nasUrlEl.value.trim();
        if (url) pushBinding(url, nasTokEl.value.trim()).then((ok) => { if (ok) { render(); showMsg("已绑定，以后登录就会自动同步。"); } });
      });

      // 打开网页时：已登录就自动取回 NAS 设置
      sb.auth.getSession().then(({ data }) => {
        user = data && data.session ? data.session.user : null;
        render();
        if (user) pullBinding().catch(() => {});
      });
    })();

    document.getElementById("btn-car-gps-test").addEventListener("click", () => {
      nasMsgEl.textContent = "正在获取当前定位…";
      nasMsgEl.classList.remove("hidden");
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (pos) => activateCarPurple(pos.coords.latitude, pos.coords.longitude, state.departPct, "GPS"),
          () => {
            const c = map ? map.getCenter() : { lat: 35.6812, lng: 139.7671 };
            activateCarPurple(c.lat, c.lng, state.departPct, "地图中心");
          },
          { timeout: 5000 }
        );
      } else {
        const c = map ? map.getCenter() : { lat: 35.6812, lng: 139.7671 };
        activateCarPurple(c.lat, c.lng, state.departPct, "地图中心");
      }
    });

    document.getElementById("btn-car-clear").addEventListener("click", () => {
      carState.active = false;
      btnMyCar.setAttribute("aria-pressed", "false");
      nasModal.classList.add("hidden");
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
    // 屏幕上方的小提示条
    let toastTimer = null;
    const showToast = (msg, ms = 2600) => {
      let el = document.getElementById("toast");
      if (!el) {
        el = document.createElement("div");
        el.id = "toast";
        el.className = "toast";
        el.setAttribute("role", "status");
        document.body.appendChild(el);
      }
      el.textContent = msg;
      el.classList.add("show");
      clearTimeout(toastTimer);
      if (ms > 0) toastTimer = setTimeout(() => el.classList.remove("show"), ms);
    };

    let meMarker = null;
    const btnLocate = document.getElementById("btn-locate");
    btnLocate.addEventListener("click", () => {
      if (!navigator.geolocation) {
        showToast("这个浏览器不支持定位");
        return;
      }
      if (!window.isSecureContext) {
        showToast("需要用 https 打开页面才能定位");
        return;
      }
      if (btnLocate.classList.contains("busy")) return;
      btnLocate.classList.add("busy");
      showToast("正在获取你的位置…", 0);
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          btnLocate.classList.remove("busy");
          const { latitude, longitude } = pos.coords;
          userTookOver = true;
          // 定位以我的位置为准：退出「我的车」显示（车辆数据保留，点「我的车」可再打开）
          if (carState.active) {
            carState.active = false;
            cardMinimized = false;
            document.getElementById("btn-my-car").setAttribute("aria-pressed", "false");
            document.getElementById("car-pill-bar")?.classList.add("hidden");
            document.getElementById("status-card").classList.remove("hidden");
          }
          // 地图上标出我的位置
          if (map) {
            if (!meMarker) {
              const dot = document.createElement("div");
              dot.className = "me-dot";
              meMarker = new maplibregl.Marker({ element: dot });
            }
            meMarker.setLngLat([longitude, latitude]).addTo(map);
            map.easeTo({ center: [longitude, latitude], zoom: Math.max(map.getZoom(), 8.5), duration: 700 });
          }
          if (dataReadyPromise) await dataReadyPromise;
          if (!superchargers.length) {
            showToast("已定位，超充数据还在加载");
            return;
          }
          let bestIdx = 0;
          let bestD = Infinity;
          for (let i = 0; i < superchargers.length; i++) {
            const d = haversineKm(latitude, longitude, superchargers[i].lat, superchargers[i].lon);
            if (d < bestD) { bestD = d; bestIdx = i; }
          }
          if (bestD > 600) {
            showToast("你现在不在日本，已标出位置");
            return;
          }
          showToast(`最近的超充站约 ${Math.round(bestD)} km`);
          selectedScIdx = bestIdx;
          updateReachability({ animate: true, pan: false });
        },
        (err) => {
          btnLocate.classList.remove("busy");
          if (err.code === 1) {
            showToast("没有定位权限：请在手机「设置 → 隐私 → 定位服务」里允许这个浏览器使用定位", 6000);
          } else if (err.code === 3) {
            showToast("定位超时，请到室外或稍后再试", 4000);
          } else {
            showToast("暂时拿不到位置，请稍后再试", 4000);
          }
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
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
    const closeDrawer = () => {
      drawer.classList.add("collapsed");
      btnDrawer.setAttribute("aria-expanded", "false");
    };
    document.getElementById("btn-drawer-done").addEventListener("click", closeDrawer);
    // 点左上角闪电图标/标题：回到主界面（关掉面板和弹窗，切回超充地图，镜头回到全日本）
    const brandEl = document.querySelector(".brand");
    brandEl.setAttribute("role", "button");
    brandEl.setAttribute("tabindex", "0");
    brandEl.setAttribute("title", "回到主界面");
    const goHome = () => {
      closeDrawer();
      document.querySelectorAll(".modal-backdrop:not(.hidden)").forEach((m) => m.classList.add("hidden"));
      const tabMap = document.getElementById("tab-map");
      if (!tabMap.classList.contains("active")) tabMap.click();
      document.getElementById("camp-view")?.classList.add("hidden");
      document.getElementById("status-card")?.classList.remove("peek");
      if (map) map.flyTo({ center: [137.8, 36.2], zoom: window.innerWidth <= 760 ? 4.6 : 5.2, duration: 900 });
    };
    brandEl.addEventListener("click", goHome);
    brandEl.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goHome(); } });
    // 手机上点地图空白处自动收起参数面板，避免挡住地图
    document.getElementById("map").addEventListener("pointerdown", () => {
      if (window.innerWidth <= 760 && !drawer.classList.contains("collapsed")) closeDrawer();
    });
    // Esc 关闭弹窗和参数面板
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const open = [...document.querySelectorAll(".modal-backdrop:not(.hidden)")];
      if (open.length) { open.forEach((m) => m.classList.add("hidden")); return; }
      if (!drawer.classList.contains("collapsed")) closeDrawer();
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
      const [scData, nacsData] = await Promise.all([
        fetch("data/superchargers.json").then((r) => r.json()),
        fetch("data/nacs_chargers.json").then((r) => r.json()).catch(() => []),
      ]);
      superchargers = scData.map((x) => ({
        ...x,
        name: x.name.replace(/,\s*Japan\s*-?\s*/, " · ").replace(/\s·\s$/, ""),
      }));
      nacsChargers = nacsData;

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
        const qp = new URLSearchParams(window.location.search);
        const qSoc = Number(qp.get("soc"));
        const qLat = Number(qp.get("lat"));
        const qLon = Number(qp.get("lon"));
        if (qSoc > 0 && qSoc <= 100) {
          state.departPct = Math.round(qSoc);
          if (qLat && qLon) {
            const snap = findNearestNode(qLat, qLon, Infinity);
            if (snap.node >= 0) {
              carState = { active: true, lat: qLat, lon: qLon, node: snap.node, soc: state.departPct, updatedAt: "URL" };
              document.getElementById("btn-my-car").setAttribute("aria-pressed", "true");
            }
          }
        }
        if (selectedScIdx >= 0 || carState.active) {
          updateReachability({ animate: true, pan: carState.active });
        }
        // Always auto-sync saved NAS car connection on subsequent visits
        if (!carState.active) {
          try {
            const savedNas = JSON.parse(localStorage.getItem("dokomademap_nas_v1") || "{}");
            if (savedNas.lastCar && typeof savedNas.lastCar.lat === "number") {
              const lc = savedNas.lastCar;
              const snap = findNearestNode(lc.lat, lc.lon, Infinity);
              if (snap.node >= 0) {
                if (lc.full_range_km) state.fullRangeKm = Math.max(450, Math.min(680, Math.round(lc.full_range_km / 10) * 10));
                if (lc.wh_per_km) state.whPerKm = Math.max(120, Math.min(240, Math.round(lc.wh_per_km / 5) * 5));
                state.departPct = lc.soc;
                selectedScIdx = -1;
                selectedNacsIdx = -1;
                carState = { active: true, lat: lc.lat, lon: lc.lon, node: snap.node, soc: lc.soc, updatedAt: lc.updatedAt || "NAS" };
                document.getElementById("btn-my-car").setAttribute("aria-pressed", "true");
                updateReachability({ animate: true, pan: true });
              }
            }
            if (savedNas.url && savedNas.url.startsWith("http")) {
              const headers = savedNas.token ? { Authorization: `Bearer ${savedNas.token}` } : {};
              fetch(savedNas.url, { headers })
                .then((r) => (r.ok ? r.json() : null))
                .then((d) => {
                  if (d && typeof d.soc === "number" && typeof d.lat === "number" && typeof d.lon === "number") {
                    const snap = findNearestNode(d.lat, d.lon, Infinity);
                    if (snap.node >= 0) {
                      if (d.full_range_km) state.fullRangeKm = Math.max(450, Math.min(680, Math.round(d.full_range_km / 10) * 10));
                      if (d.wh_per_km) state.whPerKm = Math.max(120, Math.min(240, Math.round(d.wh_per_km / 5) * 5));
                      state.departPct = Math.max(5, Math.min(100, Math.round(d.soc)));
                      const updatedAt = d.updated_at || "NAS";
                      if (userTookOver) {
                        // 用户已经在看自己的位置：只悄悄更新车辆数据，不切换画面
                        carState = { active: false, lat: d.lat, lon: d.lon, node: snap.node, soc: state.departPct, updatedAt };
                        try {
                          savedNas.lastCar = { lat: d.lat, lon: d.lon, soc: state.departPct, full_range_km: d.full_range_km, wh_per_km: d.wh_per_km, updatedAt };
                          localStorage.setItem("dokomademap_nas_v1", JSON.stringify(savedNas));
                        } catch (_) {}
                        return;
                      }
                      selectedScIdx = -1;
                      selectedNacsIdx = -1;
                      carState = { active: true, lat: d.lat, lon: d.lon, node: snap.node, soc: state.departPct, updatedAt };
                      try {
                        savedNas.lastCar = { lat: d.lat, lon: d.lon, soc: state.departPct, full_range_km: d.full_range_km, wh_per_km: d.wh_per_km, updatedAt };
                        localStorage.setItem("dokomademap_nas_v1", JSON.stringify(savedNas));
                      } catch (_) {}
                      document.getElementById("btn-my-car").setAttribute("aria-pressed", "true");
                      updateReachability({ animate: true, pan: true });
                    }
                  }
                })
                .catch(() => {});
            }
          } catch (_) {}
        }
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

      map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "bottom-right");
      map.addControl(
        new maplibregl.AttributionControl({
          compact: true,
          customAttribution: "高程数据: 国土地理院 | 路网: OpenStreetMap | 超充: supercharge.info | 底图: OpenFreeMap",
        }),
        "bottom-right"
      );

      map.on("style.load", () => {
        setupMapLayers();
        // 换配色会重载底图，行程线要重新画上
        if (window.__redrawTrips) window.__redrawTrips();
      });

      map.on("load", () => {
        bindMapInteractions();
        loadingOverlay.classList.add("hidden");
        // 版权说明默认收起成 ⓘ，不占地图
        document.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
      });
    } catch (err) {
      console.error(err);
      loadingText.textContent = `加载失败：${err.message}`;
    }
  }

  init();
})();
