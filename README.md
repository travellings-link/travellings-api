## Travellings-API
[![wakatime](https://wakatime.com/badge/github/travellings-link/travellings-api.svg)](https://wakatime.com/badge/github/travellings-link/travellings-api)
New API For Travellings Project（Node.js + Express）  
不代表最终品质

## 环境
- Node.JS ≥ 18
- MySQL ≥ 8.0
- Redis ≥ 7.0
- pnpm

## 配置
将 `.env.example` 重命名为 `.env`，修改之后保存

## 安装 & 启动
`npm install -g pnpm` & `pnpm i` & `node app.js`

## 端点
`/random` 随机一个站点，示例响应：
```
{
    "success": true,
    "data": [
        {
            "id": 142,
            "name": "BLxcwg666 の Blog",
            "url": "https://blog.nekorua.com",
            "tag": "go,blog.tech"
        }
    ]
}
```
## 规范
其他路由详见 `routes` 目录  
组件放在 `modules` 目录  
工具（外置函数）放在 `utils` 目录  

PR 请注意规范 commit message 谢谢喵
## 版权
Under [GPL v3](https://www.gnu.org/licenses/gpl-3.0.html)  
2024 © Travellings-link Project. All rights reserved.
