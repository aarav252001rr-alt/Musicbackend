// ============================================================
// 🎵 ECHO MUSIC BACKEND v3.4 — Multi-Client Rotation
// yt-dlp + Cookies + Smart Client Fallback
// Deploy-ready for Render.com
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Innertube } = require('youtubei.js');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');

// ==================== CONFIG ====================
const PORT = process.env.PORT || 5000;
const CACHE_TTL_MS = (parseInt(process.env.CACHE_TTL_MINUTES) || 60) * 60 * 1000;
const CACHE_DIR = path.resolve(process.env.CACHE_DIR || './cache');
const MAX_CACHE_SIZE = (parseInt(process.env.MAX_CACHE_SIZE_MB) || 400) * 1024 * 1024;

// yt-dlp binary
let YTDLP = process.env.YTDLP_PATH;
if (!YTDLP) {
  const localBin = path.join(__dirname, 'bin', 'yt-dlp');
  YTDLP = fs.existsSync(localBin) ? localBin : 'yt-dlp';
}

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// ==================== COOKIES SETUP ====================
let COOKIES_FILE = null;

function setupCookies() {
  if (process.env.YTDLP_COOKIES_B64) {
    try {
      const cookiesPath = path.join(CACHE_DIR, 'cookies.txt');
      const content = Buffer.from(process.env.YTDLP_COOKIES_B64, 'base64').toString('utf-8');
      fs.writeFileSync(cookiesPath, content, { mode: 0o600 });
      COOKIES_FILE = cookiesPath;
      const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
      console.log(`🍪 Cookies loaded from ENV (${lines.length} entries)`);
      return;
    } catch (e) {
      console.error('❌ Failed to decode YTDLP_COOKIES_B64:', e.message);
    }
  }

  if (process.env.COOKIES_FILE && fs.existsSync(process.env.COOKIES_FILE)) {
    COOKIES_FILE = process.env.COOKIES_FILE;
    const count = fs.readFileSync(COOKIES_FILE, 'utf-8')
      .split('\n').filter(l => l.trim() && !l.startsWith('#')).length;
    console.log(`🍪 Cookies from env path: ${COOKIES_FILE} (${count} entries)`);
    return;
  }

  const localCookies = path.join(__dirname, 'cookies', 'cookies.txt');
  if (fs.existsSync(localCookies)) {
    COOKIES_FILE = localCookies;
    const count = fs.readFileSync(localCookies, 'utf-8')
      .split('\n').filter(l => l.trim() && !l.startsWith('#')).length;
    console.log(`🍪 Cookies from local: ${localCookies} (${count} entries)`);
    return;
  }

  console.warn('⚠️  NO COOKIES FOUND — YouTube may block requests');
}

setupCookies();

// ==================== VERIFY yt-dlp ====================
function verifyYtdlp() {
  try {
    if (YTDLP !== 'yt-dlp' && fs.existsSync(YTDLP)) {
      const size = fs.statSync(YTDLP).size;
      console.log(`📦 yt-dlp: ${YTDLP} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    } else {
      console.log(`📦 System yt-dlp: ${YTDLP}`);
    }
  } catch (e) {
    console.error('yt-dlp verify error:', e.message);
  }
}
verifyYtdlp();

// ==================== APP ====================
const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Slow down!' }
}));

// ==================== YOUTUBE CLIENT (metadata) ====================
let ytClient = null;
async function getClient() {
  if (!ytClient) {
    ytClient = await Innertube.create({
      lang: 'en',
      location: 'IN',
      retrieve_player: false,
    });
    console.log('✅ YT client ready (metadata)');
  }
  return ytClient;
}

// ==================== QUALITY MAP ====================
const QUALITY_MAP = {
  'opus-160': {
    ext: 'opus', label: 'Opus 160kbps', bitrate: 160, mime: 'audio/webm',
    ytdlpFormat: 'bestaudio[acodec=opus][abr>=128]/bestaudio[acodec=opus]/bestaudio[ext=webm]/bestaudio'
  },
  'opus-70': {
    ext: 'opus', label: 'Opus 70kbps', bitrate: 70, mime: 'audio/webm',
    ytdlpFormat: 'bestaudio[acodec=opus]/bestaudio[ext=webm]/bestaudio'
  },
  'm4a-128': {
    ext: 'm4a', label: 'M4A 128kbps', bitrate: 128, mime: 'audio/mp4',
    ytdlpFormat: 'bestaudio[ext=m4a][abr>=96]/bestaudio[acodec^=mp4a]/bestaudio[ext=m4a]/bestaudio[acodec=opus]/bestaudio'
  },
  'm4a-48': {
    ext: 'm4a', label: 'M4A 48kbps', bitrate: 48, mime: 'audio/mp4',
    ytdlpFormat: 'bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio[acodec=opus]/bestaudio'
  },
};

// ==================== PLAYER CLIENTS (rotation list) ====================
const PLAYER_CLIENTS = [
  'tv_embedded',   // best for music
  'android_vr',    // no PO token needed
  'ios',
  'android',
  'tv',
  'web_music',     // YouTube Music
  'web_safari',
  'mweb',
  'web_embedded',
  'web'
];

// ==================== CACHE ====================
const cacheMeta = new Map();

function cacheFilePath(videoId, quality) {
  const ext = QUALITY_MAP[quality]?.ext || 'm4a';
  return path.join(CACHE_DIR, `${videoId}_${quality}.${ext}`);
}

function isCacheValid(entry) {
  return entry
    && (Date.now() - entry.createdAt) < CACHE_TTL_MS
    && fs.existsSync(entry.filePath);
}

const inflightDownloads = new Map();

async function getOrCreateCache(videoId, quality) {
  const key = `${videoId}__${quality}`;
  const existing = cacheMeta.get(key);

  if (isCacheValid(existing)) {
    console.log(`♻️  CACHE HIT: ${videoId} (${quality})`);
    return { ...existing, fromCache: true };
  }

  if (inflightDownloads.has(key)) {
    console.log(`⏳ Waiting for in-flight: ${videoId}`);
    return await inflightDownloads.get(key);
  }

  console.log(`⬇️  Downloading: ${videoId} (${quality})`);
  const promise = downloadWithYtdlp(videoId, quality)
    .then((entry) => {
      cacheMeta.set(key, entry);
      inflightDownloads.delete(key);
      return { ...entry, fromCache: false };
    })
    .catch((err) => {
      inflightDownloads.delete(key);
      throw err;
    });

  inflightDownloads.set(key, promise);
  return promise;
}

// ==================== yt-dlp DOWNLOAD (Multi-Client Rotation) ====================
async function downloadWithYtdlp(videoId, quality) {
  const q = QUALITY_MAP[quality];
  if (!q) throw new Error('Invalid quality');

  const errors = [];

  for (const client of PLAYER_CLIENTS) {
    try {
      console.log(`🎯 Trying client: ${client}`);
      const result = await tryDownloadWithClient(videoId, quality, client);
      console.log(`✅ Success with client: ${client}`);
      return result;
    } catch (err) {
      const shortErr = err.message.split('\n')[0].slice(0, 150);
      console.log(`❌ ${client}: ${shortErr}`);
      errors.push(`[${client}] ${shortErr}`);

      // Cleanup partial files
      try {
        for (const f of fs.readdirSync(CACHE_DIR)) {
          if (f.startsWith(`${videoId}_${quality}`)) {
            fs.unlinkSync(path.join(CACHE_DIR, f));
          }
        }
      } catch {}
    }
  }

  throw new Error(`All ${PLAYER_CLIENTS.length} clients failed:\n${errors.join('\n')}`);
}

// ==================== Single Client Download ====================
function tryDownloadWithClient(videoId, quality, client) {
  return new Promise((resolve, reject) => {
    const q = QUALITY_MAP[quality];
    const tempTemplate = path.join(CACHE_DIR, `${videoId}_${quality}.%(ext)s`);
    const expectedFile = cacheFilePath(videoId, quality);
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    const args = [
      '-f', q.ytdlpFormat,
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      '--no-part',
      '--no-mtime',
      '--prefer-free-formats',
      '-o', tempTemplate,
      '--print-json',
      '--quiet',
      '--extractor-args', `youtube:player_client=${client}`,
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '--add-header', 'Accept-Language:en-US,en;q=0.9',
      '--geo-bypass',
      '--geo-bypass-country', 'IN',
      '--socket-timeout', '30',
      '--retries', '2',
      '--fragment-retries', '2'
    ];

    if (COOKIES_FILE && fs.existsSync(COOKIES_FILE)) {
      args.push('--cookies', COOKIES_FILE);
    }

    args.push(videoUrl);

    let stdout = '';
    let stderr = '';

    const proc = spawn(YTDLP, args, { timeout: 90000 });

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(stderr.slice(-400) || `exit code ${code}`));
      }

      let actualFile = null;
      try {
        const files = fs.readdirSync(CACHE_DIR);
        const match = files.find(f =>
          f.startsWith(`${videoId}_${quality}`)
          && !f.endsWith('.txt')
          && !f.endsWith('.json')
          && !f.endsWith('.part')
          && !f.endsWith('.ytdl')
        );
        if (match) actualFile = path.join(CACHE_DIR, match);
      } catch (e) {
        return reject(new Error(`List dir failed: ${e.message}`));
      }

      if (!actualFile || !fs.existsSync(actualFile)) {
        return reject(new Error('Output file not found after download'));
      }

      const stats = fs.statSync(actualFile);
      if (stats.size < 10000) {
        try { fs.unlinkSync(actualFile); } catch {}
        return reject(new Error(`File too small: ${stats.size} bytes`));
      }

      // Rename to canonical path
      if (actualFile !== expectedFile) {
        try {
          if (fs.existsSync(expectedFile)) fs.unlinkSync(expectedFile);
          fs.renameSync(actualFile, expectedFile);
        } catch (e) {
          console.warn('Rename failed:', e.message);
        }
      }

      const finalPath = fs.existsSync(expectedFile) ? expectedFile : actualFile;
      const finalStats = fs.statSync(finalPath);

      // Parse metadata JSON
      let meta = {};
      try {
        const lines = stdout.trim().split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const parsed = JSON.parse(lines[i]);
            if (parsed && parsed.title) { meta = parsed; break; }
          } catch {}
        }
      } catch (e) {}

      const actualExt = path.extname(finalPath).replace('.', '').toLowerCase() || q.ext;
      const isWebm = actualExt === 'opus' || actualExt === 'webm';
      const mime = isWebm ? 'audio/webm' : 'audio/mp4';

      console.log(`✅ Downloaded: ${actualExt} (${(finalStats.size / 1024).toFixed(0)} KB) via ${client}`);

      resolve({
        videoId,
        quality,
        filePath: finalPath,
        createdAt: Date.now(),
        size: finalStats.size,
        title: meta.title || 'Unknown',
        artist: meta.uploader || meta.channel || 'Unknown',
        duration: meta.duration || 0,
        thumbnail: meta.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        mime,
        ext: actualExt,
        client
      });
    });

    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        return reject(new Error(`yt-dlp not found at ${YTDLP}`));
      }
      reject(err);
    });
  });
}

// ==================== DEBUG: Test single client ====================
function testClient(videoId, client) {
  return new Promise((resolve) => {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const args = [
      '--list-formats',
      '--no-warnings',
      '--no-check-certificates',
      '--extractor-args', `youtube:player_client=${client}`,
      '--geo-bypass',
      '--geo-bypass-country', 'IN',
      '--socket-timeout', '20'
    ];
    if (COOKIES_FILE && fs.existsSync(COOKIES_FILE)) {
      args.push('--cookies', COOKIES_FILE);
    }
    args.push(videoUrl);

    execFile(YTDLP, args, { timeout: 25000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        return resolve({
          ok: false,
          error: err.message.split('\n')[0].slice(0, 200),
          stderr: stderr?.slice(-300)
        });
      }

      // Count audio formats (skip storyboards)
      const lines = stdout.split('\n');
      const audioFormats = lines.filter(l => {
        if (l.includes('storyboard') || l.includes('mhtml')) return false;
        if (l.includes('RESOLUTION') || l.startsWith('---') || l.startsWith('ID')) return false;
        // Match audio-only format rows
        return /\b(audio|opus|mp4a|vorbis)\b/i.test(l) || /\b(251|250|249|140|139|599|600)\b/.test(l);
      });

      resolve({
        ok: true,
        audioFormatsFound: audioFormats.length,
        sample: audioFormats.slice(0, 3),
        totalLines: lines.length
      });
    });
  });
}

// ==================== CLEANUP ====================
async function cleanupExpiredCache() {
  let removed = 0;
  const now = Date.now();

  for (const [key, entry] of cacheMeta.entries()) {
    if ((now - entry.createdAt) >= CACHE_TTL_MS || !fs.existsSync(entry.filePath)) {
      try { if (fs.existsSync(entry.filePath)) fs.unlinkSync(entry.filePath); } catch {}
      cacheMeta.delete(key);
      removed++;
    }
  }

  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (f === 'cookies.txt') continue;
      const fp = path.join(CACHE_DIR, f);
      const st = fs.statSync(fp);
      if ((now - st.mtimeMs) > CACHE_TTL_MS) {
        fs.unlinkSync(fp);
        removed++;
      }
    }
  } catch {}

  let totalSize = 0;
  for (const e of cacheMeta.values()) totalSize += e.size || 0;
  if (totalSize > MAX_CACHE_SIZE) {
    const sorted = [...cacheMeta.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [key, e] of sorted) {
      if (totalSize <= MAX_CACHE_SIZE * 0.8) break;
      try { fs.unlinkSync(e.filePath); totalSize -= e.size; } catch {}
      cacheMeta.delete(key);
      removed++;
    }
  }

  if (removed) console.log(`🧹 Cleaned ${removed} files`);
}

setInterval(cleanupExpiredCache, 10 * 60 * 1000);

// ==================== HELPERS ====================
function sanitizeFilename(str) {
  return (str || 'audio').replace(/[^\w\s-]/g, '').trim().slice(0, 60) || 'audio';
}

function formatSongItem(item) {
  if (!item) return null;
  const videoId = item.id || item.video_id;
  if (!videoId) return null;
  return {
    videoId,
    title: item.title?.text || item.title || 'Unknown',
    artist: item.artists?.map(a => a.name).join(', ') || item.author?.name || 'Unknown',
    album: item.album?.name || null,
    duration: item.duration?.text || '0:00',
    durationSeconds: item.duration?.seconds || 0,
    thumbnail:
      item.thumbnail?.contents?.[0]?.url ||
      item.thumbnail?.[0]?.url ||
      item.thumbnails?.[0]?.url ||
      `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    url: `https://music.youtube.com/watch?v=${videoId}`
  };
}

// ==================== MUSIC FUNCTIONS ====================
async function searchMusic(query, limit = 20) {
  const yt = await getClient();
  const results = await yt.music.search(query, { type: 'song' });
  return (results.songs?.contents || []).slice(0, limit).map(formatSongItem).filter(Boolean);
}

async function searchAll(query) {
  const yt = await getClient();
  const r = await yt.music.search(query);
  return {
    songs: (r.songs?.contents || []).slice(0, 15).map(formatSongItem).filter(Boolean),
    videos: (r.videos?.contents || []).slice(0, 10).map(formatSongItem).filter(Boolean),
    albums: (r.albums?.contents || []).slice(0, 10).map(a => ({
      browseId: a.id, title: a.title,
      artist: a.artists?.map(x => x.name).join(', ') || '',
      year: a.year, thumbnail: a.thumbnail?.[0]?.url
    })),
    artists: (r.artists?.contents || []).slice(0, 10).map(a => ({
      browseId: a.id, name: a.name,
      subscribers: a.subscribers?.text, thumbnail: a.thumbnail?.[0]?.url
    })),
    playlists: (r.playlists?.contents || []).slice(0, 10).map(p => ({
      browseId: p.id, title: p.title, author: p.author?.name,
      itemCount: p.item_count, thumbnail: p.thumbnail?.[0]?.url
    }))
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

async function getHomePage() {
  const yt = await getClient();
  const home = await yt.music.getHomeFeed();
  const sections = home.sections || [];
  const result = [];
  for (const s of sections) {
    const title = s.header?.title?.text || 'Featured';
    const items = (s.contents || []).slice(0, 15).map(formatSongItem).filter(Boolean);
    if (items.length) result.push({ title, items });
  }
  return result.slice(0, 10);
}

async function getNewReleases() {
  const yt = await getClient();
  try {
    const home = await yt.music.getHomeFeed();
    const sections = home.sections || [];
    const result = [];
    for (const s of sections) {
      const title = s.header?.title?.text || '';
      const lower = title.toLowerCase();
      if (lower.includes('new') || lower.includes('release') || lower.includes('fresh')) {
        const items = (s.contents || []).slice(0, 15).map(formatSongItem).filter(Boolean);
        if (items.length) result.push({ section: title, items });
      }
    }
    return result;
  } catch {
    return [];
  }
}

async function getLyrics(videoId) {
  const yt = await getClient();
  try {
    const info = await yt.music.getInfo(videoId);
    const lyrics = info?.lyrics;
    if (!lyrics) return { available: false };

    if (lyrics.has_timed_lyrics && lyrics.text) {
      const parsed = lyrics.text.split('\n').map(line => {
        const m = line.match(/^\[(\d+):(\d+\.\d+)\]\s*(.*)$/);
        if (m) return { time: parseInt(m[1]) * 60 + parseFloat(m[2]), text: m[3] };
        return { time: null, text: line };
      }).filter(l => l.text);
      return { available: true, synced: true, lines: parsed };
    }

    return {
      available: true, synced: false,
      lines: (lyrics.text || '').split('\n').filter(l => l.trim())
        .map(t => ({ time: null, text: t }))
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
      browseId: a.id, title: a.title, year: a.year, thumbnail: a.thumbnail?.[0]?.url
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

async function getPlaylistInfo(browseId, limit = 100) {
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

// ==================== USER PLAYLISTS ====================
const userPlaylists = new Map();

function getUserPlaylists(userId = 'default') {
  if (!userPlaylists.has(userId)) userPlaylists.set(userId, new Map());
  return userPlaylists.get(userId);
}

function createPlaylist(userId, name) {
  const pls = getUserPlaylists(userId);
  const id = crypto.randomBytes(8).toString('hex');
  const pl = { id, name, tracks: [], createdAt: Date.now() };
  pls.set(id, pl);
  return pl;
}

// ==================== ROUTES ====================

app.get('/health', (req, res) => {
  let ytdlpOk = YTDLP === 'yt-dlp';
  let ytdlpSize = 0;
  try {
    if (fs.existsSync(YTDLP)) {
      ytdlpSize = fs.statSync(YTDLP).size;
      ytdlpOk = ytdlpSize > 1000000;
    }
  } catch {}

  let cookieCount = 0;
  if (COOKIES_FILE && fs.existsSync(COOKIES_FILE)) {
    try {
      cookieCount = fs.readFileSync(COOKIES_FILE, 'utf-8')
        .split('\n').filter(l => l.trim() && !l.startsWith('#')).length;
    } catch {}
  }

  res.json({
    status: 'ok',
    version: '3.4.0',
    uptime: process.uptime(),
    cache: cacheMeta.size,
    ytdlp: {
      path: YTDLP,
      exists: fs.existsSync(YTDLP) || YTDLP === 'yt-dlp',
      sizeMB: +(ytdlpSize / 1024 / 1024).toFixed(1),
      ok: ytdlpOk
    },
    cookies: {
      loaded: !!COOKIES_FILE,
      path: COOKIES_FILE,
      exists: COOKIES_FILE ? fs.existsSync(COOKIES_FILE) : false,
      entries: cookieCount
    },
    clients: PLAYER_CLIENTS
  });
});

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    name: '🎵 Echo Music API',
    version: '3.4.0',
    cache: { entries: cacheMeta.size, ttl: `${CACHE_TTL_MS / 60000} min` }
  });
});

app.get('/api/qualities', (req, res) => {
  res.json({
    success: true,
    qualities: Object.entries(QUALITY_MAP).map(([key, v]) => ({
      key, ext: v.ext, label: v.label, bitrate: v.bitrate
    }))
  });
});

app.get('/api/test-ytdlp', (req, res) => {
  execFile(YTDLP, ['--version'], { timeout: 10000 }, (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({
        ok: false, path: YTDLP, error: err.message,
        exists: fs.existsSync(YTDLP)
      });
    }
    res.json({
      ok: true, version: stdout.trim(), path: YTDLP,
      cookiesLoaded: !!COOKIES_FILE
    });
  });
});

// 🎯 Debug: Test all clients for a video
app.get('/api/debug-formats/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const results = {};

  await Promise.all(PLAYER_CLIENTS.map(async (client) => {
    try {
      results[client] = await testClient(videoId, client);
    } catch (e) {
      results[client] = { ok: false, error: e.message };
    }
  }));

  // Summary
  const working = Object.entries(results)
    .filter(([_, r]) => r.ok && r.audioFormatsFound > 0)
    .map(([c]) => c);

  res.json({
    success: true,
    videoId,
    workingClients: working,
    totalWorking: working.length,
    results
  });
});

// SEARCH
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
    res.json({ success: true, query: q, ...(await searchAll(q)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/home', async (req, res) => {
  try { res.json({ success: true, sections: await getHomePage() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/trending', async (req, res) => {
  try {
    const { region = 'IN' } = req.query;
    const results = await getTrending(region);
    res.json({ success: true, region, count: results.length, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/new', async (req, res) => {
  try { res.json({ success: true, sections: await getNewReleases() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/related/:videoId', async (req, res) => {
  try {
    const results = await getRelated(req.params.videoId);
    res.json({ success: true, count: results.length, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/lyrics/:videoId', async (req, res) => {
  try {
    const lyrics = await getLyrics(req.params.videoId);
    res.json({ success: true, videoId: req.params.videoId, ...lyrics });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/artist/:browseId', async (req, res) => {
  try { res.json({ success: true, ...(await getArtist(req.params.browseId)) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/album/:browseId', async (req, res) => {
  try { res.json({ success: true, ...(await getAlbum(req.params.browseId)) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/playlist/:browseId', async (req, res) => {
  try { res.json({ success: true, ...(await getPlaylistInfo(req.params.browseId)) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// STREAM INFO
app.get('/api/stream-info/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    const quality = req.query.quality || 'm4a-128';

    if (!QUALITY_MAP[quality]) {
      return res.status(400).json({
        error: 'Invalid quality',
        valid: Object.keys(QUALITY_MAP)
      });
    }

    const entry = await getOrCreateCache(videoId, quality);
    const host = req.get('host');
    const proto = req.protocol;

    res.json({
      success: true,
      videoId,
      title: entry.title,
      artist: entry.artist,
      duration: entry.duration,
      thumbnail: entry.thumbnail,
      requestedQuality: quality,
      actualFormat: {
        ext: entry.ext,
        mime: entry.mime,
        size: entry.size,
        client: entry.client
      },
      streamUrl: `${proto}://${host}/api/stream/${videoId}?quality=${quality}`,
      downloadUrl: `${proto}://${host}/api/download/${videoId}?quality=${quality}`,
      fromCache: entry.fromCache,
      expiresAt: new Date(entry.createdAt + CACHE_TTL_MS).toISOString()
    });
  } catch (err) {
    console.error('stream-info error:', err);
    res.status(500).json({ error: err.message });
  }
});

// STREAM
app.get('/api/stream/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    const quality = req.query.quality || 'm4a-128';

    if (!QUALITY_MAP[quality]) return res.status(400).json({ error: 'Invalid quality' });

    const entry = await getOrCreateCache(videoId, quality);
    const stat = fs.statSync(entry.filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    res.setHeader('Content-Type', entry.mime);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('X-Cache', entry.fromCache ? 'HIT' : 'MISS');
    res.setHeader('X-Actual-Ext', entry.ext);
    res.setHeader('X-Client', entry.client || 'cache');

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', end - start + 1);
      fs.createReadStream(entry.filePath, { start, end }).pipe(res);
    } else {
      res.setHeader('Content-Length', fileSize);
      fs.createReadStream(entry.filePath).pipe(res);
    }
  } catch (err) {
    console.error('stream error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// DOWNLOAD
app.get('/api/download/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    const quality = req.query.quality || 'm4a-128';
    if (!QUALITY_MAP[quality]) return res.status(400).json({ error: 'Invalid quality' });

    const entry = await getOrCreateCache(videoId, quality);
    const stat = fs.statSync(entry.filePath);
    const filename = `${sanitizeFilename(entry.title)} - ${sanitizeFilename(entry.artist)}.${entry.ext}`;

    res.setHeader('Content-Type', entry.mime);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Cache', entry.fromCache ? 'HIT' : 'MISS');
    res.setHeader('X-Actual-Ext', entry.ext);
    fs.createReadStream(entry.filePath).pipe(res);
  } catch (err) {
    console.error('download error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// USER PLAYLISTS
app.get('/api/user/playlists', (req, res) => {
  const userId = req.headers['x-user-id'] || 'default';
  res.json({ success: true, playlists: [...getUserPlaylists(userId).values()] });
});

app.post('/api/user/playlists', (req, res) => {
  const userId = req.headers['x-user-id'] || 'default';
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  res.json({ success: true, playlist: createPlaylist(userId, name) });
});

app.post('/api/user/playlists/:id/add', (req, res) => {
  const userId = req.headers['x-user-id'] || 'default';
  const pl = getUserPlaylists(userId).get(req.params.id);
  if (!pl) return res.status(404).json({ error: 'Not found' });
  const { videoId } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });
  if (!pl.tracks.find(t => t.videoId === videoId)) {
    pl.tracks.push({ videoId, addedAt: Date.now() });
  }
  res.json({ success: true, playlist: pl });
});

app.delete('/api/user/playlists/:id/:videoId', (req, res) => {
  const userId = req.headers['x-user-id'] || 'default';
  const pl = getUserPlaylists(userId).get(req.params.id);
  if (!pl) return res.status(404).json({ error: 'Not found' });
  pl.tracks = pl.tracks.filter(t => t.videoId !== req.params.videoId);
  res.json({ success: true, playlist: pl });
});

app.delete('/api/user/playlists/:id', (req, res) => {
  const userId = req.headers['x-user-id'] || 'default';
  const ok = getUserPlaylists(userId).delete(req.params.id);
  res.json({ success: ok });
});

// CACHE ADMIN
app.get('/api/cache/stats', (req, res) => {
  let totalSize = 0;
  for (const e of cacheMeta.values()) totalSize += e.size || 0;
  res.json({
    success: true,
    entries: cacheMeta.size,
    totalSizeMB: +(totalSize / 1024 / 1024).toFixed(2),
    ttlMinutes: CACHE_TTL_MS / 60000,
    items: [...cacheMeta.entries()].map(([k, e]) => ({
      key: k, videoId: e.videoId, quality: e.quality, title: e.title,
      ext: e.ext, mime: e.mime, client: e.client,
      sizeMB: +(e.size / 1024 / 1024).toFixed(2),
      ageMinutes: +((Date.now() - e.createdAt) / 60000).toFixed(1),
      expiresIn: Math.max(0, Math.round((e.createdAt + CACHE_TTL_MS - Date.now()) / 60000))
    }))
  });
});

app.post('/api/cache/clear', (req, res) => {
  let removed = 0;
  for (const [k, e] of cacheMeta.entries()) {
    try { fs.unlinkSync(e.filePath); removed++; } catch {}
    cacheMeta.delete(k);
  }
  res.json({ success: true, removed });
});

// ERROR HANDLER
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  if (!res.headersSent) res.status(500).json({ error: err.message });
});

// START
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('============================================');
  console.log(`🎵 Echo Music API v3.4`);
  console.log(`🌐 http://0.0.0.0:${PORT}`);
  console.log(`📁 Cache: ${CACHE_DIR}`);
  console.log(`🎬 yt-dlp: ${YTDLP}`);
  console.log(`🍪 Cookies: ${COOKIES_FILE || 'NONE ⚠️'}`);
  console.log(`🎯 Clients: ${PLAYER_CLIENTS.length} (rotation)`);
  console.log(`⏱️  TTL: ${CACHE_TTL_MS / 60000} min`);
  console.log('============================================');
});

process.on('SIGTERM', () => {
  cleanupExpiredCache().finally(() => process.exit(0));
});

process.on('uncaughtException', (err) => console.error('Uncaught:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled:', err));
