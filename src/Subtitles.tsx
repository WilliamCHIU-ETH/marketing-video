import React from 'react';
import { AbsoluteFill, Sequence } from 'remotion';
import { secToFrame } from './timeline';
import subtitleData from './subtitles.json';

/**
 * Whisper 輸出的字幕格式
 */
type WhisperWord = {
  word: string;
  start: number;
  end: number;
};

type WhisperSegment = {
  start: number; // 秒
  end: number;   // 秒
  text: string;
  words?: WhisperWord[];
};

type WhisperOutput = {
  segments: WhisperSegment[];
  language?: string;
  /** 從 public/script.txt 的逗號/句號推算出的強制換幕時間（秒） */
  _scriptBreaks?: number[];
};

type Phrase = {
  start: number;
  end: number;
  text: string;
};

const data = subtitleData as WhisperOutput;

/**
 * 把 Whisper 的長 segment 切成多個短句以利顯示。
 *
 * 切點優先順序（2026-05-28 改：嚴格跟 script.txt 標點，不再用字數硬斷）：
 *   1. ⭐ script.txt 推算出來的「強制換幕時間」（_scriptBreaks，最優先）
 *   2. 上一字結尾為 ，。？！ 等標點
 *   3. 與下個字之間停頓 > GAP_THRESHOLD（換氣，safety net）
 *
 * 不再用字數上限切（之前 MAX_CHARS=10 會在 script 沒寫標點的長句中亂斷）。
 * 太長的句子由 SubtitleLine 的 maxWidth 自動換行處理。
 *
 * 不再合併太短的句子（用戶 2026-05-28 要求嚴格跟 script.txt 結構、短句也保留）。
 */
const GAP_THRESHOLD = 0.5;
const BREAK_TOLERANCE = 0.05; // 比對 _scriptBreaks 時的時間容差（秒）
// 2026-08-10 只認「全形」標點當斷句點；半形 , . ! ? : ; 不斷（數字裡的 44,396 / 1.95% 不被切）
const PUNCT_RE = /[，。、！？：；]/;

function isAtScriptBreak(endTime: number, breaks: number[]): boolean {
  return breaks.some((t) => Math.abs(endTime - t) < BREAK_TOLERANCE);
}

function splitIntoPhrases(
  segments: WhisperSegment[],
  breaks: number[] = []
): Phrase[] {
  const raw: Phrase[] = [];

  // 把所有 segment 的 word 攤平成一條 list — 不再每個 segment 重置 current。
  // 原因：Whisper 的 segment 邊界是它自己分析出來的（常常切在奇怪的地方），
  // 真正該斷句的時機是腳本標點（_scriptBreaks）跟換氣停頓（gap）。
  // 用 segment 重置 phrase 會在 segment 邊界硬切，讓「籤 / 3090」這種應該分開的字綁在一起、
  // 或「大戶買散戶賣頁 / 籤30」這種應該連起來的字反而被切散。
  const allWords: WhisperWord[] = [];
  for (const seg of segments) {
    if (!seg.words || seg.words.length === 0) {
      raw.push({ start: seg.start, end: seg.end, text: seg.text.trim() });
      continue;
    }
    for (const w of seg.words) allWords.push(w);
  }

  let current: Phrase | null = null;
  for (const w of allWords) {
    // Whisper 的英文 word 會帶 leading space（例 " goodbye"），是 word 邊界提示；
    // trim 拿來判斷有沒有內容，但串接時要把該空白還原成分隔符（不然「Say goodbye」會變「Saygoodbye」）
    const hasLeadingSpace = /^\s/.test(w.word);
    const wordText = w.word.trim();
    if (!wordText) continue;
    if (current === null) {
      current = { start: w.start, end: w.end, text: wordText };
      continue;
    }
    const gap = w.start - current.end;
    const lastChar = current.text.slice(-1);
    // 只有全形標點才算斷句點（PUNCT_RE 已不含半形），所以半形 . , 結尾（1.95 / 44,396）自然不斷，
    // 不再需要「小數點兩側是數字」的特例。
    const prevEndsWithPunct = PUNCT_RE.test(lastChar);
    const atScriptBreak = isAtScriptBreak(current.end, breaks);
    // 嚴格跟 script.txt 標點切：script break / Whisper word-end 標點 / 換氣停頓。不再用字數硬斷。
    // 數字中間絕不斷開：Whisper 唸「零點八八」時常在 0. 與 88 之間留停頓，
    // 只看 gap 就會把 0.88% 拆成「0.」「88%」兩行（2026-08-12 使用者回報）。
    // 前一段結尾是數字或小數點／千分位逗號，且下一個字以數字開頭 → 視為同一個數字，不斷。
    const midNumber = /[\d.,]$/.test(current.text) && /^[\d.,%]/.test(wordText);
    const shouldSplit =
      !midNumber && (atScriptBreak || prevEndsWithPunct || gap > GAP_THRESHOLD);

    if (shouldSplit) {
      raw.push({
        ...current,
        text: current.text.replace(/[，。、]+$/, '').trim(),
      });
      current = { start: w.start, end: w.end, text: wordText };
    } else {
      current.end = w.end;
      current.text += (hasLeadingSpace ? ' ' : '') + wordText;
    }
  }
  if (current) {
    raw.push({
      ...current,
      text: current.text.replace(/[，。、,]+$/, '').trim(),
    });
  }

  // 2026-05-28 起：不再合併太短句、嚴格跟 script.txt 結構（用戶要求）
  return raw.filter((p) => p.text.length > 0);
}

const PHRASES = splitIntoPhrases(data.segments, data._scriptBreaks ?? []);

if (typeof window !== 'undefined') {
  // eslint-disable-next-line no-console
  console.log(
    `[Subtitles] ${data.segments.length} 段 Whisper segment → ${PHRASES.length} 段短句（含 ${(data._scriptBreaks ?? []).length} 個 script 強制換幕點）`,
    PHRASES
  );
}

/**
 * 字幕層
 * - 把 Whisper 的長 segment 自動切成小段顯示
 * - 想做 TikTok 風格的字字高亮，要改成用 word-by-word
 */
// 2026-08-10 新增 optional 定位 props（向後相容）：
//   containerStyle → 疊在外層 AbsoluteFill 的預設定位之上（後者贏）
//   textStyle      → 疊在字幕文字 div 的預設樣式之上
// 不傳（直式 DapanComposition / 投廣模板 MarketingVideo 的 <Subtitles />）＝行為完全不變。
// 橫式 DapanLandscapeComposition 用這兩個 prop 把字幕改成「置中在左側講者區底部」。
type SubtitlesStyleProps = {
  containerStyle?: React.CSSProperties;
  textStyle?: React.CSSProperties;
};

export const Subtitles: React.FC<SubtitlesStyleProps> = ({
  containerStyle,
  textStyle,
}) => {
  return (
    <>
      {PHRASES.map((p, i) => {
        const from = secToFrame(p.start);
        const duration = Math.max(1, secToFrame(p.end - p.start));
        return (
          <Sequence
            key={`subtitle-${i}`}
            from={from}
            durationInFrames={duration}
          >
            <SubtitleLine
              text={p.text}
              containerStyle={containerStyle}
              textStyle={textStyle}
            />
          </Sequence>
        );
      })}
    </>
  );
};

const SubtitleLine: React.FC<{ text: string } & SubtitlesStyleProps> = ({
  text,
  containerStyle,
  textStyle,
}) => {
  return (
    <AbsoluteFill
      style={{
        // 字幕位置：以「上邊」為錨點 → 多行字幕會向下延伸（而不是往上推第一行）
        justifyContent: 'flex-start',
        alignItems: 'center',
        paddingTop: 1440,
        paddingLeft: 65,
        paddingRight: 65,
        ...containerStyle,
      }}
    >
      <div
        style={{
          // 字體：'Noto Sans TC' 在 src/fonts.ts 預載；找不到時 fallback 到系統繁中字
          fontFamily:
            '"Noto Sans TC", system-ui, -apple-system, "PingFang TC", "Microsoft JhengHei", sans-serif',
          fontSize: 70,
          fontWeight: 700, // 700 = Bold（若放 NotoSansTC-Bold.ttf 並在 fonts.ts 註冊會更精準）
          color: '#ffffff',
          textAlign: 'center',
          lineHeight: 1.3,
          // 半透明黑底字幕條（圓角膠囊感）
          backgroundColor: 'rgba(0, 0, 0, 0.43)',
          padding: '12px 28px',
          borderRadius: 24,
          // 太長自動換行：限制最大寬度（扣 padding 後實際內容 ≈ 894px ≈ 12-13 個中文字 / 行）
          // 2026-05-28 新增：配合 splitIntoPhrases 嚴格跟標點切的改動、讓單句超寬時自動 wrap
          maxWidth: 950,
          wordBreak: 'break-word',
          overflowWrap: 'break-word',
          ...textStyle,
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};
