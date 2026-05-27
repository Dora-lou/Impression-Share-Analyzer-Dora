from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

import pandas as pd


class Quadrant(str, Enum):
    Q1 = "① 高份额 + 高排名"
    Q2 = "② 高份额 + 低排名"
    Q3 = "③ 低份额 + 高排名"
    Q4 = "④ 低份额 + 低排名"


@dataclass(frozen=True)
class Thresholds:
    """High share / good rank use inclusive boundaries."""

    share_high_pct: float = 30.0
    rank_good_max: int = 3
    acos_good_max_pct: float = 30.0


@dataclass(frozen=True)
class DocConfig:
    """
    Config extracted from user's document.

    This keeps the system flexible: the 'document' can override thresholds and
    strategy copy without changing code.
    """

    thresholds: Thresholds = Thresholds()
    # Optional custom strategy overrides keyed by quadrant label.
    strategy_overrides: dict[Quadrant, dict[str, str]] | None = None


QUADRANT_META: dict[Quadrant, dict[str, str]] = {
    Quadrant.Q1: {
        "situation": "你最强，市场地位稳固",
        "base_strategy": "继续卡位，稳住份额",
        "acos_good": "ACOS 健康 → 维持出价与预算，巩固首位",
        "acos_bad": "ACOS 偏高 → 降 BID、降低 TOS 比例，用份额换利润",
    },
    Quadrant.Q2: {
        "situation": "份额不低但排名靠后，强劲竞品占主导",
        "base_strategy": "优化 Listing（标题/主图/A+/视频）提升转化与相关性",
        "acos_good": "ACOS 健康 → 加预算、抬 BID 争取更高排名",
        "acos_bad": "ACOS 差 → 评估是否退出或大幅控成本",
    },
    Quadrant.Q3: {
        "situation": "排名靠前但份额低，大词/类目词竞争激烈、曝光分散",
        "base_strategy": "数据好 → 冲 TOS（大词单词单组，BID +30%~50%）",
        "acos_good": "数据好 → 冲首页顶部，扩大 ASIN 定向 / SBV 覆盖",
        "acos_bad": "数据差但自然排名好 → 控 TOS bid，曝光投向中部/底部",
    },
    Quadrant.Q4: {
        "situation": "份额与排名都低，多为偏词或不精准词",
        "base_strategy": "检查相关性：不相关 → 否词并停投",
        "acos_good": "相关且市场量可观 → 小幅抬 BID 测试",
        "acos_bad": "市场量很低 → 不必投入，降 ACOS 或停投",
    },
}


def share_level(share_pct: float | None, thresholds: Thresholds) -> str | None:
    if share_pct is None or pd.isna(share_pct):
        return None
    return "高" if share_pct >= thresholds.share_high_pct else "低"


def rank_level(rank: float | None, thresholds: Thresholds) -> str | None:
    """排名高 = STIR 数字小（越好）。"""
    if rank is None or pd.isna(rank):
        return None
    return "高" if rank <= thresholds.rank_good_max else "低"


def classify_quadrant(
    share_pct: float | None,
    rank: float | None,
    thresholds: Thresholds,
) -> Quadrant | None:
    sl = share_level(share_pct, thresholds)
    rl = rank_level(rank, thresholds)
    if sl is None or rl is None:
        return None
    key = (sl, rl)
    mapping = {
        ("高", "高"): Quadrant.Q1,
        ("高", "低"): Quadrant.Q2,
        ("低", "高"): Quadrant.Q3,
        ("低", "低"): Quadrant.Q4,
    }
    return mapping.get(key)


def acos_is_good(acos_pct: float | None, thresholds: Thresholds) -> bool | None:
    if acos_pct is None or pd.isna(acos_pct):
        return None
    return acos_pct <= thresholds.acos_good_max_pct


def build_recommendation(
    quadrant: Quadrant | None,
    acos_pct: float | None,
    thresholds: Thresholds,
    total_market_impressions: float | None = None,
    overrides: dict[Quadrant, dict[str, str]] | None = None,
) -> str:
    if quadrant is None:
        return "Share 或 Rank 缺失，无法分类"
    base = QUADRANT_META[quadrant]
    meta = {**base, **(overrides.get(quadrant, {}) if overrides else {})}
    parts = [meta["situation"], meta["base_strategy"]]
    good = acos_is_good(acos_pct, thresholds)
    if good is True:
        parts.append(meta["acos_good"])
    elif good is False:
        parts.append(meta["acos_bad"])
    if total_market_impressions is not None and not pd.isna(total_market_impressions):
        parts.append(f"估算市场总曝光 ≈ {total_market_impressions:,.0f}")
    return "；".join(parts)


def estimate_market_impressions(
    your_impressions: float | None, share_pct: float | None
) -> float | None:
    """总曝光 = 你的曝光 ÷ (份额 / 100)"""
    if (
        your_impressions is None
        or share_pct is None
        or pd.isna(your_impressions)
        or pd.isna(share_pct)
        or share_pct <= 0
    ):
        return None
    return your_impressions / (share_pct / 100.0)


def enrich_analysis(
    summary: pd.DataFrame,
    thresholds: Thresholds,
    overrides: dict[Quadrant, dict[str, str]] | None = None,
) -> pd.DataFrame:
    """Add market volume, quadrant, and strategy columns to latest-term summary."""
    out = summary.copy()
    if "latest_impressions" in out.columns:
        out["market_impressions"] = out.apply(
            lambda r: estimate_market_impressions(
                r.get("latest_impressions"), r.get("latest_share")
            ),
            axis=1,
        )
        out["competitor_impressions"] = out.apply(
            lambda r: (
                r["market_impressions"] - r["latest_impressions"]
                if r.get("market_impressions") is not None
                and r.get("latest_impressions") is not None
                and not pd.isna(r["market_impressions"])
                else None
            ),
            axis=1,
        )
    else:
        out["market_impressions"] = None
        out["competitor_impressions"] = None

    out["share_level"] = out["latest_share"].map(
        lambda s: share_level(s, thresholds)
    )
    out["rank_level"] = out["latest_rank"].map(lambda r: rank_level(r, thresholds))
    out["quadrant"] = out.apply(
        lambda r: classify_quadrant(r["latest_share"], r["latest_rank"], thresholds),
        axis=1,
    )
    out["quadrant_label"] = out["quadrant"].map(
        lambda q: q.value if q is not None else None
    )
    out["strategy"] = out.apply(
        lambda r: build_recommendation(
            r["quadrant"],
            r.get("latest_acos"),
            thresholds,
            r.get("market_impressions"),
            overrides=overrides,
        ),
        axis=1,
    )
    return out


def quadrant_counts(enriched: pd.DataFrame) -> pd.DataFrame:
    counts = (
        enriched.dropna(subset=["quadrant_label"])
        .groupby("quadrant_label", as_index=False)
        .size()
        .rename(columns={"size": "count"})
    )
    return counts.sort_values("quadrant_label")
