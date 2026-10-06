// scripts/install-ytdlp.js
// Downloads yt-dlp binary into ./bin during npm install (works on Render)
const fs = require('fs');
const path = require('path');
const https = require('https');

const BIN_DIR = path.join(__dirname, '..', 'bin');
const BIN_PATH = path.join(BIN_DIR, 'yt-dlp');

if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

if (fs.existsSync(BIN_PATH)) {
  console.log('✅ yt-dlp already exists');
  process.exit(0);
}

const URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

console.log('⬇️  Downloading yt-dlp...');

const file = fs.createWriteStream(BIN_PATH);
https.get(URL, (res) => {
  if (res.statusCode === 302 || res.statusCode === 301) {
    https.get(res.headers.location, (res2) => {
      res2.pipe(file);
      file.on('finish', () => {
        file.close();
        fs.chmodSync(BIN_PATH, 0o755);
        console.log('✅ yt-dlp installed');
      });
    });
  } else {
    res.pipe(file);
    file.on('finish', () => {
      file.close();
      fs.chmodSync(BIN_PATH, 0o755);
      console.log('✅ yt-dlp installed');
    });
  }
}).on('error', (err) => {
  console.error('❌ yt-dlp download failed:', err.message);
  // Don't fail install
  process.exit(0);
});
