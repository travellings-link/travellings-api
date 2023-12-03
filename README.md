# Travellings-API
New API For Travellings Project（Node.js + Express）
警告：此版本还未正式上线使用

# 环境
- Node.JS ≥ 18
- MySQL ≥ 8.0
- 数据表格式（indexs, name, link, status, tag）

# 配置
将 `.env.example` 重命名为 `.env`，写入
```
# API 设置
API_PORT=3000           # API 启动端口
API_HOST=0.0.0.0        # API 绑定地址（127.0.0.1 仅本机）

# 数据库设置
DB_HOST=127.0.0.1       # 数据库地址
DB_PORT=3306            # 数据库端口
DB_USER=user            # 数据库用户名
DB_NAME=dbname          # 数据库名
DB_PASSWORD=password    # 数据库密码
```

# 安装 & 启动
`npm install` & `node app.js`

# 端点
`/random` 随机一个站点，示例响应：
```
{
    "success": true,
    "data": [
        {
            "id": 815,
            "name": "BLxcwg666 の Blog",
            "url": "https://blog.xcnya.cn",
            "tag": "go"
        }
    ]
}
```
