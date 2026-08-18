"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

/* ============================================================
   BuddySystem：博士科研小人陪读彩蛋
   - 形象：SVG 计算机博士，等级外观体系：
     初始（无眼镜）→ 学术学徒（眼镜+手稿）→ 文献矿工（放大镜）
     → 咖啡因战士（咖啡+闪电眼）→ 论文重构大师（红流苏学位帽
     +权杖+文献小山）→ 图灵飞升·赛博老博（格子衫+地中海+台式机
     +写实学位证弹窗）
   - 话痨滑块：调节陪读说话概率与冷却
   - 挂机打盹/梦境/惊醒；里程碑横幅/粒子/震动/拍立得/证书
   - 浮层统一插槽：speech/横幅/拍立得/梦境同槽排开，永不重叠
   ============================================================ */

const IDLE_MS = 5 * 60 * 1000;
const POLL_MS = 5 * 1000;
const Z_STEP_MS = 20 * 1000;
const DREAM_MS = 90 * 1000;
const SCALE = 3;
const POS_KEY = "papermate-buddy-pos-v1";
const WELCOME_KEY = "papermate-buddy-welcome-v1";
const PERSONA_KEY = "papermate-buddy-persona-v1";
const TALK_KEY = "papermate-buddy-talk-v1";

const BUDDY_RECENT_LIMIT = 12;
const DEFAULT_TALK = 55;

export type BuddyPersonaId = "sarcastic" | "soft" | "philosopher" | "encourager" | "mentor";

const PERSONA_OPTIONS: Array<{ id: BuddyPersonaId; name: string; emoji: string }> = [
  { id: "soft", name: "软萌学徒", emoji: "🌱" },
  { id: "sarcastic", name: "毒舌审稿人", emoji: "🧐" },
  { id: "philosopher", name: "摸鱼哲学家", emoji: "☕" },
  { id: "encourager", name: "温柔鼓励师", emoji: "💛" },
  { id: "mentor", name: "严师益友", emoji: "🎓" },
];

const PERSONA_SWITCH_LINES: Record<BuddyPersonaId, string> = {
  soft: "切换到软萌学徒模式啦，我会认真记笔记的！",
  sarcastic: "毒舌审稿人已上线，请准备好接受挑刺。",
  philosopher: "摸鱼哲学家就位——先来杯咖啡再说话。",
  encourager: "温柔鼓励师上线，今天也要好好读哦。",
  mentor: "导师已上线——我跟你讲，论文得这么读。",
};

function loadPersona(): BuddyPersonaId {
  try {
    const saved = window.localStorage.getItem(PERSONA_KEY);
    if (saved === "sarcastic" || saved === "soft" || saved === "philosopher" || saved === "encourager" || saved === "mentor") {
      return saved;
    }
  } catch {
    /* 忽略 */
  }
  return "soft";
}

function loadTalk(): number {
  try {
    const raw = window.localStorage.getItem(TALK_KEY);
    if (raw !== null) {
      const saved = Number(raw);
      if (Number.isFinite(saved) && saved >= 0 && saved <= 100) return Math.round(saved);
    }
  } catch {
    /* 忽略 */
  }
  return DEFAULT_TALK;
}

/* ---------- 博士小人 SVG（等级外观体系） ---------- */
function DoctorBuddy({ level }: { level: number }) {
  const props: Record<number, boolean> = {
    1: level >= 1,
    2: level >= 2,
    3: level >= 3,
    4: level >= 4,
    5: level >= 5,
  };
  return (
    <svg viewBox="0 0 100 132" className="doctor-svg" aria-hidden>
      <defs>
        <pattern id="doc-plaid" width="9" height="9" patternUnits="userSpaceOnUse">
          <rect width="9" height="9" fill="#4a5a78" />
          <rect width="9" height="3" fill="#7a5a4a" />
          <rect width="3" height="9" fill="#7a5a4a" opacity=".85" />
          <rect width="9" height="1.4" fill="#cfa83e" opacity=".55" />
        </pattern>
        {/* 美化：袍子/帽子/皮肤渐变，增加体积感 */}
        <linearGradient id="doc-robe-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5d7094" />
          <stop offset=".55" stopColor="#4a5a78" />
          <stop offset="1" stopColor="#3d4a6b" />
        </linearGradient>
        <linearGradient id="doc-cap-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3a4152" />
          <stop offset="1" stopColor="#1c1f28" />
        </linearGradient>
        <radialGradient id="doc-skin-grad" cx="0.42" cy="0.36" r="0.8">
          <stop offset="0" stopColor="#fbd6a8" />
          <stop offset=".7" stopColor="#f8c99a" />
          <stop offset="1" stopColor="#efb183" />
        </radialGradient>
      </defs>
      {/* 腿（袍/裤下） */}
      <g className="doc-leg doc-leg-l">
        <rect x="39" y="99" width="10" height="18" rx="3" fill="#2a2f3c" />
        <rect x="37" y="115" width="14" height="8" rx="3" fill="#1c1f28" />
      </g>
      <g className="doc-leg doc-leg-r">
        <rect x="51" y="99" width="10" height="18" rx="3" fill="#2a2f3c" />
        <rect x="49" y="115" width="14" height="8" rx="3" fill="#1c1f28" />
      </g>
      {/* 博士服长袍（L5 换成程序员格子衫；其余用渐变增加体积感） */}
      {props[5] ? (
        <path d="M36 52 Q34 74 32 100 Q35 106 42 104 L58 104 Q65 106 68 100 Q66 74 64 52 Z" fill="url(#doc-plaid)" stroke="#333f58" strokeWidth="1.6" />
      ) : (
        <path d="M36 52 Q34 74 32 100 Q35 106 42 104 L58 104 Q65 106 68 100 Q66 74 64 52 Z" fill="url(#doc-robe-grad)" stroke="#333f58" strokeWidth="1.6" />
      )}
      {/* 袍身褶皱线（精致度） */}
      <path d="M42 62 Q40.6 78 40.6 96" fill="none" stroke="#31405f" strokeWidth="1" opacity=".55" />
      <path d="M58 62 Q59.4 78 59.4 96" fill="none" stroke="#31405f" strokeWidth="1" opacity=".45" />
      <path d="M35 60 Q33.6 80 33.4 98 Q37 103 41 102 L41 60 Z" fill="#5d7094" opacity=".8" />
      <path d="M65 60 Q66.4 80 66.6 98 Q63 103 59 102 L59 60 Z" fill="#5d7094" opacity=".55" />
      {/* 白衬衫 + 垂布（计算机科学代表色：金色，V 领带 PhD 标识；L4+ 门襟红边）。
         L5 赛博老博已脱掉学位服：只穿格子衫，露出简单深色 V 领口。 */}
      {props[5] ? (
        <path d="M43 44 L50 58 L57 44 L57 40 L43 40 Z" fill="#2a2f3c" />
      ) : (
        <>
          <path d="M43 42 L50 58 L57 42 L57 36 L43 36 Z" fill="#f6f6f2" />
          <path d="M43.5 42 L50 56 L56.5 42 L56.5 37 L43.5 37 Z" fill="#cfa83e" />
          <path d="M44 38 L56 38 L56 34 L44 34 Z" fill="#cfa83e" opacity=".72" />
          <path d="M50 56 L47.5 66 L52.5 66 Z" fill="#cfa83e" />
          <text x="50" y="48.5" textAnchor="middle" fontFamily="monospace" fontSize="7" fontWeight="800" fill="#3a2a10">PhD</text>
          {props[4] && (
            <>
              <path d="M43.5 42 L50 56 L43.5 42 Z" fill="#c24b3f" opacity=".9" />
              <path d="M56.5 42 L50 56 L56.5 42 Z" fill="#c24b3f" opacity=".9" />
            </>
          )}
        </>
      )}
      {/* 手臂（袍袖圆润；L5 脱袍后为格子衫短袖，金线袖口仅 L0-L4） */}
      <g className="doc-arm doc-arm-l">
        <rect x="24" y="56" width="11" height="30" rx="5.5" fill={props[5] ? "url(#doc-plaid)" : "#4a5a78"} stroke="#333f58" strokeWidth="1.2" />
        <rect x="26" y="59" width="2.6" height="25" rx="1.3" fill="#5d7094" opacity=".7" />
        {!props[5] && <rect x="24.5" y="81" width="10" height="2.4" rx="1.2" fill="#cfa83e" />}
      </g>
      <g className="doc-arm doc-arm-r">
        <rect x="65" y="56" width="11" height="30" rx="5.5" fill={props[5] ? "url(#doc-plaid)" : "#4a5a78"} stroke="#333f58" strokeWidth="1.2" />
        <rect x="71.4" y="59" width="2.6" height="25" rx="1.3" fill="#5d7094" opacity=".7" />
        {!props[5] && <rect x="65.5" y="81" width="10" height="2.4" rx="1.2" fill="#cfa83e" />}
      </g>
      {/* 笔记本电脑已按规格移除：电脑元素只属于 L5 的“脚边台式电脑”，
          L0-L4 不再显示任何电脑，避免“电脑一直出现”的 bug。 */}
      {/* 头 */}
      <g className="doc-head">
        {/* 头发：L5 地中海（只留两侧鬓发） */}
        {props[5] ? (
          <>
            <path d="M30 27 Q32 13 39 12 L40 18 Q35 19 34 27 Z" fill="#4a3a28" />
            <path d="M70 27 Q68 13 61 12 L60 18 Q65 19 66 27 Z" fill="#4a3a28" />
          </>
        ) : (
          <>
            <path d="M33 26 Q33 13 50 13 Q67 13 67 26 L67 20 Q67 9 50 9 Q33 9 33 20 Z" fill="#4a3a28" />
            <path d="M35 22 Q36 12 50 12 Q64 12 65 22 L65 18 Q65 10 50 10 Q35 10 35 18 Z" fill="#5d4a33" opacity=".8" />
          </>
        )}
        <circle cx="50" cy="33" r="17" fill="url(#doc-skin-grad)" />
        {/* 秃顶反光（L5 赛博老博） */}
        {props[5] && <path d="M44 19 Q50 16.8 56 19 Q50 21 44 19 Z" fill="#ffe9d2" opacity=".65" />}
        {/* 腮红 */}
        <circle cx="41" cy="38" r="3.2" fill="#f2a888" opacity=".55" />
        <circle cx="59" cy="38" r="3.2" fill="#f2a888" opacity=".55" />
        {/* 眉毛 */}
        <path d="M38.5 24.5 Q42.5 22.5 46.5 24" fill="none" stroke="#4a3a28" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M53.5 24 Q57.5 22.5 61.5 24.5" fill="none" stroke="#4a3a28" strokeWidth="1.6" strokeLinecap="round" />
        {/* 开眼（L3+ 闪电发光眼；L1+ 圆框眼镜） */}
        <g className="doc-eyes-open">
          {props[3] ? (
            <>
              <g className="doc-lightning-eye">
                <circle cx="42.5" cy="32" r="4" fill="#fff" stroke="#1c1f28" strokeWidth="1.3" />
                <path d="M41.4 30.2 L42.6 33 L41.1 33.3 L42.9 35.8 L43.7 32.9 L42.2 32.6 L43.4 30.2 Z" fill="#1c1f28" />
              </g>
              <g className="doc-lightning-eye">
                <circle cx="57.5" cy="32" r="4" fill="#fff" stroke="#1c1f28" strokeWidth="1.3" />
                <path d="M56.4 30.2 L57.6 33 L56.1 33.3 L57.9 35.8 L58.7 32.9 L57.2 32.6 L58.4 30.2 Z" fill="#1c1f28" />
              </g>
            </>
          ) : (
            <>
              <circle cx="42.5" cy="32" r="2.2" fill="#1c1f28" />
              <circle cx="57.5" cy="32" r="2.2" fill="#1c1f28" />
              <circle cx="43.6" cy="30.6" r="1" fill="#fff" />
              <circle cx="58.6" cy="30.6" r="1" fill="#fff" />
            </>
          )}
          {props[1] && (
            <g className="doc-glasses">
              <circle cx="42.5" cy="32" r="6.4" fill="none" stroke="#1c1f28" strokeWidth="2.4" />
              <circle cx="57.5" cy="32" r="6.4" fill="none" stroke="#1c1f28" strokeWidth="2.4" />
              <line x1="48.9" y1="32" x2="51.1" y2="32" stroke="#1c1f28" strokeWidth="2" />
            </g>
          )}
        </g>
        {/* 闭眼（打盹；L1+ 带镜框） */}
        <g className="doc-eyes-closed">
          <line x1="38.8" y1="32" x2="46.2" y2="32" stroke="#1c1f28" strokeWidth="2.2" strokeLinecap="round" />
          <line x1="53.8" y1="32" x2="61.2" y2="32" stroke="#1c1f28" strokeWidth="2.2" strokeLinecap="round" />
          {props[1] && (
            <g className="doc-glasses">
              <circle cx="42.5" cy="32" r="6.4" fill="none" stroke="#1c1f28" strokeWidth="2.4" />
              <circle cx="57.5" cy="32" r="6.4" fill="none" stroke="#1c1f28" strokeWidth="2.4" />
              <line x1="48.9" y1="32" x2="51.1" y2="32" stroke="#1c1f28" strokeWidth="2" />
            </g>
          )}
        </g>
        {/* 微笑 */}
        <path d="M45.5 41 Q50 45.5 54.5 41" fill="none" stroke="#a5552e" strokeWidth="2" strokeLinecap="round" />
        {/* 学位帽（L5 赛博老博已脱帽，仅 L0-L4 佩戴；L4+ 红流苏垂左前侧=已授予，其余金色） */}
        {!props[5] && (
          <g className="doc-cap">
            <path d="M28 6 L72 6 L67 -2 L33 -2 Z" fill="url(#doc-cap-grad)" stroke="#14161c" strokeWidth="1" />
            <path d="M31 5.2 L69 5.2 L65.4 -0.6 L34.6 -0.6 Z" fill="#4a5670" opacity=".85" />
            <rect x="35" y="6" width="30" height="9" rx="1" fill="url(#doc-cap-grad)" />
            <rect x="36" y="7" width="28" height="2" fill="#4a5670" opacity=".75" />
            {/* 帽顶中央亮线（精致度） */}
            <line x1="50" y1="-0.6" x2="50" y2="5.4" stroke="#4a5670" strokeWidth="1.4" opacity=".85" />
            {props[4] ? (
              <>
                {/* 红流苏垂左前（已授予）：挂在帽檐带左端外侧，避开面部 */}
                <line x1="40" y1="9" x2="32" y2="21" stroke="#c24b3f" strokeWidth="2.1" strokeLinecap="round" />
                <circle cx="31" cy="22.4" r="2.3" fill="#c24b3f" />
              </>
            ) : (
              <>
                {/* 金流苏：帽檐带右端锚点 + 垂珠 */}
                <circle cx="63" cy="9" r="1.6" fill="#cfa83e" />
                <line x1="63.6" y1="10" x2="70.6" y2="22.4" stroke="#cfa83e" strokeWidth="2.1" strokeLinecap="round" />
                <circle cx="71.4" cy="23.4" r="2.3" fill="#cfa83e" />
              </>
            )}
          </g>
        )}
      </g>
      {/* ---- 等级道具（互斥：升级后旧道具不残留，避免重叠） ---- */}
      {level === 1 && (
        <g className="doc-prop">
          {/* 手稿小摞（学术学徒）：脚边地面，底部与鞋底对齐 + 地面阴影 */}
          <g transform="translate(14, 106)">
            <ellipse cx="17" cy="18" rx="11" ry="2.2" fill="var(--ink)" opacity=".1" />
            <rect x="1" y="6" width="16" height="11" fill="#fff" stroke="#8f979f" strokeWidth="1" transform="rotate(-4 9 11)" />
            <rect x="3" y="3" width="16" height="11" fill="#fff" stroke="#8f979f" strokeWidth="1" transform="rotate(-1.5 11 8)" />
            <rect x="5" y="0" width="16" height="11" fill="#fff" stroke="#8f979f" strokeWidth="1" />
            <line x1="8" y1="3" x2="18" y2="3" stroke="#c9ccd2" strokeWidth=".9" />
            <line x1="8" y1="6" x2="16" y2="6" stroke="#c9ccd2" strokeWidth=".9" />
          </g>
        </g>
      )}
      {level === 2 && (
        <g className="doc-prop">
          {/* 手稿堆变高（文献矿工继续积累），底部对齐地面 + 地面阴影 */}
          <g transform="translate(13, 98)">
            <ellipse cx="18" cy="26" rx="12" ry="2.4" fill="var(--ink)" opacity=".1" />
            <rect x="0" y="14" width="17" height="11" fill="#fff" stroke="#8f979f" strokeWidth="1" transform="rotate(-4 8 19)" />
            <rect x="3" y="10" width="17" height="11" fill="#fff" stroke="#8f979f" strokeWidth="1" transform="rotate(-1.5 11 15)" />
            <rect x="6" y="6" width="17" height="11" fill="#fff" stroke="#8f979f" strokeWidth="1" />
            <rect x="9" y="2" width="17" height="11" fill="#fff" stroke="#8f979f" strokeWidth="1" />
            <line x1="12" y1="5" x2="23" y2="5" stroke="#c9ccd2" strokeWidth=".9" />
            <line x1="12" y1="8" x2="21" y2="8" stroke="#c9ccd2" strokeWidth=".9" />
          </g>
          {/* 右手高举大放大镜：实色镜片 + 玻璃反光 + 粗手柄伸入右袖口（握持感），
              镜片抬到眼睛高度，呈“举起来看”的姿态 */}
          <g transform="translate(65, 34)">
            <circle cx="9" cy="6" r="8.5" fill="#cfe9f8" stroke="#1c1f28" strokeWidth="2.4" />
            <path d="M4.4 2.2 a7 7 0 0 1 7 -3.4" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" />
            <path d="M3.8 8.6 L8.6 3.8" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" opacity=".85" />
            <path d="M15.4 12 L11 46" stroke="#5d4026" strokeWidth="4.8" strokeLinecap="round" />
            <path d="M15.4 12 L11 46" stroke="#a06a3e" strokeWidth="1.9" strokeLinecap="round" />
          </g>
        </g>
      )}
      {level === 3 && (
        <g className="doc-prop">
          {/* 左手咖啡（咖啡因战士）：杯体叠在左臂前（呈握持感），把手朝外不穿袖 */}
          <g transform="translate(20, 69)">
            <rect x="0" y="0" width="14" height="12" rx="2.5" fill="#fff" stroke="#1c1f28" strokeWidth="1.6" />
            <path d="M0 2.5 h-2.6 a3 3 0 0 0 0 6 h2.6" fill="none" stroke="#1c1f28" strokeWidth="1.6" />
            <rect x="1.6" y="1.8" width="10.8" height="4.6" rx="1.6" fill="#6b4226" />
            <rect x="1.6" y="1.8" width="4" height="4.6" rx="1.6" fill="#7d5130" />
            <path d="M5 -3 q1.6 -4.5 -1.6 -7.5 M8.5 -3 q1.4 -4 -1 -6.6" fill="none" stroke="#cfcfc8" strokeWidth="1.5" strokeLinecap="round" />
          </g>
        </g>
      )}
      {level === 4 && (
        <g className="doc-prop">
          {/* 手拄权杖（论文重构大师）：立在右脚侧、顶端贴右袖口，底部着地 */}
          <g transform="translate(72, 50)">
            <rect x="1.5" y="10" width="4" height="63" rx="2" fill="#b08a4f" stroke="#5d4a30" strokeWidth="1" />
            <rect x="2" y="10" width="1.6" height="63" fill="#d9bd85" opacity=".8" />
            <circle cx="3.5" cy="7" r="5.5" fill="none" stroke="#cfa83e" strokeWidth="2.6" />
            <circle cx="3.5" cy="7" r="2.2" fill="#cfa83e" />
          </g>
          {/* 脚踩文献小山：紧贴左脚侧地面，底部与鞋底对齐 + 地面阴影 */}
          <g transform="translate(3, 98)">
            <ellipse cx="19" cy="26" rx="14" ry="2.4" fill="var(--ink)" opacity=".1" />
            <rect x="0" y="16" width="24" height="9" fill="#8a6a4a" stroke="#5d4a30" strokeWidth="1.2" />
            <rect x="4" y="11" width="24" height="9" fill="#a5825c" stroke="#5d4a30" strokeWidth="1.2" />
            <rect x="8" y="6" width="24" height="9" fill="#c9a876" stroke="#5d4a30" strokeWidth="1.2" />
            <rect x="12" y="1" width="24" height="8" fill="#e8d3a8" stroke="#5d4a30" strokeWidth="1.2" />
            <line x1="15" y1="4" x2="33" y2="4" stroke="#d9c69b" strokeWidth=".9" />
            <line x1="16" y1="7" x2="32" y2="7" stroke="#d9c69b" strokeWidth=".9" />
          </g>
        </g>
      )}
      {level >= 5 && (
        <g className="doc-prop">
          {/* 脚边 </> 台式电脑（赛博老博）：显示器 + 支架 + 底座，底座落地 */}
          <g transform="translate(62, 93)">
            <rect x="0" y="0" width="28" height="18" rx="2" fill="#3a4152" stroke="#1c1f28" strokeWidth="1.4" />
            <rect x="3" y="3" width="22" height="12" rx="1" fill="#0e2e24" />
            <rect x="4" y="4" width="20" height="10" fill="none" stroke="#1d6b4f" strokeWidth=".8" />
            <text x="14" y="11.5" textAnchor="middle" fontFamily="monospace" fontSize="7" fill="#5ef2b8" fontWeight="700">{"</>"}</text>
            {/* 屏幕顶部高光（精致度） */}
            <rect x="3" y="3" width="22" height="1.6" fill="#5ef2b8" opacity=".35" />
            <rect x="10" y="18" width="8" height="3" rx="1" fill="#1c1f28" />
            <rect x="12" y="21" width="4" height="5" fill="#2a2f3c" />
            <rect x="7" y="26" width="14" height="3.5" rx="1.2" fill="#1c1f28" />
          </g>
          {/* 左手咖啡（咖啡因战士的传承）：杯体叠在左臂前，把手朝外不穿袖 */}
          <g transform="translate(20, 68)">
            <rect x="0" y="0" width="14" height="12" rx="2.5" fill="#fff" stroke="#1c1f28" strokeWidth="1.6" />
            <path d="M0 2.5 h-2.6 a3 3 0 0 0 0 6 h2.6" fill="none" stroke="#1c1f28" strokeWidth="1.6" />
            <rect x="1.6" y="1.8" width="10.8" height="4.6" rx="1.6" fill="#6b4226" />
            <rect x="1.6" y="1.8" width="4" height="4.6" rx="1.6" fill="#7d5130" />
            <path d="M5 -3 q1.6 -4.5 -1.6 -7.5 M8.5 -3 q1.4 -4 -1 -6.6" fill="none" stroke="#cfcfc8" strokeWidth="1.5" strokeLinecap="round" />
          </g>
          {/* 代码符号：主题前景色（任何主题清晰可辨）+ 轻柔浮动 */}
          <g className="doc-code" transform="translate(84, 28)">
            <text textAnchor="middle" fontFamily="monospace" fontSize="9" fontWeight="700" fill="var(--ink)">{"{}"}</text>
          </g>
          <g className="doc-code" transform="translate(4, 46)" style={{ animationDelay: ".3s" }}>
            <text textAnchor="middle" fontFamily="monospace" fontSize="9" fontWeight="700" fill="var(--ink)">{"</>"}</text>
          </g>
          <g className="doc-code" transform="translate(86, 68)" style={{ animationDelay: "1.5s" }}>
            <text textAnchor="middle" fontFamily="monospace" fontSize="9" fontWeight="700" fill="var(--ink)">{"0x1F"}</text>
          </g>
        </g>
      )}
    </svg>
  );
}

/* ---------- 1-Bit 像素画（梦境论文 / 拍立得） ---------- */
function drawPaper(g: CanvasRenderingContext2D, ink: string) {
  const cells: string[] = [
    "################",
    "#..............#",
    "#..####..#####.#",
    "#..............#",
    "#..##...##..##.#",
    "#..##...##..##.#",
    "#..####.####..#",
    "#..##...##..##.#",
    "#..##...##..##.#",
    "#..............#",
    "#..ACC.ACCEPT.#",
    "################",
  ];
  g.fillStyle = ink;
  cells.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === "#") g.fillRect(x * SCALE, y * SCALE, SCALE, SCALE);
    });
  });
}

function drawPolaroid(g: CanvasRenderingContext2D, ink: string, index: number) {
  const cells: string[] = [
    "##############",
    "#............#",
    "#..########..#",
    "#..#......#..#",
    "#..#.####.#..#",
    "#..#.####.#..#",
    "#..#.####.#..#",
    "#..#......#..#",
    "#..########..#",
    "#............#",
    "#..##..###...#",
    "##############",
  ];
  g.fillStyle = ink;
  cells.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === "#") g.fillRect(x * SCALE, y * SCALE, SCALE, SCALE);
    });
  });
  g.fillStyle = ink;
  g.font = `${SCALE * 1.6}px monospace`;
  g.fillText(String(index + 1).padStart(2, "0"), 2 * SCALE, 10 * SCALE);
}

/* ---------- 里程碑文案 ---------- */
const MILESTONES: Record<number, { title: string; toast: string }> = {
  10: { title: "COMBO x10! 研读状态已激活", toast: "学术学徒 · Novice Reader" },
  20: { title: "已解锁：深度挖掘者", toast: "文献矿工 · Paper Miner" },
  30: { title: "血清咖啡因浓度超标！审稿人开始害怕你了。", toast: "咖啡因战士 · Caffeine Overdrive" },
  40: { title: "案卷线索整理完毕：本篇论文已被你看穿 80% 的漏洞。", toast: "论文重构大师 · Grand Master" },
  50: { title: "★ 图灵飞升 · TRANSCENDED ★", toast: "赛博老博 · Cyber Doctor" },
};

/* ---------- 盖章声（Web Audio 合成） ---------- */
function playStamp() {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(150, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(55, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.13);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.14);
    window.setTimeout(() => ctx.close().catch(() => undefined), 600);
  } catch {
    /* 静默 */
  }
}

function useInkColor(): string {
  const [ink, setInk] = useState("#20312b");
  useEffect(() => {
    const read = () => {
      const v = getComputedStyle(document.documentElement).getPropertyValue("--ink").trim();
      if (v) setInk(v);
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return ink;
}

type BuddyState = "idle" | "sleeping" | "dreaming" | "waking";

export interface BuddyHandle {
  speak: (text: string) => void;
}

function loadSavedPos(): { x: number; y: number } | null {
  try {
    const raw = window.localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as { x: number; y: number; vw: number; vh: number };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (Math.abs(saved.vw - vw) / vw > 0.35 || Math.abs(saved.vh - vh) / vh > 0.35) return null;
    return { x: saved.x, y: saved.y };
  } catch {
    return null;
  }
}

const BuddySystem = forwardRef<BuddyHandle, { noteCount: number }>(function BuddySystem(
  { noteCount },
  ref,
) {
  const [buddyState, setBuddyState] = useState<BuddyState>("idle");
  const [zLevel, setZLevel] = useState(0);
  const [dreaming, setDreaming] = useState(false);
  const [wakeBurst, setWakeBurst] = useState(false);
  const ink = useInkColor();
  const level = Math.min(5, Math.floor(Math.max(0, noteCount) / 10));

  /* 话痨程度（0-100，影响响应概率与冷却） */
  const [talkativeness, setTalkativeness] = useState<number>(() => loadTalk());
  const talkRef = useRef(talkativeness);
  talkRef.current = talkativeness;
  const changeTalk = useCallback((value: number) => {
    const next = Math.min(100, Math.max(0, Math.round(value)));
    setTalkativeness(next);
    try {
      window.localStorage.setItem(TALK_KEY, String(next));
    } catch {
      /* 忽略 */
    }
  }, []);
  const eventRateFor = (talk: number) => 0.05 + (talk / 100) * 0.9;
  const randomRateFor = (talk: number) => (talk / 100) * 0.6;

  /* 位置（仅拖拽） */
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    if (typeof window === "undefined") return { x: 1280, y: 780 };
    return loadSavedPos() ?? { x: Math.max(20, window.innerWidth - 118), y: Math.max(78, window.innerHeight - 168) };
  });
  const [dragging, setDragging] = useState(false);
  const posRef = useRef(pos);
  posRef.current = pos;

  /* 说话气泡 */
  const [speech, setSpeech] = useState<string | null>(null);
  const speechTimerRef = useRef(0);
  const speak = useCallback((text: string, duration = 4200) => {
    setSpeech(text);
    window.clearTimeout(speechTimerRef.current);
    speechTimerRef.current = window.setTimeout(() => setSpeech(null), duration);
  }, []);
  useImperativeHandle(ref, () => ({ speak }));

  /* 人格 */
  const [persona, setPersona] = useState<BuddyPersonaId>("soft");
  const [personaMenuOpen, setPersonaMenuOpen] = useState(false);
  const [talkMenuOpen, setTalkMenuOpen] = useState(false);
  const talkTier = (talk: number) =>
    talk <= 20 ? "安静陪读" : talk <= 45 ? "偶尔搭话" : talk <= 75 ? "活泼话痨" : "超话痨模式";
  useEffect(() => {
    setPersona(loadPersona());
  }, []);
  const recentLinesRef = useRef<string[]>([]);

  const speakBuddy = useCallback(
    async (event: string, title?: string, payload?: string) => {
      try {
        const response = await fetch("/api/buddy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ persona, event, title, payload }),
        });
        const data = (await response.json()) as { text?: string };
        let text = data.text?.trim();
        if (!text) return;
        if (recentLinesRef.current.includes(text)) {
          const retry = await fetch("/api/buddy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ persona, event: "idle", title }),
          });
          const retryData = (await retry.json()) as { text?: string };
          text = retryData.text?.trim() ?? text;
        }
        recentLinesRef.current = [...recentLinesRef.current.slice(-(BUDDY_RECENT_LIMIT - 1)), text];
        speak(text, 5500);
      } catch {
        /* 静默 */
      }
    },
    [persona, speak],
  );

  /* 动作事件监听（挂机/梦境期间不响应） */
  useEffect(() => {
    const onBuddyEvent = (event: Event) => {
      if (stateRef.current !== "idle") return;
      const detail = (event as CustomEvent<{ type: string; title?: string; payload?: string }>).detail;
      if (!detail?.type) return;
      const type = detail.type;
      const rate =
        type === "paper-open" || type === "paper-close"
          ? eventRateFor(talkRef.current) * 0.8
          : eventRateFor(talkRef.current);
      if (Math.random() > rate) return;
      void speakBuddy(type, detail.title, detail.payload);
    };
    window.addEventListener("papermate-buddy-event", onBuddyEvent);
    return () => window.removeEventListener("papermate-buddy-event", onBuddyEvent);
  }, [speakBuddy]);

  /* 随机闲聊（挂机/梦境期间不响应；间隔与概率都随话痨程度变化：
     话痨 100 → 约 1.5~2.5 分钟聊一次；默认 55 → 约 7~11 分钟；
     话痨 0 → 约 13~21 分钟且概率极低，几乎不主动聊） */
  useEffect(() => {
    let timer = 0;
    const schedule = () => {
      const talk = talkRef.current;
      const base = 90_000 + (1 - talk / 100) * 720_000;
      const delay = base * (1 + Math.random() * 0.6);
      timer = window.setTimeout(() => {
        if (stateRef.current === "idle" && Math.random() < randomRateFor(talkRef.current)) {
          void speakBuddy("idle");
        }
        schedule();
      }, delay);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [speakBuddy]);

  /* 欢迎气泡：每天首次进入工作区 */
  useEffect(() => {
    try {
      const today = new Date().toDateString();
      if (window.localStorage.getItem(WELCOME_KEY) !== today) {
        window.localStorage.setItem(WELCOME_KEY, today);
        speak("你好，我是你的论文陪读助理，划选原文即可开始提问 ✨");
      }
    } catch {
      /* 忽略 */
    }
  }, [speak]);

  const stateRef = useRef<BuddyState>("idle");
  const lastActivityRef = useRef<number>(Date.now());
  const sleepStartRef = useRef<number>(0);

  /* 拖拽 */
  const dragRef = useRef<{ startX: number; startY: number; offsetX: number; offsetY: number } | null>(null);
  const onPointerDown = useCallback((event: React.PointerEvent) => {
    dragRef.current = {
      startX: posRef.current.x,
      startY: posRef.current.y,
      offsetX: event.clientX - posRef.current.x,
      offsetY: event.clientY - posRef.current.y,
    };
    setDragging(true);
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }, []);
  const onPointerMove = useCallback((event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    setPos({
      x: Math.min(window.innerWidth - 60, Math.max(0, event.clientX - drag.offsetX)),
      y: Math.min(window.innerHeight - 70, Math.max(0, event.clientY - drag.offsetY)),
    });
  }, []);
  const onPointerUp = useCallback(() => {
    dragRef.current = null;
    setDragging(false);
    try {
      window.localStorage.setItem(
        POS_KEY,
        JSON.stringify({ x: posRef.current.x, y: posRef.current.y, vw: window.innerWidth, vh: window.innerHeight }),
      );
    } catch {
      /* 忽略 */
    }
  }, []);

  /* 挂机检测 */
  const triggerWake = useCallback(() => {
    if (stateRef.current === "idle") return;
    stateRef.current = "waking";
    setBuddyState("waking");
    setWakeBurst(true);
    window.setTimeout(() => {
      stateRef.current = "idle";
      setBuddyState("idle");
      setDreaming(false);
      setWakeBurst(false);
    }, 1600);
  }, []);

  useEffect(() => {
    const onActivity = () => {
      lastActivityRef.current = Date.now();
      triggerWake();
    };
    window.addEventListener("mousemove", onActivity, { passive: true });
    window.addEventListener("mousedown", onActivity, { passive: true });
    window.addEventListener("keydown", onActivity, { passive: true });
    window.addEventListener("wheel", onActivity, { passive: true });
    window.addEventListener("touchstart", onActivity, { passive: true });
    window.addEventListener("scroll", onActivity, { passive: true });

    const timer = window.setInterval(() => {
      const idle = Date.now() - lastActivityRef.current;
      const state = stateRef.current;
      if (state === "idle" && idle >= IDLE_MS) {
        stateRef.current = "sleeping";
        sleepStartRef.current = Date.now();
        setBuddyState("sleeping");
        setDreaming(false);
      } else if (state === "sleeping" || state === "dreaming") {
        const sleepMs = Date.now() - sleepStartRef.current;
        const nextZ = Math.min(2, Math.floor(sleepMs / Z_STEP_MS));
        setZLevel(nextZ);
        if (!dreaming && sleepMs >= DREAM_MS) {
          setDreaming(true);
        }
      }
    }, POLL_MS);

    return () => {
      window.removeEventListener("mousemove", onActivity);
      window.removeEventListener("mousedown", onActivity);
      window.removeEventListener("keydown", onActivity);
      window.removeEventListener("wheel", onActivity);
      window.removeEventListener("touchstart", onActivity);
      window.removeEventListener("scroll", onActivity);
      window.clearInterval(timer);
    };
  }, [triggerWake, dreaming]);

  /* 里程碑检测（跨阈值触发一次）。
     注意：workspace 数据在组件挂载后异步加载（noteCount 从 0 变为真实值），
     若直接比较会误触发全部里程碑；挂载后延迟 1s 再初始化基准值，
     只有用户在本会话内真正新增笔记跨过阈值才触发。 */
  const prevCountRef = useRef<number>(0);
  const milestoneReadyRef = useRef(false);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      prevCountRef.current = noteCount;
      milestoneReadyRef.current = true;
    }, 1000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const triggeredRef = useRef<Set<number>>(new Set());
  const [banner, setBanner] = useState<{ key: number; title: string; toast: string } | null>(null);
  const [sparks, setSparks] = useState<{ id: number; x: number; y: number }[]>([]);
  const [showPolaroids, setShowPolaroids] = useState(false);
  const [diploma, setDiploma] = useState(false);
  const [shake, setShake] = useState(false);
  const lastSelectionRef = useRef<{ x: number; y: number } | null>(null);
  const sparkIdRef = useRef(0);

  useEffect(() => {
    const onMouseUp = () => {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          lastSelectionRef.current = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
    };
    document.addEventListener("mouseup", onMouseUp);
    return () => document.removeEventListener("mouseup", onMouseUp);
  }, []);

  const fireMilestone = useCallback((threshold: number) => {
    const meta = MILESTONES[threshold];
    if (!meta) return;
    const isDiploma = threshold === 50;
    setBanner({ key: threshold, title: meta.title, toast: meta.toast });
    playStamp();
    window.setTimeout(() => setBanner(null), isDiploma ? 3400 : 3000);
    if (threshold === 10) {
      speak(`已达 ${threshold} 条笔记！${meta.title}`);
    }
    if (threshold === 20) {
      const base = lastSelectionRef.current ?? { x: window.innerWidth - 140, y: window.innerHeight - 160 };
      const particles = Array.from({ length: 10 }, (_, i) => ({
        id: sparkIdRef.current++,
        x: base.x + (Math.random() - 0.5) * 220,
        y: base.y + (Math.random() - 0.5) * 60,
      }));
      setSparks(particles);
      window.setTimeout(() => setSparks([]), 1100);
    } else if (threshold === 30) {
      setShake(true);
      window.setTimeout(() => setShake(false), 650);
    } else if (threshold === 40) {
      setShowPolaroids(true);
      window.setTimeout(() => setShowPolaroids(false), 6000);
    } else if (threshold === 50) {
      setDiploma(true);
    }
  }, [speak]);

  useEffect(() => {
    if (!milestoneReadyRef.current) return;
    const prev = prevCountRef.current;
    prevCountRef.current = noteCount;
    if (noteCount <= prev) return;
    for (const t of [10, 20, 30, 40, 50]) {
      if (prev < t && noteCount >= t && !triggeredRef.current.has(t)) {
        triggeredRef.current.add(t);
        fireMilestone(t);
      }
    }
  }, [noteCount, fireMilestone]);

  /* 学位证 6 秒自动收起 */
  useEffect(() => {
    if (!diploma) return;
    const timer = window.setTimeout(() => setDiploma(false), 6000);
    return () => window.clearTimeout(timer);
  }, [diploma]);

  /* 页面震动（30 条） */
  useEffect(() => {
    if (!shake) return;
    const shell = document.querySelector(".workspace-shell");
    if (shell) shell.classList.add("buddy-shake");
    return () => shell?.classList.remove("buddy-shake");
  }, [shake]);

  const sleeping = buddyState === "sleeping" || buddyState === "dreaming";
  const zText = zLevel === 0 ? "Z" : zLevel === 1 ? "Zz" : "Zzz";
  // 气泡展开方向：小人位于视口右半边时向左展开（避免超出屏幕被裁切），左半边时向右展开。
  const bubbleRight = typeof window !== "undefined" && pos.x > window.innerWidth * 0.45;

  /* 人格切换 */
  const switchPersona = useCallback(
    (next: BuddyPersonaId) => {
      setPersona(next);
      setPersonaMenuOpen(false);
      try {
        window.localStorage.setItem(PERSONA_KEY, next);
      } catch {
        /* 忽略 */
      }
      speak(PERSONA_SWITCH_LINES[next], 4500);
    },
    [speak],
  );

  return (
    <div
      className={`buddy-root ${sleeping ? "is-asleep" : ""} ${buddyState === "waking" ? "is-waking" : ""} ${dragging ? "is-dragging" : ""} ${bubbleRight ? "bubble-right" : "bubble-left"}`}
      style={{ left: pos.x, top: pos.y }}
      aria-hidden
    >
      {/* 统一浮层插槽：Z/惊醒叹号/说话气泡/横幅/拍立得/梦境同槽排开，永不重叠；
         人格/话痨菜单打开时隐藏浮层，避免与菜单交叠 */}
      {!personaMenuOpen && !talkMenuOpen && (
        <div className="buddy-overlay">
          {sleeping && !dreaming && <span className="buddy-z" key={`z-${zLevel}`}>{zText}</span>}
          {wakeBurst && <span className="buddy-wake">!</span>}
          {speech && <div className="buddy-speech">{speech}</div>}
          {banner && (
            <div className="buddy-banner" key={banner.key}>
              <strong>{banner.title}</strong>
              <small>{banner.toast}</small>
            </div>
          )}
          {showPolaroids && (
            <div className="buddy-polaroids">
              {[0, 1, 2].map((i) => (
                <canvas
                  key={i}
                  className="buddy-polaroid"
                  width={14 * SCALE}
                  height={12 * SCALE}
                  ref={(node) => {
                    if (node) {
                      const g = node.getContext("2d");
                      if (g) {
                        g.clearRect(0, 0, node.width, node.height);
                        drawPolaroid(g, ink, i);
                      }
                    }
                  }}
                />
              ))}
            </div>
          )}
          {dreaming && (
            <div className="buddy-dream" key="dream">
              <div className="buddy-dream-canvas-wrap">
                <canvas
                  width={16 * SCALE}
                  height={12 * SCALE}
                  ref={(node) => {
                    if (node) {
                      const g = node.getContext("2d");
                      if (g) {
                        g.clearRect(0, 0, node.width, node.height);
                        drawPaper(g, ink);
                      }
                    }
                  }}
                />
              </div>
              <span className="buddy-dream-label">Accept with No Revisions</span>
            </div>
          )}
        </div>
      )}
      {/* 博士小人本体（可拖拽） */}
      <div
        className="buddy-figure"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className={`doctor-body ${sleeping ? "is-napping" : ""}`}>
          <DoctorBuddy level={level} />
        </div>
        {/* 话痨程度按钮（点击展开面板） */}
        <button
          className={`buddy-talk-btn ${talkMenuOpen ? "is-open" : ""}`}
          aria-label="话痨程度"
          title="话痨程度"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            setPersonaMenuOpen(false);
            setTalkMenuOpen((open) => !open);
          }}
        >
          <svg viewBox="0 0 14 14" width="12" height="12" aria-hidden>
            <path d="M1.5 5.2v3.6h2.6l3.2 2.4V2.8L4.1 5.2H1.5z" fill="currentColor" />
            <path d="M10.2 4.6a3.6 3.6 0 0 1 0 4.8M11.6 3.2a5.6 5.6 0 0 1 0 7.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </button>
        {talkMenuOpen && (
          <div className="buddy-talk-menu" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
            <span className="buddy-talk-label">话痨程度</span>
            <div className="buddy-talk-row">
              <input
                type="range"
                className="buddy-talk-slider"
                min={0}
                max={100}
                step={5}
                value={talkativeness}
                aria-label="话痨程度"
                onChange={(event) => changeTalk(Number(event.target.value))}
              />
              <span className="buddy-talk-value">{talkativeness}%</span>
            </div>
            <small className="buddy-talk-tier">{talkTier(talkativeness)}</small>
          </div>
        )}
        {/* 人格切换齿轮 */}
        <button
          className={`buddy-gear ${personaMenuOpen ? "is-open" : ""}`}
          aria-label="切换陪读小人人格"
          title="切换人格"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            setTalkMenuOpen(false);
            setPersonaMenuOpen((open) => !open);
          }}
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
            <path
              d="M8 3.2a4.8 4.8 0 0 0-.8.07L6.6 1.5H4.9l-.6 1.9a4.9 4.9 0 0 0-1.4.9L1 3.9 0 5.4l1.5 1.1a4.9 4.9 0 0 0 0 1.6L0 9.2l1 1.5 1.9-.4a4.9 4.9 0 0 0 1.4.9l.6 1.9h1.7l.6-1.8a4.8 4.8 0 0 0 1.6 0l.6 1.8h1.7l.6-1.9a4.9 4.9 0 0 0 1.4-.9l1.9.4 1-1.5-1.5-1.1a4.9 4.9 0 0 0 0-1.6L16 5.4l-1-1.5-1.9.4a4.9 4.9 0 0 0-1.4-.9l-.6-1.9H9.4l-.6 1.77A4.8 4.8 0 0 0 8 3.2Z"
              fill="currentColor"
            />
            <circle cx="8" cy="7.5" r="2.2" fill="var(--panel)" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
        {personaMenuOpen && (
          <div className="buddy-persona-menu" role="menu" aria-label="陪读人格">
            {PERSONA_OPTIONS.map((option) => (
              <button
                key={option.id}
                role="menuitem"
                className={`buddy-persona-item ${persona === option.id ? "active" : ""}`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  switchPersona(option.id);
                }}
              >
                <span>{option.emoji}</span>
                <b>{option.name}</b>
                {persona === option.id && <span className="buddy-persona-check">✓</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      {/* 火花粒子（20 条） */}
      {sparks.map((s) => (
        <span key={s.id} className="buddy-spark" style={{ left: s.x, top: s.y }} />
      ))}
      {/* 图灵飞升 · 计算机博士学位证（写实风，居中弹窗） */}
      {diploma && (
        <div className="buddy-diploma-overlay" onClick={() => setDiploma(false)}>
          <div className="buddy-diploma" onClick={(event) => event.stopPropagation()}>
            <div className="buddy-diploma-border">
              <div className="buddy-diploma-inner">
                <span className="buddy-diploma-kicker">PAPERMATE UNIVERSITY</span>
                <h3>计算机博士学位证书</h3>
                <p className="buddy-diploma-award">兹证明 <b>刻苦的你</b> 已通过全部论文答辩</p>
                <p className="buddy-diploma-thesis">
                  论文课题：《关于在阅读本论文过程中维持脑电波活跃的可行性研究》
                </p>
                <div className="buddy-diploma-cost">
                  <span>消耗算力</span>
                  <div>
                    <b>50 杯咖啡</b> · <b>88,000 个 Token</b> · <b>65,536 根头发</b>
                  </div>
                </div>
                <div className="buddy-diploma-seal">已授予</div>
                <button className="buddy-diploma-close" onClick={() => setDiploma(false)}>收下证书</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

export default BuddySystem;
