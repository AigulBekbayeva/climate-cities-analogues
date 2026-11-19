"""
Build the default scenario of the geoportal from the published city-analogue
dissimilarity matrix of Bastin et al. (2019, PLOS ONE 14(7): e0217592, CC BY 4.0).

Input
  pipeline/source/bastin2019_dissimilarity_matrix.csv
      517 current cities (rows) x 514 future (2050, RCP4.5) cities (columns).
      Cell = Euclidean distance in the space of the first 4 principal components
      of 19 WorldClim bioclimatic variables (scaled PCA on 1970-2000 climate).
  Natural Earth "populated places" (downloaded automatically) for coordinates.

What this script does (multivariate analysis):
  1. Multidimensional unfolding: the rectangular distance matrix is exactly
     Euclidean in 4-D, so we recover the PC scores of every current and future
     city (double-centring + SVD + least-squares alignment).  The variance
     shares of the recovered axes reproduce the paper (40.2/26.9/10.5/7.6 %).
  2. Rotation to principal axes of the current cities -> PC1..PC4.
  3. Novel (no-analogue) climate: future city outside the convex hull of current
     cities in 4-D PC space (linear-programming membership test), as in the paper.
  4. Top-5 analogues for every future city.

Outputs
  data/cities.json
  data/scenarios/bastin2019_rcp45_2050.json
Usage
  python pipeline/build_bastin.py
"""
import json
import os
import sys
import unicodedata
import urllib.request

import numpy as np
import pandas as pd
from scipy.optimize import least_squares, linprog

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "pipeline", "source", "bastin2019_dissimilarity_matrix.csv")
NE_URL = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/"
          "geojson/ne_10m_populated_places_simple.geojson")
NE_CACHE = os.environ.get("NE_PLACES", "/tmp/ne_places.geojson")

# Cities whose name is shared by several places; resolved by checking the
# climate neighbours in the matrix (see README, "Data provenance").
OVERRIDES = {
    "Hyderabad1": "Pakistan",
    "Hamilton": "Bermuda",
    "George Town": "Cayman Islands",
    "San Jose": "Costa Rica",
    "Saint John's": "Antigua and Barbuda",
}
ALIASES = {"Washington, DC": "washington, d.c.", "Hyderabad1": "hyderabad"}


def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    return " ".join(s.lower().split())


def load_places():
    if not os.path.exists(NE_CACHE):
        print("downloading Natural Earth populated places ...")
        urllib.request.urlretrieve(NE_URL, NE_CACHE)
    feats = json.load(open(NE_CACHE, encoding="utf-8"))["features"]
    idx = {}
    for f in feats:
        p = f["properties"]
        for k in ("name", "nameascii", "namealt", "ls_name", "meganame"):
            for nm in str(p.get(k) or "").split("|"):
                if nm:
                    lst = idx.setdefault(norm(nm), [])
                    if p not in lst:
                        lst.append(p)
    return idx


def geocode(names):
    idx = load_places()
    out = []
    for c in names:
        cands = idx.get(ALIASES.get(c, norm(c)), [])
        if not cands:
            sys.exit(f"city not found in Natural Earth: {c}")
        if c in OVERRIDES:
            cands = [p for p in cands if p["adm0name"] == OVERRIDES[c]]
        p = max(cands, key=lambda p: p["pop_max"])  # Bastin: capitals or >1M people
        out.append({
            "name": c.replace("Hyderabad1", "Hyderabad (PK)"),
            "country": p["adm0name"], "iso": p["iso_a2"],
            "lat": round(p["latitude"], 4), "lon": round(p["longitude"], 4),
            "pop": int(p["pop_max"]), "_ne": p["ne_id"],
        })
    return out


NE_FULL_URL = NE_URL.replace("_simple", "")
NE_ADM0_URL = NE_URL.replace("populated_places_simple", "admin_0_countries")


def add_russian_names(cities):
    """Russian city/country names from Natural Earth (NAME_RU)."""
    full = os.environ.get("NE_PLACES_FULL", "/tmp/ne_full.geojson")
    adm0 = os.environ.get("NE_ADM0", "/tmp/ne_adm0_10m.geojson")
    for url, path in ((NE_FULL_URL, full), (NE_ADM0_URL, adm0)):
        if not os.path.exists(path):
            print("downloading", url)
            urllib.request.urlretrieve(url, path)
    ru = {f["properties"]["NE_ID"]: f["properties"].get("NAME_RU")
          for f in json.load(open(full, encoding="utf-8"))["features"]}
    cru = {}
    for f in json.load(open(adm0, encoding="utf-8"))["features"]:
        q = f["properties"]
        for k in ("ADMIN", "NAME", "NAME_LONG", "SOVEREIGNT"):
            if q.get(k) and q.get("NAME_RU"):
                cru.setdefault(q[k], q["NAME_RU"])
    cru.update({"Guinea Bissau": "Гвинея-Бисау", "Congo (Brazzaville)": "Республика Конго",
                "Congo (Kinshasa)": "ДР Конго", "Macau S.A.R": "Макао", "Cape Verde": "Кабо-Верде",
                "Sao Tome and Principe": "Сан-Томе и Принсипи", "Curacao": "Кюрасао"})
    for c in cities:
        c["name_ru"] = ru.get(c.pop("_ne")) or c["name"]
        c["country_ru"] = cru.get(c["country"], c["country"])
    fixes = {"Hyderabad (PK)": "Хайдарабад (Пакистан)", "Astana": "Астана", "Almaty": "Алматы"}
    for c in cities:
        c["name_ru"] = fixes.get(c["name"], c["name_ru"])
    return cities


def unfold(D, k=4, seed=0):
    """Recover point coordinates from a rectangular Euclidean distance matrix."""
    nr, nc = D.shape
    D2 = D ** 2
    B = -0.5 * (D2 - D2.mean(1, keepdims=True) - D2.mean(0, keepdims=True) + D2.mean())
    U, s, Vt = np.linalg.svd(B)
    print("singular values:", np.round(s[:7], 2))
    P = U[:, :k] * np.sqrt(s[:k])
    Q = Vt[:k].T * np.sqrt(s[:k])

    def build(p):
        A = p[: k * k].reshape(k, k)
        return P @ A, Q @ np.linalg.inv(A).T + p[k * k:]

    sub = (slice(None, None, 3), slice(None, None, 3))

    def res(p):
        X, Y = build(p)
        d = np.sqrt(((X[sub[0], None, :] - Y[None, sub[1], :]) ** 2).sum(-1))
        return (d - D[sub]).ravel()

    rng = np.random.default_rng(seed)
    best = None
    for _ in range(4):
        p0 = np.r_[(np.eye(k) + 0.1 * rng.standard_normal((k, k))).ravel(), 0.5 * rng.standard_normal(k)]
        r = least_squares(res, p0, method="lm", max_nfev=5000)
        if best is None or r.cost < best.cost:
            best = r
    X, Y = build(best.x)
    d = np.sqrt(((X[:, None, :] - Y[None, :, :]) ** 2).sum(-1))
    rmse = float(np.sqrt(np.mean((d - D) ** 2)))
    print(f"unfolding RMSE = {rmse:.2e} (matrix is rounded to 1e-4)")
    # principal axes of the current cities
    mu = X.mean(0)
    w, E = np.linalg.eigh(np.cov((X - mu).T))
    o = np.argsort(w)[::-1]
    w, E = w[o], E[:, o]
    Xp, Yp = (X - mu) @ E, (Y - mu) @ E
    return Xp, Yp, w / w.sum(), rmse


def in_hull(points, y):
    n = len(points)
    A = np.vstack([points.T, np.ones(n)])
    r = linprog(np.zeros(n), A_eq=A, b_eq=np.r_[y, 1.0], bounds=(0, None), method="highs")
    return r.status == 0


def main():
    m = pd.read_csv(SRC, index_col=0)
    m.columns = [c.replace("Future_", "").replace("Washington, D.C.", "Washington, DC") for c in m.columns]
    cur, fut = list(m.index), list(m.columns)
    D = m.values.astype(float)

    cities = add_russian_names(geocode(cur))
    Xp, Yp, share, rmse = unfold(D)

    # orient axes for readability: +PC1 = warmer (lower |lat|), +PC2 = wetter
    lat = np.array([c["lat"] for c in cities])
    if np.corrcoef(Xp[:, 0], np.abs(lat))[0, 1] > 0:
        Xp[:, 0] *= -1; Yp[:, 0] *= -1
    wet, dry = cur.index("Singapore"), cur.index("Riyadh")
    if Xp[wet, 1] < Xp[dry, 1]:
        Xp[:, 1] *= -1; Yp[:, 1] *= -1
    for k in (2, 3):  # PC3: + monsoon-like; PC4: + hot extremes
        ref = cur.index("Seoul") if k == 2 else cur.index("Phoenix")
        if Xp[ref, k] < 0:
            Xp[:, k] *= -1; Yp[:, k] *= -1

    n = len(cur)
    fut_pc = [None] * n
    selfd = [None] * n
    novel = [None] * n
    top = [None] * n
    for j, name in enumerate(fut):
        i = cur.index(name)
        fut_pc[i] = Yp[j]
        selfd[i] = round(float(D[i, j]), 4)
        novel[i] = not in_hull(Xp, Yp[j])
        o = np.argsort(D[:, j])[:5]
        top[i] = [[int(a), round(float(D[a, j]), 4)] for a in o]

    nov = [v for v in novel if v is not None]
    other = [t[0][0] != i for i, t in enumerate(top) if t]
    print(f"novel climates: {np.mean(nov):.1%} (paper: 22%)")
    print(f"closest analogue is another city: {np.mean(other):.1%} (paper: 77%)")
    print("PC variance shares:", np.round(share * 100, 1), "(paper: 40.2 26.9 10.5 7.6, renormalised)")

    r4 = lambda v: None if v is None else [round(float(x), 4) for x in v]
    scen = {
        "id": "bastin2019_rcp45_2050",
        "label": {"ru": "≈2050 · RCP4.5 · Bastin et al. 2019", "en": "≈2050 · RCP4.5 · Bastin et al. 2019"},
        "horizon": "2050", "baseline": "1970–2000", "scenario": "RCP4.5 (CMIP5)",
        "models": ["CESM1-BGC", "CESM1-CAM5", "HadGEM2-ES"],
        "variables": "19 WorldClim bioclimatic variables → scaled PCA, 4 PCs",
        "metric": "Euclidean distance in PC1–PC4 space",
        "source": {
            "title": "Bastin J-F et al. (2019) Understanding climate change from a global analysis of city analogues. PLOS ONE 14(7): e0217592",
            "url": "https://doi.org/10.1371/journal.pone.0217592",
            "license": "CC BY 4.0",
        },
        "pc_share": [round(float(x), 4) for x in share],
        "unfolding_rmse": rmse,
        "cur": [r4(x) for x in Xp], "fut": [r4(y) for y in fut_pc],
        "self": selfd, "novel": novel, "top": top,
    }
    os.makedirs(os.path.join(ROOT, "data", "scenarios"), exist_ok=True)
    json.dump(cities, open(os.path.join(ROOT, "data", "cities.json"), "w", encoding="utf-8"),
              ensure_ascii=False, separators=(",", ":"))
    json.dump(scen, open(os.path.join(ROOT, "data", "scenarios", scen["id"] + ".json"), "w", encoding="utf-8"),
              ensure_ascii=False, separators=(",", ":"))
    print("written data/cities.json and data/scenarios/%s.json" % scen["id"])


if __name__ == "__main__":
    main()
