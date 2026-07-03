# Maple & Main — 部署说明

这是一个 Node.js + Express 项目，包含：
- `public/customer-order.html` — 顾客点餐页（公开链接）
- `public/restaurant-orders.html` — 餐馆接单看板（内部使用，不要公开分享）
- `public/admin.html` — 菜单/网站信息管理后台（**已加密码保护**）
- `server.js` — 后端服务，负责存储菜单和订单数据

## 第一步：上传到 GitHub

1. 打开 https://github.com ，登录你的账号（没有就免费注册一个）。
2. 右上角 `+` → `New repository`，起个名字（比如 `maple-and-main`），选择 **Private**（私有，别人搜不到），点 `Create repository`。
3. 把这个文件夹里的所有文件上传上去。最简单的方式：
   - 打开你新建的仓库页面
   - 点击 `uploading an existing file` 链接
   - 把这整个文件夹里的文件（包括 `public` 子文件夹）拖进去
   - 下面写个提交说明，比如 `first upload`，点 `Commit changes`

## 第二步：在 Render 上部署

1. 打开 https://render.com ，用 GitHub 账号登录（会自动关联你的仓库）。
2. 点 `New` → `Web Service`。
3. 选择你刚才上传的 `maple-and-main` 仓库。
4. 设置里：
   - **Name**：随便起，比如 `maple-and-main`
   - **Region**：选离你顾客最近的（比如 US West/East）
   - **Build Command**：`npm install`
   - **Start Command**：`npm start`
   - **Instance Type**：先选免费的 `Free` 试用即可
5. 往下翻，找到 **Environment Variables**，添加两个：
   - `ADMIN_USER` → 你自己起的后台用户名，比如 `owner`
   - `ADMIN_PASSWORD` → 一个只有你知道的密码，比如 `MyStrongPass123`
   （**这一步很重要** — 不设置的话后台会用默认密码 `admin` / `changeme`，任何人都能猜到进去改菜单）
6. 点击 `Create Web Service`，等几分钟部署完成。

## 第三步：拿到你的网址

部署完成后 Render 会给你一个网址，类似：

```
https://maple-and-main.onrender.com
```

三个页面分别是：
- 顾客点餐（可以公开分享、做成二维码）：
  `https://maple-and-main.onrender.com/customer-order.html`
- 餐馆接单看板（只给店里平板用，别公开）：
  `https://maple-and-main.onrender.com/restaurant-orders.html`
- 管理后台（打开会要求输入用户名密码）：
  `https://maple-and-main.onrender.com/admin.html`

## 需要知道的几件事

- **免费版 Render 有"休眠"机制**：如果 15 分钟没人访问，服务会休眠，下一次有人打开链接时需要等 30~60 秒才能唤醒。正式营业期间如果不希望这种延迟，需要升级到付费的 Starter 套餐（月费几美元起）。
- **订单数据保存在 `data.json` 文件里**：这种方式对小餐馆够用，但如果你之后重新部署代码（比如让我帮你改功能后重新上传），这个文件会被清空重置。真正长期稳定运营建议之后升级成数据库（比如 Render 自带的免费 PostgreSQL），我可以后续帮你迁移。
- **改完代码要重新上传到 GitHub**：以后每次我帮你改功能，你只需要把新文件重新上传替换到 GitHub 仓库里，Render 会自动检测到变化并重新部署，不用重新设置一遍。
