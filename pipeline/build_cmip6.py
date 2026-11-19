"""
Recompute city climate analogues from WorldClim 2.1 + CMIP6 (horizons 30–50 years ahead).

Method (same family as Bastin et al. 2019, updated data):
  * baseline: WorldClim 2.1, 1970–2000, 19 bioclimatic variables (BIO1–BIO19)
  * future:   WorldClim 2.1 downscaled CMIP6, multi-model mean of the 19 BIO
              variables for each SSP and 20-year period
  * values extracted at city centroids (data/cities.json); if a coastal
    centroid falls on an ocean cell, the nearest land cell (<= 5 cells) is used
  * variables z-scored with baseline city statistics -> PCA on baseline cities
    -> components covering >= 85 % of variance (min 3) are kept
  * future cities projected into the baseline PC space; Euclidean distance
    between every future city and every current city = climate dissimilarity
  * analogue = current city with the smallest distance (top-5 stored)
  * novel climate = future city outside the convex hull of current cities in
    PC space (LP test), as in Bastin et al. 2019

Usage (needs internet; ~1 GB download at 10 arc-min with the defaults):
  pip install numpy scipy rasterio
  python pipeline/build_cmip6.py                      # defaults below
  python pipeline/build_cmip6.py --ssps 245 --periods 2061-2080 --gcms MIROC6 MRI-ESM2-0

Outputs: data/scenarios/cmip6_ssp{ssp}_{period}.json and an updated data/manifest.json
"""
import argparse
import io
import json
import os
import sys
import urllib.request
import zipfile

import numpy as np
from scipy.optimize import linprog

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE_URL = os.environ.get("WORLDCLIM_URL", "https://geodata.ucdavis.edu/climate/worldclim/2_1")
DEFAULT_GCMS = ["ACCESS-CM2", "EC-Earth3-Veg", "IPSL-CM6A-LR", "MIROC6", "MPI-ESM1-2-HR", "MRI-ESM2-0"]
BIO = [f"bio{i}" for i in range(1, 20)]
SHOW = {"bio1": 1, "bio5": 1, "bio6": 1, "bio7": 1, "bio12": 0, "bio15": 0, "bio14": 0}  # decimals
SSP_LABEL = {"126": "SSP1-2.6", "245": "SSP2-4.5", "370": "SSP3-7.0", "585": "SSP5-8.5"}


def fetch(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return dest
    print("  GET", url, flush=True)
    tmp = dest + ".part"
    with urllib.request.urlopen(url, timeout=600) as r, open(tmp, "wb") as f:
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b)
    os.replace(tmp, dest)
    return dest


def sample(src_band_arrays, transform, lons, lats, nodata=None, radius=5):
    """Sample a (bands, H, W) array at points, falling back to the nearest valid cell."""
    from rasterio.transform import rowcol
    arr = src_band_arrays
    rows, cols = rowcol(transform, lons, lats)
    H, W = arr.shape[1:]
    out = np.full((len(lons), arr.shape[0]), np.nan)
    for k, (r, c) in enumerate(zip(rows, cols)):
        r = min(max(r, 0), H - 1); c = min(max(c, 0), W - 1)
        best = None
        for rad in range(radius + 1):
            r0, r1 = max(r - rad, 0), min(r + rad + 1, H)
            c0, c1 = max(c - rad, 0), min(c + rad + 1, W)
            win = arr[:, r0:r1, c0:c1]
            ok = np.all(np.isfinite(win), axis=0)
            if nodata is not None:
                ok &= np.all(win != nodata, axis=0)
            if ok.any():
                rr, cc = np.nonzero(ok)
                d = (rr + r0 - r) ** 2 + (cc + c0 - c) ** 2
                q = np.argmin(d)
                best = win[:, rr[q], cc[q]]
                break
        if best is not None:
            out[k] = best
    return out


def read_multiband(path):
    import rasterio
    with rasterio.open(path) as ds:
        a = ds.read(masked=True).astype("float64").filled(np.nan)
        return a, ds.transform, ds.nodata


def baseline(res, cache, lons, lats):
    zpath = fetch(f"{BASE_URL}/base/wc2.1_{res}_bio.zip", os.path.join(cache, f"wc2.1_{res}_bio.zip"))
    vals = []
    import rasterio
    with zipfile.ZipFile(zpath) as z:
        for i in range(1, 20):
            name = f"wc2.1_{res}_bio_{i}.tif"
            with rasterio.MemoryFile(z.read(name)) as mf, mf.open() as ds:
                a = ds.read(1, masked=True).astype("float64").filled(np.nan)[None]
                vals.append(sample(a, ds.transform, lons, lats)[:, 0])
    return np.column_stack(vals)


def future(res, cache, gcm, ssp, period, lons, lats):
    fn = f"wc2.1_{res}_bioc_{gcm}_ssp{ssp}_{period}.tif"
    urls = [f"{BASE_URL}/cmip6/{res}/{gcm}/ssp{ssp}/{fn}",
            f"{BASE_URL.replace('/climate/worldclim/2_1', '')}/cmip6/{res}/{gcm}/ssp{ssp}/{fn}"]
    dest = os.path.join(cache, fn)
    for u in urls:
        try:
            fetch(u, dest)
            break
        except Exception as e:  # noqa
            print("   failed:", e)
    else:
        return None
    a, tr, nd = read_multiband(dest)
    return sample(a, tr, lons, lats, nd)


def in_hull(points, y):
    n = len(points)
    A = np.vstack([points.T, np.ones(n)])
    r = linprog(np.zeros(n), A_eq=A, b_eq=np.r_[y, 1.0], bounds=(0, None), method="highs")
    return r.status == 0


def pca_fit(Z, min_share=0.85, min_k=3):
    C = np.cov(Z.T)
    w, E = np.linalg.eigh(C)
    o = np.argsort(w)[::-1]
    w, E = w[o], E[:, o]
    share = w / w.sum()
    k = max(min_k, int(np.searchsorted(np.cumsum(share), min_share) + 1))
    return E[:, :k], share[:k]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--res", default="10m", choices=["10m", "5m", "2.5m"])
    ap.add_argument("--gcms", nargs="+", default=DEFAULT_GCMS)
    ap.add_argument("--ssps", nargs="+", default=["245", "585"])
    ap.add_argument("--periods", nargs="+", default=["2041-2060", "2061-2080"])
    ap.add_argument("--cache", default=os.path.join(ROOT, ".cache"))
    ap.add_argument("--min-share", type=float, default=0.85)
    args = ap.parse_args()
    os.makedirs(args.cache, exist_ok=True)

    cities = json.load(open(os.path.join(ROOT, "data", "cities.json"), encoding="utf-8"))
    lons = np.array([c["lon"] for c in cities]); lats = np.array([c["lat"] for c in cities])
    print(f"{len(cities)} cities; baseline WorldClim 2.1 {args.res}")
    B = baseline(args.res, args.cache, lons, lats)
    ok = np.all(np.isfinite(B), axis=1)
    if (~ok).any():
        print("  no baseline value for:", [cities[i]["name"] for i in np.nonzero(~ok)[0]])

    mu, sd = B[ok].mean(0), B[ok].std(0, ddof=1)
    Z = (B - mu) / sd
    E, share = pca_fit(Z[ok], args.min_share)
    k = E.shape[1]
    X = Z @ E
    # orient: +PC1 = warmer (positive loading on BIO1)
    sign = np.sign(E[0, :]); sign[sign == 0] = 1
    E = E * sign; X = X * sign
    loadings = [[[BIO[v], round(float(E[v, j]), 3)] for v in np.argsort(-np.abs(E[:, j]))[:4]] for j in range(k)]
    print("PCA: k =", k, "shares", np.round(share * 100, 1))
    Xok = X[ok]
    idx_ok = np.nonzero(ok)[0]

    manifest_path = os.path.join(ROOT, "data", "manifest.json")
    manifest = json.load(open(manifest_path, encoding="utf-8"))

    for ssp in args.ssps:
        for period in args.periods:
            print(f"== SSP{ssp} {period}")
            stack = []
            used = []
            for g in args.gcms:
                F = future(args.res, args.cache, g, ssp, period, lons, lats)
                if F is not None:
                    stack.append(F); used.append(g)
            if not stack:
                print("  no data, skipped"); continue
            Fm = np.nanmean(np.stack(stack), axis=0)
            Y = ((Fm - mu) / sd) @ E
            fok = np.all(np.isfinite(Y), axis=1) & ok
            n = len(cities)
            top, selfd, novel, fut_pc = [None] * n, [None] * n, [None] * n, [None] * n
            for i in np.nonzero(fok)[0]:
                d = np.sqrt(((Xok - Y[i]) ** 2).sum(1))
                o = np.argsort(d)[:5]
                top[i] = [[int(idx_ok[a]), round(float(d[a]), 4)] for a in o]
                selfd[i] = round(float(np.sqrt(((X[i] - Y[i]) ** 2).sum())), 4)
                novel[i] = not in_hull(Xok, Y[i])
                fut_pc[i] = [round(float(v), 4) for v in Y[i]]
            nov = np.mean([v for v in novel if v is not None])
            oth = np.mean([t[0][0] != i for i, t in enumerate(top) if t])
            print(f"  GCMs used: {len(used)}; novel {nov:.1%}; analogue is another city {oth:.1%}")

            def col(M, v, dec):
                j = BIO.index(v)
                return [None if not np.isfinite(M[i, j]) else round(float(M[i, j]), dec) for i in range(n)]

            sid = f"cmip6_ssp{ssp}_{period}"
            mid = int(period[:4]) + 9
            scen = {
                "id": sid,
                "label": {"ru": f"{period} · {SSP_LABEL.get(ssp, ssp)} · CMIP6",
                          "en": f"{period} · {SSP_LABEL.get(ssp, ssp)} · CMIP6"},
                "horizon": f"{period} (~{mid})", "baseline": "1970–2000", "scenario": SSP_LABEL.get(ssp, ssp),
                "models": used,
                "variables": f"19 WorldClim 2.1 bioclimatic variables ({args.res}) → scaled PCA, {k} PCs",
                "metric": f"Euclidean distance in PC1–PC{k} space",
                "source": {"title": "WorldClim 2.1 + CMIP6 downscaled (Fick & Hijmans 2017)",
                           "url": "https://www.worldclim.org/data/cmip6/cmip6climate.html",
                           "license": "WorldClim terms of use"},
                "pc_share": [round(float(s), 4) for s in share], "pc_loadings": loadings,
                "cur": [None if not ok[i] else [round(float(v), 4) for v in X[i]] for i in range(n)],
                "fut": fut_pc, "self": selfd, "novel": novel, "top": top,
                "vars": {"cur": {v: col(B, v, d) for v, d in SHOW.items()},
                         "fut": {v: col(Fm, v, d) for v, d in SHOW.items()}},
            }
            out = os.path.join(ROOT, "data", "scenarios", sid + ".json")
            json.dump(scen, open(out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
            manifest["scenarios"] = [s for s in manifest["scenarios"] if s["id"] != sid]
            manifest["scenarios"].append({"id": sid, "file": f"data/scenarios/{sid}.json", "label": scen["label"]})
            print("  wrote", out)

    order = lambda s: (s["id"] != manifest.get("default"), s["id"])
    manifest["scenarios"].sort(key=order)
    json.dump(manifest, open(manifest_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print("manifest updated")


if __name__ == "__main__":
    sys.exit(main())
