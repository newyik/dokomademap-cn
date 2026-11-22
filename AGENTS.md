# 特斯拉充电地图（日本超充可达范围地图）· 开发说明

面向 Tesla Model 3 双电机长续航版的日本超充可达范围模拟网页，带车中泊气温估算、轮渡航线、第三方 NACS 充电站，以及对接 NAS 上 TeslaMate 的「我的车 / 最近行程」功能。以后只在这个目录开发。

## ⚠️ 公开仓库：绝对不能放密钥或私人信息

- 仓库是**公开的**（`newyik/dokomademap-cn`），任何人都能看到代码和提交记录。
- 绝对不能提交 `nas/.env`、`TM_ENCRYPTION_KEY`、`TM_DB_PASS`、`BRIDGE_TOKEN`、个人 NAS 域名 / Tunnel 地址、车辆定位或行程数据。
- **推送前必须先问仓库主人**，提交可以在本地做。

## 组成

| 部分 | 位置 | 是什么 |
|---|---|---|
| 前端网页 | `public/index.html`、`public/app.js`、`public/style.css`、`public/manifest.json` | 纯静态前端，无构建步骤。线上：https://newyik.github.io/dokomademap-cn/ |
| 静态数据 | `public/data/` | 预生成的路网（`graph.bin`、`landgrid.bin`）、超充站（`superchargers.json`）、第三方 NACS（`nacs_chargers.json`）、轮渡（`ferries.json`）、车中泊点（`camp_spots.json`） |
| 数据脚本 | `scripts/` | 抓取公开数据并生成 `public/data/` 里的文件（`fetch_sources.py`、`build_data.py`、`update_chargers.py`、`build_third_party_nacs.py`、`build_camp_spots.py`） |
| NAS 桥接 | `nas/` | 部署在用户自己 NAS 上的 Docker 配置（`docker-compose.yml`）和状态/行程桥接服务（`bridge.py`），说明见 `nas/README.md` |
| 自动任务 | `.github/workflows/` | `pages.yml`（推送 `main` 自动部署 `public/`）；`sync-chargers.yml`（每周一 03:00 JST 自动同步充电站数据并提交回 `main`） |

## 开发规矩

- **没有前端构建步骤**：直接改 `public/` 里的 HTML / CSS / JS，不要引入打包工具或重型框架。
- **先拉最新代码再动手**：GitHub Actions 每周一会自动往 `main` 提交充电站更新，开始改之前先 `git pull`，避免冲突。
- **改 `nas/bridge.py` 不会自动更新到 NAS**：推到 GitHub 后，还要提醒用户把新的 `bridge.py` 覆盖到 NAS 上并执行 `docker compose restart tesla-sync-bridge`。
- **删除行程接口有破坏性**：`DELETE /drives/<id>` 会永久删掉 TeslaMate 数据库里的记录，不要在没确认的情况下改动删除保护逻辑（例如 `BRIDGE_TOKEN` 校验和进行中行程保护）。

## 本地预览与数据更新

- **本地预览**：
  ```bash
  python3 -m http.server 8765 -d public
  ```
  浏览器打开 http://localhost:8765/ 即可测试。

- **更新充电站 / 路网数据（可选，需要 Python 依赖如 numpy、scipy）**：
  ```bash
  python3 scripts/update_chargers.py
  python3 scripts/build_third_party_nacs.py
  ```
  完整重抓路网与高程数据需要 `scripts/fetch_sources.py` 和 `scripts/build_data.py`，缓存目录 `raw_cache/` 和 `.venv/` 已在 `.gitignore` 中忽略，不要提交。

## 发布

- GitHub Actions（`.github/workflows/pages.yml`）在推送到 **`main`** 分支后，会自动把 `public/` 目录发布到 https://newyik.github.io/dokomademap-cn/。
- 推送前必须先问用户。
