import type { CleanRegexRule } from '@/state/settings';

export interface RegexRunResult {
  output: string;
  timedOut?: boolean;
  error?: string;
}

export interface WordReplaceRule {
  from: string;
  to: string;
}

const MAX_REGEX_PATTERN_LEN = 500;

/**
 * 静态检测明显存在灾难性回溯（ReDoS）风险的正则表达式模式。
 * 返回问题说明；安全则返 null。
 */
export function detectDangerousRegex(pattern: string): string | null {
  if (!pattern) return null;
  if (pattern.length > MAX_REGEX_PATTERN_LEN) {
    return `正则过长（超过 ${MAX_REGEX_PATTERN_LEN} 字符）`;
  }
  // 语法合法性预检
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern);
  } catch (e) {
    return e instanceof Error ? `正则语法错误：${e.message}` : '正则语法错误';
  }

  // 1. 嵌套量词：(a+)+, (a*)+, (a+)*, (\w+){2,}, (?:.+)+ 等
  if (/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\s*\d+\s*,)/.test(pattern)) {
    return '检测到嵌套量词（如 (a+)+），存在 ReDoS 卡死风险';
  }
  // 2. 分支交替后接高风险量词且组内含可变长度匹配
  if (/\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\s*\d+\s*,)/.test(pattern)) {
    // 若分支内包含 .* / .+ / \s+ / \w+ / 量词，易产生指数回溯
    const altWithQuant = /\((?:[^()\\]|\\.)*(?:\.\*|\.\+|\\[wWdDsS][+*])(?:[^()\\]|\\.)*\|/;
    const altWithQuant2 = /\|(?:[^()\\]|\\.)*(?:\.\*|\.\+|\\[wWdDsS][+*])(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\s*\d+\s*,)/;
    if (altWithQuant.test(pattern) || altWithQuant2.test(pattern)) {
      return '检测到含可变分支的重叠交替量词，存在 ReDoS 风险';
    }
  }
  // 3. 连续无分隔大通配符紧邻贪婪量词 .*.* / .+.+
  if (/(\.\*|\.\+)\s*[^?*+]*(\.\*|\.\+)/.test(pattern)) {
    return '检测到多重贪婪通配符 .* / .+ 串联，长文本下性能危险';
  }
  return null;
}

function sanitizeFlags(flags: string): string {
  const allowed = new Set(['g', 'i', 'm', 's', 'u']);
  const out: string[] = [];
  for (const ch of flags) {
    if (allowed.has(ch) && !out.includes(ch)) out.push(ch);
  }
  return out.join('');
}

const WORKER_SCRIPT = `
self.onmessage = function(ev) {
  var data = ev.data || {};
  try {
    var re = new RegExp(data.pattern, data.flags || 'g');
    var result = String(data.text || '').replace(re, String(data.replacement || ''));
    self.postMessage({ ok: true, output: result });
  } catch (err) {
    self.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
  }
};
`;

/**
 * 在浏览器环境中使用一次性 Web Worker（超时强杀 `worker.terminate()`）安全执行正则替换；
 * 在 Node / Vitest 等无 Worker 环境回退至同步 try/catch（仍受静态 ReDoS 检查保护）。
 */
export async function runSafeRegex(
  text: string,
  pattern: string,
  flags: string,
  replacement: string,
  timeoutMs = 1000,
): Promise<RegexRunResult> {
  if (!pattern) return { output: text };
  const danger = detectDangerousRegex(pattern);
  if (danger) {
    return { output: text, error: danger };
  }

  const safeFlags = sanitizeFlags(flags || 'gm');

  const canWorker =
    typeof Worker === 'function'
    && typeof Blob === 'function'
    && typeof URL !== 'undefined'
    && typeof URL.createObjectURL === 'function';

  if (!canWorker) {
    try {
      const re = new RegExp(pattern, safeFlags);
      return { output: text.replace(re, replacement) };
    } catch (e) {
      return { output: text, error: e instanceof Error ? e.message : String(e) };
    }
  }

  let blobUrl = '';
  let worker: Worker | null = null;
  try {
    blobUrl = URL.createObjectURL(new Blob([WORKER_SCRIPT], { type: 'application/javascript' }));
    worker = new Worker(blobUrl);
  } catch {
    // 某些严格 CSP 环境禁用 Blob Worker 时安全降级
    if (blobUrl) {
      try { URL.revokeObjectURL(blobUrl); } catch { /* noop */ }
    }
    try {
      const re = new RegExp(pattern, safeFlags);
      return { output: text.replace(re, replacement) };
    } catch (e) {
      return { output: text, error: e instanceof Error ? e.message : String(e) };
    }
  }

  return new Promise<RegexRunResult>(resolve => {
    let settled = false;
    const cleanup = () => {
      if (worker) {
        try { worker.terminate(); } catch { /* noop */ }
        worker = null;
      }
      if (blobUrl) {
        try { URL.revokeObjectURL(blobUrl); } catch { /* noop */ }
        blobUrl = '';
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ output: text, timedOut: true, error: `正则执行超时（>${timeoutMs}ms 已中止）` });
    }, timeoutMs);

    worker!.onmessage = (ev: MessageEvent<{ ok: boolean; output?: string; error?: string }>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      const d = ev.data;
      if (d?.ok && typeof d.output === 'string') {
        resolve({ output: d.output });
      } else {
        resolve({ output: text, error: d?.error || '正则执行失败' });
      }
    };

    worker!.onerror = ev => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve({ output: text, error: ev.message || 'Worker 异常' });
    };

    worker!.postMessage({ text, pattern, flags: safeFlags, replacement });
  });
}

/**
 * 对文本依次应用匹配的启用清洗正则规则。
 */
export async function applyCleanRegexRules(
  text: string,
  rules: CleanRegexRule[],
  scope: 'target' | 'history',
): Promise<string> {
  if (!text || !rules.length) return text;
  let current = text;
  for (const rule of rules) {
    if (!rule.enabled || !rule.pattern) continue;
    if (rule.scope !== 'both' && rule.scope !== scope) continue;
    const res = await runSafeRegex(current, rule.pattern, rule.flags, rule.replacement);
    if (!res.error && !res.timedOut) {
      current = res.output;
    } else if (res.error) {
      console.warn(`[柏宝·改] 跳过清洗正则「${rule.name}」：${res.error}`);
    }
  }
  return current;
}

/**
 * 解析敏感词双向替换表：
 * 每行支持 `原词=替换词` 或 `原词->替换词`，忽略空行与 `#` / `//` 注释行。
 */
export function parseWordReplaceRules(rawRules: string): WordReplaceRule[] {
  if (!rawRules) return [];
  const list: WordReplaceRule[] = [];
  for (const rawLine of rawRules.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const arrowIdx = line.indexOf('->');
    const eqIdx = line.indexOf('=');
    let from = '';
    let to = '';
    if (arrowIdx > 0 && (eqIdx < 0 || arrowIdx < eqIdx)) {
      from = line.slice(0, arrowIdx).trim();
      to = line.slice(arrowIdx + 2).trim();
    } else if (eqIdx > 0) {
      from = line.slice(0, eqIdx).trim();
      to = line.slice(eqIdx + 1).trim();
    }
    if (from && to && from !== to) {
      list.push({ from, to });
    }
  }
  return list;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceAllSorted(text: string, pairs: Array<{ search: string; replace: string }>): string {
  if (!text || !pairs.length) return text;
  const sorted = [...pairs].sort((a, b) => b.search.length - a.search.length);
  const re = new RegExp(sorted.map(p => escapeRegExp(p.search)).join('|'), 'g');
  const map = new Map<string, string>(sorted.map(p => [p.search, p.replace]));
  return text.replace(re, matched => map.get(matched) ?? matched);
}

/** 正向替换（发往 LLM 前将原词替换为安全替代词）。 */
export function applyForwardWordReplace(text: string, rules: WordReplaceRule[]): string {
  return replaceAllSorted(
    text,
    rules.map(r => ({ search: r.from, replace: r.to })),
  );
}

/** 逆向还原（LLM 返回后把替代词还原为原词，供标签校验/角色库对照/出图）。 */
export function applyReverseWordReplace(text: string, rules: WordReplaceRule[]): string {
  return replaceAllSorted(
    text,
    rules.map(r => ({ search: r.to, replace: r.from })),
  );
}

/** 对结构化 Tool 参数对象递归执行字符串逆向还原。 */
export function applyReverseWordReplaceDeep<T>(value: T, rules: WordReplaceRule[]): T {
  if (!rules.length) return value;
  if (typeof value === 'string') {
    return applyReverseWordReplace(value, rules) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map(item => applyReverseWordReplaceDeep(item, rules)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = applyReverseWordReplaceDeep(v, rules);
    }
    return out as T;
  }
  return value;
}
