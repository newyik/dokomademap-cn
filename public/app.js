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
  let selectedScIdx = -1;
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
  let goUsed = null;
  let backUsed = null;
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
    goUsed = new Float64Array(nNodes);
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

  function runDijkstra(startNode, isReverse, params, outMinUsed) {
    const { nNodes, fwdHead, fwdTo, fwdDist, fwdTime, fwdClimb, fwdDescent, fwdFlags, revHead, revFrom, revEidx } = graph;
    const { budgetWh, minUsedAllowed, winterMult } = params;
    const whPerM = (state.whPerKm / 1000.0) * winterMult;
    const climbWh = CLIMB_WH_PER_M * winterMult;
    const useFerry = state.ferry;
    const useFerryCharge = state.ferry && state.ferryCharge;

    bestTime.fill(Infinity);
    minUsed.fill(Infinity);
    ferryHops.fill(255);
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
        if (nextHops > 2) continue;

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
          if (faster || muchCheaper) {
            // Track ferry hop count for this label so post-ferry wave propagates cleanly
            if (ferryHops[v] === 255 || muchCheaper || nextHops < ferryHops[v]) {
              ferryHops[v] = nextHops;
            }
          }
          heapPush(v, newTime, newUsed);
        }
      }
    }

    outMinUsed.set(minUsed);
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
      emptyEl.classList.remove("hidden");
      activeEl.classList.add("hidden");
      if (map.getLayer("reach-overlay-layer")) {
        map.setLayoutProperty("reach-overlay-layer", "visibility", "none");
      }
      const src = map.getSource("reach-overlay");
      if (src) src.pause();
      updateFerryLayer(null, Infinity);
      updateSuperchargerLayer(null, Infinity);
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
    runDijkstra(sc.node, false, params, goUsed);
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

  function setupMapLayers() {
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
        layout: { visibility: "none" },
        paint: {
          "raster-opacity": 0.9,
          "raster-resampling": "linear",
        },
      },
      beforeId
    );

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

    updateReachability();
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

    map.on("click", "sc-hit", (e) => {
      const f = e.features[0];
      selectedScIdx = f.properties.idx;
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
    [sWh, sFull, sDep, sArr].forEach((el) => {
      el.addEventListener("input", () => [sWh, sFull, sDep, sArr].forEach(paintFill));
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
      ferChgRow.classList.toggle("disabled", !state.ferry);
      [sWh, sFull, sDep, sArr].forEach(paintFill);
    }

    syncControlsFromState();

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

    try {
      const [gBuf, lBuf, scData, ferryData] = await Promise.all([
        fetch("data/graph.bin").then((r) => {
          if (!r.ok) throw new Error("无法加载 graph.bin");
          return r.arrayBuffer();
        }),
        fetch("data/landgrid.bin").then((r) => {
          if (!r.ok) throw new Error("无法加载 landgrid.bin");
          return r.arrayBuffer();
        }),
        fetch("data/superchargers.json").then((r) => r.json()),
        fetch("data/ferries.json").then((r) => r.json()),
      ]);

      loadingText.textContent = "正在初始化路网与地图引擎...";
      graph = parseGraph(gBuf);
      grid = parseLandGrid(lBuf);
      superchargers = scData.map((x) => ({ ...x, name: x.name.replace(/,\s*Japan\s*-?\s*/, " · ").replace(/\s·\s$/, "") }));
      ferries = ferryData;

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
      loadingText.textContent = `加载失败：${err.message}（请确认已先运行数据构建脚本并通过本地 HTTP 服务打开）`;
    }
  }

  init();
})();
