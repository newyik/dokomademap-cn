# NAS 部署指南（TeslaMate + 状态桥接）

将本目录（`nas/`）复制到你的 NAS 上（群晖 Container Manager / 威联通 Container Station / 飞牛 / 通用 Docker 均可），即可把你的 Model 3 实时电量、位置与近期电耗同步到「超充可达」网页。

## 你需要做的 4 步

1. **创建环境变量文件 `.env`**（与 `docker-compose.yml` 同目录）：
   ```env
   TM_ENCRYPTION_KEY=随便填一串32位随机字母数字
   TM_DB_PASS=随便填一个数据库密码
   BRIDGE_TOKEN=你自定义的访问密钥（填到网页里用）
   ```

2. **启动容器**：
   ```bash
   docker compose up -d
   ```

3. **登录特斯拉账号**：
   - 在局域网浏览器打开 `http://你的NAS_IP:4000`
   - 按 TeslaMate 界面提示用 Tesla App 授权登录你的车辆即可开始记录。

4. **在外面手机访问的配置**：
   - 使用 **Cloudflare Tunnel** 或 **Tailscale** / NAS 反向代理（HTTPS），将 NAS 的 `8090` 端口映射出来（例如 `https://tesla.你的域名`）。
   - 打开 `https://newyik.github.io/dokomademap-cn/`，点击顶部 **`🚗 我的车`**，填入接口地址（例如 `https://tesla.你的域名/status`）和 `BRIDGE_TOKEN`，点击「同步并查看紫色辐射」即可。

> 不登录时，接口地址和密钥**只保存在你自己的浏览器本地存储**。
> 在「我的车」里用小家控账号登录后，会额外存到小家控的 Supabase（表 `dokomademap_nas_bindings`，每个账号只能读写自己那一行），换设备登录就能自动取回。建表语句见 `supabase/001_nas_bindings.sql`。

## 行程、统计与足迹解锁

网页里打开「我的车」后，点卡片上的行程图标（或底部胶囊左边的图标），可以按「**全部 / 年 / 月**」查看累计行驶里程、累计充电量、累计驾驶时长，并分页浏览全部历史行程；点右上角「**足迹地图**」可在地图上点亮开车经过的区域网格与路线（支持迷雾遮罩与按年/按月切换）。

桥接接口提供这几个地址（和 `/status` 用同一个前缀、同一个密钥）：

| 地址 | 作用 |
|---|---|
| `GET /stats?period=all\|YYYY\|YYYY-MM` | 累计或指定年/月的总里程、总充电量、总行程数与可用年月 |
| `GET /drives?limit=20&offset=0&period=...` | 历史行程分页列表，含简化轨迹与总条数 |
| `GET /drives/<id>` | 单段行程的完整轨迹 |
| `GET /footprint?period=all\|YYYY\|YYYY-MM` | 已探索区域网格（约 2km）、轻量轨迹与去过的县市 |
| `DELETE /drives/<id>` | **永久删除**这段行程和它的轨迹点 |

- 删除会直接改 TeslaMate 数据库，删了找不回来，TeslaMate 自己的统计也会少掉这一段。正在进行中的行程不能删。
- 没设置 `BRIDGE_TOKEN` 时，删除功能自动关闭。

### 已经部署过的，怎么更新

1. 把新的 `bridge.py` 覆盖到 NAS 上原来的位置。
2. 重启桥接容器：
   ```bash
   docker compose restart tesla-sync-bridge
   ```
