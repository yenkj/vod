import express from "express";          
import { Agent, setGlobalDispatcher } from "undici";      
      
// 配置全局 Agent 提高连接复用      
const agent = new Agent({      
  connections: 100,      
  pipelining: 1,      
  keepAliveTimeout: 60000,      
  keepAliveMaxTimeout: 600000      
});      
      
setGlobalDispatcher(agent);      
      
const app = express();          
const PORT = process.env.PORT || 3000;       
      
app.use(express.json());      
      
app.options('*', (req, res) => {      
  res.set({      
    'Access-Control-Allow-Origin': '*',      
    'Access-Control-Allow-Methods': 'GET, OPTIONS',      
    'Access-Control-Allow-Headers': 'Content-Type',      
    'Content-Type': 'application/json; charset=utf-8'      
  });      
  res.sendStatus(204);      
});      
      
app.get('/', async (req, res) => {  
  // ⏱️ 记录请求开始时间  
  const requestStartTime = Date.now();  
    
  const params = req.query;      
      
  const ac = params.ac;      
  const wd = params.wd;      
  const ids = params.ids;      
      
  const corsHeaders = {      
    'Access-Control-Allow-Origin': '*',      
    'Content-Type': 'application/json; charset=utf-8'      
  };      
      
  try {      
    let upstreamUrl = 'http://YOUR_DOMAIN:4567/vod1/?';      
    let needsTransform = false;   
    let finalData = null;  
      
    if ((ac === 'videolist' || ac === 'detail') && (wd || ids)) {      
      needsTransform = true;      
      if (wd) {      
        upstreamUrl += `ac=videolist&wd=${encodeURIComponent(wd)}`;      
      } else if (ids) {      
        upstreamUrl += `ac=videolist&ids=${ids}`;      
      }      
    } else {      
      upstreamUrl += new URLSearchParams(params).toString();      
    }      
      
    const upstreamResponse = await fetch(upstreamUrl, {      
      headers: {      
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'      
      },        
      signal: AbortSignal.timeout(55000)    
    });      
      
    if (!upstreamResponse.ok) {      
      throw new Error(`上游 API 请求失败: ${upstreamResponse.status}`);      
    }      
      
    console.log(`📝 [DEBUG] ac=${ac}, wd=${wd}, ids=${ids}, needsTransform=${needsTransform}`);      
    const data = await upstreamResponse.json();      
    console.log(`📦 [DEBUG] 上游返回数据: list.length=${data.list?.length}, 第一条: ${JSON.stringify(data.list?.[0])}`);      
      
    if (needsTransform) {      
      console.log(`🔄 [DEBUG] 开始执行 transformResponse`);      
      finalData = await transformResponse(data);      
    } else {      
      console.log(`⚠️ [DEBUG] 跳过 transformResponse,直接返回原始数据`);      
      finalData = data;      
    }      
      
    const userAgent = req.headers['user-agent'] || '';      
    const isBrowser = userAgent.includes('Mozilla');      
      
    let responseText = JSON.stringify(finalData);      
    if (isBrowser) {      
      responseText = replaceAllDoubanImages(responseText);      
    }      
      
    res.set(corsHeaders).send(responseText);  
      
    // ⏱️ 记录总耗时  
    const totalDuration = Date.now() - requestStartTime;  
    console.log(`⏱️ [LUNA SEARCH TIME] ${totalDuration}ms (${(totalDuration/1000).toFixed(2)}s) - LunaTV超时限制: 40s`);  
    if (totalDuration > 40000) {  
      console.log(`⚠️ 警告: 超过LunaTV的40秒超时!`);  
    }  
      
  } catch (error) {  
    // ⏱️ 错误情况也记录时间  
    const totalDuration = Date.now() - requestStartTime;  
    console.log(`❌ [LUNA SEARCH TIME] 请求失败 - ${totalDuration}ms (${(totalDuration/1000).toFixed(2)}s)`);  
    console.error(`❌ [ERROR]`, error);  
      
    res.status(500).set(corsHeaders).send(JSON.stringify({      
      code: 0,      
      msg: error.message,      
      list: []      
    }));      
  }      
});      
      
function replaceAllDoubanImages(text) {      
  if (text.includes('image-proxy?url=')) {      
    return text;      
  }      
      
  return text.replace(      
    /(https?:\/\/)(img\d+\.doubanio\.com)(\/[^\s"']*)?/g,      
    (match, protocol, domain, path) => {      
      const originalUrl = `${protocol}${domain}${path || ''}`;      
      return `http://YOUR_DOMAIN:3000/api/image-proxy?url=${encodeURIComponent(originalUrl)}`;      
    }      
  );      
}      
      
async function transformResponse(data) {      
  if (!data.list || data.list.length === 0) {      
    return {      
      code: 1,      
      msg: '数据列表',      
      page: data.page || 1,      
      pagecount: data.pagecount || 1,      
      limit: data.limit || '20',      
      total: 0,      
      list: []      
    };      
  }      
      
const results = await Promise.allSettled(data.list.map(async (item) => {  
  try {  
    console.log(`[PROCESSING] ${item.vod_name} (${item.vod_id})`);  
      
    const transformed = {  
      vod_id: item.vod_id,  
      vod_name: item.vod_name,  
      vod_pic: item.vod_pic,  
      vod_remarks: item.vod_remarks || '',  
      vod_year: item.vod_year || '',  
      vod_area: item.vod_area || '',  
      vod_lang: item.vod_lang || '',  
      vod_actor: item.vod_actor || '',  
      vod_director: item.vod_director || '',  
      vod_content: extractContent(item.vod_content),  
      vod_douban_id: item.dbid || item.vod_douban_id || 0,  
      type_name: item.type_name || ''  
    };  
      
    if (item.vod_play_url) {  
      const playInfo = await transformPlayUrl(item);  
      transformed.vod_play_from = item.vod_play_from || '默认';  
      transformed.vod_play_url = playInfo.url;  
      transformed.vod_play_server = 'no';  
      transformed.vod_play_note = '';  
      if (playInfo.subs && playInfo.subs.length > 0) {  
        transformed.vod_play_subs = playInfo.subs;  
      }  
      return transformed;  
    } else {  
      const detailResponse = await fetch(  
        `http://us.199301.xyz:4567/vod1/?ac=videolist&ids=${item.vod_id}`,  
        {  
          headers: {  
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'  
          },  
          signal: AbortSignal.timeout(10000)  
        }  
      );  
        
      if (!detailResponse.ok) {  
        throw new Error(`详情请求失败: ${item.vod_id}`);  
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
    }  
  } catch (error) {  
    console.error(`❌ 处理失败: ${item.vod_name}`, error);  
    return {  
      vod_id: item.vod_id,  
      vod_name: item.vod_name,  
      vod_pic: item.vod_pic,  
      vod_remarks: item.vod_remarks || '',  
      vod_year: item.vod_year || '',  
      vod_area: item.vod_area || '',  
      vod_lang: item.vod_lang || '',  
      vod_actor: item.vod_actor || '',  
      vod_director: item.vod_director || '',  
      vod_content: extractContent(item.vod_content),  
      vod_douban_id: item.dbid || item.vod_douban_id || 0,  
      type_name: item.type_name || '',  
      vod_play_from: '默认',  
      vod_play_url: '',  
      vod_play_server: 'no',  
      vod_play_note: '暂无播放源'  
    };  
  }  
}));  
      
  const transformedList = results  
    .filter(result => result.status === 'fulfilled')  
    .map(result => result.value);
      
 console.log(`📊 [TRANSFORM] 转换结果: ${transformedList.length}/${results.length} 成功`);  
if (transformedList.length > 0) {  
  const firstItem = transformedList[0];  
  console.log(`📋 [TRANSFORM] 第一条 vod_play_url 预览:`, firstItem.vod_play_url?.substring(0, 200));  
    
  // 添加这行 - 输出完整的第一个剧集 URL  
  const firstEpisode = firstItem.vod_play_url?.split('#')[0];  
  console.log(`🔍 [TRANSFORM] 第一集完整 URL: ${firstEpisode}`);  
    
  const sampleUrls = firstItem.vod_play_url?.split('#').slice(0, 3);  
  sampleUrls?.forEach((episodeUrl, index) => {  
    const [title, url] = episodeUrl.split('$');  
    const matches = url?.match(/\.(m3u8|mkv|mp4|avi|flv|webm|mov)(\?.*)?$/i);  
    console.log(`   [${index + 1}] ${title}: ${url?.substring(0, 80)} - 匹配: ${!!matches}`);  
    // 添加这行 - 输出完整 URL  
    console.log(`       完整 URL: ${url}`);  
  });  
}     
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
  let allSubs = [];      
  const allEpisodePromises = [];      
        
  const startTime = Date.now();      
  const TOTAL_TIMEOUT = 55000;    
          
  for (const urlGroup of playUrlGroups) {      
    const episodes = urlGroup.split('#');      
    for (const episode of episodes) {      
      const parts = episode.split('$');      
      if (parts.length !== 2) continue;      
      
      let [title, fileId] = parts;      
      
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
      
      const episodePromise = (async () => {      
        try {      
          const playResponse = await fetch(`http://YOUR_DOMAIN:4567/play?id=${fileId}&getSub=true`, {      
            headers: {      
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',  
              'Connection': 'keep-alive'  
            },      
            signal: AbortSignal.timeout(20000)    
          });      
      
          if (!playResponse.ok) return null;      
      
          const playData = await playResponse.json();      
          if (playData.subs && playData.subs.length > 0) {      
            allSubs = playData.subs;      
          }      
      
          if (playData.url) {      
          // 检查 URL 是否以视频格式结尾  
           if (!playData.url.match(/\.(m3u8|mkv|mp4|avi|flv|webm|mov)(\?.*)?$/i)) {  
             console.warn(`⚠️ URL 格式不正确,缺少视频扩展名: ${playData.url}`);  
             return null; // 跳过这个剧集  
           }  
           return `${title}$${playData.url}`;  
         }     
          return null;      
        } catch (error) {      
          if (error.name !== 'TimeoutError') {      
            console.error(`获取播放地址异常: ${fileId}`, error.message);      
          }      
          return null;      
        }      
      })();      
      
      allEpisodePromises.push(episodePromise);      
    }      
  }      
      
  const timeoutPromise = new Promise((resolve) => {      
    setTimeout(() => resolve('TIMEOUT'), TOTAL_TIMEOUT);      
  });      
      
  const resultsPromise = Promise.allSettled(allEpisodePromises);      
  const raceResult = await Promise.race([resultsPromise, timeoutPromise]);      
      
  let allEpisodes = [];      
  if (raceResult === 'TIMEOUT') {      
    console.log(`[TIMEOUT] 处理超时,返回空结果`);      
  } else {      
    allEpisodes = raceResult      
      .filter(r => r.status === 'fulfilled' && r.value !== null)      
      .map(r => r.value);      
  }      
      
  const endTime = Date.now();      
  const totalTime = endTime - startTime;      
  console.log(`[EPISODES RESOLVED] ${allEpisodes.length} episodes in ${totalTime}ms`);      
      
  // 替换播放 URL    
  const urlString = allEpisodes.join('#');    
  const replacedUrlString = urlString.replace(    
    /http:\/\/YOUR_DOMAIN\.YOUR_DOMAIN\.YOUR_DOMAIN:5344\/p/g,     
    ''https://YOUR_DOMAIN:5444/d'    
  );  
    
  // 替换字幕 URL  
  const replacedSubs = allSubs.map(sub => {  
    if (sub.url) {  
      return {  
        ...sub,  
        url: sub.url.replace(  
          /http:\/\/YOUR_DOMAIN\.YOUR_DOMAIN\.YOUR_DOMAIN:5344\/p/g,  
          'https://YOUR_DOMAIN:5444/d'  
        )  
      };  
    }  
    return sub;  
  });  
        
  return {          
    url: replacedUrlString,  
    subs: replacedSubs  // 使用替换后的字幕数组  
  };      
}      
      
app.listen(PORT, () => {      
  console.log(`Server is running on http://localhost:${PORT}`);      
});
