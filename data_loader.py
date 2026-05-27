from __future__ import annotations

import re
from datetime import datetime
from io import BytesIO
from pathlib import Path
from typing import BinaryIO

import pandas as pd

DEFAULT_CSV = Path(__file__).resolve().parent / "data" / "sample_report.csv"

DATE_FMT = "%b %d, %Y"

# Core columns; optional metrics loaded when present in CSV
CORE_COLUMNS = [
    "Date",
    "Country",
    "Customer Search Term",
    "Search Term Impression Rank",
    "Search Term Impression Share",
]
OPTIONAL_COLUMNS = [
    "Impressions",
    "Clicks",
    "Spend",
    "Total Advertising Cost of Sales (ACOS)",
    "Click-Thru Rate (CTR)",
    "14 Day Total Orders (#)",
    "14 Day Total Sales",
    "Campaign Name",
    "Ad Group Name",
    "Targeting",
    "Match Type",
]


def parse_share(value: str | float) -> float | None:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    text = str(value).strip()
    if not text:
        return None
    text = text.replace("%", "").replace(",", "")
    try:
        return float(text)
    except ValueError:
        return None


def parse_acos(value: str | float) -> float | None:
    return parse_share(value)


def parse_numeric(value) -> float | None:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    text = str(value).strip().replace(",", "").replace("$", "")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_date(value: str) -> datetime:
    return datetime.strptime(value.strip(), DATE_FMT)


def _columns_present(header: list[str]) -> tuple[list[str], list[str]]:
    core = [c for c in CORE_COLUMNS if c in header]
    optional = [c for c in OPTIONAL_COLUMNS if c in header]
    return core, optional


def load_raw_report(csv_source: str | Path | BinaryIO) -> pd.DataFrame:
    """Load report with all available columns."""
    if isinstance(csv_source, (str, Path)):
        peek = pd.read_csv(csv_source, nrows=0, encoding="utf-8-sig")
    else:
        peek = pd.read_csv(csv_source, nrows=0, encoding="utf-8-sig")
        csv_source.seek(0)

    # Amazon exports sometimes contain trailing spaces in headers.
    header = [str(c).strip() for c in peek.columns.tolist()]
    core, optional = _columns_present(header)
    wanted = set(core + optional)
    raw = pd.read_csv(
        csv_source,
        usecols=lambda c: str(c).strip() in wanted,
        encoding="utf-8-sig",
        low_memory=False,
    )
    raw = raw.rename(columns=lambda c: str(c).strip())
    raw["date"] = pd.to_datetime(raw["Date"].map(parse_date))
    raw["impression_share"] = raw["Search Term Impression Share"].map(parse_share)
    raw["impression_rank"] = pd.to_numeric(
        raw["Search Term Impression Rank"], errors="coerce"
    )
    if "Impressions" in raw.columns:
        raw["impressions"] = raw["Impressions"].map(parse_numeric)
    if "Clicks" in raw.columns:
        raw["clicks"] = raw["Clicks"].map(parse_numeric)
    if "Spend" in raw.columns:
        raw["spend"] = raw["Spend"].map(parse_numeric)
    if "Total Advertising Cost of Sales (ACOS)" in raw.columns:
        raw["acos"] = raw["Total Advertising Cost of Sales (ACOS)"].map(parse_acos)
    return raw.rename(columns={"Customer Search Term": "search_term"})


def load_impression_share_trends(csv_source: str | Path | BinaryIO) -> pd.DataFrame:
    """
    One row per (date, search term, country).

    Impressions are summed across campaigns/ad groups (跨广告组累加).
    Share/Rank are account-level per term — take first non-null per group.
    """
    raw = load_raw_report(csv_source)
    has_impressions = "impressions" in raw.columns

    agg_spec: dict = {
        "impression_share": ("impression_share", "first"),
        "impression_rank": ("impression_rank", "first"),
    }
    if has_impressions:
        agg_spec["impressions"] = ("impressions", "sum")
    if "clicks" in raw.columns:
        agg_spec["clicks"] = ("clicks", "sum")
    if "spend" in raw.columns:
        agg_spec["spend"] = ("spend", "sum")
    if "acos" in raw.columns:
        agg_spec["acos"] = ("acos", "first")

    trends = (
        raw.groupby(["date", "search_term", "Country"], as_index=False)
        .agg(**agg_spec)
        .sort_values(["search_term", "date"])
    )
    return trends


def add_trend_metrics(trends: pd.DataFrame) -> pd.DataFrame:
    """Latest snapshot plus first-to-last change per search term."""
    sorted_df = trends.sort_values(["search_term", "date"])

    latest = sorted_df.groupby("search_term", as_index=False).tail(1)
    earliest = sorted_df.groupby("search_term", as_index=False).head(1)
    obs = trends.groupby("search_term").size().reset_index(name="observations")

    latest_cols = {
        "date": "latest_date",
        "impression_share": "latest_share",
        "impression_rank": "latest_rank",
    }
    if "impressions" in trends.columns:
        latest_cols["impressions"] = "latest_impressions"
    if "acos" in trends.columns:
        latest_cols["acos"] = "latest_acos"
    if "spend" in trends.columns:
        latest_cols["spend"] = "latest_spend"
    if "clicks" in trends.columns:
        latest_cols["clicks"] = "latest_clicks"

    latest = latest.rename(columns=latest_cols)[
        ["search_term"] + list(latest_cols.values())
    ]

    earliest = earliest.rename(
        columns={
            "date": "first_date",
            "impression_share": "first_share",
            "impression_rank": "first_rank",
        }
    )[["search_term", "first_date", "first_share", "first_rank"]]

    summary = latest.merge(earliest, on="search_term").merge(obs, on="search_term")
    summary["share_change"] = summary["latest_share"] - summary["first_share"]
    summary["rank_change"] = summary["latest_rank"] - summary["first_rank"]
    return summary.sort_values("latest_share", ascending=False, na_position="last")


def filter_terms(summary: pd.DataFrame, query: str) -> pd.DataFrame:
    if not query.strip():
        return summary
    pattern = re.escape(query.strip().lower())
    mask = summary["search_term"].str.lower().str.contains(pattern, regex=True)
    return summary[mask]


def report_has_impressions(csv_source: str | Path | BinaryIO) -> bool:
    if isinstance(csv_source, (str, Path)):
        peek = pd.read_csv(csv_source, nrows=0, encoding="utf-8-sig")
    else:
        pos = csv_source.tell()
        peek = pd.read_csv(csv_source, nrows=0, encoding="utf-8-sig")
        csv_source.seek(pos)
    return "Impressions" in [str(c).strip() for c in peek.columns.tolist()]
