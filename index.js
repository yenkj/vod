import express from "express";    
import { Agent, setGlobalDispatcher } from "undici";    
    
// 优化连接池配置  
const agent = new Agent({    
  connections: 30,  // 从100降到30  
  pipelining: 1,    
  keepAliveTimeout: 30000,  // 从60秒降到30秒  
  keepAliveMaxTimeout: 30000    
});    
    
setGlobalDispatcher(agent);    
    
const app = express();    
const PORT = process.env.PORT || 3000;    
const API_BASE_URL = 'http://YOUR_DOMAIN:4000';    
  
// 添加URL缓存  
const urlCache = new Map();  
const CACHE_TTL = 10 * 60 * 1000; // 10分钟  
  
// 缓存清理函数  
function cleanCache() {  
  const now = Date.now();  
  for (const [key, value] of urlCache.entries()) {  
    if (now - value.timestamp > CACHE_TTL) {  
      urlCache.delete(key);  
    }  
  }  
}  
  
// 每5分钟清理一次过期缓存  
setInterval(cleanCache, 5 * 60 * 1000);  
    
app.use(express.json());    
    
app.options('*', (req, res) => {    
  res.set({    
    'Access-Control-Allow-Origin': '*',    
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',    
    'Access-Control-Allow-Headers': 'Content-Type, Range',    
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges'    
  });    
  res.sendStatus(204);    
});    
    
// 健康检查端点    
app.get('/health', (req, res) => {    
  res.status(200).json({   
    status: 'ok',   
    timestamp: Date.now(),  
    cacheSize: urlCache.size  
  });    
});    
    
// 🔥 视频代理路由(代理模式,不是重定向)    
app.get('/r/:fileId', async (req, res) => {    
  let fileId = req.params.fileId;    
  fileId = fileId.replace(/\.(m3u8|mkv|mp4|avi|flv|webm|mov)$/i, '');    
    
  // 创建AbortController用于清理  
  const abortController = new AbortController();  
  let reader = null;  
    
  // 监听客户端断开连接  
  req.on('close', () => {  
    console.log(`🔌 [PROXY] 客户端断开连接: ${fileId}`);  
    abortController.abort(); // 取消所有上游请求  
    if (reader) {  
      reader.cancel().catch(() => {}); // 取消流读取  
    }  
  });  
      
  try {    
    // 1. 检查缓存  
    const cached = urlCache.get(fileId);  
    let playUrl;  
      
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {  
      console.log(`💾 [CACHE HIT] ${fileId}`);  
      playUrl = cached.url;  
    } else {  
      // 获取真实URL  
      const playResponse = await fetch(`http://YOUR_DOMAIN:4567/play?id=${fileId}`, {    
        headers: {    
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'    
        },    
        signal: abortController.signal,  
        dispatcher: agent  
      });    
          
      if (!playResponse.ok) {    
        console.error(`❌ [PROXY] Play API返回错误: ${playResponse.status}`);    
        return res.status(404).send('File not found');    
      }    
          
      const playData = await playResponse.json();    
          
      if (!playData.url) {    
        console.error(`❌ [PROXY] Play API未返回URL: ${fileId}`);    
        return res.status(404).send('URL not found');    
      }    
        
      playUrl = playData.url;  
      // 缓存URL  
      urlCache.set(fileId, { url: playUrl, timestamp: Date.now() });  
        
      // 限制缓存大小  
      if (urlCache.size > 1000) {  
        cleanCache();  
      }  
    }  
        
    console.log(`🔗 [PROXY] ${fileId} -> ${playUrl.substring(0, 100)}...`);    
        
    // 2. 代理视频流  
    const videoResponse = await fetch(playUrl, {    
      headers: {    
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',    
        'Range': req.headers.range || 'bytes=0-',    
      },  
      signal: abortController.signal,  
      dispatcher: agent  
    });    
        
    if (!videoResponse.ok) {    
      console.error(`❌ [PROXY] 视频获取失败: ${videoResponse.status}`);    
      return res.status(videoResponse.status).send('Video fetch failed');    
    }    
        
    // 3. 设置CORS头和其他响应头    
    res.set({    
      'Access-Control-Allow-Origin': '*',    
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',    
      'Access-Control-Allow-Headers': 'Range, Content-Type',    
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',    
      'Content-Type': videoResponse.headers.get('Content-Type') || 'video/mp4',    
      'Content-Length': videoResponse.headers.get('Content-Length'),    
      'Content-Range': videoResponse.headers.get('Content-Range'),    
      'Accept-Ranges': 'bytes'    
    });    
        
    // 4. 流式传输数据  
    if (!videoResponse.body) {    
      return res.status(500).send('No video stream');    
    }    
      
    reader = videoResponse.body.getReader();    
        
    try {    
      while (true) {    
        const { done, value } = await reader.read();    
            
        if (done) {    
          res.end();    
          break;    
        }    
            
        // 使用背压控制    
        if (!res.write(value)) {    
          await new Promise(resolve => res.once('drain', resolve));    
        }    
      }    
    } catch (error) {    
      // 忽略客户端断开导致的错误  
      if (error.name !== 'AbortError') {  
        console.error(`❌ [PROXY STREAM ERROR] ${fileId}:`, error.message);    
      }  
      if (!res.headersSent) {    
        res.status(500).send('Stream error');    
      }    
    } finally {    
      if (reader) {  
        reader.releaseLock();    
      }  
    }    
        
  } catch (error) {    
    // 忽略客户端断开导致的错误  
    if (error.name !== 'AbortError') {  
      console.error(`❌ [PROXY ERROR] ${fileId}:`, error.message);    
    }  
    if (!res.headersSent) {    
      return res.status(500).send('Internal server error');    
    }    
  }    
});  
    
// 主API端点    
app.get('/', async (req, res) => {    
  const requestStartTime = Date.now();    
  const params = req.query;    
  const ac = params.ac;    
  const wd = params.wd;    
  const ids = params.ids;    
    
  const corsHeaders = {    
    'Access-Control-Allow-Origin': '*',    
    'Access-Control-Allow-Methods': 'GET, OPTIONS',    
    'Access-Control-Allow-Headers': 'Content-Type',    
    'Content-Type': 'application/json; charset=utf-8'    
  };    
    
  try {    
    const upstreamUrl = new URL('http://YOUR_DOMAIN:4567/vod1/');    
    Object.keys(params).forEach(key => upstreamUrl.searchParams.append(key, params[key]));    
    
    const response = await fetch(upstreamUrl.toString(), {    
      headers: { 'User-Agent': 'Mozilla/5.0' },    
      signal: AbortSignal.timeout(60000),  
      dispatcher: agent  
    });    
    
    if (!response.ok) {    
      return res.status(response.status).set(corsHeaders).send(`上游API错误: ${response.statusText}`);    
    }    
    
    const data = await response.json();    
    const needsTransform = ac === 'videolist' && (wd || ids);    
    
    console.log(`📝 [DEBUG] ac=${ac}, wd=${wd}, ids=${ids}, needsTransform=${needsTransform}`);    
    console.log(`📦 [DEBUG] 上游返回数据: list.length=${data.list?.length}`);    
    
    let responseData;    
    if (needsTransform && data.list && data.list.length > 0) {    
      console.log(`🔄 [DEBUG] 开始执行 transformResponse`);    
      responseData = await transformResponse(data);    
    } else {    
      console.log(`⚠️ [DEBUG] 跳过 transformResponse,直接返回原始数据`);    
      responseData = data;    
    }    
    
    const userAgent = req.headers['user-agent'] || '';  
    const isBrowser = userAgent.includes('Mozilla');  
              
    let responseText = JSON.stringify(responseData);  
    if (isBrowser) {  
      responseText = replaceAllDoubanImages(responseText);  
    }    
    
    res.set(corsHeaders).send(responseText);  
    
    const totalDuration = Date.now() - requestStartTime;    
    console.log(`⏱️ [LUNA SEARCH TIME] ${totalDuration}ms (${(totalDuration/1000).toFixed(2)}s) - LunaTV超时限制: 20s`);    
    if (totalDuration > 20000) {    
      console.log(`⚠️ 警告: 超过LunaTV的20秒超时!`);    
    }    
    
  } catch (error) {    
    console.error('API错误:', error);    
    return res.status(500).set(corsHeaders).send(`服务器错误: ${error.message}`);    
  }    
});   
  
function replaceAllDoubanImages(text) {              
  if (text.includes('image-proxy?url=')) {              
    return text;              
  }              
              
  return text.replace(              
    /(https?:\/\/)(img\d+\.doubanio\.com)(\/[^\s"']*)?/g,              
    (match, protocol, domain, path) => {              
      const originalUrl = match;              
      return `http://YOUR_DOMAIN:3000/api/image-proxy?url=${encodeURIComponent(originalUrl)}`;              
    }              
  );              
}  
  
async function transformResponse(data) {    
  const results = await Promise.allSettled(data.list.map(async (item) => {    
    try {    
      console.log(`[PROCESSING] ${item.vod_name} (${item.vod_id})`);    
    
      const detailUrl = new URL('http://YOUR_DOMAIN:4567/vod1/');    
      detailUrl.searchParams.append('ac', 'videolist');    
      detailUrl.searchParams.append('ids', item.vod_id);
        
      const detailStartTime = Date.now(); 
    
      const detailResponse = await fetch(detailUrl.toString(), {    
        headers: { 'User-Agent': 'Mozilla/5.0' },    
        signal: AbortSignal.timeout(8000),  
        dispatcher: agent  
      });    
         // 添加计时 - 结束并打印  
      const detailTime = Date.now() - detailStartTime;  
      console.log(`⏱️ [FETCH DETAIL] ${item.vod_id} took ${detailTime}ms`);  
 
      if (!detailResponse.ok) {    
        throw new Error(`详情API错误: ${detailResponse.status}`);    
      }    
    
      const detailData = await detailResponse.json();    
      if (!detailData.list || detailData.list.length === 0) {    
        throw new Error(`详情数据为空: ${item.vod_id}`);    
      }    
    
      const detailItem = detailData.list[0];    
      if (!detailItem.vod_play_url) {    
        throw new Error(`无播放地址: ${item.vod_id}`);    
      }    
    
      const playInfo = await transformPlayUrl(detailItem);    
      const transformed = { ...item };    
      transformed.vod_play_from = detailItem.vod_play_from || '默认';    
      transformed.vod_play_url = playInfo.url;    
      transformed.vod_play_server = 'no';    
      transformed.vod_play_note = '';    
    
      if (playInfo.subs && playInfo.subs.length > 0) {    
        transformed.vod_play_subs = playInfo.subs;    
      }    
    
      if (!transformed.vod_play_url || transformed.vod_play_url === '') {    
        throw new Error(`播放地址转换失败: ${item.vod_id}`);    
      }    
    
      return transformed;    
    } catch (error) {    
      console.error(`处理失败: ${item.vod_name}`, error);    
      return null;    
    }    
  }));    
    
  const transformedList = results    
    .filter(result => result.status === 'fulfilled' && result.value !== null)    
    .map(result => result.value);    
    
  console.log(`📊 [TRANSFORM] 转换结果: ${transformedList.length}/${results.length} 成功`);    
    
  return {    
    code: 1,    
    msg: '数据列表',    
    page: data.page || 1,    
    pagecount: data.pagecount || 1,    
    limit: data.limit || '20',    
    total: transformedList.length,    
    list: transformedList    
  };    
}    
    
function extractContent(content) {    
  if (!content) return '';    
  const parts = content.split(';\n');    
  if (parts.length > 1) {    
    return parts.slice(1).join('\n').trim();    
  }    
  return content;    
}    
    
async function transformPlayUrl(item) {    
  const playUrl = item.vod_play_url;    
  if (!playUrl) return { url: '', subs: [] };    
    
  let directoryPath = '';    
  if (item.vod_content) {    
  const pathMatch = item.vod_content.match(/香蕉:(.+?);/);    
    if (pathMatch) {    
      directoryPath = pathMatch[1];    
    }    
  }    
    
  const isTVShow = directoryPath.includes('/电视节目/');    
  const playUrlGroups = playUrl.split('$$$');    
  const allEpisodes = [];    
    
  const startTime = Date.now();    
    
  // 🔥 关键优化:直接从vod_play_url提取fileId,不调用play API    
  for (const urlGroup of playUrlGroups) {    
    const episodes = urlGroup.split('#');    
    for (const episode of episodes) {    
      const parts = episode.split('$');    
      if (parts.length !== 2) continue;    
    
      let [title, fileId] = parts; // fileId就是519616-1这样的格式    
    
      if (isTVShow) {    
        const episodeMatch = title.match(/S(\d+)E(\d+)/i);    
        const sizeMatch = title.match(/\(([^)]+?(?:GB|MB|KB))\)/i);    
        if (episodeMatch) {    
          const season = episodeMatch[1].padStart(2, '0');    
          const ep = episodeMatch[2].padStart(2, '0');    
          const size = sizeMatch ? sizeMatch[1] : '';    
          title = size ? `S${season}E${ep}(${size})` : `S${season}E${ep}`;    
        }    
      } else {    
        const sizeMatch = title.match(/\(([^)]+?(?:GB|MB|KB))\)/i);    
        const size = sizeMatch ? sizeMatch[1] : '';    
        title = size ? `HD高清(${size})` : 'HD高清';    
      }    
    
      // 直接构建短链接,假装添加.mkv后缀    
      const shortUrl = `${API_BASE_URL}/r/${fileId}.mkv`;    
      allEpisodes.push(`${title}$${shortUrl}`);    
    }    
  }    
    
  const endTime = Date.now();    
  const totalTime = endTime - startTime;    
  console.log(`[EPISODES RESOLVED] ${allEpisodes.length} episodes in ${totalTime}ms`);    
    
  return {    
    url: allEpisodes.join('#'),    
    subs: [] // 搜索时不返回字幕    
  };    
}    
    
app.listen(PORT, () => {    
  console.log(`Server is running on http://localhost:${PORT}`);    
});
