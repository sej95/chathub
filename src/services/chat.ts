import { PluginRequestPayload, createHeadersWithPluginSettings } from '@lobehub/chat-plugin-sdk';
import { produce } from 'immer';
import { merge } from 'lodash-es';

import { createErrorResponse } from '@/app/api/errorResponse';
import { DEFAULT_AGENT_CONFIG } from '@/const/settings';
import { TracePayload, TraceTagMap } from '@/const/trace';
import { ChatCompletionErrorPayload, ModelProvider } from '@/libs/agent-runtime';
import AgentRuntimeLib from '@/libs/agent-runtime/AgentRuntime';
import { filesSelectors, useFileStore } from '@/store/file';
import { useGlobalStore } from '@/store/global';
import {
  commonSelectors,
  modelProviderSelectors,
  preferenceSelectors,
} from '@/store/global/selectors';
import { useSessionStore } from '@/store/session';
import { agentSelectors } from '@/store/session/selectors';
import { useToolStore } from '@/store/tool';
import { pluginSelectors, toolSelectors } from '@/store/tool/selectors';
import { ChatErrorType } from '@/types/fetch';
import { ChatMessage } from '@/types/message';
import type { ChatStreamPayload, OpenAIChatMessage } from '@/types/openai/chat';
import { UserMessageContentPart } from '@/types/openai/chat';
import { FetchSSEOptions, OnFinishHandler, fetchSSE, getMessageError } from '@/utils/fetch';
import { createTraceHeader, getTraceId } from '@/utils/trace';

import { createHeaderPayload, createHeaderWithAuth, getProviderAuthPayload } from './_auth';
import { API_ENDPOINTS } from './_url';

interface FetchOptions {
  signal?: AbortSignal | undefined;
  trace?: TracePayload;
}

interface GetChatCompletionPayload extends Partial<Omit<ChatStreamPayload, 'messages'>> {
  messages: ChatMessage[];
}

interface FetchAITaskResultParams {
  abortController?: AbortController;
  /**
   * 错误处理函数
   */
  onError?: (e: Error, rawError?: any) => void;
  onFinish?: OnFinishHandler;
  /**
   * 加载状态变化处理函数
   * @param loading - 是否处于加载状态
   */
  onLoadingChange?: (loading: boolean) => void;
  /**
   * 消息处理函数
   * @param text - 消息内容
   */
  onMessageHandle?: (text: string) => void;
  /**
   * 请求对象
   */
  params: Partial<ChatStreamPayload>;
  trace?: TracePayload;
}

interface CreateAssistantMessageStream extends FetchSSEOptions {
  abortController?: AbortController;
  params: GetChatCompletionPayload;
  trace?: TracePayload;
}

async function fetchOnClient(
  provider: string,
  payload: Partial<ChatStreamPayload>,
  options?: FetchOptions,
) {
  // add auth payload
  const providerAuthPayload = getProviderAuthPayload(provider);
  let providerOptions;

  switch (provider) {
    case ModelProvider.OpenAI: {
      // if provider is openai, enable browser agent runtime and set baseurl
      providerOptions = {
        baseURL: providerAuthPayload?.endpoint,
        dangerouslyAllowBrowser: true,
      };
      break;
    }
    case ModelProvider.Azure: {
      providerOptions = {
        apiVersion: providerAuthPayload?.azureApiVersion,
      };
      break;
    }
    case ModelProvider.ZhiPu: {
      break;
    }
    case ModelProvider.Google: {
      providerOptions = {
        baseURL: providerAuthPayload?.endpoint,
      };
      break;
    }
    case ModelProvider.Moonshot: {
      // no moonshot env for client side
      break;
    }
    case ModelProvider.Bedrock: {
      if (providerAuthPayload?.apiKey) {
        providerOptions = {
          accessKeyId: providerAuthPayload?.awsAccessKeyId,
          accessKeySecret: providerAuthPayload?.awsSecretAccessKey,
          region: providerAuthPayload?.awsRegion,
        };
      }
      break;
    }
    case ModelProvider.Ollama: {
      providerOptions = {
        baseURL: providerAuthPayload?.endpoint,
      };
      break;
    }
    case ModelProvider.Perplexity: {
      break;
    }
    case ModelProvider.Anthropic: {
      providerOptions = {
        baseURL: providerAuthPayload?.endpoint,
      };
      break;
    }
    case ModelProvider.Mistral: {
      break;
    }
    case ModelProvider.Groq: {
      break;
    }
    case ModelProvider.OpenRouter: {
      break;
    }
    case ModelProvider.TogetherAI: {
      break;
    }
    case ModelProvider.ZeroOne: {
      break;
    }
  }

  const agentRuntime = await AgentRuntimeLib.initializeWithProviderOptions(provider, {
    [provider]: {
      ...payload,
      ...providerAuthPayload,
      ...providerOptions,
    },
  });

  const data = payload as ChatStreamPayload;
  const tracePayload = options?.trace;
  return agentRuntime.chat(data, {
    enableTrace: tracePayload?.enabled,
    provider,
    trace: tracePayload,
  });
}

class ChatService {
  createAssistantMessage = async (
    { plugins: enabledPlugins, messages, ...params }: GetChatCompletionPayload,
    options?: FetchOptions,
  ) => {
    const payload = merge(
      {
        model: DEFAULT_AGENT_CONFIG.model,
        stream: true,
        ...DEFAULT_AGENT_CONFIG.params,
      },
      params,
    );
    // ============  1. preprocess messages   ============ //

    const oaiMessages = this.processMessages({
      messages,
      model: payload.model,
      tools: enabledPlugins,
    });

    // ============  2. preprocess tools   ============ //

    const filterTools = toolSelectors.enabledSchema(enabledPlugins)(useToolStore.getState());

    // check this model can use function call
    const canUseFC = modelProviderSelectors.isModelEnabledFunctionCall(payload.model)(
      useGlobalStore.getState(),
    );
    // the rule that model can use tools:
    // 1. tools is not empty
    // 2. model can use function call
    const shouldUseTools = filterTools.length > 0 && canUseFC;

    const tools = shouldUseTools ? filterTools : undefined;

    return this.getChatCompletion({ ...params, messages: oaiMessages, tools }, options);
  };

  createAssistantMessageStream = async ({
    params,
    abortController,
    onAbort,
    onMessageHandle,
    onErrorHandle,
    onFinish,
    trace,
  }: CreateAssistantMessageStream) => {
    await fetchSSE(
      () =>
        this.createAssistantMessage(params, {
          signal: abortController?.signal,
          trace: this.mapTrace(trace, TraceTagMap.Chat),
        }),
      {
        onAbort,
        onErrorHandle,
        onFinish,
        onMessageHandle,
      },
    );
  };

  getChatCompletion = async (params: Partial<ChatStreamPayload>, options?: FetchOptions) => {
    const { signal } = options ?? {};

    const { provider = ModelProvider.OpenAI, ...res } = params;

    let model = res.model || DEFAULT_AGENT_CONFIG.model;

    // if the provider is Azure, get the deployment name as the request model
    if (provider === ModelProvider.Azure) {
      const chatModelCards = modelProviderSelectors.getModelCardsById(provider)(
        useGlobalStore.getState(),
      );

      const deploymentName = chatModelCards.find((i) => i.id === model)?.deploymentName;
      if (deploymentName) model = deploymentName;
    }

    const payload = merge(
      { model: DEFAULT_AGENT_CONFIG.model, stream: true, ...DEFAULT_AGENT_CONFIG.params },
      { ...res, model },
    );

    const traceHeader = createTraceHeader({ ...options?.trace });

    const headers = await createHeaderWithAuth({
      headers: { 'Content-Type': 'application/json', ...traceHeader },
      provider,
    });

    /**
     * Use browser agent runtime
     */
    const headerPayload = createHeaderPayload({ provider });
    // If user specify the endpoint, use the browser agent runtime directly
    /**
     * Notes:
     * 1. Broswer agent runtime will skip auth check if a key and endpoint provided by
     *    user which will cause abuse of plugins services
     * 2. This feature will need to control by user llm settings after, but set it enable
     *    when user use it's own key and endpoint temporary
     */
    if (headerPayload['endpoint'] && headerPayload['apiKey']) {
      try {
        return await fetchOnClient(provider, payload, options);
      } catch (e) {
        const {
          errorType = ChatErrorType.BadRequest,
          error: errorContent,
          ...res
        } = e as ChatCompletionErrorPayload;

        const error = errorContent || e;
        // track the error at server side
        console.error(`Route: [${provider}] ${errorType}:`, error);

        return createErrorResponse(errorType, { error, ...res, provider });
      }
    }

    return fetch(API_ENDPOINTS.chat(provider), {
      body: JSON.stringify(payload),
      headers,
      method: 'POST',
      signal,
    });
  };

  /**
   * run the plugin api to get result
   * @param params
   * @param options
   */
  runPluginApi = async (params: PluginRequestPayload, options?: FetchOptions) => {
    const s = useToolStore.getState();

    const settings = pluginSelectors.getPluginSettingsById(params.identifier)(s);
    const manifest = pluginSelectors.getPluginManifestById(params.identifier)(s);

    const traceHeader = createTraceHeader(this.mapTrace(options?.trace, TraceTagMap.ToolCalling));

    const headers = await createHeaderWithAuth({
      headers: { ...createHeadersWithPluginSettings(settings), ...traceHeader },
    });

    const gatewayURL = manifest?.gateway ?? API_ENDPOINTS.gateway;

    const res = await fetch(gatewayURL, {
      body: JSON.stringify({ ...params, manifest }),
      headers,
      method: 'POST',
      signal: options?.signal,
    });

    if (!res.ok) {
      throw await getMessageError(res);
    }

    const text = await res.text();
    return { text, traceId: getTraceId(res) };
  };

  fetchPresetTaskResult = async ({
    params,
    onMessageHandle,
    onFinish,
    onError,
    onLoadingChange,
    abortController,
    trace,
  }: FetchAITaskResultParams) => {
    const errorHandle = (error: Error, errorContent?: any) => {
      onLoadingChange?.(false);
      if (abortController?.signal.aborted) {
        return;
      }
      onError?.(error, errorContent);
    };

    onLoadingChange?.(true);

    const data = await fetchSSE(
      () =>
        this.getChatCompletion(params, {
          signal: abortController?.signal,
          trace: this.mapTrace(trace, TraceTagMap.SystemChain),
        }),
      {
        onErrorHandle: (error) => {
          errorHandle(new Error(error.message), error);
        },
        onFinish,
        onMessageHandle,
      },
    ).catch(errorHandle);

    onLoadingChange?.(false);

    return await data?.text();
  };

  private processMessages = ({
    messages,
    tools,
    model,
  }: {
    messages: ChatMessage[];
    model: string;
    tools?: string[];
  }): OpenAIChatMessage[] => {
    // handle content type for vision model
    // for the models with visual ability, add image url to content
    // refs: https://platform.openai.com/docs/guides/vision/quick-start
    const getContent = (m: ChatMessage) => {
      if (!m.files) return m.content;

      const imageList = filesSelectors.getImageUrlOrBase64ByList(m.files)(useFileStore.getState());

      if (imageList.length === 0) return m.content;

      const canUploadFile = modelProviderSelectors.isModelEnabledUpload(model)(
        useGlobalStore.getState(),
      );

      if (!canUploadFile) {
        return m.content;
      }

      return [
        { text: m.content, type: 'text' },
        ...imageList.map(
          (i) => ({ image_url: { detail: 'auto', url: i.url }, type: 'image_url' }) as const,
        ),
      ] as UserMessageContentPart[];
    };

    const postMessages = messages.map((m): OpenAIChatMessage => {
      switch (m.role) {
        case 'user': {
          return { content: getContent(m), role: m.role };
        }

        case 'function': {
          const name = m.plugin?.identifier as string;
          return { content: m.content, name, role: m.role };
        }

        default: {
          return { content: m.content, role: m.role };
        }
      }
    });

    return produce(postMessages, (draft) => {
      if (!tools || tools.length === 0) return;
      const hasFC = modelProviderSelectors.isModelEnabledFunctionCall(model)(
        useGlobalStore.getState(),
      );
      if (!hasFC) return;

      const systemMessage = draft.find((i) => i.role === 'system');

      const toolsSystemRoles = toolSelectors.enabledSystemRoles(tools)(useToolStore.getState());
      if (!toolsSystemRoles) return;

      if (systemMessage) {
        systemMessage.content = systemMessage.content + '\n\n' + toolsSystemRoles;
      } else {
        draft.unshift({
          content: toolsSystemRoles,
          role: 'system',
        });
      }
    });
  };

  private mapTrace(trace?: TracePayload, tag?: TraceTagMap): TracePayload {
    const tags = agentSelectors.currentAgentMeta(useSessionStore.getState()).tags || [];

    const enabled = preferenceSelectors.userAllowTrace(useGlobalStore.getState());

    if (!enabled) return { enabled: false };

    return {
      ...trace,
      enabled: true,
      tags: [tag, ...(trace?.tags || []), ...tags].filter(Boolean) as string[],
      userId: commonSelectors.userId(useGlobalStore.getState()),
    };
  }
}

export const chatService = new ChatService();
