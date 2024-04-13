# Travellings-API
[![wakatime](https://wakatime.com/badge/user/018c29a9-6bba-4290-b83c-e1d1582f0233/project/018c2b3a-a125-424a-af40-965603a6d04a.svg)](https://wakatime.com/badge/user/018c29a9-6bba-4290-b83c-e1d1582f0233/project/018c2b3a-a125-424a-af40-965603a6d04a)  
New API For Travellings Project（Node.js + Express）  
不代表最终品质

# 环境
- Node.JS ≥ 18
- MySQL ≥ 8.0
- Redis ≥ 7.0
- pnpm

# 配置
将 `.env.example` 重命名为 `.env`，修改之后保存

# 安装 & 启动
`npm install -g pnpm` & `pnpm i` & `node app.js`

# 端点
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
其他路由详见 `routes` 目录