// scripts/install-ytdlp.js
// Downloads proper yt-dlp standalone binary for Render

const fs = require('fs');
const path = require('path');
const https = require('https');

const BIN_DIR = path.join(__dirname, '..', 'bin');
const BIN_PATH = path.join(BIN_DIR, 'yt-dlp');

if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

function log(msg) { console.log(`[yt-dlp-install] ${msg}`); }

// Check if already valid (must be > 15 MB for real binary)
if (fs.existsSync(BIN_PATH)) {
  const size = fs.statSync(BIN_PATH).size;
  if (size > 15 * 1024 * 1024) {
    log(`✅ Already installed (${(size / 1024 / 1024).toFixed(1)} MB)`);
    process.exit(0);
  } else {
    log(`⚠️  Existing binary too small (${(size / 1024 / 1024).toFixed(1)} MB) — removing`);
    fs.unlinkSync(BIN_PATH);
  }
}

// ⚠️ IMPORTANT: use "yt-dlp_linux" (standalone Linux binary, ~30MB)
const URLS = [
  'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux',
  'https://github.com/yt-dlp/yt-dlp/releases/download/2024.11.18/yt-dlp_linux'
];

function download(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) return reject(new Error('Too many redirects'));

    log(`Fetching: ${url}`);

    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; EchoMusic/1.0)',
        'Accept': '*/*'
      },
      timeout: 90000
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        return download(res.headers.location, dest, redirects - 1)
          .then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const file = fs.createWriteStream(dest);
      let size = 0;
      res.on('data', (chunk) => { size += chunk.length; });
      res.pipe(file);

      file.on('finish', () => {
        file.close(() => {
          log(`Downloaded ${(size / 1024 / 1024).toFixed(1)} MB`);
          resolve(size);
        });
      });
      file.on('error', reject);
    }).on('error', reject).on('timeout', function() {
      this.destroy();
      reject(new Error('timeout'));
    });
  });
}

(async () => {
  for (const url of URLS) {
    try {
      const size = await download(url, BIN_PATH);
      if (size < 15 * 1024 * 1024) {
        throw new Error(`File too small: ${(size / 1024 / 1024).toFixed(1)} MB`);
      }
      fs.chmodSync(BIN_PATH, 0o755);
      log(`✅ yt-dlp ready (${(size / 1024 / 1024).toFixed(1)} MB)`);
      process.exit(0);
    } catch (e) {
      log(`❌ Failed: ${e.message}`);
      try { fs.unlinkSync(BIN_PATH); } catch {}
    }
  }
  log('⚠️  All URLs failed, will try system yt-dlp at runtime');
  process.exit(0);
})();
