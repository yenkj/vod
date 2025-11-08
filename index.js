import express from "express";    
import { Agent, setGlobalDispatcher } from "undici";    
import ffmpeg from "fluent-ffmpeg";
import { spawn } from "child_process";
import { promisify } from "util"; 
import { exec } from "child_process";
  
const execAsync = promisify(exec);    
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
// ✅ 添加编解码器检测函数  
async function needsTranscoding(videoUrl) {  
  return new Promise((resolve, reject) => {  
    ffmpeg.ffprobe(videoUrl, (err, metadata) => {  
      if (err) {  
        console.error('❌ [FFprobe] 编解码器检测失败:', err.message);  
        return reject(err);  
      }  
  
      const videoStream = metadata.streams.find(s => s.codec_type === 'video');  
      const audioStream = metadata.streams.find(s => s.codec_type === 'audio');  
  
      const videoCodec = videoStream?.codec_name?.toLowerCase();  
      const audioCodec = audioStream?.codec_name?.toLowerCase();  
  
      // H.264 的各种别名  
      const isH264 = videoCodec === 'h264' || videoCodec === 'avc' || videoCodec === 'x264';  
      // AAC 的各种别名  
      const isAAC = audioCodec === 'aac' || audioCodec === 'mp4a';  
  
      console.log(`📊 [编解码器检测] 视频: ${videoCodec}, 音频: ${audioCodec}`);  
  
      resolve({  
        videoCodec,  
        audioCodec,  
        needsVideoTranscode: !isH264,  
        needsAudioTranscode: !isAAC,  
        videoStream,  
        audioStream  
      });  
    });  
  });  
}  
  
// ✅ 添加字幕提取函数  
async function extractSubtitles(videoUrl, fileId) {  
  try {  
    return new Promise((resolve, reject) => {  
      ffmpeg.ffprobe(videoUrl, (err, metadata) => {  
        if (err) {  
          console.error('❌ [字幕检测] 失败:', err.message);  
          return resolve([]);  
        }  
  
        const subtitleStreams = metadata.streams.filter(s => s.codec_type === 'subtitle');  
        const subs = [];  
  
        for (let i = 0; i < subtitleStreams.length; i++) {  
          const stream = subtitleStreams[i];  
          const lang = stream.tags?.language || `track${i}`;  
          const title = stream.tags?.title || `字幕${i + 1}`;  
            
          subs.push({  
            lang: lang,  
            ext: 'srt',  
            url: `${API_BASE_URL}/s/${fileId}.${i}.srt`,  
            name: title  
          });  
        }  
  
        resolve(subs);  
      });  
    });  
  } catch (error) {  
    console.error('❌ [字幕提取] 失败:', error.message);  
    return [];  
  }  
}    
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
    
// 视频重定向路由(302模式,不是代理)  
app.get('/r/:fileId', async (req, res) => {  
  let fileId = req.params.fileId;  
  fileId = fileId.replace(/\.(m3u8|mkv|mp4|avi|flv|webm|mov)$/i, '');  
    
  try {  
    const cached = urlCache.get(fileId);  
    let playUrl;  
  
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {  
      console.log(`✅ [CACHE HIT] ${fileId}`);  
      playUrl = cached.url;  
    } else {  
      const playResponse = await fetch(`http://YOUR_DOMAIN:4567/play?id=${fileId}`, {  
        headers: {  
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'  
        },  
        signal: AbortSignal.timeout(10000),  
        dispatcher: agent  
      });  
  
      if (!playResponse.ok) {  
        console.error(`❌ [REDIRECT] Play API返回错误: ${playResponse.status}`);  
        return res.status(404).send('File not found');  
      }  
  
      const playData = await playResponse.json();  
      if (!playData.url) {  
        console.error(`❌ [REDIRECT] Play API未返回URL: ${fileId}`);  
        return res.status(404).send('URL not found');  
      }  
  
      playUrl = playData.url;  
      urlCache.set(fileId, { url: playUrl, timestamp: Date.now() });  
  
      if (urlCache.size > 1000) {  
        cleanCache();  
      }  
    }  
  
    // 🔑 关键: 替换 5344 为 5444
    const modifiedUrl = playUrl.replace(  
      /http:\/\/YOUR_DOMAIN\.YOUR_DOMAIN\.YOUR_DOMAIN:5344\/p/g,  
      'https://YOUR_DOMAIN:5444/d'  
    );  
  
    console.log(`🔄 [REDIRECT] ${fileId} -> ${modifiedUrl.substring(0, 100)}...`);  
  
    // 返回 302 重定向并添加 CORS 头部  
    res.set({  
      'Location': modifiedUrl,  
      'Access-Control-Allow-Origin': '*',  
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',  
      'Access-Control-Allow-Headers': 'Range, If-Range, Content-Type'  
    });  
    res.status(302).end();  
  
  } catch (error) {  
    console.error(`❌ [REDIRECT ERROR] ${fileId}:`, error.message);  
    if (!res.headersSent) {  
      return res.status(500).send('Internal server error');  
    }  
  }  
});

// ✅ 添加 HLS 转码端点  
app.get('/t/:fileId.:extension', async (req, res) => {  
  const { fileId, extension } = req.params;  
  const audioTrack = parseInt(req.query.audio) || 0;  
  
  console.log(`🎬 [HLS转码请求] ${fileId}.${extension}, 音轨: ${audioTrack}`);  
  
  try {  
    // 获取原始视频 URL  
    const playResponse = await fetch(`http://YOUR_DOMAIN:4567/play?id=${fileId}`, {  
      headers: { 'User-Agent': 'Mozilla/5.0' },  
      signal: AbortSignal.timeout(10000),  
      dispatcher: agent  
    });  
  
    if (!playResponse.ok) {  
      return res.status(404).send('视频未找到');  
    }  
  
    const playData = await playResponse.json();  
    if (!playData.url) {  
      return res.status(404).send('视频 URL 未找到');  
    }  
  
    const originalUrl = playData.url.replace(  
      /http:\/\/YOUR_DOMAIN\.YOUR_DOMAIN\.xyz:5344\/p/g,  
      'https://YOUR_DOMAIN:5444/d'  
    );  
  
    // 🎯 检测编解码器  
    const codecInfo = await needsTranscoding(originalUrl);  
      
    console.log(`🔍 [编解码器决策] 视频: ${codecInfo.needsVideoTranscode ? '转码' : 'copy'}, 音频: ${codecInfo.needsAudioTranscode ? '转码' : 'copy'}`);  
  
    // 设置 HLS 响应头  
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');  
    res.setHeader('Access-Control-Allow-Origin', '*');  
    res.setHeader('Cache-Control', 'no-cache');  
  
    // 🎬 构建 FFmpeg 命令 - 智能选择编解码器  
    const ffmpegArgs = [  
      '-i', originalUrl,  
      '-map', '0:v:0',  
      '-map', `0:a:${audioTrack}`,  
    ];  
  
    // 视频编解码器选择  
    if (codecInfo.needsVideoTranscode) {  
      console.log(`🔄 [视频转码] ${codecInfo.videoCodec} -> H.264`);  
      ffmpegArgs.push(  
        '-c:v', 'libx264',  
        '-preset', 'veryfast',  
        '-crf', '23'  
      );  
    } else {  
      console.log(`✅ [视频直通] ${codecInfo.videoCodec} (H.264)`);  
      ffmpegArgs.push('-c:v', 'copy');  
    }  
  
    // 音频编解码器选择  
    if (codecInfo.needsAudioTranscode) {  
      console.log(`🔄 [音频转码] ${codecInfo.audioCodec} -> AAC`);  
      ffmpegArgs.push(  
        '-c:a', 'aac',  
        '-b:a', '192k'  
      );  
    } else {  
      console.log(`✅ [音频直通] ${codecInfo.audioCodec} (AAC)`);  
      ffmpegArgs.push('-c:a', 'copy');  
    }  
  
    // HLS 输出参数  
    ffmpegArgs.push(  
      '-f', 'hls',  
      '-hls_time', '6',  
      '-hls_list_size', '0',  
      '-hls_flags', 'delete_segments+append_list',  
      '-start_number', '0',  
      'pipe:1'  
    );  
  
    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);  
  
    // 将 FFmpeg 输出流式传输到响应  
    ffmpegProcess.stdout.pipe(res);  
  
    ffmpegProcess.stderr.on('data', (data) => {  
      console.log(`[FFmpeg] ${data.toString().trim()}`);  
    });  
  
    ffmpegProcess.on('error', (error) => {  
      console.error('❌ [FFmpeg] 进程错误:', error);  
      if (!res.headersSent) {  
        res.status(500).send('转码失败');  
      }  
    });  
  
    ffmpegProcess.on('close', (code) => {  
      console.log(`✅ [FFmpeg] HLS转码完成, 退出码: ${code}`);  
    });  
  
    // 客户端断开连接时终止 FFmpeg  
    req.on('close', () => {  
      if (!ffmpegProcess.killed) {  
        ffmpegProcess.kill('SIGKILL');  
        console.log('🛑 [FFmpeg] 客户端断开,终止转码');  
      }  
    });  
  
  } catch (error) {  
    console.error(`❌ [HLS转码错误] ${fileId}:`, error.message);  
    if (!res.headersSent) {  
      res.status(500).send('转码失败');  
    }  
  }  
});  
  
// ✅ 添加字幕提取端点  
app.get('/s/:fileId.:index.:ext', async (req, res) => {  
  const { fileId, index, ext } = req.params;  
  
  try {  
    const playResponse = await fetch(`http://YOUR_DOMAIN:4567/play?id=${fileId}`, {  
      headers: { 'User-Agent': 'Mozilla/5.0' },  
      signal: AbortSignal.timeout(10000),  
      dispatcher: agent  
    });  
  
    if (!playResponse.ok) {  
      return res.status(404).send('视频未找到');  
    }  
  
    const playData = await playResponse.json();  
    const originalUrl = playData.url.replace(  
      /http:\/\/YOUR_DOMAIN\.YOUR_DOMAIN\.xyz:5344\/p/g,  
      'https://YOUR_DOMAIN:5444/d'  
    );  
  
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');  
    res.setHeader('Access-Control-Allow-Origin', '*');  
  
    const ffmpegProcess = spawn('ffmpeg', [  
      '-i', originalUrl,  
      '-map', `0:s:${index}`,  
      '-f', 'srt',  
      'pipe:1'  
    ]);  
  
    ffmpegProcess.stdout.pipe(res);  
  
    ffmpegProcess.on('error', (error) => {  
      console.error('❌ [字幕提取] 错误:', error);  
      if (!res.headersSent) {  
        res.status(500).send('字幕提取失败');  
      }  
    });  
  
  } catch (error) {  
    console.error(`❌ [字幕提取错误] ${fileId}:`, error.message);  
    if (!res.headersSent) {  
      res.status(500).send('字幕提取失败');  
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
      console.error(`❌ 处理失败: ${item.vod_name}`, error);    
      // 返回原始数据而不是 null    
      return {    
        ...item,    
        vod_play_from: '默认',    
        vod_play_url: '',    
         vod_play_server: 'no',    
        vod_play_note: '暂无播放源'    
      };    
    }     
  }));    
    
  const transformedList = results      
    .filter(result => result.status === 'fulfilled')  // 只过滤掉 rejected 的  
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
  const allSubs = [];  // 如果需要收集字幕  
  const startTime = Date.now();  
  
  for (const urlGroup of playUrlGroups) {      
    const episodes = urlGroup.split('#');      
    for (const episode of episodes) {      
      const parts = episode.split('$');      
      if (parts.length !== 2) continue;      
        
      let [title, fileId] = parts;  
            
      // 提取原始文件扩展名并验证    
      const extensionMatch = title.match(/\.([a-zA-Z0-9]+)(?:\(|$)/);    
      const validExtensions = ['mkv', 'mp4', 'avi', 'flv', 'webm', 'mov', 'm3u8'];    
      let extension = 'mkv'; // 默认值    
    
      if (extensionMatch) {    
        const extractedExt = extensionMatch[1].toLowerCase();    
        if (validExtensions.includes(extractedExt)) {    
          extension = extractedExt;    
        }    
      }      
        
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
        
      // 🎬 智能选择: 需要转码的格式使用 /t 端点,其他使用 /r 重定向  
      let videoUrl;  
      const needsTranscode = ['mkv', 'avi', 'flv', 'webm', 'mov'].includes(extension.toLowerCase());  
  
      if (needsTranscode) {  
        // 需要转码的格式 → 使用 HLS 转码端点  
        videoUrl = `${API_BASE_URL}/t/${fileId}.m3u8`;  
      } else {  
        // MP4、M3U8 等兼容格式 → 使用原有的重定向逻辑  
        videoUrl = `${API_BASE_URL}/r/${fileId}.${extension}`;  
      }  
        
      allEpisodes.push(`${title}$${videoUrl}`);      
    }      
  }      
        
  const endTime = Date.now();      
  const totalTime = endTime - startTime;      
  console.log(`📺 [EPISODES RESOLVED] ${allEpisodes.length} episodes in ${totalTime}ms`);      
        
  return {      
    url: allEpisodes.join('#'),      
    subs: allSubs  // 如果需要字幕,否则保持 []  
  };      
} 
    
app.listen(PORT, () => {    
  console.log(`Server is running on http://localhost:${PORT}`);    
});
