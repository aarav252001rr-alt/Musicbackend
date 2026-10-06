// ============================================================
// 🎵 ECHO MUSIC BACKEND v2.0 — Full Featured
// Deploy-ready for Render.com
// Cached audio + 1 hour TTL + Auto cleanup
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Innertube } = require('youtubei.js');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ==================== CONFIG ====================
const PORT = process.env.PORT || 5000;
const CACHE_TTL_MS = (parseInt(process.env.CACHE_TTL_MINUTES) || 60) * 60 * 1000;
const CACHE_DIR = path.resolve(process.env.CACHE_DIR || './cache');
const MAX_CACHE_SIZE = (parseInt(process.env.MAX_CACHE_SIZE_MB) || 500) * 1024 * 1024;

// Ensure cache dir exists
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// ==================== APP ====================
const app = express();
app.set('trust proxy', 1); // Render uses proxy
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Rate limiting
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Slow down!' }
}));

// ==================== YOUTUBE CLIENT ====================
let ytClient = null;
async function getClient() {
  if (!ytClient) {
    ytClient = await Innertube.create({
      lang: 'en',
      location: 'IN',
      retrieve_player: true,
    });
    console.log('✅ YouTube client ready');
  }
  return ytClient;
}

// ==================== QUALITY MAP ====================
const QUALITY_MAP = {
  'opus-160': { itag: 251, ext: 'opus', label: 'Opus 160kbps', bitrate: 160, mime: 'audio/webm' },
  'opus-70':  { itag: 250, ext: 'opus', label: 'Opus 70kbps',  bitrate: 70,  mime: 'audio/webm' },
  'opus-50':  { itag: 249, ext: 'opus', label: 'Opus 50kbps',  bitrate: 50,  mime: 'audio/webm' },
  'm4a-128':  { itag: 140, ext: 'm4a',  label: 'M4A 128kbps',  bitrate: 128, mime: 'audio/mp4'  },
  'm4a-48':   { itag: 139, ext: 'm4a',  label: 'M4A 48kbps',   bitrate: 48,  mime: 'audio/mp4'  },
  'm4a-32':   { itag: 599, ext: 'm4a',  label: 'M4A 32kbps',   bitrate: 32,  mime: 'audio/mp4'  },
};

// ==================== CACHE MANAGER ====================
// Cache key: videoId + quality
// Cache file: cache/{videoId}_{quality}.{ext}
// Metadata stored in-memory: { filePath, createdAt, size, title, artist }

const cacheMeta = new Map();

function cacheKey(videoId, quality) {
  return `${videoId}__${quality}`;
}

function cacheFilePath(videoId, quality) {
  const ext = QUALITY_MAP[quality]?.ext || 'm4a';
  return path.join(CACHE_DIR, `${videoId}_${quality}.${ext}`);
}

function isCacheValid(entry) {
  return entry && (Date.now() - entry.createdAt) < CACHE_TTL_MS && fs.existsSync(entry.filePath);
}

// Get or create cache entry — DOWNLOADS if not present
async function getOrCreateCache(videoId, quality) {
  const key = cacheKey(videoId, quality);
  const existing = cacheMeta.get(key);

  // ✅ If valid cache exists — return immediately (no re-fetch!)
  if (isCacheValid(existing)) {
    console.log(`♻️  Cache HIT: ${videoId} (${quality})`);
    return { ...existing, fromCache: true };
  }

  console.log(`⬇️  Cache MISS: downloading ${videoId} (${quality})`);
  const downloaded = await downloadAudioToCache(videoId, quality);
  cacheMeta.set(key, downloaded);
  return { ...downloaded, fromCache: false };
}

// Actual download to cache file
async function downloadAudioToCache(videoId, quality) {
  const yt = await getClient();
  const info = await yt.getInfo(videoId);

  const audioFormats = info.streaming_data?.adaptive_formats?.filter(
    f => f.mime_type?.startsWith('audio/')
  ) || [];

  const targetItag = QUALITY_MAP[quality]?.itag;
  let chosen = targetItag ? audioFormats.find(f => f.itag === targetItag) : null;

  if (!chosen) {
    // fallback: highest bitrate
    chosen = audioFormats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
  }
  if (!chosen) throw new Error('No audio format available');

  const streamUrl = await chosen.decipher(yt.session.player);
  const filePath = cacheFilePath(videoId, quality);

  await new Promise((resolve, reject) => {
    const urlObj = new URL(streamUrl);
    const client = urlObj.protocol === 'https:' ? https : http;

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*',
      'Referer': 'https://www.youtube.com/'
    };

    const ws = fs.createWriteStream(filePath);
    const req = client.get(streamUrl, { headers }, (res) => {
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        ws.close();
        fs.unlink(filePath, () => {});
        return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
      }
      res.pipe(ws);
      ws.on('finish', () => ws.close(resolve));
    });

    req.on('error', (err) => {
      ws.close();
      fs.unlink(filePath, () => {});
      reject(err);
    });

    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('Download timeout'));
    });
  });

  const stats = fs.statSync(filePath);

  return {
    videoId,
    quality,
    filePath,
    createdAt: Date.now(),
    size: stats.size,
    title: info.basic_info.title || 'Unknown',
    artist: info.basic_info.author || 'Unknown',
    duration: info.basic_info.duration || 0,
    thumbnail: info.basic_info.thumbnail?.[0]?.url || null,
    mime: QUALITY_MAP[quality]?.mime || chosen.mime_type || 'audio/mp4',
    ext: QUALITY_MAP[quality]?.ext || 'm4a'
  };
}

// ==================== AUTO CLEANUP ====================
async function cleanupExpiredCache() {
  let removed = 0;
  let freedBytes = 0;
  const now = Date.now();

  for (const [key, entry] of cacheMeta.entries()) {
    if ((now - entry.createdAt) >= CACHE_TTL_MS || !fs.existsSync(entry.filePath)) {
      try {
        if (fs.existsSync(entry.filePath)) {
          freedBytes += fs.statSync(entry.filePath).size;
          fs.unlinkSync(entry.filePath);
        }
        cacheMeta.delete(key);
        removed++;
      } catch (e) { /* ignore */ }
    }
  }

  // Also check for orphan files (not in meta)
  try {
    const files = fs.readdirSync(CACHE_DIR);
    for (const f of files) {
      const fp = path.join(CACHE_DIR, f);
      const stat = fs.statSync(fp);
      if ((now - stat.mtimeMs) > CACHE_TTL_MS) {
        fs.unlinkSync(fp);
        freedBytes += stat.size;
        removed++;
      }
    }
  } catch (e) { /* ignore */ }

  // Enforce max cache size — delete oldest first
  let totalSize = 0;
  for (const entry of cacheMeta.values()) totalSize += entry.size || 0;

  if (totalSize > MAX_CACHE_SIZE) {
    const sorted = [...cacheMeta.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [key, entry] of sorted) {
      if (totalSize <= MAX_CACHE_SIZE * 0.8) break;
      try {
        if (fs.existsSync(entry.filePath)) {
          totalSize -= fs.statSync(entry.filePath).size;
          fs.unlinkSync(entry.filePath);
        }
        cacheMeta.delete(key);
        removed++;
      } catch (e) { /* ignore */ }
    }
  }

  if (removed > 0) {
    console.log(`🧹 Cleanup: removed ${removed} files, freed ${(freedBytes / 1024 / 1024).toFixed(2)} MB`);
  }
}

// Run cleanup every 10 minutes
setInterval(cleanupExpiredCache, 10 * 60 * 1000);

// ==================== HELPERS ====================
function sanitizeFilename(str) {
  return (str || 'audio').replace(/[^\w\s-]/g, '').trim().slice(0, 60) || 'audio';
}

// Convert YT music item → clean object
function formatSongItem(item) {
  if (!item) return null;
  const videoId = item.id || item.video_id;
  if (!videoId) return null;

  return {
    videoId,
    title: item.title?.text || item.title || 'Unknown',
    artist: item.artists?.map(a => a.name).join(', ')
         || item.author?.name
         || 'Unknown',
    album: item.album?.name || null,
    duration: item.duration?.text || '0:00',
    durationSeconds: item.duration?.seconds || 0,
    thumbnail:
      item.thumbnail?.contents?.[0]?.url ||
      item.thumbnail?.[0]?.url ||
      item.thumbnails?.[0]?.url ||
      `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    url: `https://music.youtube.com/watch?v=${videoId}`,
  };
}

// ==================== MUSIC FUNCTIONS ====================

async function searchMusic(query, limit = 20) {
  const yt = await getClient();
  const results = await yt.music.search(query, { type: 'song' });
  const songs = results.songs?.contents || [];
  return songs.slice(0, limit).map(formatSongItem).filter(Boolean);
}

async function searchAll(query) {
  const yt = await getClient();
  const results = await yt.music.search(query);

  return {
    songs: (results.songs?.contents || []).slice(0, 15).map(formatSongItem).filter(Boolean),
    videos: (results.videos?.contents || []).slice(0, 10).map(formatSongItem).filter(Boolean),
    albums: (results.albums?.contents || []).slice(0, 10).map(a => ({
      browseId: a.id,
      title: a.title,
      artist: a.artists?.map(x => x.name).join(', ') || 'Unknown',
      year: a.year,
      thumbnail: a.thumbnail?.[0]?.url
    })),
    artists: (results.artists?.contents || []).slice(0, 10).map(a => ({
      browseId: a.id,
      name: a.name,
      subscribers: a.subscribers?.text,
      thumbnail: a.thumbnail?.[0]?.url
    })),
    playlists: (results.playlists?.contents || []).slice(0, 10).map(p => ({
      browseId: p.id,
      title: p.title,
      author: p.author?.name,
      itemCount: p.item_count,
      thumbnail: p.thumbnail?.[0]?.url
    })),
  };
}

async function getTrending(region = 'IN') {
  const yt = await getClient();
  const charts = await yt.music.getCharts(region);
  return (charts.songs || []).slice(0, 30).map((item, i) => ({
    ...formatSongItem(item),
    rank: item.rank || i + 1
  })).filter(x => x && x.videoId);
}

async function getRelated(videoId) {
  const yt = await getClient();
  const info = await yt.music.getUpNext(videoId);
  return (info.contents || []).slice(0, 20).map(formatSongItem).filter(Boolean);
}

async function getNewReleases() {
  const yt = await getClient();
  try {
    const home = await yt.music.getHomeFeed();
    const sections = home.sections || [];
    const results = [];
    for (const section of sections) {
      const title = section.header?.title?.text || '';
      if (title.toLowerCase().includes('new') || title.toLowerCase().includes('release')) {
        const items = (section.contents || []).slice(0, 10).map(formatSongItem).filter(Boolean);
        if (items.length) results.push({ section: title, items });
      }
    }
    return results;
  } catch (e) {
    return [];
  }
}

async function getHomePage() {
  const yt = await getClient();
  const home = await yt.music.getHomeFeed();
  const sections = home.sections || [];

  const result = [];
  for (const section of sections) {
    const title = section.header?.title?.text || 'Featured';
    const items = (section.contents || [])
      .slice(0, 15)
      .map(formatSongItem)
      .filter(Boolean);
    if (items.length > 0) {
      result.push({ title, items });
    }
  }
  return result.slice(0, 10);
}

async function getLyrics(videoId) {
  const yt = await getClient();
  try {
    const info = await yt.music.getInfo(videoId);
    const lyrics = info?.lyrics;

    if (!lyrics) return { available: false };

    // Synced lyrics
    if (lyrics.has_timed_lyrics && lyrics.text) {
      const parsed = lyrics.text
        .split('\n')
        .map(line => {
          const m = line.match(/^\[(\d+):(\d+\.\d+)\]\s*(.*)$/);
          if (m) {
            const seconds = parseInt(m[1]) * 60 + parseFloat(m[2]);
            return { time: seconds, text: m[3] };
          }
          return { time: null, text: line };
        })
        .filter(l => l.text);

      return { available: true, synced: true, lines: parsed };
    }

    // Plain lyrics
    return {
      available: true,
      synced: false,
      lines: lyrics.text?.split('\n').filter(l => l.trim()).map(t => ({ time: null, text: t })) || []
    };
  } catch (e) {
    return { available: false, error: e.message };
  }
}

async function getArtist(browseId) {
  const yt = await getClient();
  const artist = await yt.music.getArtist(browseId);
  return {
    name: artist.header?.title?.text || '',
    description: artist.description,
    thumbnail: artist.header?.thumbnail?.contents?.[0]?.url || artist.header?.thumbnail?.[0]?.url,
    subscribers: artist.header?.subscriber_count?.text,
    songs: (artist.songs?.contents || []).slice(0, 20).map(formatSongItem).filter(Boolean),
    albums: (artist.albums?.contents || []).slice(0, 20).map(a => ({
      browseId: a.id,
      title: a.title,
      year: a.year,
      thumbnail: a.thumbnail?.[0]?.url
    }))
  };
}

async function getAlbum(browseId) {
  const yt = await getClient();
  const album = await yt.music.getAlbum(browseId);
  return {
    title: album.header?.title?.text || '',
    artist: album.header?.subtitle?.text || '',
    year: album.header?.second_subtitle?.text || '',
    thumbnail: album.header?.thumbnail?.contents?.[0]?.url || album.header?.thumbnail?.[0]?.url,
    tracks: (album.contents || []).slice(0, 50).map(formatSongItem).filter(Boolean)
  };
}

async function getPlaylist(browseId, limit = 100) {
  const yt = await getClient();
  const playlist = await yt.music.getPlaylist(browseId);
  return {
    title: playlist.header?.title?.text || '',
    author: playlist.header?.author?.name || '',
    description: playlist.header?.description?.text || '',
    thumbnail: playlist.header?.thumbnail?.contents?.[0]?.url || playlist.header?.thumbnail?.[0]?.url,
    itemCount: playlist.header?.item_count?.text || '',
    tracks: (playlist.items || []).slice(0, limit).map(item => {
      if (item.item_type === 'song' || item.item_type === 'video') return formatSongItem(item);
      return null;
    }).filter(Boolean)
  };
}

// ==================== IN-MEMORY USER PLAYLISTS ====================
// For production, replace with MongoDB/PostgreSQL
const userPlaylists = new Map(); // userId → Map(playlistId → playlist)

function getUserPlaylists(userId = 'default') {
  if (!userPlaylists.has(userId)) userPlaylists.set(userId, new Map());
  return userPlaylists.get(userId);
}

function createPlaylist(userId, name) {
  const playlists = getUserPlaylists(userId);
  const id = crypto.randomBytes(8).toString('hex');
  const playlist = {
    id, name, tracks: [], createdAt: Date.now()
  };
  playlists.set(id, playlist);
  return playlist;
}

// ==================== ROUTES ====================

// Health check for Render
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), cache: cacheMeta.size });
});

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    name: '🎵 Echo Music API v2',
    version: '2.0.0',
    cache: { entries: cacheMeta.size, ttl: `${CACHE_TTL_MS / 60000} min` },
    endpoints: {
      search: 'GET /api/search?q=song&limit=20',
      searchAll: 'GET /api/search/all?q=song',
      home: 'GET /api/home',
      trending: 'GET /api/trending?region=IN',
      newReleases: 'GET /api/new',
      related: 'GET /api/related/:videoId',
      lyrics: 'GET /api/lyrics/:videoId',
      artist: 'GET /api/artist/:browseId',
      album: 'GET /api/album/:browseId',
      playlistInfo: 'GET /api/playlist/:browseId',
      stream: 'GET /api/stream/:videoId?quality=opus-160',
      download: 'GET /api/download/:videoId?quality=m4a-128',
      formats: 'GET /api/formats/:videoId',
      qualities: 'GET /api/qualities',
      userPlaylists: 'GET /api/user/playlists',
      createPlaylist: 'POST /api/user/playlists {name}',
      addToPlaylist: 'POST /api/user/playlists/:id/add {videoId}',
      removeFromPlaylist: 'DELETE /api/user/playlists/:id/:videoId',
      deletePlaylist: 'DELETE /api/user/playlists/:id',
    }
  });
});

// Qualities list
app.get('/api/qualities', (req, res) => {
  res.json({
    success: true,
    qualities: Object.entries(QUALITY_MAP).map(([key, v]) => ({ key, ...v }))
  });
});

// Search
app.get('/api/search', async (req, res) => {
  try {
    const { q, limit = 20 } = req.query;
    if (!q) return res.status(400).json({ error: 'q required' });
    const results = await searchMusic(q, parseInt(limit));
    res.json({ success: true, query: q, count: results.length, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/search/all', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'q required' });
    const results = await searchAll(q);
    res.json({ success: true, query: q, ...results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Home
app.get('/api/home', async (req, res) => {
  try {
    const sections = await getHomePage();
    res.json({ success: true, sections });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Trending
app.get('/api/trending', async (req, res) => {
  try {
    const { region = 'IN' } = req.query;
    const results = await getTrending(region);
    res.json({ success: true, region, count: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// New releases
app.get('/api/new', async (req, res) => {
  try {
    const sections = await getNewReleases();
    res.json({ success: true, sections });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Related
app.get('/api/related/:videoId', async (req, res) => {
  try {
    const results = await getRelated(req.params.videoId);
    res.json({ success: true, count: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lyrics
app.get('/api/lyrics/:videoId', async (req, res) => {
  try {
    const lyrics = await getLyrics(req.params.videoId);
    res.json({ success: true, videoId: req.params.videoId, ...lyrics });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Artist
app.get('/api/artist/:browseId', async (req, res) => {
  try {
    const data = await getArtist(req.params.browseId);
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Album
app.get('/api/album/:browseId', async (req, res) => {
  try {
    const data = await getAlbum(req.params.browseId);
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// YouTube playlist info
app.get('/api/playlist/:browseId', async (req, res) => {
  try {
    const data = await getPlaylist(req.params.browseId);
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Available formats for a video
app.get('/api/formats/:videoId', async (req, res) => {
  try {
    const yt = await getClient();
    const info = await yt.getInfo(req.params.videoId);
    const audioFormats = (info.streaming_data?.adaptive_formats || [])
      .filter(f => f.mime_type?.startsWith('audio/'))
      .map(f => ({
        itag: f.itag,
        codec: f.mime_type.includes('opus') ? 'opus' : 'aac',
        ext: f.mime_type.includes('opus') ? 'opus' : 'm4a',
        bitrate: Math.round((f.bitrate || 0) / 1000),
        sampleRate: f.audio_sample_rate,
        channels: f.audio_channels,
        mimeType: f.mime_type,
        contentLength: f.content_length ? parseInt(f.content_length) : 0
      }))
      .sort((a, b) => b.bitrate - a.bitrate);

    res.json({
      success: true,
      videoId: req.params.videoId,
      title: info.basic_info.title,
      artist: info.basic_info.author,
      duration: info.basic_info.duration,
      thumbnail: info.basic_info.thumbnail?.[0]?.url,
      formats: audioFormats
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🎧 STREAM — Cached file serves (Range supported)
// Example: /api/stream/VIDEO_ID?quality=opus-160
app.get('/api/stream/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    const { quality = 'opus-160' } = req.query;

    if (!QUALITY_MAP[quality]) {
      return res.status(400).json({
        error: 'Invalid quality',
        valid: Object.keys(QUALITY_MAP)
      });
    }

    // Get from cache OR download it now (with deduplication)
    const entry = await getOrCreateCache(videoId, quality);

    const stat = fs.statSync(entry.filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    // Headers
    res.setHeader('Content-Type', entry.mime);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('X-Cache', entry.fromCache ? 'HIT' : 'MISS');
    res.setHeader('X-Expires-At', new Date(entry.createdAt + CACHE_TTL_MS).toISOString());

    if (range) {
      // Partial content for seeking
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', chunkSize);

      fs.createReadStream(entry.filePath, { start, end }).pipe(res);
    } else {
      // Full file
      res.setHeader('Content-Length', fileSize);
      fs.createReadStream(entry.filePath).pipe(res);
    }
  } catch (err) {
    console.error('Stream error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// 🎵 STREAM-INFO — gives stream URL of THIS backend (not YouTube)
app.get('/api/stream-info/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    const { quality = 'opus-160' } = req.query;

    if (!QUALITY_MAP[quality]) {
      return res.status(400).json({ error: 'Invalid quality' });
    }

    // Preload into cache
    const entry = await getOrCreateCache(videoId, quality);

    res.json({
      success: true,
      videoId,
      title: entry.title,
      artist: entry.artist,
      duration: entry.duration,
      thumbnail: entry.thumbnail,
      quality,
      format: {
        ext: entry.ext,
        mime: entry.mime,
        size: entry.size,
        itag: QUALITY_MAP[quality].itag,
        bitrate: QUALITY_MAP[quality].bitrate
      },
      streamUrl: `${req.protocol}://${req.get('host')}/api/stream/${videoId}?quality=${quality}`,
      downloadUrl: `${req.protocol}://${req.get('host')}/api/download/${videoId}?quality=${quality}`,
      fromCache: entry.fromCache,
      expiresAt: new Date(entry.createdAt + CACHE_TTL_MS).toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ⬇️ DOWNLOAD
app.get('/api/download/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    const { quality = 'm4a-128' } = req.query;

    if (!QUALITY_MAP[quality]) {
      return res.status(400).json({ error: 'Invalid quality' });
    }

    const entry = await getOrCreateCache(videoId, quality);
    const stat = fs.statSync(entry.filePath);

    const filename = `${sanitizeFilename(entry.title)} - ${sanitizeFilename(entry.artist)}.${entry.ext}`;

    res.setHeader('Content-Type', entry.mime);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Cache', entry.fromCache ? 'HIT' : 'MISS');

    fs.createReadStream(entry.filePath).pipe(res);
  } catch (err) {
    console.error('Download error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ==================== USER PLAYLISTS ====================
app.get('/api/user/playlists', (req, res) => {
  const userId = req.headers['x-user-id'] || 'default';
  const playlists = [...getUserPlaylists(userId).values()];
  res.json({ success: true, count: playlists.length, playlists });
});

app.post('/api/user/playlists', (req, res) => {
  const userId = req.headers['x-user-id'] || 'default';
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const playlist = createPlaylist(userId, name);
  res.json({ success: true, playlist });
});

app.post('/api/user/playlists/:id/add', (req, res) => {
  const userId = req.headers['x-user-id'] || 'default';
  const playlists = getUserPlaylists(userId);
  const playlist = playlists.get(req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

  const { videoId } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });

  if (!playlist.tracks.find(t => t.videoId === videoId)) {
    playlist.tracks.push({ videoId, addedAt: Date.now() });
  }
  res.json({ success: true, playlist });
});

app.delete('/api/user/playlists/:id/:videoId', (req, res) => {
  const userId = req.headers['x-user-id'] || 'default';
  const playlists = getUserPlaylists(userId);
  const playlist = playlists.get(req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

  playlist.tracks = playlist.tracks.filter(t => t.videoId !== req.params.videoId);
  res.json({ success: true, playlist });
});

app.delete('/api/user/playlists/:id', (req, res) => {
  const userId = req.headers['x-user-id'] || 'default';
  const playlists = getUserPlaylists(userId);
  const ok = playlists.delete(req.params.id);
  res.json({ success: ok });
});

// ==================== CACHE ADMIN ====================
app.get('/api/cache/stats', (req, res) => {
  let totalSize = 0;
  for (const e of cacheMeta.values()) totalSize += e.size || 0;
  res.json({
    success: true,
    entries: cacheMeta.size,
    totalSizeMB: +(totalSize / 1024 / 1024).toFixed(2),
    ttlMinutes: CACHE_TTL_MS / 60000,
    items: [...cacheMeta.entries()].map(([key, e]) => ({
      key,
      videoId: e.videoId,
      quality: e.quality,
      sizeMB: +(e.size / 1024 / 1024).toFixed(2),
      ageMinutes: +((Date.now() - e.createdAt) / 60000).toFixed(1),
      expiresIn: Math.max(0, Math.round((e.createdAt + CACHE_TTL_MS - Date.now()) / 60000))
    }))
  });
});

app.post('/api/cache/clear', (req, res) => {
  let removed = 0;
  for (const [key, e] of cacheMeta.entries()) {
    try { fs.unlinkSync(e.filePath); removed++; } catch {}
    cacheMeta.delete(key);
  }
  res.json({ success: true, removed });
});

// ==================== ERROR HANDLER ====================
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  if (!res.headersSent) res.status(500).json({ error: err.message });
});

// ==================== START ====================
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('============================================');
  console.log(`🎵 Echo Music API v2.0`);
  console.log(`🌐 http://0.0.0.0:${PORT}`);
  console.log(`📁 Cache: ${CACHE_DIR}`);
  console.log(`⏱️  TTL: ${CACHE_TTL_MS / 60000} min`);
  console.log(`💾 Max size: ${(MAX_CACHE_SIZE / 1024 / 1024).toFixed(0)} MB`);
  console.log('============================================');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, cleaning up...');
  cleanupExpiredCache().finally(() => process.exit(0));
});
