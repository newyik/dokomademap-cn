# NAS 部署指南（TeslaMate + 只读状态桥接）

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

> 接口地址和密钥**只保存在你自己的浏览器本地存储**，不会上传到任何第三方服务器或 GitHub。
