/**
 * 用 OpenAI 生圖 API 產生投廣圖的「視覺底圖」（刻意不含文字，文字之後再疊）。
 *
 * 用法：
 *   1. 在專案根目錄 .env 加一行：  OPENAI_API_KEY=sk-...
 *   2. node scripts/gen-ad-image.js                    ← 用內建測試 prompt
 *      node scripts/gen-ad-image.js "your english prompt"  ← 自訂 prompt
 *
 * 產出：ad/gen-<時間戳>.png
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) {
  console.error('❌ .env 找不到 OPENAI_API_KEY，請先加一行：OPENAI_API_KEY=sk-...');
  process.exit(1);
}

const MODEL = 'gpt-image-1';   // gpt-image-1 / dall-e-3（dall-e-3 endpoint 已不認 response_format 參數，要走 gpt-image-1）
const SIZE = '1024x1024';      // 1:1；其他可選 1536x1024 / 1024x1536
const QUALITY = 'high';        // gpt-image-1: high / medium / low（low 最省）

// 測試用 prompt：財經戲劇感、智慧眼鏡題材、刻意無文字、上下留白給之後疊字
const DEFAULT_PROMPT = [
  'A dramatic, high-saturation financial-technology promotional key visual.',
  'Hero subject: futuristic smart AI glasses, glowing, on a sleek reflective podium.',
  'Deep navy-blue background with vivid red and gold energy glow, light rays, bokeh particles,',
  'subtle circuit and stock-chart line motifs, premium polished 3D render, cinematic lighting,',
  'rich and vibrant, professional finance-marketing style.',
  'IMPORTANT: absolutely no text, no words, no letters and no numbers anywhere in the image.',
  'Square composition; keep the top and bottom areas relatively clean for text to be added later.',
].join(' ');

const prompt = process.argv[2] || DEFAULT_PROMPT;

(async () => {
  console.log(`呼叫 OpenAI 生圖（${MODEL} / ${SIZE} / ${QUALITY}）…`);
  const body = { model: MODEL, prompt, size: SIZE, quality: QUALITY, n: 1 };
  if (MODEL === 'dall-e-3') body.response_format = 'b64_json';

  let res;
  try {
    res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error('❌ 連線失敗：', e.message);
    process.exit(1);
  }

  if (!res.ok) {
    console.error(`❌ API 回傳錯誤 ${res.status}：`);
    console.error(await res.text());
    process.exit(1);
  }

  const data = await res.json();
  const b64 = data && data.data && data.data[0] && data.data[0].b64_json;
  if (!b64) {
    console.error('❌ 回應裡找不到圖片資料：', JSON.stringify(data).slice(0, 400));
    process.exit(1);
  }

  const adDir = path.join(__dirname, '..', 'ad');
  if (!fs.existsSync(adDir)) fs.mkdirSync(adDir, { recursive: true });
  const out = path.join(adDir, `gen-${Date.now()}.png`);
  fs.writeFileSync(out, Buffer.from(b64, 'base64'));
  console.log('✅ 圖片已存：' + path.relative(path.join(__dirname, '..'), out));
})();
