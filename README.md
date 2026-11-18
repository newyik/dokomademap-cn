# 日本超充可达范围地图 · Model 3 双电机长续航中文版

完全独立构建的日本特斯拉超级充电站单次充电可达范围模拟地图，专为 **Tesla Model 3 双电机长续航版（AWD）** 定制预设，打开即用、全中文界面，无需每次手动选车。

## 功能特性

- **固定车型免选择**：已默认锁定 `Model 3 双电机长续航（75 kWh 可用基准 / 600 km 满电参考 / 160 Wh/km）`，同时支持微调电耗、满电续航与出发/到达保留电量，并自动记忆个人设置。
- **真实物理与路网模型**：
  - 基于 OpenStreetMap 日本高速道路（Motorway）、主要国道（Trunk / Primary）及离岛干道，按最短时间路径计算能耗，尊重单行道与高速匝道方向。
  - 结合日本国土地理院公开高程瓦片（DEM）计算上下坡能耗与下坡动能回收（桥梁与隧道段已做高程平滑处理）。
  - 支持 **往返行程**（分别校验去程与回程方向及上下坡）、**冬季模式（+28% 能耗）**。
- **日本国内汽车轮渡支持**：自动筛选当前剩余电量可抵达港口的汽车轮渡航线，支持辨识船上提供约 3 kW EV 充电的航线（如商船三井 Sunflower 大阪〜别府/志布志、阪九轮渡等）。
- **纯静态前端运行**：浏览器端使用 TypedArray + 二叉堆 Dijkstra 实时计算，无任何后端依赖，可本地启动或直接托管到静态空间。

## 公开数据来源

- **超充站点**：[supercharge.info](https://supercharge.info/) 公开站点 API
- **道路与轮渡路网**：[OpenStreetMap](https://www.openstreetmap.org/)（Geofabrik 日本 PBF 数据）
- **高程与陆地掩码**：日本[国土地理院](https://maps.gsi.go.jp/) 公开标高瓦片（`dem_png` / `demgm_png`）
- **底图渲染**：[MapLibre GL JS](https://maplibre.org/) + [OpenFreeMap](https://openfreemap.org/)

## 本地启动与数据更新

1. **启动静态服务**：
   ```bash
   python3 -m http.server 8765 -d public
   ```
   浏览器打开 `http://localhost:8765` 即可使用。

2. **更新公开数据与重新构建（可选）**：
   ```bash
   .venv/bin/python scripts/fetch_sources.py
   .venv/bin/python scripts/build_data.py
   ```
