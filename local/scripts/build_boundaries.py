"""Build the display map from the public SGIS 2025 Q2 ZIP (data.go.kr 15129688)."""
import argparse
from collections import defaultdict
import hashlib
from io import BytesIO
import json
from pathlib import Path
from zipfile import ZipFile

import shapefile
from pyproj import CRS, Transformer
from shapely import make_valid, orient_polygons, set_precision, union_all
from shapely.geometry import mapping, shape
from shapely.ops import transform

ROOT = Path(__file__).resolve().parents[1]
DATE = "20250630"
SOURCE_URL = "https://www.data.go.kr/data/15129688/fileData.do"
SIGUNGU = "bnd_sigungu_00_2025_2Q"
TOLERANCE_METERS = 120


def build(source: Path) -> dict:
    regions = {r["region_id"] for r in json.loads((ROOT / "data/regions.json").read_text(encoding="utf-8"))["regions"]}
    with ZipFile(source) as archive:
        def read(filename):
            members = [name for name in archive.namelist() if name.rsplit("/", 1)[-1] == filename]
            if len(members) != 1:
                raise ValueError(f"SGIS ZIP에서 {filename}을 하나만 찾을 수 있어야 합니다.")
            return archive.read(members[0])

        province_table = shapefile.Reader(dbf=BytesIO(read("bnd_sido_00_2025_2Q.dbf")), encoding="utf-8")
        provinces = {r["SIDO_CD"]: r["SIDO_NM"] for r in province_table.records() if r["BASE_DATE"] == DATE}
        reader = shapefile.Reader(shp=BytesIO(read(SIGUNGU + ".shp")), shx=BytesIO(read(SIGUNGU + ".shx")),
                                  dbf=BytesIO(read(SIGUNGU + ".dbf")), encoding="utf-8")
        projection = Transformer.from_crs(CRS.from_wkt(read(SIGUNGU + ".prj").decode("utf-8")), 4326, always_xy=True)
        parts = defaultdict(list)
        codes = set()
        unmatched = []
        for row in reader.iterShapeRecords():
            record = row.record
            code, name = record["SIGUNGU_CD"], record["SIGUNGU_NM"]
            if record["BASE_DATE"] != DATE or code in codes:
                raise ValueError(f"경계 기준일 또는 코드 중복 오류: {code}")
            codes.add(code)
            province = provinces[code[:2]]
            key = f"{province} {name}"
            if key not in regions and " " in name:
                # SGIS supplies ordinary wards such as 천안시 동남구 separately.
                key = f"{province} {name.rsplit(' ', 1)[0]}"
            if key not in regions:
                unmatched.append((code, province, name))
                continue
            polygon = shape(row.shape.__geo_interface__).simplify(TOLERANCE_METERS, preserve_topology=True)
            parts[key].append((code, name, make_valid(polygon)))
    missing = regions - set(parts)
    if unmatched or missing:
        raise ValueError(f"경계만 있는 코드 {unmatched}, 복지만 있는 지역 {sorted(missing)}")
    features = []
    for key, components in sorted(parts.items()):
        polygon = union_all([geometry for _, _, geometry in components])
        if polygon.geom_type == "GeometryCollection":
            polygon = union_all([g for g in polygon.geoms if g.geom_type in {"Polygon", "MultiPolygon"}])
        if polygon.is_empty or not polygon.is_valid or polygon.geom_type not in {"Polygon", "MultiPolygon"}:
            raise ValueError(f"지도 표시에 필요한 유효한 경계 없음: {key}")
        display = set_precision(transform(projection.transform, polygon), grid_size=0.00001)
        if display.is_empty or not display.is_valid:
            raise ValueError(f"좌표 정밀도 변환 후 유효한 경계 없음: {key}")
        geometry = mapping(orient_polygons(display, exterior_cw=True))
        features.append({"type": "Feature", "geometry": geometry, "properties": {
            "region_id": key, "sgis_codes": [code for code, _, _ in components],
            "sgis_names": [name for _, name, _ in components],
        }})
    with source.open("rb") as archive:
        source_sha = hashlib.file_digest(archive, "sha256").hexdigest()
    return {"type": "FeatureCollection", "metadata": {
        "source_url": SOURCE_URL, "source_title": "국가데이터처 SGIS 행정구역 통계 및 경계",
        "boundary_date": "2025-06-30", "code_system": "SGIS 시군구 통계지역코드",
        "source_archive_sha256": source_sha,
        "source_code_count": len(codes), "region_count": len(features),
        "simplification_meters": TOLERANCE_METERS, "coordinate_system": "WGS84",
        "license": "공공데이터포털 이용허락범위 제한 없음",
    }, "features": features}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    args = parser.parse_args()
    data = build(args.source)
    path = ROOT / "data/boundaries_2025q2.geojson"
    # Display precision of roughly one meter is sufficient after simplification.
    import re
    rendered = json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    rendered = re.sub(r"(?<=\[|,)(\d+\.\d{6,})(?=,|\])", lambda m: str(round(float(m[1]), 5)), rendered)
    path.write_text(rendered, encoding="utf-8")
    print(json.dumps(data["metadata"], ensure_ascii=False))
