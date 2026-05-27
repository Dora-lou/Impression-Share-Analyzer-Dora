# Amazon Impression Share 分析系统

基于 **Search Term Impression Share / Rank** 的决策分析：反推市场曝光、四象限分类、策略建议，并保留趋势与涨跌榜功能。

## 核心能力

| 作用 | 指标 / 方法 |
|------|-------------|
| 判断市场曝光份额 | Impression Share |
| 判断竞争强弱 | Impression Rank（数字越小越好） |
| 反推真实搜索量 | 市场总曝光 = 你的曝光 ÷ (Share% ÷ 100) |
| 决定广告策略 | Share + Rank 四象限 + ACOS |

## 四象限模型

| 份额 | 排名 | 情况 | 优化方向 |
|------|------|------|----------|
| 高 | 高 (Rank≤阈值) | 你最强 | 继续卡位 / 控 ACOS |
| 高 | 低 | 强劲竞品 | 优化 Listing / 抬 BID / 判断是否退出 |
| 低 | 高 | 卷大词 | 冲 TOS 或控成本 |
| 低 | 低 | 不重要词 | 否词 / 降投入 / 小量测试 |

侧边栏可调整：**高份额下限**、**高排名上限（Rank 数字）**、**ACOS 健康线**。

## 数据要求

- 报告类型：Amazon **Sponsored Products → Search Term Impression Share**
- 必须含：`Customer Search Term`、`Search Term Impression Share`、`Search Term Impression Rank`、`Date`
- **反推市场曝光** 需含 `Impressions` 列；系统会按 **日期 + 搜索词 + 国家** 对 Impressions **跨 Campaign/广告组求和**
- 可选：`ACOS`、`Spend`、`Clicks` 等，用于策略中的 ACOS 分支

## 运行

### 方式 A（推荐，离线免安装）

直接双击打开 `index.html`，上传你的文件即可使用（无需 Python / pip）。

支持格式：
- `.xlsx` / `.xls`（读取第一个工作表）
- `.csv`
- `.txt`（会优先按制表符 TSV 解析，失败则按 CSV 解析）

### 方式 B（Python/Streamlit 版）

1. Python 3.10+
2. 双击 `run.bat` 或：

```bash
pip install -r requirements.txt
streamlit run app.py
```

3. 打开 `http://localhost:8501`

- **使用方式**：在侧边栏 **上传** 你的 `Sponsored_Products_Search_Term_Impression_Share_report.csv`
- **无数据也可启动**：不上传时会使用 `data/sample_report.csv`（便于 GitHub 直接跑）

## 项目结构

- `data_loader.py` — 解析 CSV、跨组累加曝光、趋势汇总
- `analysis.py` — 市场曝光公式、四象限、策略文案
- `app.py` — Streamlit 界面
- `doc_parser.py` — 粘贴“分析文档”后，抽取阈值/规则覆盖系统默认逻辑
- `index.html` / `impression-share.js` — 离线版（浏览器本地解析 CSV）
