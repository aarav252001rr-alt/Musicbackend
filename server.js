// ============================================================
// 🎵 ECHO MUSIC BACKEND v3.7 — Fast + Robust
// Fixed yt-dlp + Fresh cookies + Parallel processing
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

const CLIENT_TIMEOUT_MS = 7000;
const PARALLEL_CLIENTS = 4;

let YTDLP = process.env.YTDLP_PATH;
if (!YTDLP) {
  const localBin = path.join(__dirname, 'bin', 'yt-dlp');
  YTDLP = fs.existsSync(localBin) ? localBin : 'yt-dlp';
}

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// ==================== yt-dlp VERIFY ====================
function verifyYtdlp() {
  return new Promise((resolve) => {
    execFile(YTDLP, ['--version'], { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        console.error(`❌ yt-dlp FAILED: ${err.message}`);
        console.error(`   Path: ${YTDLP}`);
        console.error(`   Exists: ${fs.existsSync(YTDLP)}`);
        if (fs.existsSync(YTDLP)) {
          console.error(`   Size: ${(fs.statSync(YTDLP).size / 1024 / 1024).toFixed(2)} MB`);
        }
        return resolve({ ok: false, error: err.message });
      }
      const version = stdout.trim();
      const size = fs.existsSync(YTDLP) ? fs.statSync(YTDLP).size : 0;
      console.log(`🎬 yt-dlp: v${version} (${(size / 1024 / 1024).toFixed(1)} MB)`);
      
      if (size < 15 * 1024 * 1024) {
        console.warn(`⚠️  yt-dlp binary is too small (${(size / 1024 / 1024).toFixed(1)} MB). Real binary is ~30 MB.`);
        console.warn(`⚠️  This is likely a corrupt/launcher script — download yt-dlp_linux instead.`);
      }
      resolve({ ok: true, version, size });
    });
  });
}

// ==================== COOKIES ====================
let COOKIES_FILE = null;

function setupCookies() {
  if (process.env.YTDLP_COOKIES_B64) {
    try {
      const cookiesPath = path.join(CACHE_DIR, 'cookies.txt');
      const content = Buffer.from(process.env.YTDLP_COOKIES_B64, 'base64').toString('utf-8');
      fs.writeFileSync(cookiesPath, content, { mode: 0o600 });
      COOKIES_FILE = cookiesPath;
      const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
      console.log(`🍪 Cookies loaded (${lines.length} entries)`);
      return;
    } catch (e) {
      console.error('❌ Cookie decode failed:', e.message);
    }
  }
  if (process.env.COOKIES_FILE && fs.existsSync(process.env.COOKIES_FILE)) {
    COOKIES_FILE = process.env.COOKIES_FILE;
    const count = fs.readFileSync(COOKIES_FILE, 'utf-8')
      .split('\n').filter(l => l.trim() && !l.startsWith('#')).length;
    console.log(`🍪 Cookies: ${COOKIES_FILE} (${count} entries)`);
    return;
  }
  const localCookies = path.join(__dirname, 'cookies', 'cookies.txt');
  if (fs.existsSync(localCookies)) {
    COOKIES_FILE = localCookies;
    console.log(`🍪 Cookies: ${localCookies}`);
    return;
  }
  console.warn('⚠️  NO COOKIES');
}
setupCookies();

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
  message: { error: 'Too many requests' }
}));

// ==================== YT CLIENT (pre-init) ====================
let ytClient = null;
let ytClientPromise = null;

async function getClient() {
  if (ytClient) return ytClient;
  if (ytClientPromise) return ytClientPromise;
  ytClientPromise = Innertube.create({
    lang: 'en',
    location: 'IN',
    retrieve_player: false,
    enable_session_cache: true,
  }).then(client => {
    ytClient = client;
    console.log('✅ YT client ready');
    return client;
  });
  return ytClientPromise;
}

// ⚡ Pre-init
getClient().catch(e => console.error('YT init failed:', e.message));

// ==================== QUALITY MAP ====================
const QUALITY_MAP = {
  'opus-160': {
    ext: 'opus', label: 'Opus 160kbps', bitrate: 160, mime: 'audio/webm',
    ytdlpFormat: 'bestaudio[acodec=opus][abr>=128]/bestaudio[acodec=opus]/bestaudio[ext=webm]/bestaudio/ba'
  },
  'opus-70': {
    ext: 'opus', label: 'Opus 70kbps', bitrate: 70, mime: 'audio/webm',
    ytdlpFormat: 'bestaudio[acodec=opus]/bestaudio[ext=webm]/bestaudio/ba'
  },
  'm4a-128': {
    ext: 'm4a', label: 'M4A 128kbps', bitrate: 128, mime: 'audio/mp4',
    ytdlpFormat: 'bestaudio[ext=m4a][abr>=96]/bestaudio[acodec^=mp4a]/bestaudio[ext=m4a]/bestaudio[acodec=opus]/bestaudio/ba'
  },
  'm4a-48': {
    ext: 'm4a', label: 'M4A 48kbps', bitrate: 48, mime: 'audio/mp4',
    ytdlpFormat: 'bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio[acodec=opus]/bestaudio/ba'
  },
};

// ⚡ FASTEST first (most likely to work)
const PLAYER_CLIENTS = [
  'android_vr',
  'ios',
  'tv_embedded',
  'web_music',
  'android',
  'mweb',
  'tv',
  'web_safari',
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
    console.log(`♻️  HIT: ${videoId}`);
    return { ...existing, fromCache: true };
  }

  if (inflightDownloads.has(key)) {
    console.log(`⏳ Wait: ${videoId}`);
    return await inflightDownloads.get(key);
  }

  console.log(`⬇️  Download: ${videoId} (${quality})`);
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

// ==================== ⚡ FAST PARALLEL DOWNLOAD ====================
async function downloadWithYtdlp(videoId, quality) {
  const q = QUALITY_MAP[quality];
  if (!q) throw new Error('Invalid quality');

  const firstBatch = PLAYER_CLIENTS.slice(0, PARALLEL_CLIENTS);
  const remaining = PLAYER_CLIENTS.slice(PARALLEL_CLIENTS);

  console.log(`🚀 Parallel: ${firstBatch.join(', ')}`);

  // ⚡ Parallel race — pehle jo succeed kare
  const parallelResults = await Promise.allSettled(
    firstBatch.map(client => tryDownloadWithClient(videoId, quality, client))
  );

  const winner = parallelResults.find(r => r.status === 'fulfilled');
  if (winner) return winner.value;

  // ⚡ Sequential fallback
  console.log(`⚠️  Parallel failed, trying ${remaining.length} more...`);
  const errors = parallelResults.map((r, i) => 
    `[${firstBatch[i]}] ${(r.reason?.message || '').slice(0, 100)}`
  );

  for (const client of remaining) {
    try {
      console.log(`🎯 ${client}`);
      return await tryDownloadWithClient(videoId, quality, client);
    } catch (err) {
      const shortErr = err.message.split('\n')[0].slice(0, 100);
      console.log(`❌ ${client}: ${shortErr}`);
      errors.push(`[${client}] ${shortErr}`);
      cleanupPartial(videoId, quality);
    }
  }

  throw new Error(`All ${PLAYER_CLIENTS.length} clients failed:\n${errors.join('\n')}`);
}

function cleanupPartial(videoId, quality) {
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (f.startsWith(`${videoId}_${quality}`)) {
        try { fs.unlinkSync(path.join(CACHE_DIR, f)); } catch {}
      }
    }
  } catch {}
}

// ==================== Single Client Attempt ====================
function tryDownloadWithClient(videoId, quality, client) {
  return new Promise((resolve, reject) => {
    const q = QUALITY_MAP[quality];
    const uniqueId = `${videoId}_${quality}_${client}_${Date.now()}`;
    const tempTemplate = path.join(CACHE_DIR, `${uniqueId}.%(ext)s`);
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
      '--socket-timeout', '5',
      '--retries', '0',
      '--fragment-retries', '0',
      '--no-check-formats',
      '--no-cache-dir'
    ];

    if (COOKIES_FILE && fs.existsSync(COOKIES_FILE)) {
      args.push('--cookies', COOKIES_FILE);
    }

    args.push(videoUrl);

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const proc = spawn(YTDLP, args);

    const killTimer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGKILL'); } catch {}
    }, CLIENT_TIMEOUT_MS);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      clearTimeout(killTimer);

      if (timedOut) {
        cleanupUnique(uniqueId);
        return reject(new Error(`Timeout ${CLIENT_TIMEOUT_MS}ms`));
      }

      if (code !== 0) {
        cleanupUnique(uniqueId);
        return reject(new Error(stderr.slice(-250) || `exit ${code}`));
      }

      // Find file
      let actualFile = null;
      try {
        const files = fs.readdirSync(CACHE_DIR);
        const match = files.find(f => f.startsWith(uniqueId));
        if (match) actualFile = path.join(CACHE_DIR, match);
      } catch (e) {
        return reject(new Error(`List failed: ${e.message}`));
      }

      if (!actualFile || !fs.existsSync(actualFile)) {
        return reject(new Error('Output not found'));
      }

      const stats = fs.statSync(actualFile);
      if (stats.size < 10000) {
        try { fs.unlinkSync(actualFile); } catch {}
        return reject(new Error(`File too small: ${stats.size}B`));
      }

      // Move to canonical
      try {
        if (fs.existsSync(expectedFile)) {
          try { fs.unlinkSync(expectedFile); } catch {}
        }
        fs.renameSync(actualFile, expectedFile);
      } catch (e) {
        try { fs.unlinkSync(expectedFile); } catch {}
        try { fs.renameSync(actualFile, expectedFile); } catch {}
      }

      const finalPath = fs.existsSync(expectedFile) ? expectedFile : actualFile;
      const finalStats = fs.statSync(finalPath);

      // Metadata
      let meta = {};
      try {
        const lines = stdout.trim().split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const parsed = JSON.parse(lines[i]);
            if (parsed && parsed.title) { meta = parsed; break; }
          } catch {}
        }
      } catch {}

      const actualExt = path.extname(finalPath).replace('.', '').toLowerCase() || q.ext;
      const isWebm = actualExt === 'opus' || actualExt === 'webm';
      const mime = isWebm ? 'audio/webm' : 'audio/mp4';

      console.log(`✅ ${client} → ${actualExt} (${(finalStats.size / 1024).toFixed(0)}KB)`);

      resolve({
        videoId, quality,
        filePath: finalPath,
        createdAt: Date.now(),
        size: finalStats.size,
        title: meta.title || 'Unknown',
        artist: meta.uploader || meta.channel || 'Unknown',
        duration: meta.duration || 0,
        thumbnail: meta.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        mime, ext: actualExt, client
      });
    });

    proc.on('error', (err) => {
      clearTimeout(killTimer);
      cleanupUnique(uniqueId);
      reject(err.code === 'ENOENT' ? new Error(`yt-dlp not found: ${YTDLP}`) : err);
    });
  });
}

function cleanupUnique(uniqueId) {
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (f.startsWith(uniqueId)) {
        try { fs.unlinkSync(path.join(CACHE_DIR, f)); } catch {}
      }
    }
  } catch {}
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
      try {
        const st = fs.statSync(fp);
        if ((now - st.mtimeMs) > CACHE_TTL_MS * 2) {
          fs.unlinkSync(fp);
          removed++;
        }
      } catch {}
    }
  } catch {}

  if (removed) console.log(`🧹 Cleaned ${removed}`);
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
      item.thumbnail?.contents?.[0]?.url || item.thumbnail?.[0]?.url ||
      item.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
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

app.get('/health', async (req, res) => {
  const ytdlpSize = fs.existsSync(YTDLP) ? fs.statSync(YTDLP).size : 0;
  let cookieCount = 0;
  if (COOKIES_FILE && fs.existsSync(COOKIES_FILE)) {
    try {
      cookieCount = fs.readFileSync(COOKIES_FILE, 'utf-8')
        .split('\n').filter(l => l.trim() && !l.startsWith('#')).length;
    } catch {}
  }

  res.json({
    status: 'ok',
    version: '3.7.0',
    uptime: Math.round(process.uptime()),
    cache: cacheMeta.size,
    ytdlp: {
      path: YTDLP,
      exists: fs.existsSync(YTDLP),
      sizeMB: +(ytdlpSize / 1024 / 1024).toFixed(2),
      ok: ytdlpSize > 15 * 1024 * 1024  // ⚠️ Real binary must be >15MB
    },
    cookies: {
      loaded: !!COOKIES_FILE,
      entries: cookieCount,
      ok: cookieCount > 20
    }
  });
});

// ⚡ Warmup — pre-init everything
app.get('/api/warmup', async (req, res) => {
  const start = Date.now();
  try {
    const yt = await getClient();
    await yt.music.search('test', { type: 'song' });
    res.json({ success: true, ms: Date.now() - start });
  } catch (e) {
    res.json({ success: false, error: e.message, ms: Date.now() - start });
  }
});

// ⚡ Diagnostics
app.get('/api/diagnose', async (req, res) => {
  const diag = {
    version: '3.7.0',
    ytdlp: { path: YTDLP, exists: fs.existsSync(YTDLP) },
    cookies: { loaded: !!COOKIES_FILE },
    test: {}
  };

  if (fs.existsSync(YTDLP)) {
    diag.ytdlp.sizeMB = +(fs.statSync(YTDLP).size / 1024 / 1024).toFixed(2);
    diag.ytdlp.ok = diag.ytdlp.sizeMB > 15;
  }

  if (COOKIES_FILE && fs.existsSync(COOKIES_FILE)) {
    diag.cookies.entries = fs.readFileSync(COOKIES_FILE, 'utf-8')
      .split('\n').filter(l => l.trim() && !l.startsWith('#')).length;
    diag.cookies.ok = diag.cookies.entries > 20;
  }

  // Test yt-dlp on a known video
  try {
    const result = await testVideo('dQw4w9WgXcQ');
    diag.test = result;
  } catch (e) {
    diag.test = { error: e.message };
  }

  res.json(diag);
});

function testVideo(videoId) {
  return new Promise((resolve) => {
    const args = [
      '--list-formats',
      '--no-warnings',
      '--no-check-certificates',
      '--extractor-args', 'youtube:player_client=android_vr',
      '--geo-bypass',
      '--geo-bypass-country', 'IN'
    ];
    if (COOKIES_FILE) args.push('--cookies', COOKIES_FILE);
    args.push(`https://www.youtube.com/watch?v=${videoId}`);

    execFile(YTDLP, args, { timeout: 15000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: stderr?.slice(-300) || err.message });
      } else {
        const audio = stdout.split('\n').filter(l => /\b(251|250|249|140|139)\b/.test(l));
        resolve({ ok: true, audioFormats: audio.length, sample: audio.slice(0, 2) });
      }
    });
  });
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', name: '🎵 Echo Music API', version: '3.7.0' });
});

app.get('/api/qualities', (req, res) => {
  res.json({
    success: true,
    qualities: Object.entries(QUALITY_MAP).map(([key, v]) => ({
      key, ext: v.ext, label: v.label, bitrate: v.bitrate
    }))
  });
});

// SEARCH
app.get('/api/search', async (req, res) => {
  try {
    const { q, limit = 20 } = req.query;
    if (!q) return res.status(400).json({ error: 'q required' });
    const results = await searchMusic(q, parseInt(limit));
    res.json({ success: true, query: q, count: results.length, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/search/all', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'q required' });
    res.json({ success: true, query: q, ...(await searchAll(q)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  const start = Date.now();
  try {
    const { videoId } = req.params;
    const quality = req.query.quality || 'm4a-128';
    if (!QUALITY_MAP[quality]) {
      return res.status(400).json({ error: 'Invalid quality', valid: Object.keys(QUALITY_MAP) });
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
      quality,
      actualFormat: { ext: entry.ext, mime: entry.mime, size: entry.size, client: entry.client },
      streamUrl: `${proto}://${host}/api/stream/${videoId}?quality=${quality}`,
      downloadUrl: `${proto}://${host}/api/download/${videoId}?quality=${quality}`,
      fromCache: entry.fromCache,
      expiresAt: new Date(entry.createdAt + CACHE_TTL_MS).toISOString(),
      processingMs: Date.now() - start
    });
  } catch (err) {
    console.error('stream-info error:', err.message);
    res.status(500).json({ error: err.message, processingMs: Date.now() - start });
  }
});

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
    console.error('stream error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

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
    fs.createReadStream(entry.filePath).pipe(res);
  } catch (err) {
    console.error('download error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// SMART STREAM
app.get('/api/smart-stream', async (req, res) => {
  const start = Date.now();
  try {
    const { q, quality = 'm4a-128' } = req.query;
    if (!q) return res.status(400).json({ error: 'q required' });

    const yt = await getClient();
    const results = await yt.music.search(q, { type: 'song' });
    const songs = (results.songs?.contents || []).slice(0, 5);
    if (!songs.length) return res.status(404).json({ error: 'No songs found' });

    const errors = [];
    const songPromises = songs.map(async (song) => {
      try {
        const entry = await getOrCreateCache(song.id, quality);
        return { song, entry };
      } catch (err) {
        errors.push({ videoId: song.id, error: err.message.slice(0, 80) });
        return null;
      }
    });

    const results2 = await Promise.all(songPromises);
    const success = results2.find(r => r !== null);

    if (!success) {
      return res.status(404).json({ error: 'All failed', tried: errors.length, errors });
    }

    const host = req.get('host');
    const proto = req.protocol;

    res.json({
      success: true,
      videoId: success.song.id,
      title: success.entry.title,
      artist: success.entry.artist,
      thumbnail: success.entry.thumbnail,
      quality,
      actualFormat: { ext: success.entry.ext, mime: success.entry.mime, size: success.entry.size, client: success.entry.client },
      streamUrl: `${proto}://${host}/api/stream/${success.song.id}?quality=${quality}`,
      downloadUrl: `${proto}://${host}/api/download/${success.song.id}?quality=${quality}`,
      fromCache: success.entry.fromCache,
      processingMs: Date.now() - start
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

// CACHE
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
      ext: e.ext, client: e.client,
      sizeMB: +(e.size / 1024 / 1024).toFixed(2)
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

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  if (!res.headersSent) res.status(500).json({ error: err.message });
});

// ==================== START ====================
(async () => {
  console.log('');
  console.log('============================================');
  console.log(`🎵 Echo Music API v3.7 (Fast + Robust)`);
  console.log(`🌐 Port: ${PORT}`);
  console.log(`📁 Cache: ${CACHE_DIR}`);
  console.log(`🍪 Cookies: ${COOKIES_FILE || 'NONE ⚠️'}`);
  console.log(`⚡ Parallel clients: ${PARALLEL_CLIENTS}`);
  console.log(`⏱️  Client timeout: ${CLIENT_TIMEOUT_MS}ms`);
  console.log('============================================');

  // Verify yt-dlp
  const check = await verifyYtdlp();
  if (!check.ok) {
    console.error('');
    console.error('⚠️  yt-dlp is BROKEN — downloads will fail!');
    console.error('⚠️  Fix: Change bin/ in .gitignore and redeploy');
    console.error('');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server listening on 0.0.0.0:${PORT}`);
  });
})();

process.on('SIGTERM', () => {
  cleanupExpiredCache().finally(() => process.exit(0));
});
process.on('uncaughtException', (err) => console.error('Uncaught:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled:', err));
