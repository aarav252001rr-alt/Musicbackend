// scripts/install-ytdlp.js
// Robust yt-dlp downloader for Render.com

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const BIN_DIR = path.join(__dirname, '..', 'bin');
const BIN_PATH = path.join(BIN_DIR, 'yt-dlp');

function log(msg) { console.log(`[yt-dlp-installer] ${msg}`); }

// Ensure bin dir
if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

// If already valid, skip
if (fs.existsSync(BIN_PATH)) {
  try {
    const stats = fs.statSync(BIN_PATH);
    if (stats.size > 1000000) {  // > 1MB = valid
      log(`✅ Already installed (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
      process.exit(0);
    } else {
      log(`⚠️  Existing binary too small (${stats.size} bytes), re-downloading...`);
      fs.unlinkSync(BIN_PATH);
    }
  } catch (e) {
    fs.unlinkSync(BIN_PATH);
  }
}

log('⬇️  Downloading yt-dlp...');

const URLS = [
  'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp',
  'https://github.com/yt-dlp/yt-dlp/releases/download/2024.11.18/yt-dlp'
];

function downloadFollowRedirects(url, dest, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));

    log(`Fetching: ${url}`);
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; EchoMusicBot/1.0)',
        'Accept': '*/*'
      },
      timeout: 60000
    }, (res) => {
      // Handle redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        const location = res.headers.location;
        log(`→ Redirect ${res.statusCode} to: ${location}`);
        return downloadFollowRedirects(location, dest, maxRedirects - 1)
          .then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const file = fs.createWriteStream(dest);
      let downloaded = 0;

      res.on('data', (chunk) => { downloaded += chunk.length; });
      res.pipe(file);

      file.on('finish', () => {
        file.close(() => {
          log(`✅ Downloaded ${(downloaded / 1024 / 1024).toFixed(1)} MB`);
          resolve();
        });
      });

      file.on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Download timeout'));
    });
  });
}

async function tryDownload() {
  for (const url of URLS) {
    try {
      await downloadFollowRedirects(url, BIN_PATH);
      const size = fs.statSync(BIN_PATH).size;
      if (size < 1000000) {
        throw new Error(`File too small: ${size} bytes`);
      }
      fs.chmodSync(BIN_PATH, 0o755);
      log(`✅ yt-dlp ready at ${BIN_PATH}`);
      return true;
    } catch (e) {
      log(`❌ Failed from ${url}: ${e.message}`);
      try { fs.unlinkSync(BIN_PATH); } catch {}
    }
  }
  return false;
}

(async () => {
  const ok = await tryDownload();
  if (!ok) {
    log('⚠️  yt-dlp download failed. Server will try system yt-dlp at runtime.');
    // Don't fail npm install
  }
  process.exit(0);
})();
