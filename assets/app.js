/* Visit Your City's Future Climate — climate-analogue geoportal */
(() => {
  "use strict";

  // ---------- i18n ----------
  const T = {
    en: {
      title: "Visit your city's future climate",
      lede: "Pick a city — the map shows where that climate already exists today.",
      searchLabel: "Find a city", searchPh: "Find a city…", scenario: "Scenario",
      modeFuture: "City's future", modeReverse: "Who becomes like it", method: "Method & data",
      climateIn: h => `Climate in ${h}`, likeToday: "will resemble today's",
      todayIn: "Today's climate of", becomes: h => `will be found in these cities by ${h}`,
      shift: "Shift", direction: "Direction", climDist: "Climate distance", change: "Change of the city's climate",
      km: "km", none: "—",
      novel: "Novel climate: the future conditions lie outside the range of all current cities in multivariate space. The closest analogue is only approximate.",
      stays: "The closest analogue is the city itself: its climate changes but stays closer to its own present than to any other city.",
      top5: "Five closest analogues today", rev: "Cities whose future climate resembles this city today",
      revEmpty: "No city gets this climate as its closest analogue. Below are the cities whose future climate comes closest to it.",
      exactTag: "closest analogue",
      space: "Climate space (PC1 × PC2)",
      spaceCap: "Grey dots: current climates. Ring: the city now; arrow: its shift to the future; orange: analogues. Similarity uses all principal components; two are shown.",
      vars: "Key indicators", today: "now", future: "future", analogToday: "analogue now",
      v: { bio1: "Annual mean temp, °C", bio5: "Max temp warmest month, °C", bio6: "Min temp coldest month, °C", bio7: "Annual temp range, °C", bio12: "Precipitation, mm/yr", bio14: "Precip. driest month, mm", bio15: "Precip. seasonality, %" },
      quality: ["very close", "close", "approximate"],
      ovIntro: "Climate analogues compare a city's future climate with the present climate of every other city across 19 bioclimatic variables at once.",
      fOther: "of cities will by mid-century have a climate closer to another city than to their own present",
      fNovel: "of cities will enter a novel climate that no major city has today",
      fShift: "median distance to the climate twin",
      fSouth: "average shift towards the equator for Northern Hemisphere cities",
      tryThese: "Try:",
      legendTitle: "How much the city's climate changes", legSmall: "little", legLarge: "a lot",
      legNovel: "novel climate (no analogue)", legArc: "path to the analogue", flows: "Show all shifts",
      dirs: ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"],
      pc1: "warmer →", pc2: "wetter ↑", loading: "Loading data…", loadErr: "Could not load data. Serve the site over HTTP (GitHub Pages or python -m http.server), not as a file.",
      basemapVec: "Country outlines", basemapTiles: "CARTO basemap", src: "Data",
    },
  };

  const RAMP = ["#3e7391", "#7fa9b8", "#d9c38a", "#d9823f", "#b8332c"];
  const ACCENT = "#d9772b", COOL = "#3e7391", INK = "#22313a", NOVEL = "#6b3d8f";
  const TRY = ["Moscow", "Almaty", "Astana", "London", "Madrid", "Stockholm", "New York", "Tokyo"];

  const S = { lang: "en", mode: "future", sel: null, cities: [], manifest: null, scen: null, cache: {}, d: null, flows: false };
  const $ = s => document.querySelector(s);
  const t = k => T[S.lang][k];
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- geo helpers ----------
  const R = 6371, rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
  function hav(a, b) {
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  // map-compass direction (as people read it on a map), not the initial great-circle bearing
  function bearing(a, b) {
    let dl = b.lon - a.lon; if (dl > 180) dl -= 360; if (dl < -180) dl += 360;
    const x = dl * Math.cos(rad((a.lat + b.lat) / 2)), y = b.lat - a.lat;
    return (deg(Math.atan2(x, y)) + 360) % 360;
  }
  function gcPath(a, b, n = 64) {
    const p1 = [rad(a.lat), rad(a.lon)], p2 = [rad(b.lat), rad(b.lon)];
    const v = p => [Math.cos(p[0]) * Math.cos(p[1]), Math.cos(p[0]) * Math.sin(p[1]), Math.sin(p[0])];
    const A = v(p1), B = v(p2);
    const w = Math.acos(Math.min(1, Math.max(-1, A[0] * B[0] + A[1] * B[1] + A[2] * B[2])));
    if (w < 1e-6) return [[a.lat, a.lon], [b.lat, b.lon]];
    const pts = []; let prev = null;
    for (let i = 0; i <= n; i++) {
      const f = i / n, s1 = Math.sin((1 - f) * w) / Math.sin(w), s2 = Math.sin(f * w) / Math.sin(w);
      const x = s1 * A[0] + s2 * B[0], y = s1 * A[1] + s2 * B[1], z = s1 * A[2] + s2 * B[2];
      let lat = deg(Math.atan2(z, Math.hypot(x, y))), lon = deg(Math.atan2(y, x));
      if (prev !== null) { while (lon - prev > 180) lon -= 360; while (lon - prev < -180) lon += 360; }
      prev = lon; pts.push([lat, lon]);
    }
    return pts;
  }
  const fmtKm = km => km >= 1000 ? Math.round(km).toLocaleString("en-US") + " km" : Math.round(km) + " km";
  const fmtNum = (x, d = 2) => x == null ? t("none") : x.toFixed(d);
  const pct = x => Math.round(x * 100) + "%";
  const quant = (arr, q) => { const a = arr.filter(x => x != null).sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(q * (a.length - 1)))]; };
  const cname = i => S.cities[i].name;
  const ccountry = i => S.cities[i].country;
  const horizon = () => (S.scen.horizon.match(/~?(\d{4})\)?$/) || [, S.scen.horizon])[1].replace(/^/, "≈");
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ---------- derived stats for a scenario ----------
  function derive(sc) {
    const n = S.cities.length, best = sc.top.map(x => x ? x[0] : null);
    const shiftKm = best.map((b, i) => b && b[0] !== i ? hav(S.cities[i], S.cities[b[0]]) : (b ? 0 : null));
    const reverse = Array.from({ length: n }, () => []);
    best.forEach((b, i) => { if (b && b[0] !== i) reverse[b[0]].push(i); });
    const top1 = best.map(b => b ? b[1] : null);
    const selfQ = [0.2, 0.4, 0.6, 0.8].map(q => quant(sc.self, q));
    const valid = best.map((b, i) => b ? i : -1).filter(i => i >= 0);
    const other = valid.filter(i => best[i][0] !== i);
    const nh = other.filter(i => S.cities[i].lat > 0);
    const southKm = nh.length ? nh.reduce((s, i) => s + (S.cities[i].lat - S.cities[best[i][0]].lat), 0) / nh.length * 111.2 : 0;
    return {
      best, shiftKm, reverse, selfQ, q50: quant(top1, 0.5), q80: quant(top1, 0.8),
      pOther: other.length / valid.length,
      pNovel: valid.filter(i => sc.novel[i]).length / valid.length,
      medShift: quant(other.map(i => shiftKm[i]), 0.5), southKm,
    };
  }
  const colorFor = i => {
    const v = S.scen.self[i]; if (v == null) return "#b9c3c0";
    const q = S.d.selfQ; let k = 0; while (k < q.length && v > q[k]) k++; return RAMP[k];
  };
  const qualityOf = d => d <= S.d.q50 ? 0 : d <= S.d.q80 ? 1 : 2;

  // ---------- map ----------
  const map = L.map("map", { worldCopyJump: true, minZoom: 2, maxZoom: 9, zoomControl: false, preferCanvas: true, attributionControl: true })
    .setView([30, 20], 2);
  L.control.zoom({ position: "topright" }).addTo(map);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>').addAttribution('Bastin et al. 2019 (CC BY) · WorldClim · <a href="https://www.naturalearthdata.com/">Natural Earth</a>');
  map.createPane("countries"); map.getPane("countries").style.zIndex = 250;
  map.createPane("arcs"); map.getPane("arcs").style.zIndex = 420;
  const svgArcs = L.svg({ pane: "arcs" });
  const canvas = L.canvas({ padding: 0.3 });
  const countryLayer = L.layerGroup().addTo(map);
  const tiles = L.tileLayer("https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png", {
    subdomains: "abcd", maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a> © <a href="https://carto.com/">CARTO</a>',
  });
  let layerCtl = null;
  const markers = L.layerGroup().addTo(map);
  const flowLayer = L.layerGroup();
  const selLayer = L.layerGroup().addTo(map);
  const markerByIdx = [];

  function drawCities() {
    markers.clearLayers(); markerByIdx.length = 0;
    S.cities.forEach((c, i) => {
      const nov = S.scen.novel[i];
      const m = L.circleMarker([c.lat, c.lon], {
        renderer: canvas, radius: 4.2, weight: nov ? 1.6 : 0.8, color: nov ? NOVEL : "#ffffff",
        dashArray: nov ? "2,2" : null, fillColor: colorFor(i), fillOpacity: 0.95,
      });
      m.bindTooltip(() => `<b>${esc(cname(i))}</b><br><small>${esc(ccountry(i))}</small>`, { className: "tip", direction: "top", offset: [0, -4] });
      m.on("click", () => select(i));
      m.addTo(markers); markerByIdx[i] = m;
    });
  }
  function drawFlows() {
    flowLayer.clearLayers();
    if (!S.flows) return;
    S.d.best.forEach((b, i) => {
      if (!b || b[0] === i) return;
      L.polyline(gcPath(S.cities[i], S.cities[b[0]], 32), { renderer: canvas, color: ACCENT, weight: 0.8, opacity: 0.35, interactive: false }).addTo(flowLayer);
    });
  }

  function arc(a, b, opts = {}) {
    const line = L.polyline(gcPath(a, b), { renderer: svgArcs, pane: "arcs", color: opts.color || ACCENT, weight: opts.weight || 3, opacity: opts.opacity ?? 0.95, lineCap: "round", interactive: false });
    const casing = L.polyline(line.getLatLngs(), { renderer: svgArcs, pane: "arcs", color: "#fff", weight: (opts.weight || 3) + 3, opacity: 0.8, interactive: false });
    casing.addTo(selLayer); line.addTo(selLayer);
    if (!reduced && line._path) {
      const p = line._path, len = p.getTotalLength();
      p.style.strokeDasharray = len; p.style.strokeDashoffset = len;
      p.getBoundingClientRect();
      p.style.transition = `stroke-dashoffset ${opts.dur || 900}ms cubic-bezier(.3,.6,.2,1)`;
      p.style.strokeDashoffset = 0;
      setTimeout(() => { p.style.strokeDasharray = ""; }, (opts.dur || 900) + 50);
    }
    return line;
  }
  const label = (i, cls) => L.tooltip({ permanent: true, direction: "right", offset: [8, 0], className: "city-label " + (cls || "") })
    .setLatLng([S.cities[i].lat, S.cities[i].lon]).setContent(esc(cname(i))).addTo(selLayer);
  const ring = (i, color, r = 8) => L.circleMarker([S.cities[i].lat, S.cities[i].lon], { renderer: svgArcs, pane: "arcs", radius: r, color, weight: 2.5, fill: false, interactive: false }).addTo(selLayer);

  function drawSelection() {
    selLayer.clearLayers();
    const i = S.sel; if (i == null) return;
    const bounds = [[S.cities[i].lat, S.cities[i].lon]];
    if (S.mode === "future") {
      const top = S.scen.top[i] || [];
      top.slice(1, 3).forEach(([j]) => { if (j !== i) { arc(S.cities[i], S.cities[j], { color: ACCENT, weight: 1.4, opacity: 0.45, dur: 700 }); } });
      if (top[0] && top[0][0] !== i) {
        const j = top[0][0];
        arc(S.cities[i], S.cities[j]); ring(j, ACCENT); label(j, "to");
        bounds.push([S.cities[j].lat, S.cities[j].lon]);
      }
      top.slice(1, 3).forEach(([j]) => bounds.push([S.cities[j].lat, S.cities[j].lon]));
      ring(i, INK); label(i);
    } else {
      const list = revList(i);
      const shown = list.filter(([j]) => j !== i).slice(0, 10);
      shown.forEach(([j, , ex], k) => { arc(S.cities[j], S.cities[i], { color: COOL, weight: ex ? 2.4 : 1.2, opacity: ex ? 0.95 : 0.5, dur: 700 + k * 60 }); if (k < 6) bounds.push([S.cities[j].lat, S.cities[j].lon]); });
      shown.slice(0, 3).forEach(([j]) => label(j));
      ring(i, ACCENT); label(i, "to");
    }
    const b = L.latLngBounds(bounds);
    if (bounds.length > 1) map.flyToBounds(b.pad(0.35), { maxZoom: 5, duration: reduced ? 0 : 0.8, paddingTopLeft: [20, 20] });
    else map.flyTo(bounds[0], Math.max(map.getZoom(), 3), { duration: reduced ? 0 : 0.8 });
  }
  function revList(i) {
    // distances from today's climate of city i to every city's future climate (full PC space)
    const a = S.scen.cur[i]; if (!a) return [];
    const out = [];
    S.scen.fut.forEach((f, j) => {
      if (!f) return;
      let d = 0; for (let k = 0; k < f.length; k++) d += (f[k] - a[k]) ** 2;
      out.push([j, Math.sqrt(d), S.d.best[j] && S.d.best[j][0] === i]);
    });
    return out.sort((x, y) => (y[2] - x[2]) || (x[1] - y[1])).slice(0, 15);
  }

  // ---------- panel ----------
  function overview() {
    const d = S.d, chips = TRY.map(n => S.cities.findIndex(c => c.name === n)).filter(i => i >= 0);
    $("#card").innerHTML = `<div class="overview">
      <p>${t("ovIntro")}</p>
      <div class="facts">
        <div class="fact"><b>${pct(d.pOther)}</b><span>${t("fOther")}</span></div>
        <div class="fact"><b>${pct(d.pNovel)}</b><span>${t("fNovel")}</span></div>
        <div class="fact"><b>${(Math.round(d.medShift / 100) * 100).toLocaleString("en-US")}</b><span>${t("km")} — ${t("fShift")}</span></div>
        <div class="fact"><b>${Math.round(d.southKm / 10) * 10}</b><span>${t("km")} — ${t("fSouth")}</span></div>
      </div>
      <p style="margin-bottom:8px">${t("tryThese")}</p>
      <div class="try">${chips.map(i => `<button class="chip" data-i="${i}">${esc(cname(i))}</button>`).join("")}</div>
    </div>`;
    $("#card").querySelectorAll(".chip").forEach(b => b.onclick = () => select(+b.dataset.i));
  }

  function card() {
    const i = S.sel; if (i == null) return overview();
    const sc = S.scen, H = horizon();
    let html = "";
    if (S.mode === "future") {
      const top = sc.top[i];
      if (!top) { $("#card").innerHTML = `<div class="pair"><p class="city">${esc(cname(i))}</p></div><p class="note plain">No future data for this city in this scenario.</p>`; return; }
      const [j, dist] = top[0], same = j === i;
      const km = S.d.shiftKm[i], br = same ? null : bearing(S.cities[i], S.cities[j]);
      html += `<div class="pair">
        <p class="when">${t("climateIn")(H)}</p>
        <p class="city">${esc(cname(i))}</p><span class="country">${esc(ccountry(i))}</span>
        <div class="bridge">${t("likeToday")}</div>
        <p class="city to">${esc(cname(j))}</p><span class="country">${esc(ccountry(j))}</span>
      </div>
      <dl class="meta">
        <div><dt>${t("shift")}</dt><dd>${same ? t("none") : fmtKm(km)}</dd></div>
        <div><dt>${t("direction")}</dt><dd>${same ? t("none") : t("dirs")[Math.round(br / 45) % 8]}</dd></div>
        <div><dt>${t("climDist")}</dt><dd>${fmtNum(dist)} · ${t("quality")[qualityOf(dist)]}</dd></div>
        <div><dt>${t("change")}</dt><dd>${fmtNum(sc.self[i])}</dd></div>
      </dl>`;
      if (sc.novel[i]) html += `<p class="note">${t("novel")}</p>`;
      else if (same) html += `<p class="note plain">${t("stays")}</p>`;
      html += `<h3>${t("top5")}</h3><ol class="rank">${top.map(([k, d]) => `<li data-i="${k}" class="${k === i ? "self" : ""}"><span>${esc(cname(k))} <small>${esc(ccountry(k))}</small></span><small>${fmtNum(d)}</small></li>`).join("")}</ol>`;
      html += varsTable(i, j);
    } else {
      const list = revList(i), exact = list.length && list[0][2];
      html += `<div class="pair">
        <p class="when">${t("todayIn")}</p>
        <p class="city to">${esc(cname(i))}</p><span class="country">${esc(ccountry(i))}</span>
        <div class="bridge">${t("becomes")(H)}</div>
      </div>`;
      {
        if (!exact) html += `<p class="note plain">${t("revEmpty")}</p>`;
        html += `<h3>${t("rev")}</h3><ol class="rank">${list.map(([k, d, ex]) => `<li data-i="${k}" class="${k === i ? "self" : ""}"><span>${esc(cname(k))} <small>${esc(ccountry(k))}${ex ? " · " + t("exactTag") : ""}</small></span><small>${fmtNum(d)}</small></li>`).join("")}</ol>`;
      }
    }
    html += spacePlot(i);
    $("#card").innerHTML = html;
    $("#card").querySelectorAll(".rank li").forEach(li => li.onclick = () => select(+li.dataset.i));
  }

  function varsTable(i, j) {
    const V = S.scen.vars; if (!V) return "";
    const rows = Object.keys(V.cur).filter(k => t("v")[k]);
    const f = (x, k) => x == null ? t("none") : (k === "bio12" || k === "bio14" || k === "bio15" ? Math.round(x) : fmtNum(x, 1));
    return `<h3>${t("vars")}</h3><table class="vars"><thead><tr><th></th><th>${t("today")}</th><th>${t("future")}</th><th>${t("analogToday")}</th></tr></thead><tbody>
      ${rows.map(k => `<tr><td>${t("v")[k]}</td><td>${f(V.cur[k][i], k)}</td><td><b>${f(V.fut[k][i], k)}</b></td><td>${f(V.cur[k][j], k)}</td></tr>`).join("")}
    </tbody></table>`;
  }

  function hull2(pts) {
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const q of p) { while (lo.length > 1 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (const q of p.reverse()) { while (up.length > 1 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }
  function axisLabels() {
    const L_ = S.scen.pc_loadings;
    if (!L_) return [t("pc1"), t("pc2")];
    const nm = k => (t("v")[k[0]] || k[0].toUpperCase()).split(",")[0];
    const pc = "PC";
    return [`${pc}1: ${nm(L_[0][0])} →`, `${pc}2: ${nm(L_[1][0])}`];
  }
  function spacePlot(i) {
    const sc = S.scen, W = 340, H = 230, pad = 14;
    const pts = sc.cur.map(p => p && [p[0], p[1]]).filter(Boolean);
    const fpts = sc.fut.map(p => p && [p[0], p[1]]).filter(Boolean);
    const all = pts.concat(fpts);
    const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const X = x => pad + (x - x0) / (x1 - x0) * (W - 2 * pad), Y = y => H - pad - (y - y0) / (y1 - y0) * (H - 2 * pad - 12);
    const hull = hull2(pts).map(p => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(" ");
    let g = `<polygon class="hull" points="${hull}"/>`;
    g += pts.map(p => `<circle class="dot" cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="1.6"/>`).join("");
    const hl = S.mode === "future" ? (sc.top[i] || []).map(x => x[0]).filter(k => k !== i) : revList(i).slice(0, 8).map(x => x[0]).filter(k => k !== i);
    if (S.mode === "future") {
      hl.forEach((k, n) => { const p = sc.cur[k]; if (p) g += `<circle cx="${X(p[0])}" cy="${Y(p[1])}" r="${n ? 3 : 4.5}" fill="${ACCENT}" opacity="${n ? 0.6 : 1}"/>`; });
    } else {
      hl.forEach(k => { const a = sc.cur[k], b = sc.fut[k]; if (a && b) g += `<line x1="${X(a[0])}" y1="${Y(a[1])}" x2="${X(b[0])}" y2="${Y(b[1])}" stroke="${COOL}" stroke-width="1" opacity=".6"/><circle cx="${X(b[0])}" cy="${Y(b[1])}" r="2.6" fill="${COOL}"/>`; });
    }
    const a = sc.cur[i], b = sc.fut[i];
    g += `<defs><marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${INK}"/></marker></defs>`;
    if (a && b && S.mode === "future") g += `<line x1="${X(a[0])}" y1="${Y(a[1])}" x2="${X(b[0])}" y2="${Y(b[1])}" stroke="${INK}" stroke-width="1.6" marker-end="url(#ah)"/>`;
    if (a) g += `<circle cx="${X(a[0])}" cy="${Y(a[1])}" r="5" fill="none" stroke="${S.mode === "future" ? INK : ACCENT}" stroke-width="2"/>`;
    const [lx, ly] = axisLabels();
    g += `<text x="${W - pad}" y="${H - 3}" text-anchor="end">${esc(lx)}</text><text x="${pad}" y="12">${esc(ly)}</text>`;
    return `<h3>${t("space")}</h3><svg class="space" viewBox="0 0 ${W} ${H}" role="img" aria-label="${t("space")}">${g}</svg><p class="caption">${t("spaceCap")}</p>`;
  }

  function legend() {
    const q = S.d.selfQ;
    $("#legend").innerHTML = `<div>${t("legendTitle")}</div>
      <div class="ramp">${RAMP.map(c => `<i style="background:${c}"></i>`).join("")}</div>
      <div class="ends"><span>${t("legSmall")}</span><span>${t("legLarge")}</span></div>
      <div class="key"><span class="ring"></span>${t("legNovel")}</div>
      <div class="key"><span class="arc"></span>${t("legArc")}</div>
      <label><input type="checkbox" id="flows" ${S.flows ? "checked" : ""}> ${t("flows")}</label>`;
    $("#flows").onchange = e => { S.flows = e.target.checked; if (S.flows) flowLayer.addTo(map); else map.removeLayer(flowLayer); drawFlows(); };
  }

  function methodBody() {
    const sc = S.scen;
    const share = sc.pc_share.map(x => (x * 100).toFixed(1) + "%").join(" / ");
    const srcs = S.manifest.scenarios.map(s => S.cache[s.id]).filter(Boolean);
    $("#method-body").innerHTML = `
      <h2>How climate twins are found</h2>
      <p>For every city we compare its <b>future</b> climate with the <b>present</b> climate of all ${S.cities.length} cities. The closest city in multivariate distance is the climate analogue: visit it to experience your city's future climate.</p>
      <h4>Analysis steps</h4>
      <ol>
        <li>19 WorldClim bioclimatic variables (BIO1–BIO19) at city centroids: means, extremes, ranges and seasonality of temperature and precipitation.</li>
        <li>Variables are standardised (z-scores); a principal component analysis (PCA) is fitted on present climate to remove redundancy between correlated variables.</li>
        <li>Future values are projected onto the same present-day components.</li>
        <li>Euclidean distance in component space between every future and every present city. A smaller distance means a more similar climate.</li>
        <li>A "novel climate" means the future point lies outside the convex hull of all present cities in multivariate space (linear-programming test).</li>
      </ol>
      <h4>Current scenario: ${esc(sc.label.en)}</h4>
      <p>Baseline: ${esc(sc.baseline)}. Scenario: ${esc(sc.scenario)}. Models: ${esc(sc.models.join(", "))}. Variance shares of the PCs: ${share}.</p>
      ${sc.id.startsWith("bastin") ? `<p>The published 517 × 514 distance matrix of Bastin et al. (2019) is exactly Euclidean in 4-D. We recovered city coordinates in PC1–PC4 by multidimensional unfolding (RMSE ${sc.unfolding_rmse.toExponential(1)} with data rounded to 10⁻⁴). The variance shares of the recovered axes match the paper (40.2 / 26.9 / 10.5 / 7.6 %), and the hull test reproduces ${pct(S.d.pNovel)} novel climates (paper: 22%). Axes were interpreted from extreme cities: PC1 runs from cold continental cities to humid tropics, PC2 from hot deserts to wet cities.</p>` : `<p>20-year mean bioclimatic variables are averaged across the GCM ensemble.</p>`}
      <h4>Limitations</h4>
      <p>Analogues are climate-only: relief, distance to the sea, urbanisation and heat islands are ignored. Values are taken at a single point, the city centroid. Scenarios and models disagree, so compare several scenarios. Analogues for novel climates are approximate.</p>
      <h4>Sources</h4>
      <ul>${srcs.map(s => `<li><a href="${s.source.url}" target="_blank" rel="noopener">${esc(s.source.title)}</a> (${esc(s.source.license)})</li>`).join("")}
        <li>City coordinates and names: <a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a> (public domain)</li>
        <li>New horizons (2041–2060, 2061–2080, SSP2-4.5 / SSP5-8.5) are recomputed with <code>pipeline/build_cmip6.py</code> from WorldClim 2.1 CMIP6.</li></ul>`;
  }

  // ---------- state changes ----------
  function select(i, fromHash) {
    S.sel = i;
    markerByIdx.forEach((m, k) => m.setRadius(k === i ? 6.5 : 4.2));
    drawSelection(); card();
    if (!fromHash) writeHash();
    if (innerWidth <= 760) $("#panel").scrollTop = 0;
  }
  function setMode(m) {
    S.mode = m;
    document.querySelectorAll(".seg button").forEach(b => b.setAttribute("aria-checked", b.dataset.mode === m));
    drawSelection(); card(); writeHash();
  }
  function setLang(l) {
    S.lang = l; document.documentElement.lang = l;
    document.querySelectorAll("[data-i18n]").forEach(e => e.textContent = t(e.dataset.i18n));
    document.querySelectorAll("[data-i18n-ph]").forEach(e => e.placeholder = t(e.dataset.i18nPh));
    document.title = t("title");
    fillScenarios(); legend(); card(); drawSelection(); methodBody(); basemapControl(); footer(); writeHash();
  }
  async function loadScenario(id) {
    const s = S.manifest.scenarios.find(x => x.id === id) || S.manifest.scenarios[0];
    if (!S.cache[s.id]) S.cache[s.id] = await (await fetch(s.file)).json();
    S.scen = S.cache[s.id]; S.d = derive(S.scen);
    $("#scenario").value = s.id;
    drawCities(); drawFlows(); legend(); methodBody(); footer();
    if (S.sel != null) select(S.sel, true); else card();
    writeHash();
  }
  function fillScenarios() {
    const sel = $("#scenario"), cur = sel.value;
    sel.innerHTML = S.manifest.scenarios.map(s => `<option value="${s.id}">${esc(s.label[S.lang])}</option>`).join("");
    if (cur) sel.value = cur;
  }
  function footer() { $("#src-short").textContent = `${t("src")}: ${S.scen.source.title.split(".")[0]}, WorldClim, Natural Earth`; }
  function basemapControl() {
    if (layerCtl) map.removeControl(layerCtl);
    layerCtl = L.control.layers({ [t("basemapVec")]: countryLayer, [t("basemapTiles")]: tiles }, null, { position: "topright" }).addTo(map);
  }

  // ---------- URL hash ----------
  function writeHash() {
    if (!S.scen) return;
    const p = new URLSearchParams();
    if (S.scen.id !== S.manifest.default) p.set("s", S.scen.id);
    if (S.sel != null) p.set("c", S.cities[S.sel].name);
    if (S.mode !== "future") p.set("m", S.mode);
    const h = p.toString(); history.replaceState(null, "", h ? "#" + h : location.pathname + location.search);
  }
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    return { s: p.get("s"), c: p.get("c"), m: p.get("m"), l: p.get("l") };
  }

  // ---------- search ----------
  function setupSearch() {
    const q = $("#q"), list = $("#q-list"); let items = [], act = -1;
    const norm = s => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const close = () => { list.hidden = true; q.setAttribute("aria-expanded", "false"); act = -1; };
    const render = () => {
      list.innerHTML = items.map((i, k) => `<li role="option" id="opt${k}" aria-selected="${k === act}" data-i="${i}">${esc(cname(i))}<small>${esc(ccountry(i))}</small></li>`).join("");
      list.hidden = !items.length; q.setAttribute("aria-expanded", String(!!items.length));
      list.querySelectorAll("li").forEach(li => li.onmousedown = e => { e.preventDefault(); pick(+li.dataset.i); });
    };
    const pick = i => { q.value = ""; close(); select(i); q.blur(); };
    q.addEventListener("input", () => {
      const v = norm(q.value.trim()); if (!v) { items = []; return render(); }
      const sc = i => { const a = norm(S.cities[i].name), b = a, c = norm(S.cities[i].country);
        return a.startsWith(v) || b.startsWith(v) ? 0 : a.includes(v) || b.includes(v) ? 1 : c.includes(v) ? 2 : 9; };
      items = S.cities.map((_, i) => [i, sc(i)]).filter(x => x[1] < 9).sort((a, b) => a[1] - b[1] || S.cities[b[0]].pop - S.cities[a[0]].pop).slice(0, 10).map(x => x[0]);
      act = items.length ? 0 : -1; render();
    });
    q.addEventListener("keydown", e => {
      if (e.key === "ArrowDown" && items.length) { act = (act + 1) % items.length; render(); e.preventDefault(); }
      else if (e.key === "ArrowUp" && items.length) { act = (act - 1 + items.length) % items.length; render(); e.preventDefault(); }
      else if (e.key === "Enter" && act >= 0) { pick(items[act]); e.preventDefault(); }
      else if (e.key === "Escape") close();
    });
    q.addEventListener("blur", () => setTimeout(close, 120));
  }

  // ---------- boot ----------
  async function boot() {
    $("#card").innerHTML = `<p class="lede">${T.en.loading}</p>`;
    try {
      const [man, cities, countries] = await Promise.all([
        fetch("data/manifest.json").then(r => r.json()), fetch("data/cities.json").then(r => r.json()),
        fetch("data/countries.json").then(r => r.json()).catch(() => null)]);
      S.manifest = man; S.cities = cities;
      if (countries) L.geoJSON(countries, { pane: "countries", style: { color: "#c4ccc6", weight: 0.7, fillColor: "#eef0ea", fillOpacity: 1 }, interactive: false }).addTo(countryLayer);
      const h = readHash();
      if (h.m === "reverse") S.mode = "reverse";
      fillScenarios(); setupSearch();
      document.querySelectorAll(".seg button").forEach(b => b.onclick = () => setMode(b.dataset.mode));
      $("#scenario").onchange = e => loadScenario(e.target.value);
      $("#open-method").onclick = () => $("#method").showModal();
      document.addEventListener("keydown", e => { if (e.key === "Escape" && S.sel != null && document.activeElement !== $("#q") && !$("#method").open) { S.sel = null; markerByIdx.forEach(m => m.setRadius(4.2)); selLayer.clearLayers(); card(); writeHash(); } });
      const ci = h.c ? cities.findIndex(c => c.name === h.c) : -1;
      if (ci >= 0) S.sel = ci;
      await loadScenario(h.s || man.default);
      setLang(S.lang);
      setMode(S.mode);
    } catch (err) {
      console.error(err);
      $("#card").innerHTML = `<p class="note">${T.en.loadErr}</p>`;
    }
  }
  boot();
})();
