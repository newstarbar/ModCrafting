import type { LlmProtocol } from './harness-runtime.ts'

export interface LlmModelDef {
	id: string;
	label: string;
	contextWindow?: number;
	/** Whether the model accepts image inputs (OpenAI-compatible multimodal). */
	vision?: boolean;
}

export interface LlmProviderDef {
	id: string;
	label: string;
	baseUrl: string;
	docsUrl: string;
	keyHint: string;
	models: LlmModelDef[];
	/** Default wire protocol. Existing saved endpoints may override this via auto detection. */
	protocol?: LlmProtocol;
}

export const CUSTOM_PROVIDER_ID = "custom";

export const LLM_PROVIDERS: LlmProviderDef[] = [
	{
		id: "deepseek",
		label: "DeepSeek",
		baseUrl: "https://api.deepseek.com/v1",
		docsUrl: "https://platform.deepseek.com/api_keys",
		keyHint: "在 DeepSeek 开放平台创建 API Key，填入上方密钥框。",
		models: [
			{ id: "deepseek-flash", label: "DeepSeek V4.1 Flash", contextWindow: 1_000_000, vision: true },
			{ id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", contextWindow: 1_000_000, vision: false }
		]
	},
	{
		id: "dashscope",
		label: "通义千问",
		baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		docsUrl: "https://bailian.console.aliyun.com/?tab=model#/api-key",
		keyHint: "使用阿里云百炼 / DashScope API Key（sk- 开头）。",
		models: [
			{ id: "qwen3.8-max", label: "Qwen3.8 Max", contextWindow: 1_000_000, vision: true },
			{ id: "qwen3.7-plus", label: "Qwen3.7 Plus", contextWindow: 1_000_000, vision: true },
			{ id: "qwen3.8-flash", label: "Qwen3.8 Flash", contextWindow: 1_000_000, vision: true },
			{ id: "qwen3.8-omni-flash", label: "Qwen3.8 Omni Flash", contextWindow: 1_000_000, vision: true },
			{ id: "qwen3.7-max", label: "Qwen3.7 Max", contextWindow: 1_000_000, vision: false }
		]
	},
	{
		id: "zhipu",
		label: "智谱 GLM",
		baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		docsUrl: "https://bigmodel.cn/apikey/platform",
		keyHint: "在智谱开放平台创建 API Key。",
		models: [
			{ id: "glm-5.3", label: "GLM-5.3", contextWindow: 1_000_000, vision: false },
			{ id: "glm-5.3-flash", label: "GLM-5.3 Flash", contextWindow: 1_000_000, vision: true },
			{ id: "glm-5.3-flashx", label: "GLM-5.3 FlashX", contextWindow: 1_000_000, vision: true },
			{ id: "glm-5.2", label: "GLM-5.2", contextWindow: 1_000_000, vision: false },
			{ id: "glm-5.1", label: "GLM-5.1", contextWindow: 200_000, vision: false },
			{ id: "glm-5", label: "GLM-5", contextWindow: 200_000, vision: false },
			{ id: "glm-5-turbo", label: "GLM-5 Turbo", contextWindow: 200_000, vision: false },
			{ id: "glm-5v-turbo", label: "GLM-5V Turbo", contextWindow: 200_000, vision: true }
		]
	},
	{
		id: "moonshot",
		label: "Kimi",
		baseUrl: "https://api.moonshot.cn/v1",
		docsUrl: "https://platform.moonshot.cn/console/api-keys",
		keyHint: "在 Moonshot 开放平台创建 API Key。",
		models: [
			{ id: "kimi-k3", label: "Kimi K3", contextWindow: 1_000_000, vision: true },
			{ id: "kimi-k2.7-code", label: "Kimi K2.7 Code", contextWindow: 262_144, vision: true },
			{ id: "kimi-k2.7-code-highspeed", label: "Kimi K2.7 Code Highspeed", contextWindow: 262_144, vision: true },
			{ id: "kimi-k2.6", label: "Kimi K2.6", contextWindow: 262_144, vision: true }
		]
	},
	{
		id: "doubao",
		label: "豆包",
		baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
		docsUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
		keyHint: "火山方舟 API Key；可直接使用模型名称或在控制台创建的推理接入点 ID（ep- 开头）。",
		models: [
			{ id: "doubao-seed-evolving", label: "豆包 Evolving", contextWindow: 1_024_000, vision: true },
			{ id: "doubao-seed-2-1-pro-260628", label: "豆包 2.1 Pro", contextWindow: 256_000, vision: true },
			{ id: "doubao-seed-2-1-turbo-260628", label: "豆包 2.1 Turbo", contextWindow: 256_000, vision: true },
			{ id: "doubao-seed-2-0-pro-260215", label: "豆包 2.0 Pro", contextWindow: 256_000, vision: true },
			{ id: "doubao-seed-2-0-lite-260428", label: "豆包 2.0 Lite", contextWindow: 256_000, vision: true },
			{ id: "doubao-seed-2-0-mini-260428", label: "豆包 2.0 Mini", contextWindow: 256_000, vision: true }
		]
	},
	{
		id: "minimax",
		label: "MiniMax",
		baseUrl: "https://api.minimaxi.com/anthropic",
		docsUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
		keyHint: "在 MiniMax 开放平台创建 API Key。",
		models: [
			{ id: "MiniMax-M3", label: "MiniMax M3", contextWindow: 1_000_000, vision: true },
			{ id: "MiniMax-M2.7", label: "MiniMax M2.7", contextWindow: 204_800, vision: false },
			{ id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 Highspeed", contextWindow: 204_800, vision: false },
			{ id: "MiniMax-M2.5", label: "MiniMax M2.5", contextWindow: 204_800, vision: false },
			{ id: "MiniMax-M2.5-highspeed", label: "MiniMax M2.5 Highspeed", contextWindow: 204_800, vision: false },
			{ id: "MiniMax-M2.1", label: "MiniMax M2.1", contextWindow: 204_800, vision: false },
			{ id: "MiniMax-M2.1-highspeed", label: "MiniMax M2.1 Highspeed", contextWindow: 204_800, vision: false }
		],
		protocol: 'anthropic-messages'
	}
];

export const CUSTOM_PROVIDER: LlmProviderDef = {
	id: CUSTOM_PROVIDER_ID,
	label: "自定义",
	baseUrl: "",
	docsUrl: "",
	keyHint: "手动填写 OpenAI 兼容 API 地址与模型名称。",
	models: [],
	protocol: 'openai-chat'
};

export interface LlmSelection {
	providerId: string;
	modelId: string;
	endpoint: string;
	modelLabel: string;
	protocol?: LlmProtocol;
}

/** Canonical DeepSeek id per official docs; retired ids resolve to this serving model at Flash price. */
const DEEPSEEK_CANONICAL_MODEL = "deepseek-flash";

/**
 * Collapse retired DeepSeek ids (`deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`,
 * and any future `-v4-flash*` variant) onto `deepseek-flash`. This is the only place
 * that knows about the alias — catalog, vision, context-window and pricing lookups all
 * go through it, so they cannot drift apart.
 *
 * An explicitly non-DeepSeek provider is never rewritten; `undefined` is treated as
 * "provider not resolved yet", because several lookups only have the bare model id.
 */
export function normalizeModelId(providerId: string | undefined, modelId: string): string {
	const trimmed = (modelId || "").trim();
	if (!trimmed) return trimmed;
	if (trimmed === DEEPSEEK_CANONICAL_MODEL) return trimmed;
	if (providerId && providerId !== "deepseek") return trimmed;
	if (/^deepseek-v4-flash(?:$|-)/i.test(trimmed)) return DEEPSEEK_CANONICAL_MODEL;
	return trimmed;
}

function normalizeEndpoint(endpoint: string): string {
	return endpoint.trim().replace(/\/+$/, "").toLowerCase();
}

export function getProvider(id: string): LlmProviderDef | undefined {
	if (id === CUSTOM_PROVIDER_ID) return CUSTOM_PROVIDER;
	return LLM_PROVIDERS.find((p) => p.id === id);
}

export function getAllProviders(): LlmProviderDef[] {
	return LLM_PROVIDERS;
}

export function findProviderByEndpoint(endpoint: string): LlmProviderDef | undefined {
	const normalized = normalizeEndpoint(endpoint);
	if (!normalized) return undefined;
	return LLM_PROVIDERS.find((p) => normalizeEndpoint(p.baseUrl) === normalized);
}

export function findModelInProvider(providerId: string, modelId: string): LlmModelDef | undefined {
	const provider = getProvider(providerId);
	if (!provider || provider.id === CUSTOM_PROVIDER_ID) return undefined;
	return provider.models.find((m) => m.id === normalizeModelId(provider.id, modelId));
}

/** Catalog lookup across providers, honouring per-provider retired-id aliases. */
function findCatalogModel(modelId: string): { model: LlmModelDef; provider: LlmProviderDef } | undefined {
	for (const provider of LLM_PROVIDERS) {
		const model = provider.models.find((m) => m.id === normalizeModelId(provider.id, modelId));
		if (model) return { model, provider };
	}
	return undefined;
}

export function resolveSelection(providerId: string, modelId: string): LlmSelection {
	if (providerId === CUSTOM_PROVIDER_ID) {
		return {
			providerId: CUSTOM_PROVIDER_ID,
			modelId,
			endpoint: "",
			modelLabel: modelId,
			protocol: 'openai-chat'
		};
	}
	const provider = getProvider(providerId);
	if (!provider) {
		return {
			providerId: CUSTOM_PROVIDER_ID,
			modelId,
			endpoint: "",
			modelLabel: modelId
		};
	}
	const canonical = normalizeModelId(provider.id, modelId);
	const model = provider.models.find((m) => m.id === canonical) ?? provider.models[0];
	const resolvedModelId = model?.id ?? canonical;
	return {
		providerId: provider.id,
		modelId: resolvedModelId,
		endpoint: provider.baseUrl,
		modelLabel: modelDisplayLabel(resolvedModelId, provider.id),
		protocol: provider.protocol
	};
}

/** Resolve an explicit protocol first, then infer legacy saved endpoints. */
export function inferLlmProtocol(endpoint: string, providerId?: string, explicit?: LlmProtocol): LlmProtocol {
	if (explicit && explicit !== 'auto') return explicit
	const normalized = normalizeEndpoint(endpoint)
	if (/\/anthropic(?:\/|$)/i.test(normalized)) return 'anthropic-messages'
	const provider = providerId ? getProvider(providerId) : undefined
	if (provider?.protocol && provider.protocol !== 'auto' && normalized === normalizeEndpoint(provider.baseUrl)) {
		return provider.protocol
	}
	return 'openai-chat'
}

export function inferProviderId(endpoint: string, model: string, savedId?: string): string {
	if (savedId && getProvider(savedId)) return savedId;
	const byEndpoint = findProviderByEndpoint(endpoint);
	if (byEndpoint) return byEndpoint.id;
	if (/^ep-[a-z0-9-]+$/i.test(model)) return "doubao";
	const catalog = findCatalogModel(model);
	if (catalog) return catalog.provider.id;
	return CUSTOM_PROVIDER_ID;
}

export function providerDisplayLabel(providerId?: string, endpoint?: string): string {
	if (!providerId || providerId === CUSTOM_PROVIDER_ID) {
		if (endpoint) {
			try {
				const host = new URL(endpoint).hostname.replace(/^www\./, "");
				return host || CUSTOM_PROVIDER.label;
			} catch {
				return CUSTOM_PROVIDER.label;
			}
		}
		return CUSTOM_PROVIDER.label;
	}
	return getProvider(providerId)?.label ?? CUSTOM_PROVIDER.label;
}

export function modelDisplayLabel(modelId: string, providerId?: string): string {
	if (!modelId) return "未配置模型";
	if (modelId === "ep-xxxxxxxx") {
		return "豆包（请填写接入点）";
	}
	if (providerId === "doubao" && /^ep-[a-z0-9-]+$/i.test(modelId)) {
		return "豆包接入点";
	}
	if (providerId) {
		const model = findModelInProvider(providerId, modelId);
		if (model) return model.label;
	}
	const catalog = findCatalogModel(modelId);
	if (catalog) return catalog.model.label;
	return modelId;
}

export function isKnownModel(modelId: string, providerId?: string): boolean {
	if (providerId && providerId !== CUSTOM_PROVIDER_ID) {
		return Boolean(findModelInProvider(providerId, modelId));
	}
	return Boolean(findCatalogModel(modelId));
}

export function getModelContextWindow(modelId: string, providerId?: string): number | undefined {
	if (providerId) {
		const model = findModelInProvider(providerId, modelId);
		if (model?.contextWindow) return model.contextWindow;
	}
	const catalog = findCatalogModel(modelId);
	if (catalog?.model.contextWindow) return catalog.model.contextWindow;
	return undefined;
}

/**
 * Look up explicit vision support from the model catalog.
 * Returns `undefined` when the model is not in the catalog (e.g. custom endpoint).
 */
export function getCatalogVisionSupport(modelId: string, providerId?: string): boolean | undefined {
	const trimmed = modelId.trim();
	if (!trimmed) return undefined;
	if (providerId && providerId !== CUSTOM_PROVIDER_ID) {
		const model = findModelInProvider(providerId, trimmed);
		if (model) return Boolean(model.vision);
	}
	const catalog = findCatalogModel(trimmed);
	if (catalog) return Boolean(catalog.model.vision);
	// Doubao inference endpoint IDs are opaque; assume vision-capable seed family.
	if (providerId === "doubao" && /^ep-[a-z0-9-]+$/i.test(trimmed)) return true;
	return undefined;
}

/**
 * GLM-5.2+ supports `reasoning_effort` (docs: medium/low→high, xhigh→max).
 * Older GLM thinking models only accept `thinking.type`.
 */
export function supportsGlmReasoningEffort(modelId: string): boolean {
	const id = modelId.trim().toLowerCase();
	if (!id.startsWith("glm-")) return false;
	const match = id.match(/^glm-(\d+)(?:\.(\d+))?/);
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2] || "0");
	return major > 5 || (major === 5 && minor >= 2);
}

/**
 * Extra chat/completions body fields for a model family with a switchable
 * deep-thinking mode. Families are declared once here — a new thinking model is
 * a table entry, never an `if (modelId …)` branch scattered through the adapters.
 */
interface ThinkingProfile {
	/** Matched against the trimmed model id. */
	family: RegExp;
	/** Body fields that enable/tune the thinking mode for this family. */
	requestFields: (modelId: string) => Record<string, unknown>;
}

const THINKING_PROFILES: ThinkingProfile[] = [
	{
		family: /^glm-/i,
		requestFields: (modelId) => ({
			thinking: { type: "enabled" },
			...(supportsGlmReasoningEffort(modelId) ? { reasoning_effort: "high" } : {})
		})
	}
];

export function thinkingProfileFor(modelId: string): ThinkingProfile | undefined {
	const id = modelId.trim();
	return THINKING_PROFILES.find((profile) => profile.family.test(id));
}

/** Chat/completions body fields for a model family with a switchable thinking mode. */
export function buildProviderThinkingFields(modelId: string): Record<string, unknown> {
	return thinkingProfileFor(modelId)?.requestFields(modelId) ?? {};
}

/** Per-million-token list prices in CNY (元) for cost estimates. */
export interface ProviderPricing {
	inputMiss: number;
	inputHit: number;
	output: number;
}

/**
 * DeepSeek 中文官网人民币标价（元 / 百万 tokens，闲时）。
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 *
 * Canonical ids only: `normalizeModelId` folds retired aliases such as
 * `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` onto `deepseek-flash`,
 * which is the serving model and the price they are billed at.
 */
const DEEPSEEK_CNY_BY_MODEL: Record<string, ProviderPricing> = {
	"deepseek-flash": { inputHit: 0.02, inputMiss: 1, output: 4 },
	"deepseek-v4-pro": { inputHit: 0.15, inputMiss: 4.5, output: 13.5 }
};

const DEFAULT_PRICING: ProviderPricing = DEEPSEEK_CNY_BY_MODEL["deepseek-flash"];

const PROVIDER_PRICING: Record<string, ProviderPricing> = {
	deepseek: DEFAULT_PRICING,
	dashscope: { inputMiss: 2.0, inputHit: 0.5, output: 6.0 },
	zhipu: { inputMiss: 8.0, inputHit: 2.0, output: 28.0 },
	moonshot: { inputMiss: 12.0, inputHit: 12.0, output: 12.0 },
	doubao: { inputMiss: 3.0, inputHit: 0.6, output: 15.0 },
	minimax: { inputMiss: 1.0, inputHit: 0.1, output: 1.0 },
	stepfun: { inputMiss: 5.0, inputHit: 5.0, output: 20.0 },
	baichuan: { inputMiss: 0.5, inputHit: 0.5, output: 0.5 },
	lingyi: { inputMiss: 2.5, inputHit: 2.5, output: 2.5 },
	siliconflow: { inputMiss: 1.0, inputHit: 0.5, output: 1.0 },
	qianfan: { inputMiss: 3.0, inputHit: 3.0, output: 6.0 }
};

export function getProviderPricing(providerId?: string): ProviderPricing {
	if (!providerId || providerId === CUSTOM_PROVIDER_ID) return DEFAULT_PRICING;
	return PROVIDER_PRICING[providerId] ?? DEFAULT_PRICING;
}

/** Prefer model-specific rates (DeepSeek Flash vs Pro); fall back to provider defaults. */
export function getModelPricing(providerId?: string, modelId?: string): ProviderPricing {
	const model = normalizeModelId(providerId, (modelId || "").toLowerCase().trim());
	if (providerId === "deepseek" || (!providerId && model.startsWith("deepseek"))) {
		const exact = DEEPSEEK_CNY_BY_MODEL[model];
		if (exact) return exact;
		if (model === "deepseek-v4-pro") {
			return DEEPSEEK_CNY_BY_MODEL["deepseek-v4-pro"];
		}
		// Unknown / future DeepSeek ids bill at Flash, never at the Pro premium.
		return DEEPSEEK_CNY_BY_MODEL["deepseek-flash"];
	}
	return getProviderPricing(providerId);
}
