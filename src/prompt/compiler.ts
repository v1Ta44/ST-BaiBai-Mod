import { expandMacros, getSlotRawValue } from './macros';
import type { AutoTagCompileContext, CompiledChatMsg, CompileResult, PromptEntry, PromptPreset } from './types';

function matchesConditions(entry: PromptEntry, ctx: AutoTagCompileContext): boolean {
  const c = entry.conditions;
  if (!c) return true;

  if (c.nl === 'on' && !ctx.profile.nl) return false;
  if (c.nl === 'off' && ctx.profile.nl) return false;

  const isComic = ctx.profile.comic;
  if (c.comic === 'on' && !isComic) return false;
  if (c.comic === 'off' && isComic) return false;

  if (c.backend && c.backend !== 'any' && c.backend !== ctx.backend) return false;

  const hasSlotTask = ctx.slotTaskNote.trim().length > 0;
  if (c.slotRewrite === 'only' && !hasSlotTask) return false;
  if (c.slotRewrite === 'exclude' && hasSlotTask) return false;

  return true;
}

function matchesTrigger(entry: PromptEntry, haystackLower: string): { matched: boolean; triggered: boolean } {
  const t = entry.trigger;
  if (!t || t.mode !== 'keyword') {
    return { matched: true, triggered: false };
  }

  const orWords = (t.orWords ?? []).map(w => w.trim().toLowerCase()).filter(Boolean);
  const andWords = (t.andWords ?? []).map(w => w.trim().toLowerCase()).filter(Boolean);

  if (orWords.length === 0 && andWords.length === 0) {
    return { matched: false, triggered: false };
  }

  const orOk = orWords.length === 0 || orWords.some(w => haystackLower.includes(w));
  const andOk = andWords.length === 0 || andWords.every(w => haystackLower.includes(w));
  const matched = orOk && andOk;
  return { matched, triggered: matched };
}

interface BuiltPiece {
  role: 'system' | 'user' | 'assistant';
  content: string;
  isGuide: boolean;
}

function collectLintWarnings(
  preset: PromptPreset,
  ctx: AutoTagCompileContext,
  activeEntries: PromptEntry[],
  guideIndices: number[],
): string[] {
  const warnings: string[] = [];

  if (preset.outputMode === 'tool_tunnel' && preset.toolCall.guideWrap && guideIndices.length === 0) {
    warnings.push('已开启 Mode A（引导包裹），但当前没有激活的【ToolCall引导】条目；发送时会自动退回普通消息列表。');
  }

  const hasTargetSlot = activeEntries.some(
    e =>
      (e.entryType === 'slot' && e.slotKind === 'target_text')
      || /\{\{(?:target_text|正文)\}\}/i.test(e.content),
  );
  if (!hasTargetSlot) {
    warnings.push('未激活「待生图正文」槽位或 {{target_text}} / {{正文}} 占位符，模型可能看不到当前楼层正文。');
  }

  if (preset.outputMode === 'text_json') {
    const hasProtocol = activeEntries.some(
      e =>
        (e.entryType === 'slot' && e.slotKind === 'protocol_contract')
        || /\{\{(?:protocol_contract|输出协议)\}\}/i.test(e.content),
    );
    if (!hasProtocol) {
      warnings.push('当前为「文本 JSON」模式，但未包含 {{protocol_contract}} 输出协议槽位，解析成功率可能下降。');
    }
  }

  if (preset.outputMode === 'tool_tunnel' && preset.toolCall.fields.filter(f => f.required).length === 0) {
    warnings.push('Tool Calls 隧道未配置任何必填字段（required=true）。');
  }

  if (ctx.profile.comic && ctx.backend !== 'comfyui') {
    warnings.push('当前选用了条漫预设条件，但图片后端不是 ComfyUI。');
  }

  return warnings;
}

/**
 * 纯函数编译提示词预设：
 * 1. 按条件与关键词触发器过滤条目
 * 2. 展开注释/NL/槽位/宏，自动跳过空槽位
 * 3. 应用 system->user 合并与同角色相邻合并（不跨越 tool_guide 边界）
 * 4. 产出静态 Lint 警告与粗略 token 估算
 */
export function compilePromptPreset(preset: PromptPreset, ctx: AutoTagCompileContext): CompileResult {
  const haystackLower = `${ctx.targetText}\n${ctx.historyBlock}`.toLowerCase();
  const matchedTriggers: string[] = [];
  const activeEntries: PromptEntry[] = [];
  const rawPieces: BuiltPiece[] = [];
  let activeCount = 0;

  for (const entry of preset.entries) {
    if (!entry.enabled) continue;
    if (!matchesConditions(entry, ctx)) continue;

    const trig = matchesTrigger(entry, haystackLower);
    if (!trig.matched) continue;
    if (trig.triggered) matchedTriggers.push(entry.name);

    if (entry.entryType === 'slot') {
      const slotKind = entry.slotKind;
      if (!slotKind) continue;

      if (slotKind === 'history' && entry.historyMode === 'turns') {
        if (ctx.historyTurns.length === 0) continue;
        activeCount += 1;
        activeEntries.push(entry);
        for (const turn of ctx.historyTurns) {
          if (!turn.content.trim()) continue;
          rawPieces.push({
            role: turn.role,
            content: turn.content,
            isGuide: false,
          });
        }
        continue;
      }

      const backing = getSlotRawValue(slotKind, ctx);
      if (!backing.trim()) continue;

      const tpl = entry.content.trim() ? entry.content : `{{${slotKind}}}`;
      const expanded = expandMacros(tpl, ctx);
      if (!expanded.trim()) continue;

      activeCount += 1;
      activeEntries.push(entry);
      rawPieces.push({
        role: entry.role,
        content: expanded,
        isGuide: false,
      });
      continue;
    }

    const expanded = expandMacros(entry.content, ctx);
    if (!expanded.trim()) continue;

    activeCount += 1;
    activeEntries.push(entry);
    rawPieces.push({
      role: entry.role,
      content: expanded,
      isGuide: entry.entryType === 'tool_guide',
    });
  }

  const normalizedPieces: BuiltPiece[] = rawPieces.map(piece => ({
    ...piece,
    role: preset.mergeSystemIntoUser && piece.role === 'system' ? 'user' : piece.role,
  }));

  const finalPieces: BuiltPiece[] = [];
  for (const piece of normalizedPieces) {
    const prev = finalPieces[finalPieces.length - 1];
    if (
      preset.mergeAdjacentSameRole
      && prev
      && !prev.isGuide
      && !piece.isGuide
      && prev.role === piece.role
    ) {
      prev.content = `${prev.content}\n\n${piece.content}`;
    } else {
      finalPieces.push({ ...piece });
    }
  }

  const messages: CompiledChatMsg[] = finalPieces.map(p => ({ role: p.role, content: p.content }));
  const guideIndices: number[] = [];
  finalPieces.forEach((p, idx) => {
    if (p.isGuide) guideIndices.push(idx);
  });

  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  const estimatedTokens = Math.ceil(totalChars / 3);
  const lintWarnings = collectLintWarnings(preset, ctx, activeEntries, guideIndices);

  return {
    messages,
    guideIndices,
    lintWarnings,
    stats: {
      totalEntries: preset.entries.length,
      activeEntries: activeCount,
      matchedTriggers,
      estimatedTokens,
    },
  };
}
