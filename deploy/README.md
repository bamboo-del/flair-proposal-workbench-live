# 阿里云路演部署

路演入口为 `https://flair.yisonglian.cn/roadshow`。`flair.yisonglian.cn` 的 A 记录指向现有杭州 ECS `101.37.147.197`。

1. 将不含 `.env` 和 SQLite 数据的版本包上传至 ECS。校验包的 SHA-256，再解包到 `/opt/flair-proposal/releases/<版本>`。
2. 在 `/opt/flair-proposal/shared/app.env` 保存服务端配置，权限设为 `0600`，所有者为 `root`。使用项目 `.env.example` 中的字段。
3. 执行 `bash /opt/flair-proposal/releases/<版本>/deploy/aliyun.sh /opt/flair-proposal/releases/<版本>`。

部署使用 `flair-proposal` Compose 项目和 `flair-proposal_flair-data` 数据卷。应用通过现有 Caddy 提供 HTTPS，容器以 `flair-proposal-web` 接入边缘网络。

首次部署会追加该子域的代理配置并保留旧 Caddy 配置备份，随后检查路演页、Wi-Fi API、Wi-Fi 管理端和 ClassFlow 的 HTTPS。更新应用时保留原数据卷。需要撤回路演入口时，仅移除 `# BEGIN flair-proposal` 到 `# END flair-proposal` 的独立配置块，验证 Caddy 配置并平滑重载。
