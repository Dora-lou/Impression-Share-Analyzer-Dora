from __future__ import annotations

from io import BytesIO

import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import streamlit as st

from analysis import DocConfig, Quadrant, Thresholds, enrich_analysis, quadrant_counts
from data_loader import (
    DEFAULT_CSV,
    add_trend_metrics,
    filter_terms,
    load_impression_share_trends,
    report_has_impressions,
)
from doc_parser import parse_document_config

st.set_page_config(
    page_title="Amazon Impression Share 分析",
    page_icon="📊",
    layout="wide",
)

st.title("Amazon Impression Share 分析系统")
st.caption(
    "份额判断市场曝光 · 排名判断竞争强弱 · Share+曝光反推搜索量 · 四象限决定策略"
)


@st.cache_data(show_spinner="正在加载并聚合 CSV…")
def get_data_from_upload(file_bytes: bytes) -> tuple[pd.DataFrame, pd.DataFrame, bool]:
    bio = BytesIO(file_bytes)
    trends = load_impression_share_trends(bio)
    bio2 = BytesIO(file_bytes)
    has_imp = report_has_impressions(bio2)
    return trends, add_trend_metrics(trends), has_imp


def plot_term_trend(trends: pd.DataFrame, term: str) -> go.Figure:
    subset = trends[trends["search_term"] == term].sort_values("date")
    fig = go.Figure()
    fig.add_trace(
        go.Scatter(
            x=subset["date"],
            y=subset["impression_share"],
            mode="lines+markers",
            name="Impression Share %",
            line=dict(color="#2563eb", width=2),
            hovertemplate="%{x|%Y-%m-%d}<br>Share: %{y:.2f}%<extra></extra>",
        )
    )
    fig.add_trace(
        go.Scatter(
            x=subset["date"],
            y=subset["impression_rank"],
            mode="lines+markers",
            name="Impression Rank",
            yaxis="y2",
            line=dict(color="#f97316", width=2, dash="dot"),
            hovertemplate="%{x|%Y-%m-%d}<br>Rank: %{y:.0f}<extra></extra>",
        )
    )
    fig.update_layout(
        title=f"「{term}」Share / Rank 趋势",
        height=440,
        margin=dict(l=40, r=40, t=60, b=40),
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
        yaxis=dict(title="Share (%)", rangemode="tozero"),
        yaxis2=dict(
            title="Rank",
            overlaying="y",
            side="right",
            autorange="reversed",
        ),
        hovermode="x unified",
    )
    return fig


def plot_compare(trends: pd.DataFrame, terms: list[str]) -> go.Figure:
    subset = trends[trends["search_term"].isin(terms)]
    fig = px.line(
        subset,
        x="date",
        y="impression_share",
        color="search_term",
        markers=True,
        labels={
            "date": "日期",
            "impression_share": "Impression Share (%)",
            "search_term": "搜索词",
        },
        title="多词 Impression Share 对比",
    )
    fig.update_layout(height=420, hovermode="x unified")
    return fig


def plot_quadrant_scatter(enriched: pd.DataFrame, thresholds: Thresholds) -> go.Figure:
    plot_df = enriched.dropna(subset=["latest_share", "latest_rank"]).copy()
    plot_df["quadrant_label"] = plot_df["quadrant_label"].fillna("未分类")
    plot_df["bubble_size"] = (
        plot_df["latest_impressions"].fillna(10)
        if "latest_impressions" in plot_df.columns
        else 10
    )
    fig = px.scatter(
        plot_df,
        x="latest_share",
        y="latest_rank",
        color="quadrant_label",
        hover_name="search_term",
        size="bubble_size",
        labels={
            "latest_share": "Impression Share (%)",
            "latest_rank": "Impression Rank",
        },
        title="四象限分布（气泡大小 ≈ 你的曝光量）",
        color_discrete_sequence=px.colors.qualitative.Set2,
    )
    fig.add_hline(
        y=thresholds.rank_good_max + 0.5,
        line_dash="dash",
        line_color="#64748b",
        annotation_text=f"排名分界 (≤{thresholds.rank_good_max} 为高排名)",
    )
    fig.add_vline(
        x=thresholds.share_high_pct,
        line_dash="dash",
        line_color="#64748b",
        annotation_text=f"份额分界 ({thresholds.share_high_pct}%)",
    )
    fig.update_yaxes(autorange="reversed", title="Rank（越小越好）")
    fig.update_layout(height=480)
    return fig


with st.sidebar:
    st.header("数据源")
    uploaded = st.file_uploader("上传 Impression Share 报告 CSV", type=["csv"])

    if uploaded is not None:
        trends, summary, has_impressions = get_data_from_upload(uploaded.getvalue())
        csv_label = uploaded.name
    else:
        # GitHub-friendly: do not read any local absolute path.
        # When no upload is provided, fall back to the bundled sample dataset.
        trends = load_impression_share_trends(DEFAULT_CSV)
        summary = add_trend_metrics(trends)
        has_impressions = True
        csv_label = "data/sample_report.csv"

    st.success(f"已加载：{csv_label}")
    if not has_impressions:
        st.warning(
            "CSV 无 Impressions 列，无法反推市场总曝光。"
            "请下载含 Impressions 的 Search Term Impression Share 报告。"
        )

    st.divider()
    st.header("文档输入（用于覆盖规则）")
    doc_text = st.text_area(
        "粘贴你的文档内容（可选）",
        height=180,
        placeholder="把你要系统遵循的分析文档粘贴到这里…",
    )
    doc_cfg: DocConfig | None = None
    if doc_text.strip():
        try:
            doc_cfg = parse_document_config(doc_text)
            st.caption(
                f"已解析阈值：高份额≥{doc_cfg.thresholds.share_high_pct:.1f}% · "
                f"高排名≤{doc_cfg.thresholds.rank_good_max} · "
                f"ACOS≤{doc_cfg.thresholds.acos_good_max_pct:.1f}%"
            )
        except Exception as e:
            st.error(f"文档解析失败：{e}")
            doc_cfg = None

    st.divider()
    st.header("四象限阈值")
    default_share = doc_cfg.thresholds.share_high_pct if doc_cfg else 30.0
    default_rank = doc_cfg.thresholds.rank_good_max if doc_cfg else 3
    default_acos = doc_cfg.thresholds.acos_good_max_pct if doc_cfg else 30.0
    share_high = st.slider("高份额下限 (%)", 5.0, 80.0, float(default_share), 5.0)
    rank_good = st.slider("高排名上限 (Rank≤)", 1, 10, int(default_rank))
    acos_good = st.slider("ACOS 健康上限 (%)", 5.0, 60.0, float(default_acos), 5.0)
    thresholds = Thresholds(
        share_high_pct=share_high,
        rank_good_max=rank_good,
        acos_good_max_pct=acos_good,
    )

countries = sorted(trends["Country"].dropna().unique())
with st.sidebar:
    st.divider()
    st.header("筛选")
    if len(countries) > 1:
        picked = st.selectbox("国家", ["全部"] + countries)
    else:
        picked = "全部"

if picked != "全部":
    trends = trends[trends["Country"] == picked]
    summary = add_trend_metrics(trends)

overrides = doc_cfg.strategy_overrides if doc_cfg else None
enriched = enrich_analysis(summary, thresholds, overrides=overrides)

date_min, date_max = trends["date"].min(), trends["date"].max()
term_count = trends["search_term"].nunique()
day_count = trends["date"].nunique()

col1, col2, col3, col4 = st.columns(4)
col1.metric("搜索词数量", f"{term_count:,}")
col2.metric("日期范围", f"{date_min:%Y-%m-%d} → {date_max:%Y-%m-%d}")
col3.metric("天数", day_count)
col4.metric("数据点", f"{len(trends):,}")

with st.expander("核心公式与指标说明", expanded=False):
    st.markdown(
        """
        | 作用 | 指标 |
        |------|------|
        | 判断市场曝光份额 | **Impression Share** |
        | 判断竞争强弱 | **Impression Rank**（数字越小越好） |
        | 反推真实搜索量/市场曝光 | **Share + 跨组累加的你的曝光** |
        | 决定广告策略 | **Share + Rank 四象限** |

        **市场总曝光** = 你的曝光 ÷ (份额 ÷ 100)

        例：曝光 300、份额 30% → 市场总曝光 ≈ 1,000

        同一搜索词须 **跨 Campaign / 广告组累加 Impressions**；Share/Rank 为账户级，各 Campaign 相同。
        """
    )

tab_overview, tab_market, tab_quadrant, tab_term, tab_compare, tab_movers = st.tabs(
    ["总览", "市场曝光", "四象限策略", "单词趋势", "多词对比", "涨跌榜"]
)

with tab_overview:
    st.subheader("最新 Impression Share 一览")
    search = st.text_input("搜索词过滤（包含匹配）", key="overview_search")
    min_obs = st.slider("最少出现天数", 1, int(day_count), 2, key="overview_days")
    view = filter_terms(enriched, search)
    view = view[view["observations"] >= min_obs]
    cols = [
        "search_term",
        "latest_date",
        "latest_share",
        "latest_rank",
        "quadrant_label",
        "share_change",
        "rank_change",
        "observations",
    ]
    if "latest_impressions" in view.columns:
        cols.insert(4, "latest_impressions")
    if "market_impressions" in view.columns:
        cols.insert(5, "market_impressions")
    display = view[cols].copy()
    rename = {
        "search_term": "搜索词",
        "latest_date": "最新日期",
        "latest_share": "Share %",
        "latest_rank": "Rank",
        "latest_impressions": "你的曝光",
        "market_impressions": "市场总曝光",
        "quadrant_label": "象限",
        "share_change": "Share 变化",
        "rank_change": "Rank 变化",
        "observations": "天数",
    }
    display = display.rename(columns={k: v for k, v in rename.items() if k in display.columns})
    fmt = {
        "Share %": "{:.2f}",
        "Share 变化": "{:+.2f}",
        "Rank": "{:.0f}",
        "Rank 变化": "{:+.0f}",
    }
    if "你的曝光" in display.columns:
        fmt["你的曝光"] = "{:,.0f}"
    if "市场总曝光" in display.columns:
        fmt["市场总曝光"] = "{:,.0f}"
    st.dataframe(
        display.style.format(fmt, na_rep="—"),
        use_container_width=True,
        height=480,
    )

with tab_market:
    st.subheader("市场总曝光估算")
    st.markdown(
        "按公式 **市场总曝光 = 你的曝光 ÷ (Share% ÷ 100)** 反推该词在市场的真实曝光规模。"
    )
    if not has_impressions:
        st.info("当前报告缺少 Impressions，请重新下载完整报告后再分析。")
    else:
        m_search = st.text_input("搜索词过滤", key="market_search")
        m_view = filter_terms(enriched, m_search).dropna(
            subset=["market_impressions", "latest_share"]
        )
        m_view = m_view.sort_values("market_impressions", ascending=False)
        show = m_view[
            [
                "search_term",
                "latest_impressions",
                "latest_share",
                "market_impressions",
                "competitor_impressions",
                "latest_rank",
            ]
        ].head(500)
        show.columns = [
            "搜索词",
            "你的曝光",
            "Share %",
            "市场总曝光",
            "竞品曝光",
            "Rank",
        ]
        st.dataframe(
            show.style.format(
                {
                    "你的曝光": "{:,.0f}",
                    "Share %": "{:.2f}",
                    "市场总曝光": "{:,.0f}",
                    "竞品曝光": "{:,.0f}",
                    "Rank": "{:.0f}",
                }
            ),
            use_container_width=True,
            height=480,
        )
        top = m_view.nlargest(15, "market_impressions")
        if len(top):
            fig = px.bar(
                top,
                x="search_term",
                y="market_impressions",
                title="市场总曝光 Top 15",
                labels={"market_impressions": "市场总曝光", "search_term": "搜索词"},
            )
            fig.update_layout(xaxis_tickangle=-35, height=400)
            st.plotly_chart(fig, use_container_width=True)

with tab_quadrant:
    st.subheader("四象限策略分析")
    c_chart, c_table = st.columns([1, 1])
    with c_chart:
        st.plotly_chart(plot_quadrant_scatter(enriched, thresholds), use_container_width=True)
    with c_table:
        st.markdown("**各象限词数**")
        st.dataframe(quadrant_counts(enriched), use_container_width=True, hide_index=True)

    st.markdown("#### 完整优化模型")
    model = pd.DataFrame(
        [
            ["高", "高 (Rank小)", "你最强", "继续卡位 / 控 ACOS"],
            ["高", "低", "强劲竞品", "优化 Listing / 抬 BID / 判断是否退出"],
            ["低", "高", "卷大词", "冲 TOS 或控成本"],
            ["低", "低", "不重要词", "否词 / 降投入 / 小量测试"],
        ],
        columns=["份额", "排名", "情况", "优化方向"],
    )
    st.table(model)

    q_filter = st.multiselect(
        "筛选象限",
        options=[q.value for q in Quadrant],
        default=[q.value for q in Quadrant],
    )
    q_search = st.text_input("搜索词过滤", key="quad_search")
    q_view = filter_terms(enriched, q_search)
    q_view = q_view[q_view["quadrant_label"].isin(q_filter)]
    strat_cols = [
        "search_term",
        "latest_share",
        "latest_rank",
        "share_level",
        "rank_level",
        "quadrant_label",
        "strategy",
    ]
    if "latest_acos" in q_view.columns:
        strat_cols.insert(4, "latest_acos")
    st.dataframe(
        q_view[strat_cols]
        .rename(
            columns={
                "search_term": "搜索词",
                "latest_share": "Share %",
                "latest_rank": "Rank",
                "latest_acos": "ACOS %",
                "share_level": "份额",
                "rank_level": "排名",
                "quadrant_label": "象限",
                "strategy": "策略建议",
            }
        )
        .style.format({"Share %": "{:.2f}", "ACOS %": "{:.2f}", "Rank": "{:.0f}"}),
        use_container_width=True,
        height=420,
    )

with tab_term:
    st.subheader("单个搜索词趋势")
    term_query = st.text_input("输入或搜索词", key="term_pick")
    candidates = summary["search_term"].tolist()
    if term_query.strip():
        matches = [t for t in candidates if term_query.lower() in t.lower()]
    else:
        matches = summary.head(200)["search_term"].tolist()
    if not matches:
        st.warning("没有匹配的搜索词")
    else:
        selected = st.selectbox("选择搜索词", matches, index=0)
        row = enriched[enriched["search_term"] == selected].iloc[0]
        m1, m2, m3, m4 = st.columns(4)
        m1.metric("最新 Share", f"{row['latest_share']:.2f}%" if pd.notna(row["latest_share"]) else "—")
        m2.metric("最新 Rank", f"{row['latest_rank']:.0f}" if pd.notna(row["latest_rank"]) else "—")
        if "market_impressions" in row and pd.notna(row.get("market_impressions")):
            m3.metric("市场总曝光", f"{row['market_impressions']:,.0f}")
        if row.get("quadrant_label"):
            m4.metric("象限", row["quadrant_label"])
        if row.get("strategy"):
            st.info(row["strategy"])
        st.plotly_chart(plot_term_trend(trends, selected), use_container_width=True)
        detail = trends[trends["search_term"] == selected].sort_values("date", ascending=False)
        detail_cols = ["date", "impression_share", "impression_rank"]
        names = ["日期", "Share %", "Rank"]
        if "impressions" in detail.columns:
            detail_cols.append("impressions")
            names.append("曝光（合计）")
        st.dataframe(
            detail[detail_cols].rename(columns=dict(zip(detail_cols, names))),
            use_container_width=True,
        )

with tab_compare:
    st.subheader("多个搜索词对比")
    default_compare = summary.head(5)["search_term"].tolist()
    compare_terms = st.multiselect(
        "选择要对比的搜索词（最多 8 个）",
        options=summary["search_term"].tolist(),
        default=default_compare[:3],
        max_selections=8,
    )
    if compare_terms:
        st.plotly_chart(plot_compare(trends, compare_terms), use_container_width=True)
    else:
        st.info("请至少选择一个搜索词")

with tab_movers:
    st.subheader("Share 涨跌榜（首日到末日）")
    min_days = st.slider("最少天数", 2, int(day_count), 3, key="mover_days")
    movers = summary[summary["observations"] >= min_days].dropna(subset=["share_change"])
    c_up, c_down = st.columns(2)
    with c_up:
        st.markdown("**Share 上升 Top 20**")
        st.dataframe(
            movers.nlargest(20, "share_change")[
                ["search_term", "first_share", "latest_share", "share_change", "observations"]
            ].rename(
                columns={
                    "search_term": "搜索词",
                    "first_share": "首日 %",
                    "latest_share": "末日 %",
                    "share_change": "变化",
                    "observations": "天数",
                }
            ),
            use_container_width=True,
        )
    with c_down:
        st.markdown("**Share 下降 Top 20**")
        st.dataframe(
            movers.nsmallest(20, "share_change")[
                ["search_term", "first_share", "latest_share", "share_change", "observations"]
            ].rename(
                columns={
                    "search_term": "搜索词",
                    "first_share": "首日 %",
                    "latest_share": "末日 %",
                    "share_change": "变化",
                    "observations": "天数",
                }
            ),
            use_container_width=True,
        )
