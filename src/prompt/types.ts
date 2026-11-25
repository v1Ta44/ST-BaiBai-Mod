import type { ChatMsg } from '@/api/client';
import type { AutoTagProfile } from '@/autoTag/prompt';
import type { OutputMode, ToolCallPresetConfig } from '@/llm/types';
import type { BackendId } from '@/state/settings';

export type PromptSlotKind =
  | 'char_card'
  | 'persona'
  | 'world_info'
  | 'book_memory'
  | 'char_library'
  | 'slot_task'
  | 'history'
  | 'target_text'
  | 'backend_spec'
  | 'protocol_contract'
  | 'thinking_guide';

export type PromptEntryRole = 'system' | 'user' | 'assistant';
export type PromptEntryType = 'normal' | 'slot' | 'tool_guide';
export type HistoryRenderMode = 'block' | 'turns';

export interface EntryConditions {
  nl?: 'any' | 'on' | 'off';
  comic?: 'any' | 'on' | 'off';
  backend?: 'any' | BackendId;
  slotRewrite?: 'any' | 'only' | 'exclude';
}

export interface EntryTrigger {
  mode: 'always' | 'keyword';
  orWords: string[];
  andWords: string[];
}

export interface PromptEntry {
  id: string;
  name: string;
  enabled: boolean;
  role: PromptEntryRole;
  entryType: PromptEntryType;
  slotKind?: PromptSlotKind;
  historyMode?: HistoryRenderMode;
  content: string;
  conditions?: EntryConditions;
  trigger?: EntryTrigger;
}

export type PromptPresetScope = 'universal' | 'nai' | 'comfy-illust' | 'comfy-comic';

export interface PromptPreset {
  id: string;
  name: string;
  builtin?: boolean;
  scope: PromptPresetScope;
  outputMode: OutputMode;
  mergeAdjacentSameRole: boolean;
  mergeSystemIntoUser: boolean;
  toolCall: ToolCallPresetConfig;
  entries: PromptEntry[];
}

export interface AutoTagCompileContext {
  backend: BackendId;
  profile: AutoTagProfile;
  minImages: number;
  maxImages: number;
  negativeOn: boolean;
  charCard: string;
  persona: string;
  worldInfo: string;
  bookMemory: string;
  charLibrary: string;
  slotTaskNote: string;
  historyBlock: string;
  historyTurns: Array<{ role: 'user' | 'assistant'; content: string }>;
  targetLabel: string;
  targetText: string;
  backendSpec: string;
  protocolContract: string;
  thinkingGuide: string;
  charName: string;
  userName: string;
  floor: number;
  /** 仅用于测试预设中替换历史匹配范围 */
  readVar?: (name: string) => string;
  readGlobalVar?: (name: string) => string;
}

export interface CompiledChatMsg {
  role: PromptEntryRole;
  content: string;
}

export interface CompileResult {
  messages: CompiledChatMsg[];
  guideIndices: number[];
  lintWarnings: string[];
  stats: {
    totalEntries: number;
    activeEntries: number;
    matchedTriggers: string[];
    estimatedTokens: number;
  };
}
