"""Portable, self-contained reports; no web requests or participant information."""
from dataclasses import asdict
from datetime import datetime, timezone
from html import escape
import csv
import hashlib
import io
import json
from importlib.metadata import version
from . import __version__


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False).encode()).hexdigest()


def inputs(metadata, areas, budget, excluded=None):
    return {"dataset_sha256": metadata["dataset_sha256"], "budget_won": budget,
            "selected_region_ids": sorted({a.region_id for a in areas} | {r["region_id"] for r in (excluded or [])}),
            "solver_config": {"scale": 10000, "seed": 2026, "workers": 1, "phase_time_limit_seconds": 5},
            "areas": [asdict(a) for a in sorted(areas, key=lambda a: a.region_id)]}


def bundle(metadata, areas, budget, results, excluded, cluster=None, provenance=None):
    parameters = inputs(metadata, areas, budget, excluded)
    return {"schema_version": "1.0", "application_version": __version__,
            "created_at": datetime.now(timezone.utc).isoformat(), "input_sha256": fingerprint(parameters),
            "source": metadata, "parameters": parameters, "excluded": excluded,
            "region_sources": [{k: r[k] for k in ["region_id", "source_row", "annual_users", "raw_ratio", "flags"]} for r in (provenance or [])],
            "package_versions": {p: version(p) for p in ["streamlit", "pandas", "numpy", "openpyxl", "scikit-learn", "ortools"]},
            "interpretation": ["정책 검토용 가정 시나리오이며 실제 수용 능력·인력·효과를 측정하지 않습니다.",
                               "연간 이용자 수와 수요군은 모집단·기준 시점이 다를 수 있습니다.",
                               "모형 기준량은 min(이용자 수, 수요군)이며 원자료 비율은 별도 보존합니다.",
                               "최저 모형 비율은 0.01%p 단위로 양자화하여 최적화합니다.",
                               "생산성·비용·지역별 한계는 사용자가 설정한 가정입니다."],
            "results": results, "clusters": cluster}


def json_bytes(report):
    return json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8")


def safe_cell(value):
    if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")):
        return "'" + value
    return value


def csv_bytes(report):
    output = io.StringIO(newline="")
    columns = ["row_type", "input_sha256", "source_sha256", "source_report_sha256", "source_url", "dataset_version", "budget_won", "interpretation", "excluded_reason", "source_row", "annual_users_raw", "raw_ratio", "method", "status", "region_id", "demand", "model_base",
               "units", "additional_model_users", "cost", "before_ratio", "after_ratio", "productivity", "unit_cost", "lower", "upper", "status_message"]
    writer = csv.DictWriter(output, fieldnames=columns)
    writer.writeheader()
    common = {"input_sha256": report["input_sha256"], "source_sha256": report["source"]["source_sha256"],
              "source_report_sha256": report["source"].get("source_report_sha256", ""), "source_url": report["source"]["source_url"],
              "dataset_version": report["source"]["dataset_version"], "budget_won": report["parameters"]["budget_won"],
              "interpretation": " / ".join(report["interpretation"])}
    writer.writerow({**common, "row_type": "metadata"})
    sources = {r["region_id"]: r for r in report.get("region_sources", [])}
    for result in report["results"]:
        if not result["rows"]:
            status = {**common, "row_type": "status", "method": result["method"], "status": result["status"],
                      "status_message": " / ".join(result["messages"])}
            writer.writerow({key: safe_cell(value) for key, value in status.items()})
        for row in result["rows"]:
            original = sources.get(row["region_id"], {})
            values = {**row, **common, "row_type": "allocation", "source_row": original.get("source_row", ""),
                      "annual_users_raw": original.get("annual_users", ""), "raw_ratio": original.get("raw_ratio", ""),
                      "method": result["method"], "status": result["status"]}
            writer.writerow({k: safe_cell(values.get(k, "")) for k in columns})
    for row in report["excluded"]:
        values = {**common, "row_type": "excluded", "region_id": row["region_id"], "excluded_reason": row["reason"], "source_row": row["source_row"]}
        writer.writerow({k: safe_cell(values.get(k, "")) for k in columns})
    return output.getvalue().encode("utf-8-sig")


def html_bytes(report):
    def e(value):
        return escape(str(value), quote=True)
    blocks = []
    for result in report["results"]:
        rows = "".join(f"<tr><td>{e(r['region_id'])}</td><td>{r['units']:,}</td><td>{r['additional_model_users']:,}</td>"
                       f"<td>{r['cost']:,}</td><td>{r['before_ratio']:.2%}</td><td>{r['after_ratio']:.2%}</td></tr>" for r in result["rows"])
        metrics = result["metrics"]
        details = " / ".join(e(m) for m in result["messages"])
        if metrics:
            details += f" 추가 모형 이용자 {metrics['additional_model_users']:,}, 비용 {metrics['cost']:,}원, 최저 모형 비율 {metrics['minimum_ratio']:.2%}"
        blocks.append(f"<h2>{e(result['method'])} · {e(result['status'])}</h2><p>{details}</p>"
                      f"<pre>{e(json.dumps(result['stages'], ensure_ascii=False, indent=2))}</pre>"
                      f"<table><thead><tr><th>지역</th><th>자원 단위</th><th>추가 모형 이용자</th><th>비용(원)</th><th>전</th><th>후</th></tr></thead><tbody>{rows}</tbody></table>")
    assumptions = "".join(f"<li>{e(x)}</li>" for x in report["interpretation"])
    exclusion = "".join(f"<li>{e(x['region_id'])}: {e(x['reason'])}</li>" for x in report["excluded"])
    text = f"""<!doctype html><html lang="ko"><meta charset="utf-8"><title>CareGap 시나리오 보고서</title>
<style>body{{font:15px/1.6 'Malgun Gothic',sans-serif;max-width:1100px;margin:40px auto;padding:0 24px;color:#172b38}}h1,h2{{color:#172b38}}table{{border-collapse:collapse;width:100%;font-size:13px}}th,td{{border:1px solid #ccd6da;padding:6px;text-align:right}}th:first-child,td:first-child{{text-align:left}}th{{background:#edf5f2}}pre{{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}}@media print{{thead{{display:table-header-group}}tr{{break-inside:avoid}}}}</style>
<h1>CareGap 배분 대안 비교 보고서</h1><p>{e(report['created_at'])} · 모형 시뮬레이션</p><ul>{assumptions}</ul>
<p>자료: <a href="https://www.mohw.go.kr/board.es?act=view&amp;bid=0073&amp;list_no=1492217&amp;mid=a60401000000">보건복지부 통합돌봄 실태조사</a><br>입력 지문: {e(report['input_sha256'])}<br>원본 지문: {e(report['source']['source_sha256'])}<br>예산: {report['parameters']['budget_won']:,}원</p>
<h2>제외 지역</h2><ul>{exclusion or '<li>없음</li>'}</ul>{''.join(blocks)}
<h2>재현 입력과 자료 정의</h2><pre>{e(json.dumps({'source':report['source'], 'parameters':report['parameters'], 'region_sources':report.get('region_sources', [])}, ensure_ascii=False, indent=2))}</pre></html>"""
    return text.encode("utf-8")
