# README
## 使用代理功能解决跨域问题
- docker-compose.yml
```
version: '3'  
services:  
  vod:
    container_name: vod
    image: ghcr.io/yenkj/vod:latest  
    ports:  
      - "4000:3000"  
    volumes:  
      - /volume1/docker/vod/index.js:/app/index.js 
    restart: unless-stopped
    network_mode: bridge

```
## 原始地址.js功能为不代理直接替换，响应稍慢会跨域
