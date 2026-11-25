import {
  normalizeSimpleConfig,
  simpleDefaults,
  type ComfyPresetMode,
  type ComfySimpleConfig,
} from '@/backends/comfyTemplates';
import { BUILTIN_NAI_ARTISTS, isBuiltinNaiArtist, naiDefaultUndesired } from '@/backends/nai';
import {
  normalizeOrientationLock,
  parseSize,
  type OrientationLock,
  type SizePair,
} from '@/backends/size';
import {
  clampVibeStrength,
  saveVibeFiles,
  vibeFingerprint,
  vibeMetaFromData,
} from '@/backends/vibeStore';
import {
  DEFAULT_COMFY_COMIC_SPEC,
  DEFAULT_COMFY_COMIC_THINKING,
  DEFAULT_COMFY_SPEC,
  DEFAULT_COMFY_THINKING,
} from '@/prompt/defaultBlocks';
import { resolvePromptPreset } from '@/prompt/presets';
import type { PromptPreset } from '@/prompt/types';
import { getContext } from '@/st/context';
import { reactive, watch } from 'vue';

/**
 * 柏宝绘设置(全局,跨聊天)。存进 ST 的 extension_settings(→ 服务器 settings.json),
 * 因而跨设备同步:手机/局域网另一端打开同一 ST 账户即可见到同一份设置。
 * 骨架阶段:字段只覆盖界面搭建所需,后端/提示词的具体参数随功能迭代往里加。
 */

/** 生图后端 */
export type BackendId = 'comfyui' | 'nai';
// 顺序即展示顺序(渠道页页签 / 设置页出图后端下拉):NAI 用户最多,排最前。
export const BACKENDS: { value: BackendId; label: string }[] = [
  { value: 'nai', label: 'NAI' },
  { value: 'comfyui', label: 'ComfyUI' },
];

/** 各后端共有骨架:连接 + 出图参数。具体参数后面按后端加。 */
export interface BackendConn {
  /** 服务地址,如 http://127.0.0.1:7860 */
  url: string;
  /** 正面质量词。语义按后端各自解释:webui 骨架期仅存值未生效;
   *  nai 视为覆盖值——留空则按模型取官方质量词(见 nai.ts naiDefaultQualityTags)。 */
  qualityTags: string;
  /** 负面提示词。webui 骨架期仅存值未生效;nai 已并入 undesiredContent,只留作存量迁移来源。 */
  negativePrompt: string;
  /** 分辨率,如 832×1216。webui 骨架期仅存值;comfyui/nai 已改用下面的横竖两格。 */
  resolution: string;
  /** 竖屏尺寸,如 832×1216。模型判定为竖屏(单人/特写/立绘)的画面用它。
   *  comfyui 已下沉到单套工作流(见 ComfyWorkflowPreset),这里只留作存量迁移来源。 */
  portraitSize: string;
  /** 横屏尺寸,如 1216×832。模型判定为横屏(群像/远景/全景)的画面用它。
   *  comfyui 同上,只留作存量迁移来源。 */
  landscapeSize: string;
}

/**
 * ComfyUI 出图方案的类型。两类的 AI 协议结构不同,不能混用:
 * - illustration:一个画面一张图,AI 写 tag / nl(现有协议);
 * - comic:整楼剧情画成若干页漫画,AI 写分格布局(MOSS-Image layout)。
 * 方案与提示词各带一份类型,方案只能选同类型的提示词——错配出来的是废图而不是「效果差点」。
 */
export type ComfyKind = 'illustration' | 'comic';

/** 类型选项(顺序即分段按钮顺序)。 */
export const COMFY_KINDS: { value: ComfyKind; label: string }[] = [
  { value: 'illustration', label: '插画' },
  { value: 'comic', label: '漫画' },
];

/** 一台 ComfyUI 服务器。多个方案可共用一台;被方案引用时不可删。 */
export interface ComfyServer {
  id: string;
  name: string;
  url: string;
}

/**
 * 一套 AI 写提示词用的文本:书写规范 + 思维链,成对存放(两者必须配套,见设置页旧注释)。
 * 多个方案可共用一套,改一处全部生效——这正是它从方案里拆出来的理由。
 *
 * 内置的两套(BUILTIN_COMFY_PROMPT_SETS)不入库,按 id 解析、只读、随插件版本更新;
 * 想改就复制成自己的(同 NAI 内置画师串的口径)。
 * kind 建好即固定:改类型会让引用它的方案瞬间错配。
 */
export interface ComfyPromptSet {
  id: string;
  name: string;
  kind: ComfyKind;
  /** 书写规范;留空回落同类型内置那份。 */
  spec: string;
  /** 输出前思考清单;留空回落同类型内置那份。 */
  thinking: string;
}

/**
 * 一套出图方案(存储键沿用 workflows / ComfyWorkflowPreset,免迁移)。
 * 除 JSON 外还带着「这套底模要什么」——切过去即全套生效。
 *
 * 为什么自然语言开关与横竖尺寸归方案:它们本质是底模的属性。
 * Illustrious/Pony 吃 danbooru 短 tag、832×1216;Flux/SD3.5 吃自然语言、1024 方图。
 * 服务器与提示词则是**引用**:多个方案共用一台服务器、一套提示词,改一处不必挨个改。
 */
export interface ComfyWorkflowPreset extends SizePair {
  id: string;
  /** 显示名(下拉列表与切换用;允许重名,以 id 为键)。 */
  name: string;
  /** 方案类型;决定能选哪些提示词、AI 走哪套协议。 */
  kind: ComfyKind;
  /** 引用的服务器 id;悬空时 normalize 回落第一台。 */
  serverId: string;
  /** 引用的提示词 id(用户库或内置);悬空/类型不符时 normalize 回落同类型内置。 */
  promptSetId: string;
  /**
   * 配置方式,两模式互斥:
   * - custom:粘贴 Save (API Format) 的 JSON,动态值用 %prompt% 等占位符;
   * - simple:选模型/LoRA + 填基础参数,出图时由 comfyTemplates 组装 JSON,无占位符。
   */
  mode: ComfyPresetMode;
  /** custom 模式的工作流 JSON;simple 模式下保留但不生效(切回不丢)。 */
  workflow: string;
  /** simple 模式的参数;custom 模式下保留但不生效(切回不丢)。 */
  simple: ComfySimpleConfig;
  /** 生成自然语言:开=自动 tag 以连贯短句写正向提示词(Flux/SD3.5 等);关=逗号分隔 tag。 */
  naturalLanguage: boolean;
  /** 画幅锁:auto = 由自动 tag 判定横竖;portrait/landscape = 这套工作流一律出该方向(见 size.ts)。 */
  orientationLock: OrientationLock;
  /** 可选：仅当选中此工作流时覆盖全局激活的提示词预设 id（留空则跟随全局）。 */
  promptPresetId?: string;
}

/**
 * 出图/测试连接实际需要的字段:方案引用的服务器 url + 方案自身派生(见 effectiveComfyConn)。
 *
 * backends/comfyui.ts 只认这个收窄后的形状,不认整个 ComfyUISettings——
 * 后端层拿到的应该是「这一次出图用什么」,而不是「用户存了几套工作流」。
 */
export interface ComfyRunConn extends SizePair {
  url: string;
  workflow: string;
  mode: ComfyPresetMode;
  simple: ComfySimpleConfig;
}

/**
 * ComfyUI 的三个库:服务器、提示词、出图方案。
 * 继承来的 url 只留作存量迁移来源(折成第一台服务器),出图一律走方案引用的服务器。
 */
export interface ComfyUISettings extends BackendConn {
  /** 服务器库。**不变式:恒非空**(方案恒非空且必引用一台,被引用的删不掉)。 */
  servers: ComfyServer[];
  /** 用户提示词库(不含内置);可为空。 */
  promptSets: ComfyPromptSet[];
  /** 出图方案库。**不变式:恒非空**(至少一条,见 normalizeComfyUI 收尾兜底)。 */
  workflows: ComfyWorkflowPreset[];
  /** 当前使用的工作流 id;指向已删条目时由 normalize 回落到第一条。 */
  activeWorkflowId: string;
}

/**
 * NAI 生图模型标识。
 *
 * ⚠ 类型故意比下拉表宽:4.5 以下(4-full / 4-curated-preview / nai-diffusion-3)已从
 * NAI_MODELS 撤下,但标识留在类型里 —— backends/nai.ts 的协议分支(NAI3 发参考原图、
 * 原版 NAI4 不发 Character Prompts)与其回归测试仍按这些字符串区分代数。
 * 「能不能选中」一律以 NAI_MODELS 为准,它同时是 normalizeNai 的白名单。
 */
export type NaiModel =
  | 'nai-diffusion-5-full'
  | 'nai-diffusion-5-full-medium'
  | 'nai-diffusion-5-curated'
  | 'nai-diffusion-4-5-full'
  | 'nai-diffusion-4-5-curated'
  | 'nai-diffusion-4-full'
  | 'nai-diffusion-4-curated-preview'
  | 'nai-diffusion-3';

/**
 * 可选模型:只留 4.5 与 V5。两代共用同一套「Base + 原生 Character Prompts + 英文自然
 * 语言」协议,收窄后 naiSupportsCharacterPrompts 对全部可选模型恒真 —— 单串 tag 那套
 * DEFAULT_NAI_SPEC / DEFAULT_NAI_THINKING 因此不再可达,设置页也相应撤掉了入口。
 *
 * ⚠ 存量选着已下线模型的配置会被 normalizeNai 回落到 naiDefaults().model:画风、Anlas
 * 消耗与 vibe 编码 key 都会随之改变。这是有意接受的代价(4.5 以下已基本无人使用),
 * 只在控制台留一条告警,不弹窗打扰。
 */
export const NAI_MODELS: { value: NaiModel; label: string }[] = [
  { value: 'nai-diffusion-5-full', label: 'NAI 5 Full(最新,无过滤)' },
  { value: 'nai-diffusion-5-full-medium', label: 'NAI 5 Full Medium(更快更省,部分参数固定)' },
  { value: 'nai-diffusion-5-curated', label: 'NAI 5 Curated(有内容过滤)' },
  { value: 'nai-diffusion-4-5-full', label: 'NAI 4.5 Full(无过滤)' },
  { value: 'nai-diffusion-4-5-curated', label: 'NAI 4.5 Curated(有内容过滤)' },
];

export type NaiVibeEncodings = Record<string, { encoding: string; infoExtracted: number }>;

/** Vibe 大数据正文:存 ST user/files，失败时回退本机 IndexedDB；不进入 extension_settings。 */
export interface NaiVibeData {
  /** 参考原图 base64(不含 data: 前缀):NAI3 直接使用。 */
  image: string;
  /** 缩略图 dataURL。 */
  thumbnail: string;
  /** 按模型分组的编码数据。 */
  encodings: NaiVibeEncodings;
}

/** Vibe 设置索引:只含小型元数据和正文文件路径。 */
export interface NaiVibe {
  id: string;
  /** 显示名(默认取 .naiv4vibe 的 name 或「Vibe-N」)。 */
  name: string;
  /** ST user/files 正文路径，或 `idb:` 开头的本机回退引用。 */
  dataPath: string;
  /** ST user/files 下的小缩略图路径；本机回退时为空。 */
  thumbnailPath: string;
  /** 正文包含的模型编码键。 */
  modelKeys: string[];
  /** 正文是否包含参考原图。 */
  hasImage: boolean;
  /** 编码内容指纹，用于无需读取正文的迁移去重。 */
  fingerprint: string;
  /** 参考强度 0–1(挂在 vibe 上,全部方案共用)。 */
  strength: number;
  // 「启用与否」不在这里:哪几张叠加由方案的 vibeIds 决定(见 NaiPlan)。
  // 老数据的 enabled 键只在迁移时读一次,折进默认方案。
  /**
   * 所属分组名(空串 = 未分组)。
   *
   * 刻意用扁平字符串而非独立的 groups 数组:组只是「一起启用/一起折叠」的标签,
   * 没有自身属性,存成引用就得额外维护「组删了成员怎么办」。改名/删组都是对
   * 本字段的批量赋值,天然不会产生悬空引用。
   *
   * 代价:一条 vibe 只属于一个组,且同一张图无法在两组里用不同强度
   * (strength 挂在 vibe 上而非成员关系上)。现状本就如此,真有需要再升级。
   */
  group: string;
}

/**
 * 一条具名画师串。多个出图方案可共用一条(方案的 artistId 引用它),改一处全部生效。
 *
 * 为什么不按模型分表:官方推荐词是**模型的属性**,切模型必须跟着换
 * (见 nai.ts 的 QUALITY_TAGS / DEFAULT_UNDESIRED_CONTENT);画师串是**用户自己的搭配**,
 * 跨模型复用才是常态。故做成可增删的库,而非 Record<model, …>。
 *
 * quality / negative 随画师串一起切换:对应字段有值就只用它,留空则按当前模型取官方词。
 * 正/负面分别回落;智绘姬导入的预设也直接落成这三段,选中即整套生效。
 * 渠道级与方案级旧字段不再参与出图,避免同一份词出现多层覆盖。
 */
export interface NaiArtistPreset {
  id: string;
  /** 显示名(下拉列表与切换用;允许重名,以 id 为键)。 */
  name: string;
  /** 画师/画风 tag 串,拼在正向提示词最前面;留空的条目在拼装时等同于没选。 */
  prompt: string;
  /** 正面质量词;空串或纯空白 = 按当前模型取官方质量词。 */
  quality: string;
  /** 负面提示词;空串或纯空白 = 按当前模型取官方负面词(Medium 档恒为官方)。 */
  negative: string;
  /**
   * 预览图路径(/api/images/upload 落在 user/images/柏宝绘_画师串/ 的相对路径)。
   * 可选:老数据没有此键;空 = 管理器卡片显示占位。文件归属随条目:
   * 删条目时按此路径删文件;复制条目不带走(否则两条目共指一个文件,删一边另一边破图)。
   */
  previewPath?: string;
}

/** 官方站地址。内置那条接入点的 url 恒为它(UI 禁改,normalize 也把脏数据纠回来)。 */
export const NAI_OFFICIAL_URL = 'https://image.novelai.net';

/** 内置官方接入点的固定 id。靠它认人而非靠 url 比对(与内置画师串 `bi_*` 同套路)。 */
export const OFFICIAL_NAI_ENDPOINT_ID = 'nep_official';

/** 这条是不是内置官方接入点(url 只读、不可删、不可改名)。 */
export function isOfficialNaiEndpoint(id: string): boolean {
  return id === OFFICIAL_NAI_ENDPOINT_ID;
}

/**
 * 一条 NAI 接入点:地址、密钥与该站的同时出图数。方案引用它(endpointId),多个方案可共用一个站。
 *
 * 为什么出图参数一概归方案、接入点只管「站」的事:公益站之间换的是「从哪儿发、用谁的额度」,
 * 协议与参数完全一致。参数若跟着接入点走,换个站就得把步数/画师串/vibe 重配一遍,
 * 而用户要的恰恰是「同一套设置换个出口」——改方案里的接入点一项即可。
 * 并发例外地挂在这里:它是站/账号的属性(各站额度不同),不是画风的属性。
 */
export interface NaiEndpoint {
  id: string;
  /** 显示名(下拉切换用;允许重名,以 id 为键)。 */
  name: string;
  /** 接口地址;内置官方那条恒为 NAI_OFFICIAL_URL。 */
  url: string;
  /** 该站的 API Key(公益站各有各的 key,故随条目走而非渠道级共用一份)。 */
  key: string;
  /**
   * 同时出图数(1–4,默认 1)。NAI 的 generate-image 是阻塞式请求、服务端不排队,
   * 并发压过去容易吃 429,故由客户端闸门限流(floor/genQueue.ts,每个接入点一把)。
   * 不进方案:按方案各设一个数会让「切方案」顺手改了同一个站的限流。
   * ComfyUI 无此设置:它有服务端队列,一次性全发即可。
   */
  concurrency: number;
}

/**
 * 一套 NAI 出图方案:「从哪个站发、用什么模型、什么画风、怎么采样」打包在一起,切过去全套生效。
 *
 * 方案通过 artistId 引用一整套画风:画师串正文 + 它绑定的质量词 / 负面词;
 * 正/负面分别按「画师串值 → 当前模型官方词」回落,不再读方案级旧字段。
 *
 * 接入点、画师串、vibe 是**引用**:三个库全局共享,多个方案共用一个站、一条画师串、
 * 一张 vibe,改一处全部生效。vibe 强度挂在 vibe 上(全方案共用),方案只记「叠加哪几张」。
 * 同时出图数不进方案:限流是接入点/账号级的事(见 NaiEndpoint.concurrency)。
 */
export interface NaiPlan extends SizePair {
  id: string;
  /** 显示名(列表与切换用;允许重名,以 id 为键)。 */
  name: string;
  /** 引用的接入点 id;悬空时回落第一条(地址是必需品,不能落空)。 */
  endpointId: string;
  model: NaiModel;
  /**
   * 引用的画师串 id。**空串 = 不使用画师串**,是有意义的存储值。
   * 合法值域:{''} ∪ 用户库 id ∪ 内置库 id(bi_*);其余一律由 normalizeNai 清成空串——
   * 刻意**不**像 endpointId 那样回落第一条:那会给用户静默套上一套
   * 他没选过的画风,每张图都变样却查不出原因。
   */
  artistId: string;
  /** @deprecated 方案化初期的旧字段;仅为兼容保留存储,出图只读当前画师串的 quality。 */
  qualityTags: string;
  /** @deprecated 方案化初期的旧字段;仅为兼容保留存储,出图只读当前画师串的 negative。 */
  undesiredContent: string;
  sampler: string;
  steps: number;
  /** 提示词相关性(CFG scale)。 */
  scale: number;
  /** 关联性调整(cfg_rescale,0–1)。 */
  cfgRescale: number;
  /** 噪声表(karras/native/exponential/polyexponential)。 */
  noiseSchedule: string;
  /** 固定种子;0 = 每次随机。 */
  seed: number;
  /** Variety Boost(skip_cfg_above_sigma,按尺寸与模型自动算 magic 值)。 */
  varietyBoost: boolean;
  /** 参考强度归一化:多个 vibe 强度总和超过 1 时按比例压回 1。 */
  normalizeRefStrength: boolean;
  /**
   * 本方案叠加的 vibe(库内 id)。模型不支持 vibe(当前 = NAI 5)时**原样保留**、出图整批跳过:
   * 切回 4.5,或日后官方给 V5 开放 vibe,勾过的还在。「支不支持」只认 nai.ts 的
   * naiSupportsVibes 一处——V5 开放那天改它一行,面板与出图一起放开。
   * 指向已删 vibe 的 id 由 normalize 与删除动作清掉。
   */
  vibeIds: string[];
  /**
   * 生成自然语言(仅 4.5/V5 有意义,默认开):开 = 自动 tag 为 Base 与每个角色
   * 写英文 nl;关 = 只写 tag。与 ComfyUI 方案的同名开关同一口径——**只管 AI 写不写,
   * 不管发不发**:tag 里已有的 nl 照常发送(想对比就清掉 nl 或「AI 重写提示词」)。
   * 关它不影响原生多角色提示(characters[]),那是模型能力,不是写法。
   * 存在理由:4.5 的提示词预算(约 512 token,Base 与全部角色共用)比 V5 紧得多,
   * nl 是最大头,超了会被截断、画面跟着走样。
   */
  naturalLanguage: boolean;
  /** 画幅锁;语义见 size.ts 的 OrientationLock。 */
  orientationLock: OrientationLock;
}

/**
 * NAI 渠道:三个共享库(接入点 / 画师串 / vibe)+ 出图方案库 + 同时出图数。
 *
 * 方案化之前的渠道级平铺字段(model、sampler、qualityTags、activeArtistId、vibe.enabled……)
 * 只在 normalizeNai 里读一次、折成第一套方案,之后不再存。
 */
export interface NaiSettings {
  /**
   * 接入点列表。**不变式:恒非空,且必含内置官方那条**(normalize 缺则补回)。
   * 官方条不可删,故 UI 不必处理「删空了怎么办」——与方案库的恒非空同构,
   * 与画师串库的「允许为空」相反:没有地址就出不了图,它是必需品。
   */
  endpoints: NaiEndpoint[];
  /**
   * 画师串库。**允许为空**——画师串不给只是不加画风,是可选调味。
   * 这里只存**用户自己的**条目;官方推荐的内置条目在 backends/nai.ts 的
   * BUILTIN_NAI_ARTISTS(只读、随版本更新),不进 settings——不然默认值会冻在
   * 每个用户的设备上,以后想调都得做指纹迁移。
   */
  artistPresets: NaiArtistPreset[];
  /** Vibe 库索引；正文存在 ST user/files，设置中不存大 Base64。 */
  vibes: NaiVibe[];
  /** 出图方案库。**不变式:恒非空**(至少一条,见 normalizeNai 收尾兜底)。 */
  plans: NaiPlan[];
  /** 当前方案 id;悬空时由 normalize 回落到第一条。 */
  activePlanId: string;
}

/**
 * 一次 NAI 请求实际要用的全部参数(effectiveNai 产出)。
 *
 * backends/nai.ts 只认这个收窄后的形状,不认 NaiSettings / NaiPlan——后端关心的是
 * 「这一次往哪儿发、画什么风格」,不是「用户存了几套方案」。引用都已在这里解开:
 * 接入点给出 url/key,画师串给出快照,vibes 只含本方案叠加的那几张(库内顺序)。
 */
export interface NaiRunConfig extends SizePair {
  /** 所用接入点的 id:闸门与 429 冷却按它分账(floor/genQueue.ts)。 */
  endpointId: string;
  url: string;
  key: string;
  model: NaiModel;
  /** 本方案的画师串;未选 / 悬空 = null。 */
  artist: NaiArtistPreset | null;
  /** @deprecated 兼容旧配置形状;提示词拼装不读,正/负面只认 artist 与模型官方词。 */
  qualityTags: string;
  /** @deprecated 同 qualityTags。 */
  undesiredContent: string;
  sampler: string;
  steps: number;
  scale: number;
  cfgRescale: number;
  noiseSchedule: string;
  seed: number;
  varietyBoost: boolean;
  normalizeRefStrength: boolean;
  /** 本方案叠加的 vibe;模型不支持 vibe 时由后端整批跳过(不在这里滤,好让它提示用户)。 */
  vibes: NaiVibe[];
}

/** 界面偏好里要跨设备同步的部分;activePage 等纯本机临时态不在此。 */
export interface UiPrefs {
  /** 主题名(合法值见 state/ui.ts 的 THEMES;这里只存字符串,避免 settings 反向依赖 ui) */
  theme: string;
  /** 导航位置:top/bottom/auto */
  navPosition: string;
  /** 移动端:再点当前页导航按钮即关闭整窗。默认开;怕误触的用户可关。 */
  navTapClose: boolean;
  /** 在 ST 顶栏注入一个快速打开按钮(魔杖菜单入口照旧保留)。默认关。 */
  showTopBar: boolean;
  /** 屏幕边缘悬浮球,点击打开柏宝绘。默认关。 */
  showOrb: boolean;
  /** 悬浮球自定义图标(ST 服务器图片路径;空=默认画笔图标)。跨设备同步。 */
  orbImage: string;
  /** 悬浮球形状:bookmark 书签(默认)/ circle 圆 / square 方。 */
  orbShape: string;
  /** 悬浮球静止时不透明度(百分比 20–100,默认 62)。唤起/拖动时一律全显。 */
  orbOpacity: number;
  /** 悬浮球基准尺寸(px,32–80,默认 48)。 */
  orbSize: number;
  /**
   * 楼层卡片主题(合法值同 theme,见 state/ui.ts 的 THEMES)。
   * 默认 'st' = 从宿主 --SmartTheme* 派生,卡片融进当前 ST 配色;
   * 想让卡片走柏宝绘品牌观感就选 night/pastel 等。与设置窗口主题(theme)分开,
   * 因为两者诉求不同:窗口是独立界面,卡片嵌在聊天流里。
   */
  cardTheme: string;
  /**
   * 楼层图片默认折叠:开启后卡片默认收成一条细条(点击展开),适合公共场合防窥。
   * 只是「默认」——卡片上手动展开/折叠过的槽位以手动状态为准(会话内,见 floor/collapseState.ts)。
   */
  autoCollapseImages: boolean;
  /**
   * 楼层图片显示大小(合法值见 IMAGE_DISPLAY_SIZES)。只管聊天里显示多大,
   * 与出图分辨率、横竖方向无关,生成的文件一字节不变。
   */
  imageDisplaySize: ImageDisplaySize;
  /**
   * 楼层图片沉浸显示:开启后有图时不显示 ⋯ 菜单与翻页器,点一下图片才浮现,
   * 点卡片外面收起;浮现时再点图片才进灯箱。关闭 = ⋯ 常驻淡显、翻页器常驻(老样子)。
   */
  immersiveImages: boolean;
  /**
   * 美化正则与前端卡 iframe 穿透（默认开启）：当 <bbm_image> 槽位被正文美化正则改写或包裹在同源 iframe 内时，
   * 自动定位原文上下文并锚定卡片，兜底挂载到楼层末尾，保证生图卡片不丢失。
   */
  enableBeautifyPenetration: boolean;
}

/** 楼层图片显示大小。 */
export type ImageDisplaySize = 'small' | 'medium' | 'large' | 'full';

/**
 * 显示大小选项(顺序即下拉顺序)。封的是**高度**而不是宽度:PC 上嫌大的,是竖图铺满
 * 楼层宽度后比一屏还高;按宽度封顶,竖图照样高,横图反倒被压得过小。宽度随原图比例,
 * 且始终不超过楼层宽度——窄屏(手机竖屏)上竖图本来就矮于 600px,默认档基本无感。
 */
export const IMAGE_DISPLAY_SIZES: { value: ImageDisplaySize; label: string; maxHeight: number | null }[] = [
  { value: 'small', label: '小（高度不超过 400px）', maxHeight: 400 },
  { value: 'medium', label: '中（高度不超过 600px）', maxHeight: 600 },
  { value: 'large', label: '大（高度不超过 800px）', maxHeight: 800 },
  { value: 'full', label: '铺满楼层宽度（不限高度）', maxHeight: null },
];

/** 显示大小 → 图片显示高度上限(px);null = 不封顶,铺满楼层宽度(0.3.0 及以前的样子)。 */
export function imageDisplayMaxHeight(size: ImageDisplaySize): number | null {
  return IMAGE_DISPLAY_SIZES.find(option => option.value === size)?.maxHeight ?? null;
}

/**
 * 副 API 渠道(OpenAI 兼容)。结构与柏宝书完全一致:渠道列表通过共享存储
 * (extensionSettings['baibai_api_channels'])在各「柏宝」插件间同步——
 * 在柏宝书里配好的渠道,这里直接可用;任一端增删改,另一端实时跟随。
 */
export interface ApiChannel {
  id: string;
  /** 显示名 */
  name: string;
  /** OpenAI 兼容的 base url,如 https://api.openai.com/v1 */
  url: string;
  /** 密钥 */
  key: string;
  /** 模型名 */
  model: string;
  /** 采样温度 */
  temperature: number;
  /** 最大输出 token */
  maxTokens: number;
  /** 单次请求超时(秒)。超过后主动中断;每个渠道独立配置,默认 180 秒。 */
  timeoutSec: number;
  /** 流式传输(默认关);开启后按 SSE 增量拼接 */
  stream: boolean;
  /** 排除参数:这些字段名会在构造请求体时从 body 中删除,
   *  用于规避不接受某些参数(如 temperature/max_tokens)的兼容端点报错。 */
  excludeParams: string[];
  /**
   * 思考强度(推理模型的 reasoning_effort)。空串 = auto = 不发这个参数(默认,老渠道即此值)。
   *
   * 取值不做白名单校验,原样发给端点:各家词汇不统一(OpenAI 的 minimal/low/medium/high/xhigh、
   * 部分中转站的 max/none……),中转站比我们更清楚自己的模型吃什么,校验只会误伤。
   *
   * 非空时整条请求改走 custom 源(见 api/client.ts 的 buildRequestBody):
   * ST 代理对 openai 源的 reasoning_effort 有**模型名白名单**(src/constants.js 的
   * OPENAI_REASONING_EFFORT_MODELS,精确匹配 o1/o3/gpt-5 那批),模型名对不上就**静默丢弃且照样返回 200**——
   * 用户设了却毫无效果、还看不出来。custom 源的 custom_include_body 是纯 merge,不过白名单。
   *
   * ⚠️ 跨插件:本字段是绘独有的,柏宝书 ≤ 当前版本的 normalizeChannel 是「逐字段重建对象」,
   * 不认识的键会被丢掉。在书里**新增/编辑/删除渠道**、或**点测试渠道**(可能自动改写 url)
   * 会触发共享存储回写,进而抹掉本字段。只开书、或在书里改摘要/提示词/排除名单则不受影响。
   * 等书那边补上同名字段后此风险消失。
   */
  reasoningEffort: string;
}

/**
 * 破限词内置默认:与柏宝书同款(副 API 共享同一套),作为置顶 system 附加在自动 tag 请求里,
 * 降低副 API 对露骨/暴力内容的拒答率。留空即回落此默认,与柏宝书「留空则用内置默认」同口径。
 */
export {
  DEFAULT_JAILBREAK_PROMPT,
  DEFAULT_SEMANTIC_FIELD_BLOCK,
  DEFAULT_DIRECTOR_COMPOSITION_BLOCK,
  DEFAULT_VISUAL_STATE_BLOCK,
  DEFAULT_AESTHETIC_MALE_BIAS_BLOCK,
  DEFAULT_AESTHETIC_FEMALE_BIAS_BLOCK,
  DEFAULT_COMFY_PROMPT_BASE,
  DEFAULT_COMFY_SPEC,
  DEFAULT_COMFY_NL_SPEC,
  DEFAULT_NAI_SPEC,
  DEFAULT_COMFY_THINKING,
  DEFAULT_NAI_THINKING,
  DEFAULT_NAI_V5_THINKING,
  DEFAULT_NAI_V5_SPEC,
  DEFAULT_COMFY_COMIC_SPEC,
  DEFAULT_COMFY_COMIC_THINKING,
} from '@/prompt/defaultBlocks';

export interface AutoTagSettings {
  /** 新 AI 正文落地后自动请求模型。 */
  enabled: boolean;
  /** 发送最近多少个 AI 故事楼及其间 user 楼的清洗后正文；目标楼计入数量。 */
  contextMessages: number;
  /** 单楼要求模型返回的最少画面数；0 = 允许没有值得绘制的画面。 */
  minImages: number;
  /** 单楼允许模型选择的最大画面数。 */
  maxImages: number;
  /** 生成失败自动重试次数(请求异常或返回无法解析都算),0 = 不重试,默认 1。 */
  retryCount: number;
  /** 写入 tag 后是否立即调用出图渠道自动生成图片(默认开;关闭则卡片上手动点「生成」)。 */
  autoGenerate: boolean;
  /** 可编辑提示词集(破限/后端规范/思维链);空串 = 回落内置默认。 */
  prompts: AutoTagPrompts;
}

/**
 * 排除设置(镜像共享存储;真身在 extensionSettings['baibai_exclude_settings'])。
 * 与柏宝书共用同一份名单、同一套匹配口径:任一端改动自动同步,双端行为一致。
 */
/** 落盘存储行为(影响新生成图片的保存格式)。 */
export interface StoragePrefs {
  /**
   * 新图统一转存 JPG(固定质量 0.9)再落盘,不再保存 PNG。
   * 体积约为 PNG 的 10–20%;代价是图内嵌的生成参数(NAI tEXt / ComfyUI 工作流块,
   * 即「拖回官方站复现」依赖的信息)随转码丢失——提示词与种子仍保存在 extra 里,
   * 但无法再从图片本身提取。仅影响新图,存量 PNG 不动;转码失败自动回退 PNG。
   */
  saveAsJpeg: boolean;
}

export interface ExcludesSettings {
  /** 排除的角色名:这些名字(含重名卡)的聊天里,自动 tag 全流程停用(与柏宝书记忆停用同名单)。 */
  excludedChars: string[];
  /** 整本排除的世界书文件名:这些书的所有激活条目都不进 tag 生成的副 API 参考(仅影响副 API)。 */
  excludedWorldNames: string[];
  /** 按条目名(comment)过滤的规则:命中任一规则的条目不进副 API 参考。
   *  每条当正则编译(普通名字天然=包含匹配),编译失败降级为字面子串包含。 */
  excludedWorldInfoPatterns: string[];
  /** 自定义清洗标签(只填标签名,不带尖括号,如 snow):清洗正文时
   *  <snow>…</snow> 连同内部内容一并删掉。与柏宝书共用名单。 */
  customStripTags: string[];
}

/**
 * ComfyUI 规范内置默认:tag 规范常驻;{{nl}} 宏按 ComfyUI 面板「生成自然语言」开关展开/置空。
 * 多人部分提炼自本地实践文档(comfyui docs/多人tag标准格式.md)的普适规则:
 * 编号无效、特征绑定、共有特征一次、场景别抢主体——本地模型多人图串味的主因就是这些。
 */


/**
 * 自动 tag 请求的可编辑提示词集。各条留空 = 回落内置默认(与柏宝书自定义提示词同口径)。
 *
 * ⚠ 键名与设置页标签不是一一对应的:设置页里的「NAI 规范 / NAI 思维链」实际存在
 * naiV5Spec / naiV5Thinking(历史命名),而同名的 naiSpec / naiThinking 是 4.5 以下
 * 那套单串 tag 版本 —— 已随模型列表收窄下线,无 UI 入口。键一律保留,免得动存量设置。
 *
 * 规范与思维链(两个后端都是)支持自然语言条件段:{{#nl}}…{{/nl}} 只在开启「生成自然语言」
 * 时保留,{{^nl}}…{{/nl}} 只在关闭时保留(展开见 autoTag/prompt.ts 的 expandNlSections)。
 * NAI 的两份内置默认靠它在开关两侧共用一份文本;开启侧展开后与 0.3.0 的内置文本逐字相同。
 */
export interface AutoTagPrompts {
  /** 破限词:置顶 system,降低副 API 拒答率。 */
  jailbreak: string;
  /** 【已下线,无 UI 入口】NAI 4 系及以下的单串 tag 规范;回落 DEFAULT_NAI_SPEC。 */
  naiSpec: string;
  /** NAI 规范(4.5/V5 的 Base Prompt + 原生 Character Prompts);设置页显示为「NAI 规范」。 */
  naiV5Spec: string;
  /** 【已迁走,只留作迁移来源】ComfyUI 规范已搬进提示词库(comfyui.promptSets),出图不再读这里。
   *  老用户改过的内容在首次升级时折成「我的插画提示词」(见 foldLegacyPromptSets)。 */
  comfySpec: string;
  /** 【已迁走,只留作迁移来源】同 comfySpec。 */
  comfyThinking: string;
  /** 【已下线,无 UI 入口】NAI 4 系及以下的思考清单;回落 DEFAULT_NAI_THINKING。 */
  naiThinking: string;
  /** NAI 思维链(4.5/V5);留空回落内置默认(DEFAULT_NAI_V5_THINKING)。
   *  槽位块是 Base + 每角色块,与 comfy 那份的单串形态不同,不可互换。 */
  naiV5Thinking: string;
}

export interface DirectChannelOverride {
  enableTemperature?: boolean;
  enableTopP?: boolean;
  topP?: number;
  enableMaxTokens?: boolean;
  customHeaders?: string;
  customBodyParams?: string;
}

/** 世界书条目级注入范围控制（含 ACU 稳定键名）。 */
export interface WorldInfoSelectionSettings {
  mode: 'auto' | 'whitelist';
  selectedByBook: Record<string, string[]>;
}

/** 自定义正文/历史清洗正则规则。 */
export interface CleanRegexRule {
  id: string;
  name: string;
  enabled: boolean;
  pattern: string;
  flags: string;
  replacement: string;
  scope: 'target' | 'history' | 'both';
}

/** 敏感词双向替换配置（发送给 LLM 前正向替换，返回解析后逆向还原）。 */
export interface WordReplaceSettings {
  enabled: boolean;
  rawRules: string;
}

export interface ImageSettings {
  /** 插件总开关。 */
  enabled: boolean;
  /** 界面偏好(主题/导航位置等),随设置存进 extension_settings → 跨设备同步 */
  ui: UiPrefs;
  /** 渠道页初始展示的后端 */
  defaultBackend: BackendId;
  /** 后端连接配置 */
  comfyui: ComfyUISettings;
  nai: NaiSettings;
  /** 副 API 渠道列表(镜像共享存储;真身在 extensionSettings['baibai_api_channels']) */
  channels: ApiChannel[];
  /** 本地直连高级参数覆写(key = channelId;不污染共享存储 baibai_api_channels) */
  channelOverrides: Record<string, DirectChannelOverride>;
  /** 任务指派(渠道 id;留空时自动取唯一渠道或提示选择)。 */
  assignments: { tagGen: string };
  /** 自动判断并向正文插入生图 tag。 */
  autoTag: AutoTagSettings;
  /** 模块化提示词预设（当前激活预设 ID + 用户自定义预设列表）。 */
  activePromptPresetId: string;
  promptPresets: PromptPreset[];
  /** 世界书条目级白名单与 ACU 稳定绑定配置。 */
  worldInfoSelection: WorldInfoSelectionSettings;
  /** 自定义正文清洗正则规则列表。 */
  cleanRegexRules: CleanRegexRule[];
  /** 敏感词双向替换配置。 */
  wordReplace: WordReplaceSettings;
  /** 排除设置(镜像共享存储;真身在 extensionSettings['baibai_exclude_settings'])。 */
  excludes: ExcludesSettings;
  /** 落盘存储行为(新图格式)。 */
  storage: StoragePrefs;
}

// extension_settings 里的命名空间键(与原版柏宝绘独立并存)。
const SETTINGS_KEY = 'baibai_mod';

/** 内置默认条目名规则:共享存储创建时播种(与柏宝书 DEFAULT_WI_PATTERNS 同值)。 */
const DEFAULT_WI_PATTERNS = ['\\[mvu[\\s\\S]*?\\]'];

function excludesDefaults(): ExcludesSettings {
  return {
    excludedChars: [],
    excludedWorldNames: [],
    excludedWorldInfoPatterns: [],
    customStripTags: [],
  };
}

function backendDefaults(url: string): BackendConn {
  return {
    url,
    qualityTags: '',
    negativePrompt: '',
    resolution: '',
    portraitSize: '832×1216',
    landscapeSize: '1216×832',
  };
}

/** 新预设的默认名(迁移与建库都用它,保持一致口径)。 */
const DEFAULT_WORKFLOW_NAME = '默认工作流';
/** 默认横竖尺寸(与 backendDefaults 同值;预设级尺寸独立于渠道级,故单列一份)。 */
const DEFAULT_PORTRAIT_SIZE = '832×1216';
const DEFAULT_LANDSCAPE_SIZE = '1216×832';

let workflowSeq = 0;

/**
 * 漫画书写规范(MOSS-Image)。只讲「每页怎么画」:写法、summary/items 分工、分格与对白;
 * 输出结构、position、角色档案在 autoTag/prompt.ts 的漫画协议里(不随用户改动漂移)。
 * 口径来自 MOSS 实测笔记:自然语言句子、权重语法无效、一人一框、避开均等田字格、
 * 对白只认 text 项、summary 不写 full color 容易出黑白稿。
 */


export const BUILTIN_COMFY_ILLUST_ID = 'builtin_illust';
export const BUILTIN_COMFY_COMIC_ID = 'builtin_comic';

/**
 * 内置提示词:不入库、只读,按 id 解析(同 BUILTIN_NAI_ARTISTS 的口径)。
 * 不入库是为了随插件版本更新——存进设置的副本会把旧版文本永远冻住。
 */
export const BUILTIN_COMFY_PROMPT_SETS: readonly ComfyPromptSet[] = [
  {
    id: BUILTIN_COMFY_ILLUST_ID,
    name: '插画(内置)',
    kind: 'illustration',
    spec: DEFAULT_COMFY_SPEC,
    thinking: DEFAULT_COMFY_THINKING,
  },
  {
    id: BUILTIN_COMFY_COMIC_ID,
    name: '漫画(内置)',
    kind: 'comic',
    spec: DEFAULT_COMFY_COMIC_SPEC,
    thinking: DEFAULT_COMFY_COMIC_THINKING,
  },
];

export function isBuiltinComfyPromptSet(id: string): boolean {
  return BUILTIN_COMFY_PROMPT_SETS.some(p => p.id === id);
}

/** 某类型的内置提示词(两类各恰好一套)。 */
export function builtinComfyPromptSet(kind: ComfyKind): ComfyPromptSet {
  return BUILTIN_COMFY_PROMPT_SETS.find(p => p.kind === kind) ?? BUILTIN_COMFY_PROMPT_SETS[0];
}

const DEFAULT_COMFY_URL = 'http://127.0.0.1:8188';
const DEFAULT_SERVER_NAME = '本机';

let serverSeq = 0;

/** 新建一台服务器(srv_ 前缀不与 wf_/ps_ 撞)。 */
export function newComfyServer(name = DEFAULT_SERVER_NAME, url = ''): ComfyServer {
  serverSeq += 1;
  return { id: `srv_${Date.now()}_${serverSeq}`, name, url };
}

let promptSetSeq = 0;

/** 新建一套提示词,内容预填同类型内置文本——空白起步没人会写,照着改才是常态。 */
export function newComfyPromptSet(kind: ComfyKind, name: string): ComfyPromptSet {
  promptSetSeq += 1;
  const builtin = builtinComfyPromptSet(kind);
  return { id: `ps_${Date.now()}_${promptSetSeq}`, name, kind, spec: builtin.spec, thinking: builtin.thinking };
}

/** 新建一条空方案(id 生成口径同 newChannel)。serverId 缺省为空,解析时回落第一台。 */
export function newComfyWorkflow(name = DEFAULT_WORKFLOW_NAME, serverId = ''): ComfyWorkflowPreset {
  workflowSeq += 1;
  return {
    id: `wf_${Date.now()}_${workflowSeq}`,
    name,
    kind: 'illustration',
    serverId,
    promptSetId: BUILTIN_COMFY_ILLUST_ID,
    mode: 'custom',
    workflow: '',
    simple: simpleDefaults(),
    naturalLanguage: false,
    portraitSize: DEFAULT_PORTRAIT_SIZE,
    landscapeSize: DEFAULT_LANDSCAPE_SIZE,
    orientationLock: 'auto',
  };
}

/**
 * 新装即带一台本机服务器 + 一条空方案,而不是空库。
 * 只用一套工作流的人不该被迫先「新建」才有地方粘 JSON——「库」这个概念对他们保持隐形。
 * 也顺带让 servers / workflows 恒非空的不变式从出生起就成立。
 */
function comfyDefaults(): ComfyUISettings {
  const server = newComfyServer(DEFAULT_SERVER_NAME, DEFAULT_COMFY_URL);
  const preset = newComfyWorkflow(DEFAULT_WORKFLOW_NAME, server.id);
  return {
    ...backendDefaults(DEFAULT_COMFY_URL),
    servers: [server],
    promptSets: [],
    workflows: [preset],
    activeWorkflowId: preset.id,
  };
}

/** 新画师串的默认名。 */
const DEFAULT_ARTIST_NAME = '画师串 1';

let artistSeq = 0;

/** 新建一条空配方(id 生成口径同 newComfyWorkflow / newChannel;art_ 前缀不与 wf_/ch_ 撞)。 */
export function newNaiArtist(name = DEFAULT_ARTIST_NAME): NaiArtistPreset {
  artistSeq += 1;
  return { id: `art_${Date.now()}_${artistSeq}`, name, prompt: '', quality: '', negative: '' };
}

/** 接入点同时出图数的缺省与上下限。 */
const NAI_CONCURRENCY_DEFAULT = 1;
export const NAI_CONCURRENCY_MAX = 4;

/** 内置官方接入点。key 随用户填(内置的只是地址与名字,不是别人的密钥)。 */
function officialNaiEndpoint(key = '', concurrency = NAI_CONCURRENCY_DEFAULT): NaiEndpoint {
  return { id: OFFICIAL_NAI_ENDPOINT_ID, name: 'NovelAI 官方', url: NAI_OFFICIAL_URL, key, concurrency };
}

let naiEpSeq = 0;

/** 新建一条空接入点(id 前缀 nep_,不与 art_/wf_/ch_ 的 id 空间相撞)。 */
export function newNaiEndpoint(name = '新接入点'): NaiEndpoint {
  naiEpSeq += 1;
  return { id: `nep_${Date.now()}_${naiEpSeq}`, name, url: '', key: '', concurrency: NAI_CONCURRENCY_DEFAULT };
}

/** 新方案的默认名(迁移与建库都用它)。 */
const DEFAULT_NAI_PLAN_NAME = '默认方案';

let naiPlanSeq = 0;

/**
 * 新建一套方案:官方接入点 + V5 + 不用画师串 + 正/负面词跟随官方 + 官方前端的采样默认。
 * 只是出厂值;面板「新建」会在此基础上带上当前方案的接入点(见 NaiPanel)。
 */
export function newNaiPlan(name = DEFAULT_NAI_PLAN_NAME): NaiPlan {
  naiPlanSeq += 1;
  return {
    id: `nplan_${Date.now()}_${naiPlanSeq}`,
    name,
    endpointId: OFFICIAL_NAI_ENDPOINT_ID,
    model: 'nai-diffusion-5-full',
    artistId: '',
    qualityTags: '',
    undesiredContent: '',
    sampler: 'k_euler',
    steps: 28,
    scale: 5.5,
    cfgRescale: 0,
    noiseSchedule: 'karras',
    seed: 0,
    varietyBoost: true,
    normalizeRefStrength: true,
    vibeIds: [],
    naturalLanguage: true,
    orientationLock: 'auto',
    portraitSize: DEFAULT_PORTRAIT_SIZE,
    landscapeSize: DEFAULT_LANDSCAPE_SIZE,
  };
}

function naiDefaults(): NaiSettings {
  // 新装用户默认启用内置「默认画师串」——默认值只在这条路径生效:老用户的存量配置
  // 走 normalizeNai 的迁移,没存过 activeArtistId 的就是「不使用」,不吃这个默认。
  const plan = { ...newNaiPlan(), artistId: BUILTIN_NAI_ARTISTS[0]?.id ?? '' };
  return {
    // 新装即带内置官方那条:地址是必需品,空列表会让「测试连接」无处可点
    endpoints: [officialNaiEndpoint()],
    // 用户库为空:库里只有用户自己建的条目,官方推荐的那条是内置只读条目
    // (BUILTIN_NAI_ARTISTS),不进 settings。
    artistPresets: [],
    vibes: [],
    plans: [plan],
    activePlanId: plan.id,
  };
}

function defaults(): ImageSettings {
  return {
    enabled: true,
    ui: {
      theme: 'day',
      navPosition: 'auto',
      navTapClose: true,
      showTopBar: false,
      showOrb: false,
      orbImage: '',
      orbShape: 'bookmark',
      orbOpacity: 62,
      orbSize: 48,
      cardTheme: 'st',
      autoCollapseImages: false,
      imageDisplaySize: 'medium',
      immersiveImages: false,
      enableBeautifyPenetration: true,
    },
    defaultBackend: 'comfyui',
    comfyui: comfyDefaults(),
    nai: naiDefaults(),
    channels: [],
    channelOverrides: {},
    assignments: { tagGen: '' },
    autoTag: {
      enabled: true,
      contextMessages: 2,
      minImages: 0,
      maxImages: 2,
      retryCount: 1,
      autoGenerate: true,
      prompts: {
        jailbreak: '',
        naiSpec: '',
        naiV5Spec: '',
        comfySpec: '',
        comfyThinking: '',
        naiThinking: '',
        naiV5Thinking: '',
      },
    },
    activePromptPresetId: 'builtin_text_json',
    promptPresets: [],
    worldInfoSelection: { mode: 'auto', selectedByBook: {} },
    cleanRegexRules: [],
    wordReplace: { enabled: false, rawRules: '' },
    excludes: excludesDefaults(),
    storage: { saveAsJpeg: true },
  };
}

let chanSeq = 0;

/** 补全单个渠道的缺失字段并校验类型(与柏宝书同构,共享存储来回序列化也安全)。 */
function normalizeChannel(c: Partial<ApiChannel>): ApiChannel {
  return {
    id: typeof c.id === 'string' ? c.id : `ch_${Date.now()}_${++chanSeq}`,
    name: typeof c.name === 'string' ? c.name : '新渠道',
    url: typeof c.url === 'string' ? c.url : '',
    key: typeof c.key === 'string' ? c.key : '',
    model: typeof c.model === 'string' ? c.model : '',
    temperature: typeof c.temperature === 'number' ? c.temperature : 1.0,
    maxTokens: typeof c.maxTokens === 'number' ? c.maxTokens : 65535,
    timeoutSec:
      typeof c.timeoutSec === 'number' && Number.isFinite(c.timeoutSec) && c.timeoutSec > 0
        ? Math.floor(c.timeoutSec)
        : 180,
    stream: typeof c.stream === 'boolean' ? c.stream : false,
    excludeParams: Array.isArray(c.excludeParams)
      ? c.excludeParams.filter((x): x is string => typeof x === 'string')
      : [],
    // 后加字段:老渠道无此键 → 空串(auto,不发参数),行为与加字段前完全一致
    reasoningEffort: typeof c.reasoningEffort === 'string' ? c.reasoningEffort.trim() : '',
  };
}

export function newChannel(): ApiChannel {
  chanSeq += 1;
  return {
    id: `ch_${Date.now()}_${chanSeq}`,
    name: '新渠道',
    url: '',
    key: '',
    model: '',
    temperature: 1.0,
    maxTokens: 65535,
    timeoutSec: 180,
    stream: false,
    excludeParams: [],
    reasoningEffort: '',
  };
}

/** 「生成 tag」当前指派的渠道;未指派且仅有 1 条渠道时自动选用,否则返回 null。 */
export function getTagGenChannel(): ApiChannel | null {
  const id = settings.assignments.tagGen;
  if (id) return settings.channels.find(c => c.id === id) ?? null;
  if (settings.channels.length === 1) return settings.channels[0];
  return null;
}

export function getChannelOverride(channelId: string): DirectChannelOverride {
  return settings.channelOverrides[channelId] ?? {};
}

/**
 * 返回当前生效的模块化提示词预设：
 * 若当前使用 ComfyUI 且激活工作流指定了 `promptPresetId`，优先使用工作流绑定的预设；
 * 否则回落到全局 `settings.activePromptPresetId`。
 */
export function activePromptPreset(workflowPresetId?: string): PromptPreset {
  const wfOverride =
    workflowPresetId?.trim()
    || (settings.defaultBackend === 'comfyui' ? activeComfyPreset().promptPresetId?.trim() : '');
  return resolvePromptPreset(wfOverride || settings.activePromptPresetId, settings.promptPresets);
}

/**
 * 当前使用的工作流预设。
 *
 * 不返回 null:workflows 恒非空(comfyDefaults 出生即带一条、normalizeComfyUI 收尾兜底),
 * activeWorkflowId 悬空时也在 normalize 阶段回落过。这里再取一次 [0] 兜底,是为了
 * 「UI 运行中把库改坏」这种时序,让调用方不必到处判空。
 * 刻意只读不写:本函数在 computed 里被调用,写 settings 会引起递归求值。
 */
export function activeComfyPreset(): ComfyWorkflowPreset {
  const list = settings.comfyui.workflows;
  return list.find(w => w.id === settings.comfyui.activeWorkflowId) ?? list[0] ?? newComfyWorkflow();
}

/** 画幅锁选项(顺序即分段按钮顺序);NAI 渠道与 ComfyUI 每套工作流的面板共用这一份。 */
export const ORIENTATION_LOCKS: { value: OrientationLock; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'portrait', label: '竖屏' },
  { value: 'landscape', label: '横屏' },
];

/**
 * 当前出图后端的画幅锁:NAI 取渠道级那一份,ComfyUI 取当前工作流预设那一份;其余后端不锁。
 *
 * 出图(generate.ts)、自动 tag 协议与收尾(autoTag/prompt.ts、runner.ts)、卡片占位与
 * 提示词编辑弹窗都从这里取——判据只此一处,免得「协议说锁竖、出图却按 tag 出横」。
 * 同样刻意只读不写(在 computed 里被调用)。
 */
export function activeOrientationLock(): OrientationLock {
  if (settings.defaultBackend === 'nai') return activeNaiPlan().orientationLock;
  if (settings.defaultBackend === 'comfyui') return activeComfyPreset().orientationLock;
  return 'auto';
}

/**
 * 方案引用的服务器;悬空时回落第一台(normalize 已修过,这里兜「UI 运行中改坏」的时序)。
 * 同样刻意只读不写(在 computed 里被调用)。
 */
export function comfyServerFor(plan: ComfyWorkflowPreset): ComfyServer {
  const list = settings.comfyui.servers;
  return list.find(s => s.id === plan.serverId) ?? list[0] ?? { id: '', name: '', url: '' };
}

/**
 * 方案引用的提示词:用户库 ∪ 内置,且类型必须与方案一致;否则回落同类型内置。
 * 类型校验放在解析处而不只在 normalize:用户运行中切了方案类型,旧引用当场就不算数。
 */
export function comfyPromptSetFor(plan: ComfyWorkflowPreset): ComfyPromptSet {
  const found =
    settings.comfyui.promptSets.find(p => p.id === plan.promptSetId) ??
    BUILTIN_COMFY_PROMPT_SETS.find(p => p.id === plan.promptSetId);
  return found && found.kind === plan.kind ? found : builtinComfyPromptSet(plan.kind);
}

/** 当前方案的服务器 / 提示词。 */
export function activeComfyServer(): ComfyServer {
  return comfyServerFor(activeComfyPreset());
}
export function activeComfyPromptSet(): ComfyPromptSet {
  return comfyPromptSetFor(activeComfyPreset());
}

/**
 * 出图/测试连接用的 conn:当前方案引用的服务器 url + 方案的工作流与横竖尺寸。
 * backends/comfyui.ts 只吃这个形状,不关心库里还有几套。
 */
export function effectiveComfyConn(): ComfyRunConn {
  const preset = activeComfyPreset();
  return {
    url: comfyServerFor(preset).url,
    workflow: preset.workflow,
    mode: preset.mode,
    simple: preset.simple,
    portraitSize: preset.portraitSize,
    landscapeSize: preset.landscapeSize,
  };
}

/**
 * 当前 NAI 方案。不返回 null(同 activeComfyPreset):plans 恒非空、id 悬空也在 normalize
 * 阶段回落过,这里再兜一层是为了「UI 运行中把列表改坏」这种时序,让调用方不必到处判空。
 * 刻意只读不写:本函数在 computed 里被调用,写 settings 会引起递归求值。
 */
export function activeNaiPlan(): NaiPlan {
  const list = settings.nai.plans;
  return list.find(p => p.id === settings.nai.activePlanId) ?? list[0] ?? newNaiPlan();
}

/**
 * 方案引用的画师串;**未选 / 指向已删条目时返回 null(= 不使用)**。
 *
 * 与 naiEndpointFor 的「永不 null」刻意相反:地址不给就出不了图,所以那边一路兜底;
 * 画师串不给只是不加画风,兜底成 [0] 反而会把「不使用」悄悄变成「用库里第一条」,
 * 是画面级的静默改动。查找域 = 用户库 ∪ 内置库(id 前缀不同,实际不可能撞)。
 */
export function naiArtistFor(plan: NaiPlan): NaiArtistPreset | null {
  const id = plan.artistId;
  if (!id) return null;
  return (
    settings.nai.artistPresets.find(a => a.id === id) ??
    BUILTIN_NAI_ARTISTS.find(a => a.id === id) ??
    null
  );
}

/** 方案引用的接入点;悬空时回落第一条(normalize 已修过,这里兜运行中改坏的时序)。 */
export function naiEndpointFor(plan: NaiPlan): NaiEndpoint {
  const list = settings.nai.endpoints;
  return list.find(e => e.id === plan.endpointId) ?? list[0] ?? officialNaiEndpoint();
}

/** 当前方案的画师串 / 接入点。 */
export function activeNaiArtist(): NaiArtistPreset | null {
  return naiArtistFor(activeNaiPlan());
}
export function activeNaiEndpoint(): NaiEndpoint {
  return naiEndpointFor(activeNaiPlan());
}

/**
 * 出图/测试连接/vibe 编码用的 NaiRunConfig:方案参数 + 解开的引用(接入点 url/key、
 * 画师串快照、本方案叠加的 vibe)。缺省取当前方案。
 *
 * **后端层一律吃这个,不吃 settings.nai**(同 effectiveComfyConn 的理由):
 * backends/nai.ts 关心的是「这一次往哪儿发、画什么」,而不是「用户存了几套方案」。
 */
export function effectiveNai(plan: NaiPlan = activeNaiPlan()): NaiRunConfig {
  const ep = naiEndpointFor(plan);
  const picked = new Set(plan.vibeIds);
  return {
    endpointId: ep.id,
    url: ep.url,
    key: ep.key,
    model: plan.model,
    artist: naiArtistFor(plan),
    qualityTags: plan.qualityTags,
    undesiredContent: plan.undesiredContent,
    sampler: plan.sampler,
    steps: plan.steps,
    scale: plan.scale,
    cfgRescale: plan.cfgRescale,
    noiseSchedule: plan.noiseSchedule,
    seed: plan.seed,
    varietyBoost: plan.varietyBoost,
    normalizeRefStrength: plan.normalizeRefStrength,
    vibes: settings.nai.vibes.filter(v => picked.has(v.id)),
    portraitSize: plan.portraitSize,
    landscapeSize: plan.landscapeSize,
  };
}

/**
 * 存量迁移:老配置只有单一 resolution(NAI 默认竖版 832×1216)。
 * 升级后按宽高关系把它归进对应那一格,另一格用默认值——
 * 用户之前特意调过的尺寸不会被默认值悄悄顶掉。
 */
function migrateSize(o: Partial<BackendConn>, def: SizePair, want: 'portrait' | 'landscape'): string {
  const key = want === 'landscape' ? 'landscapeSize' : 'portraitSize';
  const current = o[key];
  if (typeof current === 'string' && current.trim()) return current;
  const legacy = typeof o.resolution === 'string' ? parseSize(o.resolution) : null;
  if (legacy) {
    const legacyIs = legacy.width > legacy.height ? 'landscape' : 'portrait';
    if (legacyIs === want) return o.resolution as string;
  }
  return def[key];
}

function normalizeBackend(raw: unknown, def: BackendConn): BackendConn {
  const o = (raw ?? {}) as Partial<BackendConn>;
  return {
    url: typeof o.url === 'string' ? o.url : def.url,
    qualityTags: typeof o.qualityTags === 'string' ? o.qualityTags : def.qualityTags,
    negativePrompt: typeof o.negativePrompt === 'string' ? o.negativePrompt : def.negativePrompt,
    resolution: typeof o.resolution === 'string' ? o.resolution : def.resolution,
    portraitSize: migrateSize(o, def, 'portrait'),
    landscapeSize: migrateSize(o, def, 'landscape'),
  };
}

/** 单条预设清洗:缺字段/类型不符逐项回退,尺寸空串按默认补(工作流用了 %width% 时要有值可用)。 */
function normalizeWorkflowPreset(raw: unknown, seq: number): ComfyWorkflowPreset {
  const o = (raw ?? {}) as Partial<ComfyWorkflowPreset>;
  const size = (value: unknown, def: string) =>
    typeof value === 'string' && value.trim() ? value : def;
  return {
    id: typeof o.id === 'string' && o.id ? o.id : `wf_${Date.now()}_${seq}`,
    name: typeof o.name === 'string' && o.name ? o.name : DEFAULT_WORKFLOW_NAME,
    // 存量方案没有 kind → 插画(漫画是新增类型);引用的有效性在 normalizeComfyUI 收尾统一修
    kind: o.kind === 'comic' ? 'comic' : 'illustration',
    serverId: typeof o.serverId === 'string' ? o.serverId : '',
    promptSetId: typeof o.promptSetId === 'string' ? o.promptSetId : '',
    // 存量预设没有 mode 字段 → custom(它们都是粘 JSON 的);simple 逐字段清洗出全量默认值
    mode: o.mode === 'simple' ? 'simple' : 'custom',
    workflow: typeof o.workflow === 'string' ? o.workflow : '',
    simple: normalizeSimpleConfig(o.simple),
    naturalLanguage: typeof o.naturalLanguage === 'boolean' ? o.naturalLanguage : false,
    portraitSize: size(o.portraitSize, DEFAULT_PORTRAIT_SIZE),
    landscapeSize: size(o.landscapeSize, DEFAULT_LANDSCAPE_SIZE),
    orientationLock: normalizeOrientationLock(o.orientationLock),
    ...(typeof o.promptPresetId === 'string' && o.promptPresetId.trim()
      ? { promptPresetId: o.promptPresetId.trim() }
      : {}),
  };
}

/**
 * 存量迁移:老配置的 comfyui 是「单套工作流」——workflow / naturalLanguage 两个平铺字段
 * 加渠道级的横竖尺寸。升级后把这四项原样折成库里的第一条预设(与 foldLegacyNegative、
 * migrateSize 同口径:用户特意设过的值绝不被默认值悄悄顶掉)。
 *
 * workflow 为空串也照样建这一条:那正是用户当前面对的空槽位,不是垃圾数据——
 * 何况 workflows 恒非空的不变式要求库里至少有一条。
 */
function foldLegacyWorkflow(o: Partial<ComfyUISettings>, conn: BackendConn): ComfyWorkflowPreset {
  const legacy = o as Partial<{ workflow: unknown; naturalLanguage: unknown }>;
  const preset = newComfyWorkflow();
  return {
    ...preset,
    workflow: typeof legacy.workflow === 'string' ? legacy.workflow : '',
    naturalLanguage: typeof legacy.naturalLanguage === 'boolean' ? legacy.naturalLanguage : false,
    // 渠道级横竖尺寸下沉进预设;normalizeBackend 已做过 resolution→横竖两格的老迁移
    portraitSize: conn.portraitSize.trim() || preset.portraitSize,
    landscapeSize: conn.landscapeSize.trim() || preset.landscapeSize,
  };
}

function normalizeServer(raw: unknown, seq: number): ComfyServer {
  const o = (raw ?? {}) as Partial<ComfyServer>;
  return {
    id: typeof o.id === 'string' && o.id ? o.id : `srv_${Date.now()}_${seq}`,
    name: typeof o.name === 'string' ? o.name : '',
    url: typeof o.url === 'string' ? o.url : '',
  };
}

function normalizePromptSet(raw: unknown, seq: number): ComfyPromptSet {
  const o = (raw ?? {}) as Partial<ComfyPromptSet>;
  // 占了内置 id 的条目换个 id:否则解析时用户库先命中,内置那份就被它顶掉了
  const validId = typeof o.id === 'string' && o.id && !isBuiltinComfyPromptSet(o.id);
  return {
    id: validId ? (o.id as string) : `ps_${Date.now()}_${seq}`,
    name: typeof o.name === 'string' ? o.name : '',
    kind: o.kind === 'comic' ? 'comic' : 'illustration',
    spec: typeof o.spec === 'string' ? o.spec : '',
    thinking: typeof o.thinking === 'string' ? o.thinking : '',
  };
}

/**
 * 存量迁移:ComfyUI 规范/思维链原是设置页里的全局两格(autoTag.prompts.comfySpec/comfyThinking)。
 * 改过任一格 → 折成一套「我的插画提示词」并让全部方案引用它;没改过的那一格留空串
 * (= 回落内置、随版本更新,与面板保存口径一致;编辑弹窗打开时展开成内置全文,所见即生效)。
 * 两格都没改过 → 不建,方案直接引用内置——用户继续享受内置文本随版本更新。
 */
function foldLegacyPromptSets(legacy: { spec: unknown; thinking: unknown }): ComfyPromptSet[] {
  const spec = typeof legacy.spec === 'string' ? legacy.spec : '';
  const thinking = typeof legacy.thinking === 'string' ? legacy.thinking : '';
  if (!spec.trim() && !thinking.trim()) return [];
  const set = newComfyPromptSet('illustration', '我的插画提示词');
  return [{ ...set, spec: spec.trim() ? spec : '', thinking: thinking.trim() ? thinking : '' }];
}

function normalizeComfyUI(
  raw: unknown,
  def: ComfyUISettings,
  legacyPrompts: { spec: unknown; thinking: unknown } = { spec: '', thinking: '' },
): ComfyUISettings {
  const conn = normalizeBackend(raw, def);
  const o = (raw ?? {}) as Partial<ComfyUISettings>;

  // 服务器库:老配置只有渠道级 url → 折成第一台。不变式兜底:脏数据清空了也补一台
  const servers = Array.isArray(o.servers) ? o.servers.map(normalizeServer) : [];
  if (!servers.length) servers.push(newComfyServer(DEFAULT_SERVER_NAME, conn.url.trim() || DEFAULT_COMFY_URL));

  // 提示词库:字段缺失 = 还没迁移过(空数组是合法状态,不能当缺失再迁一次)
  const migratingPrompts = !Array.isArray(o.promptSets);
  const promptSets = migratingPrompts
    ? foldLegacyPromptSets(legacyPrompts)
    : (o.promptSets as unknown[]).map(normalizePromptSet);
  const legacySet = migratingPrompts ? promptSets[0] : undefined;

  const workflows = Array.isArray(o.workflows)
    ? o.workflows.map(normalizeWorkflowPreset)
    : [foldLegacyWorkflow(o, conn)];
  // 不变式兜底:脏数据把库清空了也要留一条,否则面板与出图门槛全得处理 undefined
  if (!workflows.length) workflows.push(newComfyWorkflow());

  // 引用修复:悬空的服务器回落第一台;提示词悬空或类型不符回落同类型内置
  for (const plan of workflows) {
    if (!servers.some(s => s.id === plan.serverId)) plan.serverId = servers[0].id;
    if (legacySet) plan.promptSetId = legacySet.id;
    const ref =
      promptSets.find(p => p.id === plan.promptSetId) ??
      BUILTIN_COMFY_PROMPT_SETS.find(p => p.id === plan.promptSetId);
    if (!ref || ref.kind !== plan.kind) plan.promptSetId = builtinComfyPromptSet(plan.kind).id;
  }

  // 指向已删条目(或压根没存)时回落第一条:悬空 id 会让面板显示空白、出图取不到工作流
  const activeWorkflowId =
    typeof o.activeWorkflowId === 'string' && workflows.some(w => w.id === o.activeWorkflowId)
      ? o.activeWorkflowId
      : workflows[0].id;

  return { ...conn, servers, promptSets, workflows, activeWorkflowId };
}

const NAI_MODEL_VALUES = new Set<string>(NAI_MODELS.map(m => m.value));

function clampNumber(value: unknown, def: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : def;
}

function normalizeVibeEncodings(raw: unknown): NaiVibeEncodings {
  const encodings: NaiVibeEncodings = {};
  if (!raw || typeof raw !== 'object') return encodings;
  for (const [key, value] of Object.entries(raw)) {
    const v = value as Partial<{ encoding: unknown; infoExtracted: unknown }> | null;
    if (v && typeof v.encoding === 'string' && v.encoding) {
      encodings[key] = {
        encoding: v.encoding,
        infoExtracted: clampNumber(v.infoExtracted, 1, 0, 1),
      };
    }
  }
  return encodings;
}

function readLegacyVibeData(raw: unknown): NaiVibeData | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Partial<NaiVibe & NaiVibeData>;
  if (typeof o.dataPath === 'string' && o.dataPath) return null;
  const data = {
    image: typeof o.image === 'string' ? o.image : '',
    thumbnail: typeof o.thumbnail === 'string' ? o.thumbnail : '',
    encodings: normalizeVibeEncodings(o.encodings),
  };
  return data.image || data.thumbnail || Object.keys(data.encodings).length ? data : null;
}

function normalizeVibe(raw: unknown, seq: number): NaiVibe | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Partial<NaiVibe & NaiVibeData>;
  const encodings = normalizeVibeEncodings(o.encodings);
  const id = typeof o.id === 'string' && o.id ? o.id : `vibe_${Date.now()}_${seq}`;
  const image = typeof o.image === 'string' ? o.image : '';
  const modelKeys = Array.isArray(o.modelKeys)
    ? o.modelKeys.filter((key): key is string => typeof key === 'string' && !!key)
    : Object.keys(encodings);
  return {
    id,
    name: typeof o.name === 'string' && o.name ? o.name : 'Vibe',
    dataPath: typeof o.dataPath === 'string' ? o.dataPath : '',
    thumbnailPath: typeof o.thumbnailPath === 'string' ? o.thumbnailPath : '',
    modelKeys,
    hasImage: typeof o.hasImage === 'boolean' ? o.hasImage : !!image,
    fingerprint:
      typeof o.fingerprint === 'string' && o.fingerprint ? o.fingerprint : vibeFingerprint(encodings),
    strength: clampVibeStrength(o.strength),
    group: typeof o.group === 'string' ? o.group.trim() : '',
  };
}

async function migrateLegacyVibesInPlace(
  stored: unknown,
): Promise<{ migrated: number; error: unknown }> {
  const root = stored as { nai?: { vibes?: unknown } };
  const vibes = root?.nai?.vibes;
  if (!Array.isArray(vibes)) return { migrated: 0, error: null };
  const total = vibes.reduce((count, vibe) => count + (readLegacyVibeData(vibe) ? 1 : 0), 0);
  if (!total) return { migrated: 0, error: null };

  toastr.info(`检测到 ${total} 个旧版 Vibe，正在自动搬迁大文件…`, '柏宝绘');
  let migrated = 0;
  let firstError: unknown = null;
  for (let index = 0; index < vibes.length; index++) {
    const raw = vibes[index];
    const data = readLegacyVibeData(raw);
    if (!data) continue;
    const normalized = normalizeVibe(raw, index);
    if (!normalized) continue;
    try {
      const paths = await saveVibeFiles(data, null, normalized.id);
      const meta = vibeMetaFromData(
        normalized.id,
        normalized.name,
        paths.dataPath,
        paths.thumbnailPath,
        data,
        normalized.strength,
        normalized.group,
      );
      // 原样带上老 enabled 键:本函数跑在 normalizeNai 之前,方案化迁移还要靠它
      // 折出默认方案的 vibeIds;丢了它,升级后用户启用的 vibe 会全部静默失效。
      const legacyEnabled = (raw as { enabled?: unknown }).enabled;
      vibes[index] = legacyEnabled === undefined ? meta : { ...meta, enabled: legacyEnabled };
      migrated++;
      console.info(`[柏宝绘] 旧版 Vibe 自动搬迁 ${migrated}/${total}`);
    } catch (error) {
      firstError ??= error;
      console.error(`[柏宝绘] Vibe「${normalized.name}」自动搬迁失败`, error);
    }
  }
  if (firstError) {
    toastr.error('部分旧版 Vibe 搬迁失败，原数据已保留；刷新后会自动重试。', '柏宝绘');
    return { migrated, error: firstError };
  }
  toastr.success(`已自动修复 ${migrated} 个旧版 Vibe，后续加载将恢复正常。`, '柏宝绘');
  return { migrated, error: null };
}

/**
 * 存进 settings.json 的 NAI 原始对象可能长的样子:当前形状 ∪ 方案化之前的渠道级平铺字段。
 * 平铺字段只在 normalizeNai 里读一次(折成第一套方案),之后不再写回。
 */
type LegacyNaiRaw = Partial<
  NaiSettings &
    Omit<NaiPlan, 'id' | 'name'> &
    BackendConn & {
      key: string;
      activeArtistId: string;
      activeEndpointId: string;
      /** 老的全局同时出图数;现挂在各接入点上(见 migrateNaiEndpoints)。 */
      concurrency: number;
    }
>;

/**
 * 存量迁移:早先负面词分「附加负面(negativePrompt)」+ 官方基线两段拼,现在合成
 * undesiredContent 一个框。老配置里的附加负面若不搬,升级后会静默失效(用户排除的
 * 内容悄悄回来了),故按当年的拼接顺序折进去:附加在前 + 该模型官方词在后。
 */
function foldLegacyNegative(o: LegacyNaiRaw, model: NaiModel): string {
  if (typeof o.undesiredContent === 'string') return o.undesiredContent;
  const legacy = typeof o.negativePrompt === 'string' ? o.negativePrompt.trim() : '';
  if (!legacy) return '';
  return [legacy, naiDefaultUndesired(model)].filter(Boolean).join(', ');
}

/** 单条配方清洗:缺字段/类型不符逐项回退;prompt 允许空串(空槽位不是垃圾数据)。 */
function normalizeArtistPreset(raw: unknown, seq: number): NaiArtistPreset {
  const o = (raw ?? {}) as Partial<NaiArtistPreset>;
  return {
    id: typeof o.id === 'string' && o.id ? o.id : `art_${Date.now()}_${seq}`,
    name: typeof o.name === 'string' && o.name ? o.name : `画师串 ${seq + 1}`,
    prompt: typeof o.prompt === 'string' ? o.prompt : '',
    // 存量条目没有这两个键:补空串 = 跟随渠道级,升级后提示词输出零变化
    quality: typeof o.quality === 'string' ? o.quality : '',
    negative: typeof o.negative === 'string' ? o.negative : '',
    // 可选键:非字符串/空串一律视为无预览(不落 undefined 以外的脏数据)
    previewPath:
      typeof o.previewPath === 'string' && o.previewPath ? o.previewPath : undefined,
  };
}

/**
 * 单条接入点清洗。官方条的 name/url 一律纠回内置值:UI 已禁掉改名与改址,
 * 还能出现别的值只有手改 settings.json 一途;纠回去也顺带让内置名随插件版本更新。
 * key 例外 —— 那是用户自己的密钥,内置的只是地址与名字;并发同理,是用户按自己额度调的。
 * 并发缺失(老条目)时取 fallback —— 即老的全局同时出图数,升级后限流零变化。
 */
function normalizeNaiEndpoint(raw: unknown, seq: number, fallbackConcurrency: number): NaiEndpoint {
  const o = (raw ?? {}) as Partial<NaiEndpoint>;
  const id = typeof o.id === 'string' && o.id ? o.id : `nep_${Date.now()}_${seq}`;
  const concurrency = normalizeNaiConcurrency(o.concurrency, fallbackConcurrency);
  if (isOfficialNaiEndpoint(id)) {
    return officialNaiEndpoint(typeof o.key === 'string' ? o.key : '', concurrency);
  }
  return {
    id,
    name: typeof o.name === 'string' && o.name ? o.name : `接入点 ${seq + 1}`,
    url: typeof o.url === 'string' ? o.url : '',
    key: typeof o.key === 'string' ? o.key : '',
    concurrency,
  };
}

function normalizeNaiConcurrency(value: unknown, def: number): number {
  return Math.round(clampNumber(value, def, 1, NAI_CONCURRENCY_MAX));
}

/**
 * 接入点列表的存量迁移与不变式兜底。
 *
 * 老配置只有渠道级 url/key 一对:收成第一条(名字按它指向官方还是第三方分别取),
 * 并保证内置官方那条一定在列——用户当初填的若是第三方站,官方条补在**其后**,
 * 免得静默把当前使用的那条挤到第二位、还顺手换了出图出口。
 *
 * 老的全局同时出图数分给当时已有的每一条(老闸门对它们一视同仁);事后补进来的官方条
 * 从没用过那个数,按出厂值 1 起步。
 */
function migrateNaiEndpoints(o: LegacyNaiRaw): NaiEndpoint[] {
  const legacyConcurrency = normalizeNaiConcurrency(o.concurrency, NAI_CONCURRENCY_DEFAULT);
  const list = Array.isArray(o.endpoints)
    ? o.endpoints.map((raw, i) => normalizeNaiEndpoint(raw, i, legacyConcurrency))
    : [];

  if (!list.length) {
    // 存量:渠道级 url/key 收成第一条。url 恰是官方地址(绝大多数人)时直接并入官方条,
    // 不另起一条,否则列表一上来就是两条内容相同的。
    const url = typeof o.url === 'string' ? o.url.trim() : '';
    const key = typeof o.key === 'string' ? o.key : '';
    if (!url || url.replace(/\/+$/, '') === NAI_OFFICIAL_URL) return [officialNaiEndpoint(key, legacyConcurrency)];
    return [
      { id: `nep_legacy`, name: '我的接入点', url, key, concurrency: legacyConcurrency },
      officialNaiEndpoint(),
    ];
  }

  // 官方条被删掉了(手改 settings.json,或以后版本回滚往返):补回去,但不抢当前那条的位置
  if (!list.some(e => isOfficialNaiEndpoint(e.id))) list.push(officialNaiEndpoint());
  return list;
}

/** 模型白名单清洗;已下线模型回落默认并留一条控制台告警。 */
function normalizeNaiModel(value: unknown, def: NaiModel): NaiModel {
  const stored = typeof value === 'string' ? value : '';
  const model = NAI_MODEL_VALUES.has(stored) ? (stored as NaiModel) : def;
  // 已下线模型(4.5 以下)静默回落会换掉画风与 vibe 编码 key。不弹窗(该人群已基本不存在),
  // 但留一条控制台告警 —— 否则「我的模型自己变了」这类反馈完全无据可查。
  if (stored && stored !== model) {
    console.warn(`[柏宝绘] NAI 模型「${stored}」已下线,本次回落为 ${model}`);
  }
  return model;
}

/**
 * 单套方案的逐字段清洗。引用(接入点 / 画师串 / vibe)只做类型清洗,
 * 有效性在 normalizeNai 收尾统一修——那里才看得到三个库。
 * 老渠道级平铺对象也走这里(字段同名),迁移只需先把 activeXxxId 换成方案的键名。
 */
function normalizeNaiPlanFields(o: LegacyNaiRaw, base: NaiPlan): NaiPlan {
  const model = normalizeNaiModel(o.model, base.model);
  return {
    ...base,
    endpointId: typeof o.endpointId === 'string' ? o.endpointId : '',
    model,
    artistId: typeof o.artistId === 'string' ? o.artistId : '',
    // 空串是有意义的存储值(= 跟随模型官方词),故不能用 `&& o.x` 那种把 '' 吞掉的守卫
    qualityTags: typeof o.qualityTags === 'string' ? o.qualityTags : '',
    // 「附加负面」已并入 undesiredContent 一个框,存量值折进去(见 foldLegacyNegative)
    undesiredContent: foldLegacyNegative(o, model),
    sampler: typeof o.sampler === 'string' && o.sampler ? o.sampler : base.sampler,
    steps: Math.round(clampNumber(o.steps, base.steps, 1, 50)),
    scale: clampNumber(o.scale, base.scale, 0, 35),
    cfgRescale: clampNumber(o.cfgRescale, base.cfgRescale, 0, 1),
    noiseSchedule:
      typeof o.noiseSchedule === 'string' && o.noiseSchedule ? o.noiseSchedule : base.noiseSchedule,
    seed: Math.round(clampNumber(o.seed, base.seed, 0, 4294967295)),
    varietyBoost: typeof o.varietyBoost === 'boolean' ? o.varietyBoost : base.varietyBoost,
    normalizeRefStrength:
      typeof o.normalizeRefStrength === 'boolean' ? o.normalizeRefStrength : base.normalizeRefStrength,
    vibeIds: Array.isArray(o.vibeIds)
      ? Array.from(new Set(o.vibeIds.filter((id): id is string => typeof id === 'string' && !!id)))
      : [],
    // 老配置缺这两个字段:回落默认 = 开着自然语言、不锁方向,即改动前的行为
    naturalLanguage: typeof o.naturalLanguage === 'boolean' ? o.naturalLanguage : base.naturalLanguage,
    orientationLock: normalizeOrientationLock(o.orientationLock),
    // 老 resolution 单格 → 横竖两格的迁移也在这里(见 migrateSize)
    portraitSize: migrateSize(o, base, 'portrait'),
    landscapeSize: migrateSize(o, base, 'landscape'),
  };
}

function normalizeNaiPlan(raw: unknown, seq: number): NaiPlan {
  const o = (raw ?? {}) as LegacyNaiRaw & Partial<Pick<NaiPlan, 'id' | 'name'>>;
  const base = newNaiPlan();
  return normalizeNaiPlanFields(o, {
    ...base,
    id: typeof o.id === 'string' && o.id ? o.id : base.id,
    name: typeof o.name === 'string' && o.name ? o.name : `方案 ${seq + 1}`,
  });
}

/**
 * 存量迁移:方案化之前 NAI 只有一套渠道级平铺设置,原样折成「默认方案」以保留数据:
 *
 * - 接入点 / 画师串:老的 activeEndpointId / activeArtistId 直接成为方案的引用;
 * - 正/负面词:把老规则当时生效的一份抄进方案兼容字段,同时保留画师串库里的绑定词。
 *   实际出图只读「画师串 → 官方」,这些方案旧字段不再参与;
 * - vibe:老数据每张各有 enabled,启用的那几张成为方案的 vibeIds。
 */
function foldLegacyNaiPlan(
  o: LegacyNaiRaw,
  artistPresets: NaiArtistPreset[],
  enabledVibeIds: string[],
): NaiPlan {
  const plan = normalizeNaiPlanFields(
    { ...o, endpointId: o.activeEndpointId, artistId: o.activeArtistId, vibeIds: enabledVibeIds },
    newNaiPlan(),
  );
  // 内置画师串没有绑定词,只查用户库即可
  const artist = artistPresets.find(a => a.id === plan.artistId);
  return {
    ...plan,
    qualityTags: artist?.quality.trim() || plan.qualityTags,
    undesiredContent: artist?.negative.trim() || plan.undesiredContent,
  };
}

function normalizeNai(raw: unknown, def: NaiSettings): NaiSettings {
  const o = (raw ?? {}) as LegacyNaiRaw;

  // 画师串库:允许为空,故没有「恒非空」兜底(与方案库、接入点刻意不同)
  const artistPresets = Array.isArray(o.artistPresets)
    ? o.artistPresets.map(normalizeArtistPreset)
    : def.artistPresets;
  // 接入点:存量 url/key 收成第一条;恒非空且必含官方条(见 migrateNaiEndpoints)
  const endpoints = migrateNaiEndpoints(o);

  // vibe 清洗时顺手记下老数据的 enabled(只有方案化迁移用得上)
  const rawVibes: unknown[] = Array.isArray(o.vibes) ? o.vibes : [];
  const vibes: NaiVibe[] = [];
  const enabledVibeIds: string[] = [];
  rawVibes.forEach((rawVibe, i) => {
    const vibe = normalizeVibe(rawVibe, i);
    if (!vibe) return;
    vibes.push(vibe);
    if ((rawVibe as { enabled?: unknown }).enabled === true) enabledVibeIds.push(vibe.id);
  });

  // 方案库:字段缺失 = 还没迁移过(空数组是脏数据,走下面的恒非空兜底,不重迁)
  const migrating = !Array.isArray(o.plans);
  const plans = migrating
    ? [foldLegacyNaiPlan(o, artistPresets, enabledVibeIds)]
    : (o.plans as unknown[]).map(normalizeNaiPlan);
  if (!plans.length) plans.push(newNaiPlan());

  // 引用修复。接入点悬空回落第一条——地址是必需品,清空就出不了图了;
  // 画师串悬空则清成空串(= 不使用):回落会给用户静默换一套画风,而下拉显示的
  // 也正是那一条(看起来就是自己设的),几乎无法排查。
  const vibeIdSet = new Set(vibes.map(v => v.id));
  for (const plan of plans) {
    if (!endpoints.some(e => e.id === plan.endpointId)) plan.endpointId = endpoints[0].id;
    if (
      plan.artistId &&
      !artistPresets.some(a => a.id === plan.artistId) &&
      !isBuiltinNaiArtist(plan.artistId)
    ) {
      plan.artistId = '';
    }
    plan.vibeIds = plan.vibeIds.filter(id => vibeIdSet.has(id));
  }

  const activePlanId =
    !migrating && typeof o.activePlanId === 'string' && plans.some(p => p.id === o.activePlanId)
      ? o.activePlanId
      : plans[0].id;

  return {
    endpoints,
    artistPresets,
    vibes,
    plans,
    activePlanId,
  };
}

/**
 * 把用户输入规整成可安全拼进正则的标签名(与柏宝书 settings.ts 的 sanitizeTagName 同口径)。
 * 用黑名单(而非白名单)剔除会破坏标签语法/正则的危险字符:尖括号、斜杠、空白、正则元字符;
 * 中文及其它 unicode 字母一律保留(用户可能写 <雪><状态栏> 这类中文标签)。
 */
export function sanitizeTagName(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/^<\/?/, '') // 开头的 < 或 </
    .replace(/>$/, '') // 结尾的 >
    .trim()
    .replace(/[<>/\\\s.*+?^${}()|[\]]/g, ''); // 剔除尖括号/斜杠/空白/正则元字符,中文等保留
}

/** 排除名单清洗(与柏宝书 normalize 同口径):去空、去重、标签名消毒;缺字段/类型不符回退空数组。 */
function normalizeExcludes(raw: unknown): ExcludesSettings {
  const d = excludesDefaults();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<ExcludesSettings>;
  return {
    excludedChars: Array.isArray(r.excludedChars)
      ? r.excludedChars.filter((x): x is string => typeof x === 'string')
      : d.excludedChars,
    excludedWorldNames: Array.isArray(r.excludedWorldNames)
      ? r.excludedWorldNames.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      : d.excludedWorldNames,
    excludedWorldInfoPatterns: Array.isArray(r.excludedWorldInfoPatterns)
      ? r.excludedWorldInfoPatterns.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      : d.excludedWorldInfoPatterns,
    customStripTags: Array.isArray(r.customStripTags)
      ? Array.from(
        new Set(
          r.customStripTags
            .filter((x): x is string => typeof x === 'string')
            .map(sanitizeTagName)
            .filter(Boolean),
        ),
      )
      : d.customStripTags,
  };
}

function normalizeChannelOverrides(raw: unknown): Record<string, DirectChannelOverride> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, DirectChannelOverride> = {};
  for (const [id, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || !val || typeof val !== 'object' || Array.isArray(val)) continue;
    const v = val as Partial<DirectChannelOverride>;
    out[id] = {
      enableTemperature: typeof v.enableTemperature === 'boolean' ? v.enableTemperature : true,
      enableTopP: typeof v.enableTopP === 'boolean' ? v.enableTopP : false,
      topP: typeof v.topP === 'number' && Number.isFinite(v.topP) ? Math.min(2, Math.max(0, v.topP)) : 1.0,
      enableMaxTokens: typeof v.enableMaxTokens === 'boolean' ? v.enableMaxTokens : true,
      customHeaders: typeof v.customHeaders === 'string' ? v.customHeaders : '',
      customBodyParams: typeof v.customBodyParams === 'string' ? v.customBodyParams : '',
    };
  }
  return out;
}

/** 把任意来源的原始对象并入默认值,容错缺字段/类型不符。 */
function normalizePromptPresets(raw: unknown): PromptPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: PromptPreset[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!item || typeof item !== 'object') continue;
    const o = item as Partial<PromptPreset>;
    if (typeof o.id !== 'string' || !o.id.trim() || !Array.isArray(o.entries)) continue;
    out.push({
      id: o.id.trim(),
      name: typeof o.name === 'string' && o.name.trim() ? o.name.trim() : `自定义预设 ${i + 1}`,
      builtin: false,
      scope:
        o.scope === 'nai' || o.scope === 'comfy-illust' || o.scope === 'comfy-comic'
          ? o.scope
          : 'universal',
      outputMode:
        o.outputMode === 'tool_tunnel' || o.outputMode === 'tool_structured'
          ? o.outputMode
          : 'text_json',
      mergeAdjacentSameRole: o.mergeAdjacentSameRole !== false,
      mergeSystemIntoUser: Boolean(o.mergeSystemIntoUser),
      toolCall: o.toolCall && typeof o.toolCall === 'object'
        ? (JSON.parse(JSON.stringify(o.toolCall)) as PromptPreset['toolCall'])
        : resolvePromptPreset('builtin_tool_tunnel', []).toolCall,
      entries: JSON.parse(JSON.stringify(o.entries)) as PromptPreset['entries'],
    });
  }
  return out;
}

function normalizeWorldInfoSelection(raw: unknown): WorldInfoSelectionSettings {
  const o = (raw ?? {}) as Partial<WorldInfoSelectionSettings>;
  const mode = o.mode === 'whitelist' ? 'whitelist' : 'auto';
  const selectedByBook: Record<string, string[]> = {};
  if (o.selectedByBook && typeof o.selectedByBook === 'object') {
    for (const [book, keys] of Object.entries(o.selectedByBook)) {
      if (Array.isArray(keys)) {
        selectedByBook[book] = keys.filter((k): k is string => typeof k === 'string' && k.length > 0);
      }
    }
  }
  return { mode, selectedByBook };
}

function normalizeCleanRegexRules(raw: unknown): CleanRegexRule[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is Record<string, unknown> => Boolean(x && typeof x === 'object'))
    .map((o, idx) => ({
      id: typeof o.id === 'string' && o.id ? o.id : `rx_${idx}`,
      name: typeof o.name === 'string' && o.name ? o.name : `规则 ${idx + 1}`,
      enabled: o.enabled !== false,
      pattern: typeof o.pattern === 'string' ? o.pattern : '',
      flags: typeof o.flags === 'string' ? o.flags : 'gm',
      replacement: typeof o.replacement === 'string' ? o.replacement : '',
      scope: o.scope === 'history' || o.scope === 'both' ? o.scope : 'target',
    }));
}

function normalizeWordReplace(raw: unknown): WordReplaceSettings {
  const o = (raw ?? {}) as Partial<WordReplaceSettings>;
  return {
    enabled: Boolean(o.enabled),
    rawRules: typeof o.rawRules === 'string' ? o.rawRules : '',
  };
}

function normalize(raw: unknown): ImageSettings {
  if (!raw || typeof raw !== 'object') return defaults();
  const d = defaults();
  const r = raw as Partial<ImageSettings>;
  const merged: ImageSettings = { ...d, ...r };
  // ui 是嵌套对象,展开合并不会补全缺字段,逐字段兜底
  const ru = (r.ui ?? {}) as Partial<UiPrefs>;
  merged.ui = {
    theme: typeof ru.theme === 'string' ? ru.theme : d.ui.theme,
    navPosition: typeof ru.navPosition === 'string' ? ru.navPosition : d.ui.navPosition,
    navTapClose: typeof ru.navTapClose === 'boolean' ? ru.navTapClose : d.ui.navTapClose,
    showTopBar: typeof ru.showTopBar === 'boolean' ? ru.showTopBar : d.ui.showTopBar,
    showOrb: typeof ru.showOrb === 'boolean' ? ru.showOrb : d.ui.showOrb,
    orbImage: typeof ru.orbImage === 'string' ? ru.orbImage : d.ui.orbImage,
    orbShape: typeof ru.orbShape === 'string' ? ru.orbShape : d.ui.orbShape,
    // 透明度:钳到 20–100,缺失/非法回退默认(太低会看不见,设 20 下限)
    orbOpacity:
      typeof ru.orbOpacity === 'number' && Number.isFinite(ru.orbOpacity)
        ? Math.min(100, Math.max(20, Math.round(ru.orbOpacity)))
        : d.ui.orbOpacity,
    // 尺寸:钳到 32–80,缺失/非法回退默认
    orbSize:
      typeof ru.orbSize === 'number' && Number.isFinite(ru.orbSize)
        ? Math.min(80, Math.max(32, Math.round(ru.orbSize)))
        : d.ui.orbSize,
    cardTheme: typeof ru.cardTheme === 'string' ? ru.cardTheme : d.ui.cardTheme,
    autoCollapseImages:
      typeof ru.autoCollapseImages === 'boolean' ? ru.autoCollapseImages : d.ui.autoCollapseImages,
    // 老配置缺字段 → 默认档(中)。不为「保持铺满」做迁移:铺满正是要修的问题,想要回去下拉里选
    imageDisplaySize: IMAGE_DISPLAY_SIZES.some(option => option.value === ru.imageDisplaySize)
      ? (ru.imageDisplaySize as ImageDisplaySize)
      : d.ui.imageDisplaySize,
    immersiveImages: typeof ru.immersiveImages === 'boolean' ? ru.immersiveImages : d.ui.immersiveImages,
    enableBeautifyPenetration:
      typeof ru.enableBeautifyPenetration === 'boolean'
        ? ru.enableBeautifyPenetration
        : d.ui.enableBeautifyPenetration,
  };
  merged.defaultBackend =
    merged.defaultBackend === 'comfyui' || merged.defaultBackend === 'nai'
      ? merged.defaultBackend
      : d.defaultBackend;
  merged.comfyui = normalizeComfyUI(r.comfyui, d.comfyui, (() => {
    // 迁移来源:设置页旧的全局 ComfyUI 规范/思维链(更老的版本只有单份 thinking,同 prompts 段的口径)
    const rp = ((r.autoTag ?? {}) as Partial<AutoTagSettings>).prompts as
      | (Partial<AutoTagPrompts> & { thinking?: unknown })
      | undefined;
    return { spec: rp?.comfySpec, thinking: typeof rp?.comfyThinking === 'string' ? rp.comfyThinking : rp?.thinking };
  })());
  merged.nai = normalizeNai(r.nai, d.nai);
  // 副 API 渠道:逐个补全字段并校验类型
  merged.channels = (Array.isArray(r.channels) ? r.channels : []).map(normalizeChannel);
  merged.channelOverrides = normalizeChannelOverrides(r.channelOverrides);
  // 任务指派:嵌套对象,逐字段兜底。
  const ra = (r.assignments ?? {}) as Partial<{ tagGen: string }>;
  merged.assignments = {
    tagGen: typeof ra.tagGen === 'string' ? ra.tagGen : '',
  };
  const rt = (r.autoTag ?? {}) as Partial<AutoTagSettings>;
  // 存量配置只有 maxImages:缺少 minImages 时回落 0,完整保留「没好画面可以不出图」的旧行为。
  // 先归一化上限,再把下限夹进 [0,上限],保证所有后续调用都能直接依赖范围不变式。
  const maxImages =
    typeof rt.maxImages === 'number' && Number.isFinite(rt.maxImages)
      ? Math.max(1, Math.floor(rt.maxImages))
      : d.autoTag.maxImages;
  const minImages =
    typeof rt.minImages === 'number' && Number.isFinite(rt.minImages)
      ? Math.min(maxImages, Math.max(0, Math.floor(rt.minImages)))
      : d.autoTag.minImages;
  merged.autoTag = {
    enabled: typeof rt.enabled === 'boolean' ? rt.enabled : d.autoTag.enabled,
    contextMessages:
      typeof rt.contextMessages === 'number' && Number.isFinite(rt.contextMessages)
        ? Math.max(1, Math.floor(rt.contextMessages))
        : d.autoTag.contextMessages,
    minImages,
    maxImages,
    retryCount:
      typeof rt.retryCount === 'number' && Number.isFinite(rt.retryCount)
        ? Math.min(5, Math.max(0, Math.floor(rt.retryCount)))
        : d.autoTag.retryCount,
    autoGenerate:
      typeof rt.autoGenerate === 'boolean' ? rt.autoGenerate : d.autoTag.autoGenerate,
    // 可编辑提示词集:逐字段兜底;旧版 jailbreakPrompt 字段迁移进 prompts.jailbreak
    prompts: (() => {
      const rp = (rt.prompts ?? {}) as Partial<AutoTagPrompts>;
      // 旧字段不在类型里,从原始对象读取(老版本设置才带)
      const legacy = rt as Partial<AutoTagSettings> & { jailbreakPrompt?: unknown };
      const legacyJailbreak = typeof legacy.jailbreakPrompt === 'string' ? legacy.jailbreakPrompt : '';
      // 旧版单份 thinking 拆成三份(comfy/nai/naiV5)。老内容一律是照 ComfyUI 形态写的
      // (单串 tag + 邻接绑定),只迁进同形态的 comfy 与 nai 两格;V5 留空回落新默认——
      // 把 ComfyUI 口径灌进 V5 等于把「思维链教它做规范禁止的事」这个 bug 固化下来。
      const legacyPrompts = rp as Partial<AutoTagPrompts> & { thinking?: unknown };
      const legacyThinking =
        typeof legacyPrompts.thinking === 'string' ? legacyPrompts.thinking : '';
      return {
        jailbreak: typeof rp.jailbreak === 'string' ? rp.jailbreak : legacyJailbreak,
        naiSpec: typeof rp.naiSpec === 'string' ? rp.naiSpec : '',
        naiV5Spec: typeof rp.naiV5Spec === 'string' ? rp.naiV5Spec : '',
        comfySpec: typeof rp.comfySpec === 'string' ? rp.comfySpec : '',
        comfyThinking: typeof rp.comfyThinking === 'string' ? rp.comfyThinking : legacyThinking,
        naiThinking: typeof rp.naiThinking === 'string' ? rp.naiThinking : legacyThinking,
        naiV5Thinking: typeof rp.naiV5Thinking === 'string' ? rp.naiV5Thinking : '',
      };
    })(),
  };
  merged.activePromptPresetId =
    typeof r.activePromptPresetId === 'string' && r.activePromptPresetId.trim()
      ? r.activePromptPresetId.trim()
      : d.activePromptPresetId;
  merged.promptPresets = normalizePromptPresets(r.promptPresets);
  merged.worldInfoSelection = normalizeWorldInfoSelection(r.worldInfoSelection);
  merged.cleanRegexRules = normalizeCleanRegexRules(r.cleanRegexRules);
  merged.wordReplace = normalizeWordReplace(r.wordReplace);
  merged.excludes = normalizeExcludes(r.excludes);
  // 存储行为:嵌套对象逐字段兜底(老数据无 storage 键 → 默认关)
  const rs = (r.storage ?? {}) as Partial<StoragePrefs>;
  merged.storage = {
    saveAsJpeg: typeof rs.saveAsJpeg === 'boolean' ? rs.saveAsJpeg : d.storage.saveAsJpeg,
  };
  return merged;
}

// import 阶段 ST 往往尚未就绪,先以默认值建 reactive;真实值由 hydrateSettings 灌入。
export const settings = reactive<ImageSettings>(defaults());

// 守门标志:hydrate 完成前不回写,避免「默认值」覆盖服务器上已存的设置。
let ready = false;

// hydrate 完成后要通知的订阅者(如 ui.ts:settings 就绪后才能拿到同步过来的主题/导航位置)。
// 若订阅时已就绪则立刻回调,避免错过时序。
const readyCbs: Array<() => void> = [];
export function onSettingsReady(cb: () => void): void {
  if (ready) cb();
  else readyCbs.push(cb);
}

function applyInto(target: ImageSettings, src: ImageSettings): void {
  target.enabled = src.enabled;
  target.ui = src.ui;
  target.defaultBackend = src.defaultBackend;
  target.comfyui = src.comfyui;
  target.nai = src.nai;
  target.channels = src.channels;
  target.channelOverrides = src.channelOverrides;
  target.assignments = src.assignments;
  target.autoTag = src.autoTag;
  target.activePromptPresetId = src.activePromptPresetId;
  target.promptPresets = src.promptPresets;
  target.worldInfoSelection = src.worldInfoSelection;
  target.cleanRegexRules = src.cleanRegexRules;
  target.wordReplace = src.wordReplace;
  target.excludes = src.excludes;
  target.storage = src.storage;
}

/* —— 渠道共享存储:与柏宝书等「柏宝」插件共用同一份渠道列表 ——
   真身存在 extensionSettings[SHARED_CHANNELS_KEY](带 revision),各插件的设置里只留镜像。
   任一端写入后广播事件,其他端收到后从 extensionSettings 重读并应用,实现跨插件实时同步。 */
const SHARED_CHANNELS_KEY = 'baibai_api_channels';
const SHARED_CHANNELS_EVENT = 'st-baibai-api-channels:changed';
const SHARED_CHANNELS_SCHEMA_VERSION = 1;

interface SharedChannelsStore {
  schemaVersion: number;
  revision: number;
  channels: ApiChannel[];
}

let sharedChannelsFingerprint = '';
let sharedChannelsRevision = 0;
let sharedChannelsListenerBound = false;

function channelFingerprint(channels: ApiChannel[]): string {
  return JSON.stringify(channels);
}

function readSharedChannels(raw: unknown): SharedChannelsStore | null {
  if (!raw || typeof raw !== 'object') return null;
  const store = raw as Partial<SharedChannelsStore>;
  if (!Array.isArray(store.channels)) return null;
  return {
    schemaVersion: SHARED_CHANNELS_SCHEMA_VERSION,
    revision:
      typeof store.revision === 'number' && Number.isFinite(store.revision)
        ? Math.max(0, Math.floor(store.revision))
        : 0,
    channels: store.channels.map(normalizeChannel),
  };
}

function writeSharedChannels(dispatch = true): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  sharedChannelsRevision += 1;
  const store: SharedChannelsStore = {
    schemaVersion: SHARED_CHANNELS_SCHEMA_VERSION,
    revision: sharedChannelsRevision,
    channels: JSON.parse(JSON.stringify(settings.channels)) as ApiChannel[],
  };
  ctx.extensionSettings[SHARED_CHANNELS_KEY] = store;
  sharedChannelsFingerprint = channelFingerprint(store.channels);
  ctx.saveSettingsDebounced?.();
  if (dispatch) {
    window.dispatchEvent(
      new CustomEvent(SHARED_CHANNELS_EVENT, {
        detail: { revision: store.revision, source: 'ST-BaiBai-Mod' },
      }),
    );
  }
}

function applySharedChannels(store: SharedChannelsStore): void {
  const fingerprint = channelFingerprint(store.channels);
  sharedChannelsRevision = Math.max(sharedChannelsRevision, store.revision);
  if (fingerprint === sharedChannelsFingerprint) return;
  settings.channels = store.channels;
  sharedChannelsFingerprint = fingerprint;

  // 被指派的渠道已不在共享列表里 → 清掉指派
  const ids = new Set(settings.channels.map(channel => channel.id));
  if (settings.assignments.tagGen && !ids.has(settings.assignments.tagGen)) {
    settings.assignments.tagGen = '';
  }
}

function bindSharedChannelsListener(): void {
  if (sharedChannelsListenerBound) return;
  sharedChannelsListenerBound = true;
  window.addEventListener(SHARED_CHANNELS_EVENT, () => {
    const ctx = getContext();
    const store = readSharedChannels(ctx?.extensionSettings?.[SHARED_CHANNELS_KEY]);
    if (store) applySharedChannels(store);
  });
}

/**
 * 渠道共享存储接管(消费者模式,参照柏宝砚/ST-BaiBai-Pen 的共享渠道协议):
 * - 共享存储存在 → 领养;
 * - 不存在且本插件已有渠道(绘单装用户配过)→ 以自身为种子建仓;
 * - 不存在且本插件也没有渠道 → **不建仓**,只同步内存指纹。
 *   空渠道列表绝不创建共享存储,防止空 store 占位后被书领养、双方同步成空。
 */
function hydrateSharedChannels(legacyChannels: ApiChannel[]): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  const stored = readSharedChannels(ctx.extensionSettings[SHARED_CHANNELS_KEY]);
  if (stored) {
    applySharedChannels(stored);
  } else {
    settings.channels = legacyChannels.map(normalizeChannel);
    sharedChannelsFingerprint = channelFingerprint(settings.channels);
    // 已有渠道才允许建仓;空列表不建仓(消费者模式,等书或用户改动时再建)
    if (settings.channels.length > 0) writeSharedChannels(false);
  }
  bindSharedChannelsListener();
}

/* ============ 排除设置共享存储(与柏宝书共用,协议与渠道完全同构) ============ */

const SHARED_EXCLUDES_KEY = 'baibai_exclude_settings';
const SHARED_EXCLUDES_EVENT = 'st-baibai-exclude-settings:changed';
const SHARED_EXCLUDES_SCHEMA_VERSION = 1;

interface SharedExcludesStore {
  schemaVersion: number;
  revision: number;
  excludedChars: string[];
  excludedWorldNames: string[];
  excludedWorldInfoPatterns: string[];
  customStripTags: string[];
}

let sharedExcludesFingerprint = '';
let sharedExcludesRevision = 0;
let sharedExcludesListenerBound = false;

function excludesFingerprint(ex: ExcludesSettings): string {
  return JSON.stringify([
    ex.excludedChars,
    ex.excludedWorldNames,
    ex.excludedWorldInfoPatterns,
    ex.customStripTags,
  ]);
}

/** 判断名单里除内置默认条目名规则(mvu)外,是否还有任何用户数据。 */
function excludesHasUserData(ex: ExcludesSettings): boolean {
  const patterns = ex.excludedWorldInfoPatterns.filter(p => !DEFAULT_WI_PATTERNS.includes(p));
  return (
    ex.excludedChars.length > 0 ||
    ex.excludedWorldNames.length > 0 ||
    patterns.length > 0 ||
    ex.customStripTags.length > 0
  );
}

/** 从共享存储原样读出四名单,逐名单按 normalizeExcludes 同口径清洗(缺字段/类型不符回退空数组)。 */
function readSharedExcludes(raw: unknown): SharedExcludesStore | null {
  if (!raw || typeof raw !== 'object') return null;
  const store = raw as Partial<SharedExcludesStore>;
  if (!Array.isArray(store.excludedChars)) return null;
  const normalized = normalizeExcludes({
    excludedChars: store.excludedChars,
    excludedWorldNames: store.excludedWorldNames,
    excludedWorldInfoPatterns: store.excludedWorldInfoPatterns,
    customStripTags: store.customStripTags,
  });
  return {
    schemaVersion: SHARED_EXCLUDES_SCHEMA_VERSION,
    revision:
      typeof store.revision === 'number' && Number.isFinite(store.revision)
        ? Math.max(0, Math.floor(store.revision))
        : 0,
    ...normalized,
  };
}

function writeSharedExcludes(dispatch = true): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  sharedExcludesRevision += 1;
  const store: SharedExcludesStore = {
    schemaVersion: SHARED_EXCLUDES_SCHEMA_VERSION,
    revision: sharedExcludesRevision,
    ...JSON.parse(JSON.stringify(settings.excludes)) as ExcludesSettings,
  };
  ctx.extensionSettings[SHARED_EXCLUDES_KEY] = store;
  sharedExcludesFingerprint = excludesFingerprint(store);
  ctx.saveSettingsDebounced?.();
  if (dispatch) {
    window.dispatchEvent(
      new CustomEvent(SHARED_EXCLUDES_EVENT, {
        detail: { revision: store.revision, source: 'ST-BaiBai-Mod' },
      }),
    );
  }
}

function applySharedExcludes(store: SharedExcludesStore): void {
  const fingerprint = excludesFingerprint(store);
  sharedExcludesRevision = Math.max(sharedExcludesRevision, store.revision);
  if (fingerprint === sharedExcludesFingerprint) return;
  settings.excludes = {
    excludedChars: store.excludedChars,
    excludedWorldNames: store.excludedWorldNames,
    excludedWorldInfoPatterns: store.excludedWorldInfoPatterns,
    customStripTags: store.customStripTags,
  };
  sharedExcludesFingerprint = fingerprint;
}

function bindSharedExcludesListener(): void {
  if (sharedExcludesListenerBound) return;
  sharedExcludesListenerBound = true;
  window.addEventListener(SHARED_EXCLUDES_EVENT, () => {
    const ctx = getContext();
    const store = readSharedExcludes(ctx?.extensionSettings?.[SHARED_EXCLUDES_KEY]);
    if (store) applySharedExcludes(store);
  });
}

/**
 * 排除设置共享存储接管(消费者模式,参照柏宝砚/ST-BaiBai-Pen 的共享渠道协议):
 * - 共享存储存在 → 领养共享数据;
 * - 共享存储不存在但本插件名单已有用户数据 → 以本插件名单为种子建仓(绘单装用户);
 * - 共享存储不存在且本插件也没有用户数据 → **不建仓**,只在本地播种内置默认规则。
 *   没有数据的一方绝不创建共享存储,防止空 store 占位后被书领养、双方互相同步成空。
 * 播种只在「无存储」时发生,天然满足「只发一次、删了不补回」。
 */
function hydrateSharedExcludes(): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  const stored = readSharedExcludes(ctx.extensionSettings[SHARED_EXCLUDES_KEY]);
  if (stored) {
    // 领同居中:共享存储存在但无用户数据(疑似早期版本空种子),本插件却有数据 → 以本插件为准回写,
    // 修复历史遗留的空 store(回写广播后书会领养真实数据)。
    if (!excludesHasUserData(stored) && excludesHasUserData(settings.excludes)) {
      writeSharedExcludes(true);
    } else {
      applySharedExcludes(stored);
    }
  } else {
    // 本地播种内置默认条目名规则(绘单装时开箱即用)
    for (const pat of DEFAULT_WI_PATTERNS) {
      if (!settings.excludes.excludedWorldInfoPatterns.includes(pat)) {
        settings.excludes.excludedWorldInfoPatterns.push(pat);
      }
    }
    sharedExcludesFingerprint = excludesFingerprint(settings.excludes);
    // 名单里已有用户数据才允许建仓;空名单不建仓(消费者模式,等书或用户改动时再建)
    if (excludesHasUserData(settings.excludes)) writeSharedExcludes(false);
  }
  bindSharedExcludesListener();
}

/* ============ 排除角色闸门(与柏宝书 isCurrentChatExcluded 同口径) ============ */

/** 当前单角色聊天的角色名;群聊或未进入聊天时返回 null(群聊不参与排除)。 */
function currentCharName(): string | null {
  const ctx = getContext();
  if (!ctx) return null;
  if (ctx.groupId) return null; // 群聊:多角色,不按单名排除
  const idx = ctx.characterId;
  if (idx === undefined || idx === null || idx === '') return null;
  const ch = ctx.characters?.[Number(idx)];
  return ch?.name ?? null;
}

/**
 * 当前聊天是否被排除(该角色名在排除名单里)。被排除则自动 tag 全流程停用。
 * 按「名字」匹配:同名的重名卡会被一并排除——与柏宝书排除角色的口径完全一致。
 */
export function isCurrentChatExcluded(): boolean {
  if (!settings.excludes.excludedChars.length) return false;
  const name = currentCharName();
  return name !== null && settings.excludes.excludedChars.includes(name);
}

/** 写回 extension_settings 并防抖落盘到服务器(跨设备同步的关键)。 */
function persist(): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  ctx.extensionSettings[SETTINGS_KEY] = JSON.parse(JSON.stringify(settings));
  // 渠道有改动 → 同步写共享存储并广播(指纹比对防回环)
  const fingerprint = channelFingerprint(settings.channels);
  if (fingerprint !== sharedChannelsFingerprint) writeSharedChannels();
  // 排除名单有改动 → 同步写共享存储并广播(指纹比对防回环)
  const exFingerprint = excludesFingerprint(settings.excludes);
  if (exFingerprint !== sharedExcludesFingerprint) writeSharedExcludes();
  ctx.saveSettingsDebounced?.();
}

/**
 * ST 就绪后调用:从 extension_settings 载入真实设置并放行 watch 回写。
 * 可安全重复调用(只在首次真正 hydrate)。
 */
export async function hydrateSettings(): Promise<void> {
  if (ready) return;
  const ctx = getContext();
  if (!ctx?.extensionSettings) return; // ST 未就绪,稍后重试

  const stored = ctx.extensionSettings[SETTINGS_KEY];
  if (stored && typeof stored === 'object') {
    const migration = await migrateLegacyVibesInPlace(stored);
    if (migration.error) {
      if (migration.migrated) ctx.saveSettingsDebounced?.();
      throw migration.error;
    }
    applyInto(settings, normalize(stored));
    if (migration.migrated) {
      ctx.extensionSettings[SETTINGS_KEY] = JSON.parse(JSON.stringify(settings));
      ctx.saveSettingsDebounced?.();
    }
  } else {
    // 把默认值写进 extension_settings,确立同步源
    ctx.extensionSettings[SETTINGS_KEY] = JSON.parse(JSON.stringify(settings));
    ctx.saveSettingsDebounced?.();
  }

  // 渠道列表改由共享存储接管(存在则以共享为准,不存在则以自身为种子写入)
  hydrateSharedChannels(settings.channels);

  // 排除名单同样改由共享存储接管(创建时播种内置默认条目名规则)
  hydrateSharedExcludes();

  ready = true;
  for (const cb of readyCbs.splice(0)) {
    try {
      cb();
    } catch {
      /* 订阅者自身异常不阻断后续 */
    }
  }
}

watch(
  settings,
  () => {
    if (!ready) return; // hydrate 前不回写,防止默认值覆盖服务器设置
    persist();
  },
  { deep: true },
);
