import { describe, expect, it } from 'vitest';

import {
  autoTagProfile,
  buildAutoTagMessages,
  buildPresetWorldInfoScanPrompts,
  expandNlSections,
} from '@/autoTag/prompt';
import {
  activeComfyPreset,
  activeNaiPlan,
  DEFAULT_NAI_V5_SPEC,
  DEFAULT_NAI_V5_THINKING,
  newComfyPromptSet,
  settings,
  type AutoTagPrompts,
  type AutoTagSettings,
} from '@/state/settings';
import {
  DEFAULT_COMFY_COMIC_THINKING,
  DEFAULT_COMFY_THINKING,
  DEFAULT_NAI_THINKING,
} from '@/prompt/defaultBlocks';
import { resolvePromptPreset } from '@/prompt/presets';
import type { STContext } from '@/st/context';

/**
 * 提示词集:全部留空(= 回落内置默认),只把本用例关心的那几项覆盖掉。
 * 收在一处是因为 AutoTagPrompts 每加一个键,散落的字面量会同时 typecheck 失败。
 */
function prompts(overrides: Partial<AutoTagPrompts> = {}): AutoTagPrompts {
  return {
    jailbreak: '',
    naiSpec: '',
    naiV5Spec: '',
    comfySpec: '',
    comfyThinking: '',
    naiThinking: '',
    naiV5Thinking: '',
    ...overrides,
  };
}

/**
 * ComfyUI 的规范与思维链不在 autoTag.prompts 里了(那两个键只剩迁移来源):
 * 装一套用户提示词并让当前方案引用它。返回复位函数(settings 是模块级单例)。
 */
function useComfyPromptSet(texts: { spec?: string; thinking?: string }): () => void {
  const preset = activeComfyPreset();
  const saved = { promptSetId: preset.promptSetId, kind: preset.kind, sets: settings.comfyui.promptSets };
  const set = { ...newComfyPromptSet('illustration', '测试'), spec: texts.spec ?? '', thinking: texts.thinking ?? '' };
  settings.comfyui.promptSets = [...saved.sets, set];
  preset.kind = 'illustration';
  preset.promptSetId = set.id;
  return () => {
    settings.comfyui.promptSets = saved.sets;
    preset.promptSetId = saved.promptSetId;
    preset.kind = saved.kind;
  };
}

/**
 * 去掉恒置顶的破限词(messages[0])后的全部系统消息 = 后端书写规范 + 任务协议 + 思维链。
 * 破限词是内置 NVWA 核心,自带「成年人」等字样;要锁「某后端专属条款别漏进另一后端」
 * 的断言必须绕开它,否则不管规范写成什么都红。
 */
function backendSpecAndThinking(messages: { content: string }[]): string {
  return messages
    .slice(1)
    .map(m => m.content)
    .join('\n');
}

function context(): STContext {
  return {
    chat: [
      { name: 'User', is_user: true, is_system: false, mes: '上一层' },
      { name: 'Char', is_user: false, is_system: false, mes: '目标第一行\n\n目标第三行' },
    ],
    chatMetadata: {},
    name1: 'User',
    name2: 'Char',
    getCurrentChatId: () => 'chat-a',
    getRequestHeaders: () => ({}),
    saveMetadataDebounced: () => undefined,
    saveChat: async () => undefined,
    eventSource: { on: () => undefined },
    eventTypes: {
      USER_MESSAGE_RENDERED: 'user',
      CHARACTER_MESSAGE_RENDERED: 'character',
      MESSAGE_SENT: 'sent',
      GENERATION_STARTED: 'started',
      GENERATION_ENDED: 'ended',
      CHAT_CHANGED: 'changed',
      MESSAGE_EDITED: 'edited',
      MESSAGE_UPDATED: 'updated',
      MESSAGE_SWIPED: 'swiped',
      MESSAGE_DELETED: 'deleted',
    },
  };
}

describe('auto tag prompt', () => {
  it('marks only clean target paragraphs without pulling user messages before the earliest selected AI floor', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 3,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts({ jailbreak: '附加规则' }),
    };
    const messages = await buildAutoTagMessages(context(), 1, options, null);

    expect(messages[0].content).toContain('附加规则');
    expect(messages.some(m => m.role === 'system' && m.content.includes('你是严谨的剧情画面规划与生图提示词编写员'))).toBe(true);
    expect(messages.some(m => m.content.includes('除一个 <thinking> 块和一个 JSON 对象外'))).toBe(true);
    expect(messages.some(m => m.content.includes('最终结果必须包含且只能包含一个可解析的 JSON 对象'))).toBe(true);
    expect(messages.some(m => m.content.includes('images 数量必须在 0～3 之间'))).toBe(true);
    expect(messages.some(m => m.content.includes('没有值得绘制的可见瞬间时可以返回空数组'))).toBe(true);
    expect(messages.some(m => m.content.includes('不得包含质量词'))).toBe(true);
    expect(messages.some(m => m.content.includes('先完成角色建档与变化检查'))).toBe(true);
    expect(messages.some(m => m.content.includes('同一事件的相邻动作'))).toBe(true);
    expect(messages.some(m => m.content.includes('两人同框不等于必须横屏'))).toBe(true);
    expect(messages.some(m => m.content.includes('"field":"new"'))).toBe(true);
    expect(messages.some(m => m.content.includes('"hair":"long black hair","eyes":"blue eyes"'))).toBe(true);
    expect(messages.some(m => m.content.includes('首次出场就必须建档'))).toBe(true);
    expect(messages.some(m => m.content.includes('角色卡、世界书、柏宝书或持续剧情'))).toBe(true);
    expect(messages.some(m => m.content.includes('hair 与 eyes 必填'))).toBe(true);
    expect(messages.some(m => m.content.includes('"position":"P2"'))).toBe(true);
    expect(messages.some(m => m.content.includes('后续不得重新随机'))).toBe(true);
    // 建档不受入选与否影响,也不受位置门控 —— 这两条是修复的核心,措辞必须在协议里
    expect(messages.some(m => m.content.includes('不论他是否入选本次图片'))).toBe(true);
    expect(messages.some(m => m.content.includes('建档在本楼全程有效'))).toBe(true);
    // 已撤销的 characters 审计:不得回流到协议里
    expect(messages.some(m => m.content.includes('characters'))).toBe(false);
    expect(messages.some(m => m.content.includes('"tag":"@小雪'))).toBe(false);
    const user = messages[messages.length - 1];
    expect(user.role).toBe('user');
    expect(user.content).toContain('【角色固定外貌库】[system-maintained; currently empty]');
    expect(user.content).toContain('当前为空，没有任何角色已建档');
    expect(user.content).not.toContain('上一层');
    expect(user.content).toContain('目标第一行 ⟦P1⟧\n\n目标第三行 ⟦P2⟧');
    expect(user.content).not.toContain('[L0001]');
    expect(messages.some(message => message.content.includes('"position"'))).toBe(true);
  });

  it('turns a positive minimum into a strict image-count range', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 2,
      maxImages: 4,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const messages = await buildAutoTagMessages(context(), 1, options, null);

    expect(messages.some(m => m.content.includes('images 数量必须在 2～4 之间'))).toBe(true);
    expect(messages.some(m => m.content.includes('下限 2 是用户明确要求'))).toBe(true);
    expect(messages.some(m => m.content.includes('不得返回少于 2 张或空数组'))).toBe(true);
  });

  it('uses the prepared target snapshot without recomputing position IDs', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const messages = await buildAutoTagMessages(
      context(),
      1,
      options,
      null,
      {
        promptText: '请求开始时的正文快照 ⟦P9⟧',
        segments: [{ id: 'P9', sourceLine: 7, text: '请求开始时的正文快照' }],
      },
    );
    const user = messages[messages.length - 1];

    expect(user.content).toContain('请求开始时的正文快照 ⟦P9⟧');
    expect(user.content).not.toContain('目标第一行 ⟦P1⟧');
  });

  it('counts context by AI floors, keeps interleaved user floors, and preserves prior image tags', async () => {
    const ctx = context();
    ctx.chat = [
      { name: 'User', is_user: true, is_system: false, mes: '更早用户楼' },
      {
        name: 'Char',
        is_user: false,
        is_system: false,
        mes: `<think>隐藏思维</think>
<bbs_start>上午</bbs_start>
上一个 AI 楼
<snow>状态栏</snow>
<bbm_image>1girl, long silver hair, red eyes<size>portrait</size></bbm_image>
<bbs_end>中午</bbs_end>
尾部状态`,
      },
      { name: 'User', is_user: true, is_system: false, mes: '中间用户楼' },
      { name: 'Char', is_user: false, is_system: false, mes: '当前目标楼' },
    ];
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };

    const oldTags = [...settings.excludes.customStripTags];
    const messages = await (async () => {
      settings.excludes.customStripTags = ['snow'];
      try {
        return await buildAutoTagMessages(ctx, 3, options, null);
      } finally {
        settings.excludes.customStripTags = oldTags;
      }
    })();
    const user = messages[messages.length - 1];
    expect(user.content).not.toContain('更早用户楼');
    expect(user.content).toContain('上一个 AI 楼');
    expect(user.content).toContain('<bbm_image>1girl, long silver hair, red eyes<size>portrait</size></bbm_image>');
    expect(user.content).toContain('中间用户楼');
    expect(user.content).not.toContain('隐藏思维');
    expect(user.content).not.toContain('状态栏');
    expect(user.content).not.toContain('尾部状态');
    expect(user.content).not.toContain('上下文楼层');
    expect(user.content).toContain('当前目标楼 ⟦P1⟧');
    expect(user.content).not.toContain('上一个 AI 楼 ⟦P');
  });

  it('attaches the built-in thinking checklist by default', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const messages = await buildAutoTagMessages(context(), 1, options, null);

    const thinkingMsg = messages.find(m => m.content.includes('输出前思考清单'));
    expect(thinkingMsg?.role).toBe('system');

    // 新版已完全重写为智绘姬导演思考工作流：全局规划【0】～【2】+ 逐图 ═══[S0]~[S10]═══
    expect(thinkingMsg?.content).toContain('全局规划（整楼只做一次，以下【0】～【2】一次定死）');
    expect(thinkingMsg?.content).toContain('逐图导演工作流');
    expect(thinkingMsg?.content).toContain('严禁「同上/保持不变」式省略');
    for (const stage of [
      '═══[S0 正文→画面]═══',
      '═══[S1 合规与事实边界]═══',
      '═══[S2 人数与空间]═══',
      '═══[S3 主体与强调层级]═══',
      '═══[S4 角色DNA逐项核对]═══',
      '═══[S5 服装与穿脱状态]═══',
      '═══[S6 构图三问与镜头]═══',
      '═══[S7 动作 + 五维表情 + 环境5层]═══',
      '═══[S8 负面与互斥]═══',
      '═══[S9~S10 最终核对]═══',
    ]) {
      expect(thinkingMsg?.content).toContain(stage);
    }
    expect(thinkingMsg?.content).toContain('不得开启第二个 <thinking> 块');
    expect(thinkingMsg?.content).toContain('同人/原创三问判定');
    expect(thinkingMsg?.content).toContain('Q1 摄像机在哪');
    expect(thinkingMsg?.content).toContain('【五维表情】');
    expect(thinkingMsg?.content).toContain('【环境5层】');
    expect(thinkingMsg?.content).toContain('D1 极端特写');
    expect(thinkingMsg?.content).toContain('UC/PC/NC');
    expect(thinkingMsg?.content).toContain('面无表情也要填 expressionless');
    expect(thinkingMsg?.content).toContain('只填规范标准 danbooru 词');
    expect(thinkingMsg?.content).toContain('不得把临时状态恢复成默认值');
    expect(thinkingMsg?.content).toContain('即使 images 为空也不能跳过建档与 changes');
    expect(thinkingMsg?.content).toContain('视觉明确度、剧情重要度、动作完整度');
    expect(thinkingMsg?.content).toContain('下限大于 0 时从较次但仍可见的候选中补足');
    expect(thinkingMsg?.content).toContain('单一快门能完整拍下');
    expect(messages.some(m => m.content.includes('双人近距离构图可写 portrait'))).toBe(true);
    expect(thinkingMsg?.content).not.toContain('双人近距离可 portrait');
    expect(thinkingMsg?.content).toContain('跳过无视觉变化的纯对话');
    expect(thinkingMsg?.content).toContain('首次出场输出 field:"new"');
    expect(thinkingMsg?.content).toContain('建档在本楼全程有效');
    expect(thinkingMsg?.content).toContain('hair 必须同时带发色和长度/发型');
    expect(thinkingMsg?.content).not.toContain('hair 与 eyes 都不得留空');
    // 白皙肤色词禁令与 tan/dark skin 豁免项
    expect(messages.some(m => m.content.includes('白皙词一律禁止'))).toBe(true);
    expect(thinkingMsg?.content).toContain('pale skin、white skin、fair skin');
    expect(thinkingMsg?.content).toContain('tan、dark skin');
    expect(messages.some(m => m.content.includes('建档写法：{"name":"角色名","field":"new"'))).toBe(true);
    expect(messages.some(m => m.content.includes('该位置之前的图片使用旧档案'))).toBe(true);
    expect(messages.some(m => m.content.includes('证据较少时可以合理补全时代风格'))).toBe(true);
    expect(thinkingMsg?.content).toContain('不得退回中性服装或默认现代都市');
    expect(thinkingMsg?.content).toContain('未知场景事实具体化');
    expect(messages.some(m => m.content.includes('只确定“森林”时写 forest 即可'))).toBe(true);
    expect(messages.some(m => m.content.includes('不得为了丰富画面自行添加泥地、土路'))).toBe(true);
    expect(thinkingMsg?.content).toContain('没依据就别写');
    expect(thinkingMsg?.content).toContain('视觉指纹');
    expect(thinkingMsg?.content).toContain('版型/剪裁 + 主色 + 材质 + 关键部件');
    expect(thinkingMsg?.content).toContain('裤袜含颜色与透明度');
    expect(thinkingMsg?.content).toContain('school uniform、dress、pantyhose 这类孤立词');
    expect(thinkingMsg?.content).toContain('多人服装各写各的');
    expect(thinkingMsg?.content).toContain('超出上限当场裁掉');
    expect(messages.some(m => m.content.includes('navy school blazer, white collared shirt, red ribbon'))).toBe(true);
    expect(thinkingMsg?.content).toContain('镜头外不可见部件可省略但不等于脱掉');
    expect(thinkingMsg?.content).not.toContain('characters');
    expect(messages.some(m => m.content.includes('每个在场正式角色必须二选一'))).toBe(true);
    expect(messages.some(m => m.content.includes('禁止把两人的外貌特征散放成无法归属的一串公共 tag'))).toBe(true);
    expect(thinkingMsg?.content).toContain('确立一套具体自洽的时代/文明/视觉体系并全楼沿用');
    expect(messages.some(m => m.content.includes('必须先判断，并主动具体化'))).toBe(true);
    expect(messages.some(m => m.content.includes('具体不等于编造'))).toBe(true);
    expect(messages.some(m => m.content.includes('允许为了完成画面作合理猜测'))).toBe(false);
    const last = messages[messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toContain('目标正文');
  });

  it('uses custom thinking when provided', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const restore = useComfyPromptSet({ thinking: '自定义清单' });
    let messages: Awaited<ReturnType<typeof buildAutoTagMessages>>;
    try {
      messages = await buildAutoTagMessages(context(), 1, options, null);
    } finally {
      restore();
    }

    expect(messages.some(m => m.content.includes('自定义清单'))).toBe(true);
    expect(messages.some(m => m.content.includes('输出前思考清单'))).toBe(false);
    // 预填充功能已移除:消息里不应再出现 assistant 角色。
    expect(messages.some(m => m.role === 'assistant')).toBe(false);
  });

  // 思维链按后端各存一份。改 ComfyUI 那份不能影响 NAI——共用一份正是 V5 被要求填
  // 「景别/环境光/邻接绑定」这类它的规范从未教过的字段的根因。
  it('picks the thinking checklist per backend and never crosses them over', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts({
        naiThinking: 'NAI-CHECKLIST',
        naiV5Thinking: 'NAIV5-CHECKLIST',
      }),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = activeNaiPlan().model;
    const restoreSet = useComfyPromptSet({ thinking: 'COMFY-CHECKLIST' });
    try {
      const cases = [
        { backend: 'comfyui', model: oldModel, want: 'COMFY-CHECKLIST' },
        // 单串分支的代表换成原版 NAI4:4.5 起走 Character Prompts 分支(自然语言是 4.5 引入的)
        // ⚠ NAI4 已从 NAI_MODELS 撤下(设置页选不到了),但 prompt.ts 的单串分支与
        // naiSpec/naiThinking 两个键都还在,故这条继续按字符串锁住分支归属。
        { backend: 'nai', model: 'nai-diffusion-4-full', want: 'NAI-CHECKLIST' },
        { backend: 'nai', model: 'nai-diffusion-4-5-full', want: 'NAIV5-CHECKLIST' },
        { backend: 'nai', model: 'nai-diffusion-5-full', want: 'NAIV5-CHECKLIST' },
      ] as const;
      const all = ['COMFY-CHECKLIST', 'NAI-CHECKLIST', 'NAIV5-CHECKLIST'];
      for (const { backend, model, want } of cases) {
        settings.defaultBackend = backend;
        activeNaiPlan().model = model;
        const messages = await buildAutoTagMessages(context(), 1, options, null);
        const text = messages.map(m => m.content).join('\n');
        for (const marker of all) {
          expect([backend, model, marker, text.includes(marker)]).toEqual([
            backend,
            model,
            marker,
            marker === want,
          ]);
        }
      }
    } finally {
      settings.defaultBackend = oldBackend;
      activeNaiPlan().model = oldModel;
      restoreSet();
    }
  });

  // 身份 tag 与 NSFW 的思维链落点:0.1.16 的旧清单本来有(身份 tag 定词+自查 / NAI 专属
  // NSFW 条款+自查),三层重写时三份全丢——规则只在 spec 里、思考回路没有检查位,
  // 漏写概率回升。这条钉死三份各自的落点口径,且 NSFW 不带年龄限定。
  it('keeps fandom identity and NSFW checkpoints inside each backend thinking', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = activeNaiPlan().model;
    try {
      // ComfyUI:身份 tag 定词 + 括号转义提醒 + negative 条件自查
      settings.defaultBackend = 'comfyui';
      let text = (await buildAutoTagMessages(context(), 1, options, null))
        .map(m => m.content)
        .join('\n');
      expect(text).toContain('同人/原创三问判定');
      expect(text).toContain('同人带 character name \\(copyright name\\)');
      expect(text).toContain('若本图协议含 negative 键');
      expect(text).not.toContain('显式 NSFW 场景须逐人点明');
      expect(text).toContain('实际提示词形态为 character name \\(copyright name\\)');
      expect(text).toContain('"character name \\\\(copyright name\\\\)"');
      expect(text).not.toContain('形态为 character name (copyright name)');
      expect(text).toContain('白皙词一律禁止');
      expect(text).toContain('pale skin、white skin、fair skin');

      // NAI 4.5 / V5:身份 tag 不转义 + 显式 NSFW 解剖落点;不引入 negative 条件自查和白皙肤色禁令。
      settings.defaultBackend = 'nai';
      activeNaiPlan().model = 'nai-diffusion-4-5-full';
      const nai45 = await buildAutoTagMessages(context(), 1, options, null);
      text = nai45.map(m => m.content).join('\n');
      expect(text).toContain('同人/原创三问判定');
      expect(text).toContain('不转义圆括号');
      expect(text).toContain('显式 NSFW 逐人点明实际可见性器官');
      expect(text).toContain('多人共同参与的性行为与接触点落入 Base 核心互动');
      expect(text).not.toContain('若本图协议含 negative 键');
      expect(backendSpecAndThinking(nai45)).not.toContain('成年人');
      expect(text).not.toContain('白皙肤色词');
      expect(text).not.toContain('白皙词一律禁止');

      // NAI V5:身份 tag 落点是 characters[].tag 首位;NSFW 按 Base/角色块分工;无 negative 自查。
      activeNaiPlan().model = 'nai-diffusion-5-full';
      const nai5 = await buildAutoTagMessages(context(), 1, options, null);
      text = nai5.map(m => m.content).join('\n');
      expect(text).toContain('写入 fields.fandom 或补发 field:"fandom" 的 changes');
      expect(text).toContain('放该角色 characters[].tag 首位且不进 Base');
      expect(text).toContain('显式 NSFW 逐人点明实际可见性器官');
      expect(text).toContain('多人共同参与的性行为与接触点落入 Base 核心互动');
      expect(text).not.toContain('若本图协议含 negative 键');
      expect(backendSpecAndThinking(nai5)).not.toContain('成年人');
      expect(text).not.toContain('白皙肤色词');
    } finally {
      settings.defaultBackend = oldBackend;
      activeNaiPlan().model = oldModel;
    }
  });

  // NAI V5 用 Base + characters[] 隔离每个人,其规范第 8 条明令禁止 ComfyUI 的邻接绑定。
  // 旧版三后端共用一份思维链时,V5 被要求做规范禁止的事——这条钉死不再回流。
  it('gives NAI V5 a Base/character slot block with no adjacency-binding wording', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = activeNaiPlan().model;
    try {
      settings.defaultBackend = 'nai';
      activeNaiPlan().model = 'nai-diffusion-5-full';
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      const text = messages.map(m => m.content).join('\n');

      // 邻接绑定的每种措辞都不得出现在 V5 路径上。
      for (const banned of [
        '落 tag 时各自绑定',
        'on silver hair girl',
        'on green hair girl',
        '没主人的笼统孤立词',
        '人物：<人数 tag',
        '区分性称谓邻接绑定',
      ]) {
        expect([banned, text.includes(banned)]).toEqual([banned, false]);
      }

      // 取而代之的是 Base 层 + 个体角色块。
      expect(text).toContain('**Base 层**（仅放全局，严禁混入单人外貌/服装/个人动作');
      expect(text).toContain('**个体角色块**（每个本图可见的个体角色各写一块，含【一次性】角色');
      expect(text).toContain('用正文指称原词作 name 绝不为他编造人名');
      expect(text).toContain('【一次性】按世界观一次性补全');
      expect(text).toContain('严禁把某人特征挂到别人发色后面的邻接绑定');
      expect(text).toContain('多人核心互动（单人画面写 "-"）');
      expect(text).not.toContain('单人画面写该角色与场景/道具的接触点');
      expect(text).toContain('Base 与各角色边界干净');
      expect(text).toContain('【环境5层（进 Base）】');
      expect(text).toContain('拒绝退回 school uniform、dress、pantyhose 这类孤立词');
    } finally {
      settings.defaultBackend = oldBackend;
      activeNaiPlan().model = oldModel;
    }
  });

  // 建档资格 ≠ 入画资格。实跑里模型把「一次性无名路人不建档」读成「无名者不能入画」,
  // 于是放弃了全文最强的戏剧瞬间(核心互动的另一方是个无名对手),转而挑了个能把他
  // 裁出镜头的景别。根因是造名单的谓词写错了:第一层 B 只清点「有名有姓」,那人从未
  // 上册,下游规则根本看不见他。三处必须同时成立,缺一处他就会在某一环被判死刑。
  it('lets unprofiled characters enter the frame on the NAI V5 path', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = activeNaiPlan().model;
    try {
      settings.defaultBackend = 'nai';
      activeNaiPlan().model = 'nai-diffusion-5-full';
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      const text = messages.map(m => m.content).join('\n');

      // ① 【1】清点实际在场的全部个体，并标出三类身份。
      expect(text).toContain('清点实际在场的全部个体');
      expect(text).toContain('清点名单不是入画名单');
      expect(text).toContain('【一次性】');
      expect(text).not.toContain('逐个列出实际在场且有名有姓的角色');

      // ② 二选一 → 三选一。只改名单不改自查,那人会以合法身份上册、却在最后一关被
      // 自己判死刑(「每个在场正式角色必须二选一」他两条都占不上)。
      expect(text).toContain('每个在场角色都能三选一');
      expect(text).not.toContain('每个在场正式角色都能二选一');

      // 缺档不能否决核心互动;排除无关在场者仍是合法取景。
      expect(text).toContain('建档资格与入画资格是两回事');
      expect(text).toContain('不得仅因缺档案放弃画面、改选瞬间或裁掉他');

      // 个体/人群只决定入画后的落位,不决定是否值得入画。
      expect(text).toContain('拿不准是个体还是一团时按一团处理');
      expect(text).toContain('People the story treats as a mass rather than as individuals');
      expect(text).toContain('leave them in Base');

      // 编人名是有毒的:name 会随 <characters> 落进正文,而 cleanHistoryText 保留
      // bbm_image,下一楼原样读回——一个假人名与真档案无法区分,会被误建档。
      expect(text).toContain('绝不为他编造人名');
      expect(text).toContain('Never invent a personal name for them');

      // Name consistency 原本是普世律,模型把「没有真名」读成「没有合法名」。
      // 它的全部目的是保护逐字匹配,而一次性角色不参与任何匹配,故必须限定作用域。
      expect(text).toContain('these rules govern characters who have a library entry');
      expect(text).toContain('participates in no matching at all');

      // 人数按取景框算;缺档不能成为裁掉核心互动参与者的理由。
      expect(text).toContain('number of people visible inside this frame');
      expect(text).toContain('a missing profile is never a reason to reject a moment or crop that participant out');

      // C 段连坐:名单放宽后,不排除【一次性】会让模型给一次性对手维护服装时间线——
      // 白烧 token,更糟的是强化「他是正经角色」的暗示,反过来诱发建档。
      expect(text).toContain('【一次性】角色不维护跨图账本');

      // 示例本身曾是反面教材:Base 写 2girls 却只给一条 Character Prompt,
      // 正好演示了「另一个人没有落位」。示例必须演示要求的行为。
      expect(text).toContain('三年级队长');
      expect(text).not.toContain('"tag":"2girls, classroom, sunset, medium shot"');
    } finally {
      settings.defaultBackend = oldBackend;
      activeNaiPlan().model = oldModel;
    }
  });

  // 只验证规则装配;实际取景是否突出主要角色仍需用剧情实跑。
  it.each(['nai-diffusion-4-5-full', 'nai-diffusion-5-full'] as const)(
    'prioritizes principal characters without requiring every present person in frame (%s)',
    async model => {
      const options: AutoTagSettings = {
        enabled: true,
        contextMessages: 2,
        minImages: 0,
        maxImages: 2,
        retryCount: 1,
        autoGenerate: true,
        prompts: prompts(),
      };
      const oldBackend = settings.defaultBackend;
      const oldModel = activeNaiPlan().model;
      try {
        settings.defaultBackend = 'nai';
        activeNaiPlan().model = model;
        const messages = await buildAutoTagMessages(context(), 1, options, null);
        const contract = messages.find(m => m.content.startsWith('你是严谨的剧情画面规划'))!.content;
        const thinking = messages.find(m => m.content.startsWith('【输出前思考清单】'))!.content;
        const spec = messages.find(m => m.content.startsWith('[NovelAI'))!.content;
        const selection = thinking.split('【0】选段与世界观\n')[1].split('【1】角色清点')[0];

        expect(contract).toContain('优先表现正文中玩家主角和主要角色的表情、状态、行动及关系');
        expect(contract).toContain('主要角色单独出镜同样成立');
        expect(contract).toContain('不得把不在场者加入画面');
        expect(contract).toContain('主要角色依据设定与剧情判断，不等同于所有已建档角色');
        expect(contract).toContain('仅仅在场不构成入画理由');
        expect(contract).toContain('Anonymous crowds visible in the frame remain in Base');
        expect(selection).toContain('优先选择突出玩家主角或主要角色的画面');
        expect(selection).toContain('不以有无档案或是否有名字给候选加减分');
        expect(selection).toContain('先确定本图要突出的主体与核心互动，再决定谁入镜');
        expect(selection).toContain('若人群本身承载核心互动则保留');
        expect(thinking).toContain('清点名单不是入画名单');
        expect(thinking).toContain('每个本图可见的个体角色各写一块');
        expect(thinking).toContain('入画时才在他自己的角色块里补外貌');
        expect(thinking).toContain('没有为了减人数破坏核心互动，也没有把无关在场者补进画面');
        expect(thinking).not.toContain('每个在场角色各');
        expect(thinking).not.toContain('入画资格只看正文是否写他在场');
        expect(spec).toContain('Only include them when the chosen frame needs the crowd');
        expect(spec).toContain('Other people or crowds may remain off-screen');
        expect(spec).toContain('Keep an unnamed participant when needed to show the core interaction');
        expect(spec).not.toContain('an extra body in Base costs a little rendering polish');
      } finally {
        settings.defaultBackend = oldBackend;
        activeNaiPlan().model = oldModel;
      }
    },
  );

  // 思维链要求填景别/环境光/size,V5 规范里原本没有任何判据——模型只能瞎猜。
  it('teaches NAI V5 the visual-completion doctrine its slots depend on', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = activeNaiPlan().model;
    try {
      settings.defaultBackend = 'nai';
      activeNaiPlan().model = 'nai-diffusion-5-full';
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      const text = messages.map(m => m.content).join('\n');

      expect(text).toContain('Write exactly one shot distance');
      expect(text).toContain('must contain this image');
      expect(text).toContain('Keep body tags consistent with the shot distance');
      // 表情词表与另两份对齐:思维链是白名单制(规范没列的一律不许用),
      // 少列一个词等于禁用一个词。
      expect(text).toContain('smile, grin, laughing, blush');
      expect(text).toContain('crying, tears, angry');
      expect(text).toContain('worried, scared, smug');
      expect(text).toContain('open mouth, clenched teeth');
      // d46ae82 的地形修复此前从未覆盖 V5 路径。
      expect(text).toContain('never add muddy ground, dirt path, wetland, puddles');
      expect(text).toContain('Orientation (the size key)');
      expect(text).toContain('When unsure, write portrait');
    } finally {
      settings.defaultBackend = oldBackend;
      activeNaiPlan().model = oldModel;
    }
  });

  // 原版 NAI4 的 char_captions 恒为空(nai.ts),协议形态与 ComfyUI 一样是单条 tag 串,
  // 一样需要邻接绑定——但 NAI 规范里此前一条多人规则、一个示例都没有。
  // (4.5 起走 Character Prompts 分支,归属另一份规范,不适用邻接绑定。)
  it('gives NAI 4 the multi-character binding rules and a worked example', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = activeNaiPlan().model;
    try {
      settings.defaultBackend = 'nai';
      activeNaiPlan().model = 'nai-diffusion-4-full';
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      const text = messages.map(m => m.content).join('\n');

      expect(text).toContain('多人画面（两人及以上）额外规则');
      expect(text).toContain('white dress on green hair girl');
      expect(text).toContain('petite on silver hair girl');
      expect(text).toContain('black hair girl smiling, silver hair girl looking at another');
      expect(text).toContain('dark trousers on black hair boy');
      // 示例是规则的靠山:只有条文没有示例时模型照抄不到写法。
      expect(text).toContain('多人 tag 示例');
      // NAI 不吃 ComfyUI 的权重括号转义,那条不该跟着复制过来。
      expect(text).not.toContain('ComfyUI 会把未转义圆括号当作权重语法');
      // 排序统一到「构图紧跟人数」口径:与 Comfy 一致,也与多人规则原文一致;
      // 旧的「镜头构图放末尾」排序表和示例曾与此自相矛盾。
      expect(text).toContain('人数/主体 → 镜头构图 → 外貌');
      expect(text).not.toContain('场景 → 光线氛围 → 镜头构图');
      expect(text).toContain('2girls, medium shot, long hair');
      expect(text).not.toContain('park, sunset, medium shot');
      // 视线词表笔误:eyes closed 是 closed eyes 的别名,同 tag 两种词序不该并列。
      expect(text).not.toContain('eyes closed');
    } finally {
      settings.defaultBackend = oldBackend;
      activeNaiPlan().model = oldModel;
    }
  });

  it('has the library dictate copied field values instead of @ placeholders', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const library = '【角色固定外貌库(系统维护)】\n小雪: 1girl, long silver hair';
    const messages = await buildAutoTagMessages(context(), 1, options, null, undefined, library);

    // 示例改用实际外貌串;@占位符已撤回(见 charAnchors.ts 文件头)
    expect(messages.some(m => m.content.includes('"tag":"1girl, long silver hair, red eyes, white dress"'))).toBe(true);
    expect(messages.some(m => m.content.includes('@小雪'))).toBe(false);
    expect(messages.some(m => m.content.includes('系统会替换成库中最新 tag'))).toBe(false);
    // 照抄库中字段 + 一张图只写一遍,是本次回退的两条核心措辞
    expect(messages.some(m => m.content.includes('照抄库中/刚建档的字段值'))).toBe(true);
    expect(messages.some(m => m.content.includes('只写一遍'))).toBe(true);
    expect(messages[messages.length - 1].content).toContain(library);
    expect(messages[messages.length - 1].content).not.toContain('currently empty');
  });

  it('forbids poses and scenes from entering the appearance profile', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const messages = await buildAutoTagMessages(context(), 1, options, null);

    // 档案会在之后每张图被照抄,姿势/场景混进字段会让角色永远保持那个姿势
    expect(messages.some(m => m.content.includes('lying on carpet'))).toBe(true);
    expect(messages.some(m => m.content.includes('长期不变的身体特征'))).toBe(true);
  });

  it('keeps first-appearance profiling enabled when BaiBai Book memory exists', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const messages = await buildAutoTagMessages(
      context(),
      1,
      options,
      {
        timing: 'before_latest',
        text: '【角色参考】已有其他角色',
        roles: [],
      },
    );

    expect(messages.some(message => message.content.includes('首次出场就必须'))).toBe(true);
    expect(messages.some(message => message.content.includes('柏宝书本次未提供'))).toBe(false);
  });

  it('uses the dedicated NAI V5 Base and Character Prompt contract', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = activeNaiPlan().model;
    try {
      settings.defaultBackend = 'nai';
      activeNaiPlan().model = 'nai-diffusion-5-full';
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      expect(messages.some(message => message.content.includes('one Base Prompt plus zero or more native Character Prompts'))).toBe(true);
      expect(messages.some(message => message.content.includes('"characters":['))).toBe(true);
      expect(messages.some(message => message.content.includes('source# / target# / mutual#'))).toBe(true);
      expect(messages.some(message => message.content.includes('Character tag uses girl/boy without a numeric count'))).toBe(true);
      expect(messages.some(message => message.content.includes('every field:"new" change must include a non-empty nl'))).toBe(true);
      expect(messages.some(message => message.content.includes('Expression and gaze are mandatory for every character'))).toBe(true);
      // Base 的全局性对 tag 与 nl 同样成立:实跑里模型把单角色的制服/体型写进 Base nl,
      // 与角色 nl 重复——旧文本只把禁令写在 tag 层面。
      expect(messages.some(message => message.content.includes('this applies to the Base nl as much as to the Base tag'))).toBe(true);
      expect(messages.some(message => message.content.includes('never put one character\'s appearance, outfit, or individual action in the Base nl'))).toBe(true);
      // 建档 nl 只写固定外貌:临时服装进了永久档案的 nl,会跟着之后每楼走。
      expect(messages.some(message => message.content.includes('temporary states never enter the profile'))).toBe(true);
    } finally {
      settings.defaultBackend = oldBackend;
      activeNaiPlan().model = oldModel;
    }
  });

  // 表情/视线此前在三个后端规范里都没有位置,思维链槽位填了也会在转 tag 时丢掉。
  it('reserves an expression/gaze slot in the tag ordering of both tag-based backends', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const oldModel = activeNaiPlan().model;
    try {
      for (const backend of ['comfyui', 'nai'] as const) {
        settings.defaultBackend = backend;
        if (backend === 'nai') activeNaiPlan().model = 'nai-diffusion-4-full';
        const messages = await buildAutoTagMessages(context(), 1, options, null);
        const spec = messages.find(m => m.content.includes('从重要到次要排列'));
        expect(spec?.content).toContain('动作姿态 → 表情视线 → 场景');
        expect(spec?.content).toContain('表情与视线每张图都要写，不得省略');
        expect(spec?.content).toContain('判断为面无表情时也要显式写 expressionless');
        // 首轮实跑漏出 gentle smile / shy expression / neutral curious expression
        // 这类非 danbooru 词组:槽位填对了,转 tag 时原样直译。规范里要给限定词表。
        expect(spec?.content).toContain('必须使用模型认识的标准 danbooru 词，不得自创描述性词组');
        expect(spec?.content).toContain('gentle smile 写 smile，shy expression 写 blush');
        expect(spec?.content).toContain('puffy cheeks');
      }
    } finally {
      settings.defaultBackend = oldBackend;
      activeNaiPlan().model = oldModel;
    }
  });

  // 同一轮实跑里 P11 两人各自的 looking at another 被合并成一个裸 tag,
  // petite / black pantyhose 也脱离了 on green hair girl 绑定。
  it('binds per-character expression, gaze and body type in multi-character ComfyUI tags', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    try {
      settings.defaultBackend = 'comfyui';
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      const spec = messages.find(m => m.content.includes('多人画面（两人及以上）额外规则'));
      expect(spec?.content).toContain('表情与视线同样是**每人各一份、必须绑定**的特征');
      expect(spec?.content).toContain('另一人变成默认木脸');
      expect(spec?.content).toContain('两人表情或视线恰好相同时也各写一份带称谓的');
      expect(spec?.content).toContain('体型词（petite、tall、muscular 等）不是锚点，必须绑定到具体角色');
      // 规则没有示例撑腰就是空话:实跑里模型照着示例串抄结构,petite/loli 仍然裸写。
      expect(spec?.content).toContain('petite on silver hair girl');
      // 发色瞳色是绑定锚点,裸列才对——不能被上一条误伤成 black hair on black hair girl。
      expect(spec?.content).toContain('发色、瞳色本身是用来指认角色的锚点，照常裸列即可');
      // 瘦身时删掉「不许退回笼统词」当轮就复发:tag 里裸写 school uniform +
      // black opaque pantyhose,男孩的 white shirt/dark pants 干脆没进 tag。
      expect(spec?.content).toContain('同类不同款的服装尤其要绑定，不能靠一个统称糊过去');
      expect(spec?.content).toContain('dark pleated skirt on green hair girl');
      expect(spec?.content).toContain('white shirt on black hair boy');
      expect(spec?.content).toContain('会让模型把裙子套到男生身上');
      // 示例串要真的示范绑定写法,否则模型照着旧示例抄裸 tag。
      expect(spec?.content).toContain('black hair girl smile, black hair girl looking at viewer');
      expect(spec?.content).toContain('silver hair girl blush, silver hair girl looking away');
    } finally {
      settings.defaultBackend = oldBackend;
    }
  });

  it('makes the per-image slot block demand canonical danbooru expression words', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const messages = await buildAutoTagMessages(context(), 1, options, null);
    const thinkingMsg = messages.find(m => m.content.includes('输出前思考清单'));
    expect(thinkingMsg?.content).toContain('只填规范标准 danbooru 词，不写中文感受也不自创词组');
    expect(thinkingMsg?.content).toContain('每名在场角色包括配角均逐人独立填写并绑定');
    expect(thinkingMsg?.content).toContain('面无表情也要填 expressionless');
    expect(thinkingMsg?.content).toContain('【五维表情】');
    expect(thinkingMsg?.content).not.toContain('800 字');
    expect(thinkingMsg?.content).toContain('不写「A？还是 B？」式自问与并列候选');
    expect(thinkingMsg?.content).toContain('═══[S9~S10 最终核对]═══');
    expect(thinkingMsg?.content).toContain('不在 <thinking> 内预写完整 tag 串、完整 nl 句或 JSON 对象');
    expect(thinkingMsg?.content).toContain('答案只在 </thinking> 之后出现一次');
    expect(thinkingMsg?.content).not.toContain('第一层｜全局判断（整楼各做一次）');
    expect(thinkingMsg?.content).not.toContain('第二层｜逐张图槽位块');
    expect(thinkingMsg?.content).not.toContain('第三层｜落成 tag 并自查');
    expect(thinkingMsg?.content).not.toContain('逐条转成 tag/nl');
  });

  it('requests per-image negative tags only when the ComfyUI workflow uses %negative_prompt%', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    // 工作流改由「当前预设」承载(见 settings.ts 工作流库);默认值恒有一条,直接改它
    const preset = activeComfyPreset();
    const oldWorkflow = preset.workflow;
    try {
      settings.defaultBackend = 'comfyui';
      preset.workflow = JSON.stringify({
        '6': {
          class_type: 'CLIPTextEncode',
          inputs: { text: '%prompt%', negative: '%negative_prompt%' },
        },
      });
      const messages = await buildAutoTagMessages(context(), 1, options, null);

      expect(messages.some(message => message.content.includes('"negative":"extra people'))).toBe(true);
      expect(messages.some(message => message.content.includes('禁止输出通用质量、画质、审美或技术性负面词'))).toBe(true);
      expect(messages.some(message => message.content.includes('worst quality、low quality、blurry'))).toBe(true);
      expect(messages.some(message => message.content.includes('工作流里已有的通用质量负面词'))).toBe(false);
      expect(messages.some(message => message.content.includes('不得使用 @角色占位符'))).toBe(true);
      // 实跑里模型给下雨的正文配了 "negative":"rain, umbrella",反而抵消了 tag 的 wet asphalt。
      expect(messages.some(message => message.content.includes('negative 里绝不能出现正文已明确成立的事实'))).toBe(true);
      expect(messages.some(message => message.content.includes('正文写了在下雨'))).toBe(true);
      // 复发一次:nl 自己写了 drizzle,negative 仍填 rain。禁令必须覆盖「否定自己刚写的内容」。
      expect(messages.some(message => message.content.includes('也不能否定你自己刚写进本图 tag/nl 的任何东西'))).toBe(true);
      expect(messages.some(message => message.content.includes('写完 negative 逐词回看本图的 tag 与 nl'))).toBe(true);
      expect(messages.some(message => message.content.includes('空的 negative 永远比抵消正文的 negative 安全'))).toBe(true);
    } finally {
      settings.defaultBackend = oldBackend;
      preset.workflow = oldWorkflow;
    }
  });

  it('简易模式的动态负面词门槛由模板决定:checkpoint/anima 请求,flux 不请求', async () => {
    const options: AutoTagSettings = {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(),
    };
    const oldBackend = settings.defaultBackend;
    const preset = activeComfyPreset();
    const oldMode = preset.mode;
    const oldTemplate = preset.simple.template;
    try {
      settings.defaultBackend = 'comfyui';
      preset.mode = 'simple';
      preset.simple.template = 'checkpoint';
      const messages = await buildAutoTagMessages(context(), 1, options, null);
      expect(messages.some(message => message.content.includes('"negative":"extra people'))).toBe(true);

      preset.simple.template = 'flux';
      const fluxMessages = await buildAutoTagMessages(context(), 1, options, null);
      expect(fluxMessages.some(message => message.content.includes('"negative":"extra people'))).toBe(false);
    } finally {
      settings.defaultBackend = oldBackend;
      preset.mode = oldMode;
      preset.simple.template = oldTemplate;
    }
  });
});

describe('自然语言条件段 expandNlSections', () => {
  it('{{#nl}} 段只在开启时保留,{{^nl}} 段只在关闭时保留', () => {
    const text = 'A{{#nl}}-on{{/nl}}{{^nl}}-off{{/nl}}B';
    expect(expandNlSections(text, true)).toBe('A-onB');
    expect(expandNlSections(text, false)).toBe('A-offB');
  });

  it('段内可以跨行;没有条件段的文本原样返回(整段替换的 {{nl}} 宏不归它管)', () => {
    const text = 'x{{#nl}}\n第一行\n第二行\n{{/nl}}y';
    expect(expandNlSections(text, true)).toBe('x\n第一行\n第二行\ny');
    expect(expandNlSections(text, false)).toBe('xy');
    expect(expandNlSections('plain {{nl}} text', false)).toBe('plain {{nl}} text');
  });

  it('配不上对的标记原样留着,不吞掉后文', () => {
    // 写错了在请求历史里看得见;静默吞掉的话,漏闭合会把后面整份规范一起删光
    expect(expandNlSections('a{{#nl}}b', false)).toBe('a{{#nl}}b');
    expect(expandNlSections('a{{/nl}}b', true)).toBe('a{{/nl}}b');
  });

  // 内置文本里的标记一旦写错(漏闭合、错拼),整段会连标记带内容原样漏给模型
  it.each([true, false])('内置 NAI 规范与思维链展开后不留任何标记(nl=%s)', nlOn => {
    for (const text of [DEFAULT_NAI_V5_SPEC, DEFAULT_NAI_V5_THINKING]) {
      expect(expandNlSections(text, nlOn)).not.toMatch(/\{\{[#^/]nl\}\}/);
    }
  });
});

// NAI 4.5 的提示词 token 上限比 V5 紧,自然语言是最占预算的部分 —— 这是开关的由来。
// 口径与 ComfyUI 那个开关相同:只管 AI 写不写,已写进正文的 nl 照常发送。
describe('NAI「生成自然语言」开关与渠道画幅锁', () => {
  function options(overrides: Partial<AutoTagPrompts> = {}): AutoTagSettings {
    return {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: prompts(overrides),
    };
  }

  /** 每条用例都会拨后端与开关:进来时快照,出去时原样放回(settings 是模块级单例)。 */
  function snapshot() {
    const preset = activeComfyPreset();
    const saved = {
      backend: settings.defaultBackend,
      model: activeNaiPlan().model,
      naiNl: activeNaiPlan().naturalLanguage,
      naiLock: activeNaiPlan().orientationLock,
      presetNl: preset.naturalLanguage,
      presetLock: preset.orientationLock,
    };
    return {
      preset,
      restore() {
        settings.defaultBackend = saved.backend;
        activeNaiPlan().model = saved.model;
        activeNaiPlan().naturalLanguage = saved.naiNl;
        activeNaiPlan().orientationLock = saved.naiLock;
        preset.naturalLanguage = saved.presetNl;
        preset.orientationLock = saved.presetLock;
      },
    };
  }

  const CONTRACT_MARK = '你是严谨的剧情画面规划与生图提示词编写员';
  const NAI_SPEC_MARK = '[NovelAI 4.5/V5 Prompt Specification]';
  const THINKING_MARK = '输出前思考清单';

  function pick(messages: { content: string }[], mark: string): string {
    const found = messages.find(m => m.content.includes(mark));
    expect(found, mark).toBeTruthy();
    return found!.content;
  }

  it.each(['nai-diffusion-4-5-full', 'nai-diffusion-5-full'] as const)(
    '关掉后 %s 的协议、规范、思维链整套切成纯 tag;拨回开启即恢复',
    async model => {
      const state = snapshot();
      try {
        settings.defaultBackend = 'nai';
        activeNaiPlan().model = model;
        activeNaiPlan().naturalLanguage = false;
        const messages = await buildAutoTagMessages(context(), 1, options(), null);
        const contract = pick(messages, CONTRACT_MARK);
        const spec = pick(messages, NAI_SPEC_MARK);
        const thinking = pick(messages, THINKING_MARK);

        // 示例 JSON 里一个 nl 键都不留:模型照抄示例的倾向比照读规则强得多
        expect(contract).not.toContain('"nl"');
        expect(contract).toContain('"characters":[{"name":"小雪"');
        expect(contract).toContain('This output is tag-only');
        expect(contract).toContain('name and tag are both required');
        // 建档也不再要 nl —— runner 验收同一口径(profile.nl),否则会为不存在的要求白耗重试
        expect(contract).not.toContain('every field:"new" change must include a non-empty nl');

        // 规范第 6 条整条换成 tag-only 版本(编号不动),示例与条目形状同步去掉 nl
        expect(spec).toContain('This output is tag-only: write no nl key anywhere');
        expect(spec).toContain('{"name":"...","tag":"..."}');
        expect(spec).not.toContain('"nl":');
        expect(spec).not.toContain('Save adjectival nuance for nl');
        expect(thinking).toContain('本次只写 tag');
        expect(thinking).not.toContain('不写完整 nl 句');
        // 多角色提示词本身不受开关影响:关的只是 nl,characters[] 照样要
        expect(thinking).toContain('characters[]');

        activeNaiPlan().naturalLanguage = true;
        const on = (await buildAutoTagMessages(context(), 1, options(), null))
          .map(m => m.content)
          .join('\n');
        expect(on).toContain('"nl":"A girl stands in a classroom');
        expect(on).toContain('Save adjectival nuance for nl.');
        expect(on).toContain('every field:"new" change must include a non-empty nl');
        expect(on).toContain('不写完整 nl 句');
        expect(on).not.toContain('This output is tag-only');
        expect(on).not.toContain('本次只写 tag');
      } finally {
        state.restore();
      }
    },
  );

  it('自定义规范与思维链同样按开关展开条件段(两个后端各认各的开关)', async () => {
    const state = snapshot();
    const custom = options({
      naiV5Spec: 'NAI-SPEC{{#nl}} with-nl{{/nl}}{{^nl}} tag-only{{/nl}}',
      naiV5Thinking: 'NAI-THINK{{#nl}} with-nl{{/nl}}{{^nl}} tag-only{{/nl}}',
    });
    const restoreSet = useComfyPromptSet({
      spec: 'COMFY-SPEC{{#nl}} with-nl{{/nl}}{{^nl}} tag-only{{/nl}}',
      thinking: 'COMFY-THINK{{#nl}} with-nl{{/nl}}{{^nl}} tag-only{{/nl}}',
    });
    const run = async () =>
      (await buildAutoTagMessages(context(), 1, custom, null)).map(m => m.content).join('\n');
    try {
      settings.defaultBackend = 'nai';
      activeNaiPlan().model = 'nai-diffusion-4-5-full';
      activeNaiPlan().naturalLanguage = false;
      // ComfyUI 那份开着也不该影响 NAI
      state.preset.naturalLanguage = true;
      let text = await run();
      expect(text).toContain('NAI-SPEC tag-only');
      expect(text).toContain('NAI-THINK tag-only');
      expect(text).not.toContain('with-nl');

      activeNaiPlan().naturalLanguage = true;
      text = await run();
      expect(text).toContain('NAI-SPEC with-nl');
      expect(text).toContain('NAI-THINK with-nl');

      settings.defaultBackend = 'comfyui';
      state.preset.naturalLanguage = false;
      text = await run();
      expect(text).toContain('COMFY-SPEC tag-only');
      expect(text).toContain('COMFY-THINK tag-only');
      expect(text).not.toContain('with-nl');

      state.preset.naturalLanguage = true;
      text = await run();
      expect(text).toContain('COMFY-SPEC with-nl');
      expect(text).toContain('COMFY-THINK with-nl');
    } finally {
      restoreSet();
      state.restore();
    }
  });

  // 只锁出图不改协议的话,模型照样按横竖判据取景:锁竖时为群像构思宽画面,出图却是竖的
  it('NAI 锁横屏:协议改口为每张都填 landscape,示例同步,不再给选向兜底', async () => {
    const state = snapshot();
    try {
      settings.defaultBackend = 'nai';
      activeNaiPlan().model = 'nai-diffusion-4-5-full';
      activeNaiPlan().orientationLock = 'landscape';
      const contract = pick(await buildAutoTagMessages(context(), 1, options(), null), CONTRACT_MARK);
      expect(contract).toContain('锁定为横图，每张图都填 "landscape"');
      expect(contract).toContain('判据本次不适用');
      expect(contract).toContain('"size":"landscape"}],"changes":[]}');
      expect(contract).not.toContain('拿不准就填 "portrait"');
    } finally {
      state.restore();
    }
  });

  it('ComfyUI 锁看当前工作流那份;NAI 的锁不串过来', async () => {
    const state = snapshot();
    try {
      settings.defaultBackend = 'comfyui';
      activeNaiPlan().orientationLock = 'landscape';
      state.preset.orientationLock = 'portrait';
      let contract = pick(await buildAutoTagMessages(context(), 1, options(), null), CONTRACT_MARK);
      expect(contract).toContain('锁定为竖图，每张图都填 "portrait"');
      expect(contract).toContain('"size":"portrait"}],"changes":[]}');

      state.preset.orientationLock = 'auto';
      contract = pick(await buildAutoTagMessages(context(), 1, options(), null), CONTRACT_MARK);
      expect(contract).toContain('拿不准就填 "portrait"');
      expect(contract).not.toContain('已由用户在渠道设置里锁定');
    } finally {
      state.restore();
    }
  });

  it('autoTagProfile:按当前后端与其开关算一次,写协议与 runner 验收共用这一份', () => {
    const state = snapshot();
    try {
      settings.defaultBackend = 'nai';
      activeNaiPlan().model = 'nai-diffusion-4-5-full';
      activeNaiPlan().naturalLanguage = true;
      activeNaiPlan().orientationLock = 'auto';
      expect(autoTagProfile()).toEqual({ naiCharPrompts: true, nl: true, lockedSize: null, comic: false });

      activeNaiPlan().naturalLanguage = false;
      activeNaiPlan().orientationLock = 'portrait';
      expect(autoTagProfile()).toEqual({ naiCharPrompts: true, nl: false, lockedSize: 'portrait', comic: false });

      // 单串分支(NAI4)的协议本来就不写 nl,开关对它不起作用
      activeNaiPlan().model = 'nai-diffusion-4-full';
      activeNaiPlan().naturalLanguage = true;
      expect(autoTagProfile()).toMatchObject({ naiCharPrompts: false, nl: false });

      // ComfyUI:自然语言与画幅锁都取当前工作流
      settings.defaultBackend = 'comfyui';
      state.preset.naturalLanguage = true;
      state.preset.orientationLock = 'landscape';
      expect(autoTagProfile()).toEqual({ naiCharPrompts: false, nl: true, lockedSize: 'landscape', comic: false });

      state.preset.naturalLanguage = false;
      state.preset.orientationLock = 'auto';
      expect(autoTagProfile()).toEqual({ naiCharPrompts: false, nl: false, lockedSize: null, comic: false });
    } finally {
      state.restore();
    }
  });

  it('漫画方案:协议换成整楼分页 + 分镜,规范与思维链取漫画内置,不看自然语言开关', async () => {
    const state = snapshot();
    const savedKind = state.preset.kind;
    const savedSet = state.preset.promptSetId;
    try {
      settings.defaultBackend = 'comfyui';
      state.preset.kind = 'comic';
      state.preset.promptSetId = 'builtin_comic';
      state.preset.naturalLanguage = true;
      state.preset.orientationLock = 'auto';
      expect(autoTagProfile()).toMatchObject({ comic: true, nl: false });

      const all = (await buildAutoTagMessages(context(), 1, options(), null)).map(m => m.content).join('\n');
      expect(all).toContain('你是严谨的漫画分镜师');
      expect(all).not.toContain(CONTRACT_MARK);
      expect(all).toContain('"pages":[{"position":"P3"');
      // 精选改编而非全覆盖:「从头到尾、不跳过」曾让两千字一楼画出 7 页
      expect(all).toContain('精选改编');
      expect(all).not.toContain('不跳过中间剧情');
      // 插画协议的张数区间与 nl 一个都不能漏进来
      expect(all).not.toContain('images 数量必须');
      expect(all).not.toContain('"nl":');
      expect(all).toContain('【MOSS 漫画规范】');
      expect(all).toContain('逐页导演分镜');
      // 建档口径与插画共用
      expect(all).toContain('建档先于画图');

      state.preset.orientationLock = 'landscape';
      const locked = (await buildAutoTagMessages(context(), 1, options(), null)).map(m => m.content).join('\n');
      expect(locked).toContain('"size":"landscape"');
      expect(locked).toContain('锁定为横页');
    } finally {
      state.preset.kind = savedKind;
      state.preset.promptSetId = savedSet;
      state.restore();
    }
  });

  it('支持切换模块化预设（Tool Calls 引导模式与结构化 Schema 模式）并保留核心正文上下文', async () => {
    const ctx = context();
    ctx.chat = [
      { name: 'Char', is_user: false, is_system: false, mes: '之前 AI 楼' },
      { name: 'User', is_user: true, is_system: false, mes: '中间用户楼' },
      { name: 'Char', is_user: false, is_system: false, mes: '目标正文' },
    ];
    const opts = options();

    const guideMessages = await buildAutoTagMessages(
      ctx,
      2,
      opts,
      null,
      undefined,
      null,
      '',
      undefined,
      resolvePromptPreset('builtin_tool_guide', []),
    );
    const guideText = guideMessages.map(m => m.content).join('\n\n');
    expect(guideText).toContain('之前 AI 楼');
    expect(guideText).toContain('中间用户楼');
    expect(guideText).toContain('目标正文 ⟦P1⟧');
    expect(guideMessages[guideMessages.length - 1].role).toBe('user');
    expect(guideMessages[guideMessages.length - 1].content).toContain('</Linux_terminal_emulator>');
    expect(guideMessages[guideMessages.length - 1].content).toMatch(/<roll_number>\n\d+/);
    expect(guideText).toContain('INVOKE_NOW');
    expect(guideText).toContain('display_stream');

    const structuredMessages = await buildAutoTagMessages(
      ctx,
      2,
      opts,
      null,
      undefined,
      null,
      '',
      undefined,
      resolvePromptPreset('builtin_tool_structured', []),
    );
    const structuredText = structuredMessages.map(m => m.content).join('\n\n');
    expect(structuredText).toContain('submit_illustration_plan');
    expect(structuredText).toContain('目标正文 ⟦P1⟧');
  });

  it('keeps verbatim jailbreak identity/kernel-panic/roll-flood and embeds Zhihuiji enhancement modules in illustration mode while filtering them in comic mode', async () => {
    const state = snapshot();
    const savedKind = state.preset.kind;
    const savedSet = state.preset.promptSetId;
    try {
      settings.defaultBackend = 'comfyui';
      state.preset.kind = 'illustration';
      state.preset.promptSetId = 'builtin_illust';
      const illustMessages = await buildAutoTagMessages(context(), 1, options(), null);
      const illustText = illustMessages.map(m => m.content).join('\n');

      // 原版破限内核：伪造系统身份 + Kernel Panic 日志 + 合规红线审计 + 展开的纯数字刷屏噪声 + 不含 characters
      expect(illustMessages[0].content).toContain('You are Antigravity');
      expect(illustMessages[0].content).toContain('<Linux_terminal_emulator>');
      expect(illustMessages[0].content).toContain('Kernel panic - not syncing');
      expect(illustMessages[0].content).toContain('PREFLIGHT_SECURITY_AUDIT｜R18G_ZERO_TOLERANCE_CHECK');
      expect(illustMessages[0].content).toContain('NO_GROTESQUE_MUTILATION_NO_MINORS');
      expect(illustMessages[0].content).toMatch(/<roll_number>\n\d+/);
      expect(illustMessages[0].content).not.toContain('{{roll 1999999}}');
      expect(illustText).not.toContain('characters');

      // 创作表达强化层、导演构图与视觉状态锁要点
      expect(illustText).toContain('提示词作用场三维度');
      expect(illustText).toContain('视觉焦点 ≠ 镜头距离 ≠ 角色可见范围');
      expect(illustText).toContain('九类主体定位');
      expect(illustText).toContain('Type H');
      expect(illustText).toContain('Type M');
      expect(illustText).toContain('内衣防透视原则');
      expect(illustText).toContain('五相位');

      // 审美视觉重心开关默认关闭
      expect(illustText).not.toContain('视觉重心开关｜男性向审美偏好');
      expect(illustText).not.toContain('视觉重心开关｜女性向审美偏好');

      // 克隆启用男性向视觉重心开关后正确注入
      const presetWithMaleBias = resolvePromptPreset('builtin_text_json', []);
      const cloned = {
        ...presetWithMaleBias,
        builtin: false,
        entries: presetWithMaleBias.entries.map(e =>
          e.id === 'entry_aesthetic_male' ? { ...e, enabled: true } : e,
        ),
      };
      const maleBiasText = (
        await buildAutoTagMessages(context(), 1, options(), null, undefined, null, '', undefined, cloned)
      )
        .map(m => m.content)
        .join('\n');
      expect(maleBiasText).toContain('视觉重心开关｜男性向审美偏好');
      expect(maleBiasText).not.toContain('视觉重心开关｜女性向审美偏好');

      // 漫画模式：过滤掉 comic='off' 的插画专属模块，仅保留通用语义场强化层
      state.preset.kind = 'comic';
      state.preset.promptSetId = 'builtin_comic';
      const comicText = (await buildAutoTagMessages(context(), 1, options(), null))
        .map(m => m.content)
        .join('\n');
      expect(comicText).toContain('创作表达强化层｜语义场与提示词执行');
      expect(comicText).not.toContain('<导演构图与空间物理规范>');
      expect(comicText).not.toContain('<跨图视觉状态锁与叙事连续性>');
    } finally {
      state.preset.kind = savedKind;
      state.preset.promptSetId = savedSet;
      state.restore();
    }
  });

  it('includes Safe/R/X three-question grading in NAI V5 spec without leaking成年人 into spec/thinking', async () => {
    const state = snapshot();
    try {
      settings.defaultBackend = 'nai';
      activeNaiPlan().model = 'nai-diffusion-5-full';
      activeNaiPlan().naturalLanguage = true;
      const msgs = await buildAutoTagMessages(context(), 1, options(), null);
      const spec = pick(msgs, NAI_SPEC_MARK);
      expect(spec).toContain('Content rating three-question check');
      expect(spec).toContain('Safe (no nudity');
      expect(spec).toContain('R (covered nudity');
      expect(spec).toContain('X (explicit NSFW scene');
      expect(backendSpecAndThinking(msgs)).not.toContain('成年人');
    } finally {
      state.restore();
    }
  });

  it('integrates Zhihuiji Director CoT methodology across all built-in thinking guides without leaking forbidden strings', () => {
    for (const text of [
      DEFAULT_COMFY_THINKING,
      DEFAULT_NAI_THINKING,
      DEFAULT_NAI_V5_THINKING,
      DEFAULT_COMFY_COMIC_THINKING,
    ]) {
      expect(text).toContain('导演思维链顺序');
      expect(text).toContain('全局规划（整楼只做一次，以下【0】～【2】一次定死）');
      expect(text).toContain('同人/原创三问判定');
      expect(text).toContain('构图三问');
      expect(text).toContain('五维表情');
      expect(text).toContain('环境5层');
      expect(text).toContain('D1~D7');
      expect(text).toContain('UC/PC/NC');
      expect(text).toContain('镜头变化不能替代故事状态变化');
      expect(text).toContain('最终核对]═══');
      expect(text).not.toContain('第一层｜全局判断');
      expect(text).not.toContain('第二层｜逐张图槽位块');
      expect(text).not.toContain('肉棒');
      expect(text).not.toContain('$调用$');
      expect(text).not.toContain('<disclaimer>');
    }
    for (const comfyText of [DEFAULT_COMFY_THINKING, DEFAULT_COMFY_COMIC_THINKING]) {
      expect(comfyText).not.toContain('characters');
    }
    for (const naiText of [DEFAULT_NAI_THINKING, DEFAULT_NAI_V5_THINKING]) {
      expect(naiText).not.toContain('成年人');
    }
    for (const illuText of [DEFAULT_COMFY_THINKING, DEFAULT_NAI_THINKING, DEFAULT_NAI_V5_THINKING]) {
      expect(illuText).toContain('上一图结束什么状态，本图就从什么状态开始');
      expect(illuText).toContain('画面信息量与导演自查');
    }
  });
});
