from __future__ import annotations

import re

from analysis import DocConfig, Quadrant, Thresholds


_NUM = r"(?P<num>\d+(?:\.\d+)?)"


def _find_first_number(patterns: list[str], text: str) -> float | None:
    for p in patterns:
        m = re.search(p, text, flags=re.IGNORECASE | re.MULTILINE)
        if m:
            try:
                return float(m.group("num"))
            except Exception:
                continue
    return None


def parse_document_config(doc_text: str) -> DocConfig:
    """
    Heuristic parser for the user's 'document' text.

    Current extraction:
    - share_high_pct: e.g. "份额 30%" / "share 30%"
    - rank_good_max: e.g. "Rank <= 3" / "排名 <=3"
    - acos_good_max_pct: e.g. "ACOS 30%"

    If values are not present, defaults are used.
    """

    text = (doc_text or "").strip()

    share = _find_first_number(
        [
            rf"(?:高份额|份额分界|份额阈值|share\s*threshold|share)\D{{0,20}}{_NUM}\s*%",
            rf"(?:impression\s*share)\D{{0,20}}{_NUM}\s*%",
        ],
        text,
    )
    rank = _find_first_number(
        [
            rf"(?:高排名|排名分界|rank\s*threshold|rank)\D{{0,20}}(?:<=|≤)\s*{_NUM}",
            rf"(?:rank)\D{{0,20}}{_NUM}\s*(?:以内|以下|及以内)",
        ],
        text,
    )
    acos = _find_first_number(
        [
            rf"(?:acos)\D{{0,20}}{_NUM}\s*%",
            rf"(?:健康\s*acos|acos\s*健康线)\D{{0,20}}{_NUM}\s*%",
        ],
        text,
    )

    thresholds = Thresholds(
        share_high_pct=share if share is not None else Thresholds().share_high_pct,
        rank_good_max=int(rank) if rank is not None else Thresholds().rank_good_max,
        acos_good_max_pct=acos if acos is not None else Thresholds().acos_good_max_pct,
    )

    # Strategy override parsing: optional, best-effort.
    # Support simple patterns like:
    # "① ...: xxx" or "1) ... -> xxx"
    overrides: dict[Quadrant, dict[str, str]] = {}
    quadrant_map = {
        "①": Quadrant.Q1,
        "1": Quadrant.Q1,
        "②": Quadrant.Q2,
        "2": Quadrant.Q2,
        "③": Quadrant.Q3,
        "3": Quadrant.Q3,
        "④": Quadrant.Q4,
        "4": Quadrant.Q4,
    }
    for sym, q in quadrant_map.items():
        m = re.search(
            rf"{re.escape(sym)}\s*.*?(?:优化方向|策略|方向)\D{{0,6}}(?P<txt>.+)",
            text,
            flags=re.IGNORECASE,
        )
        if m:
            overrides[q] = {"base_strategy": m.group("txt").strip()}

    return DocConfig(thresholds=thresholds, strategy_overrides=overrides or None)

