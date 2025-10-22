# README
## 使用代理功能解决moontv跨域问题
- docker-compose.yml
```
version: '3.8'  
services:  
  vod:  
    build: .  
    ports:  
      - "4000:3000"  
    volumes:  
      - /volume1/docker/vod/index.js:/app/index.js  
    restart: unless-stoppe

```
